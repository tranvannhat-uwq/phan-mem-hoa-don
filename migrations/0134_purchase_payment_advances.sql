BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0009') THEN
    RAISE EXCEPTION 'Migration 0134 requires migration 0009.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0134') THEN
    RAISE EXCEPTION 'Migration 0134 is already recorded.';
  END IF;
END $guard$;

-- Existing balances are preserved. Negative supplier debt represents money
-- already paid in excess of all purchases, including any retained carry.
ALTER TABLE public.suppliers DROP CONSTRAINT suppliers_financial_nonnegative;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_financial_nonnegative
  CHECK (total_purchase >= 0 AND total_paid >= 0);
ALTER TABLE public.purchases DROP CONSTRAINT purchases_amounts_check;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_amounts_check
  CHECK (total_amount >= 0 AND paid_amount >= 0 AND balance_due >= 0);

CREATE OR REPLACE FUNCTION public.rpc_record_supplier_payment(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  supplier_row public.suppliers%ROWTYPE;
  purchase_row public.purchases%ROWTYPE;
  existing_payment public.purchase_payments%ROWTYPE;
  payment_key text := NULLIF(btrim(p_input->>'idempotencyKey'), '');
  payment_method_value text := lower(COALESCE(NULLIF(p_input->>'paymentMethod', ''), 'cash'));
  payment_amount numeric := round(COALESCE(NULLIF(p_input->>'amount', '')::numeric, 0));
  payment_id text;
  cashbook_id text;
  request_hash text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501'; END IF;
  IF payment_key IS NULL OR length(payment_key) < 8 OR length(payment_key) > 128 THEN RAISE EXCEPTION 'A stable payment idempotency key (8..128 chars) is required'; END IF;
  IF payment_method_value NOT IN ('cash', 'bank', 'wallet') THEN RAISE EXCEPTION 'Payment method must be cash, bank or wallet'; END IF;
  IF COALESCE(p_input->>'amount', '') !~ '^[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION 'Supplier payment must be a finite positive number'; END IF;
  IF payment_amount <= 0 THEN RAISE EXCEPTION 'Supplier payment amount must be positive'; END IF;

  request_hash := md5(jsonb_build_object(
    'supplierId', p_input->>'supplierId', 'purchaseId', COALESCE(p_input->>'purchaseId', ''),
    'amount', payment_amount, 'paymentMethod', payment_method_value,
    'notes', COALESCE(p_input->>'notes', '')
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || payment_key, 0));
  SELECT * INTO existing_payment FROM public.purchase_payments
  WHERE created_by = actor.auth_user_id::text AND idempotency_key = payment_key;
  IF FOUND THEN
    IF existing_payment.request_fingerprint <> request_hash THEN RAISE EXCEPTION '409: idempotency key was already used with a different supplier payment' USING ERRCODE = '23505'; END IF;
    RETURN COALESCE(public.p4_purchase_response(existing_payment.purchase_id), jsonb_build_object('success', true))
      || public.p4_supplier_response(existing_payment.supplier_id)
      || jsonb_build_object('success', true, 'already_recorded', true,
      'payment_id', existing_payment.id, 'purchase_id', existing_payment.purchase_id,
      'supplier_id', existing_payment.supplier_id);
  END IF;

  SELECT * INTO STRICT supplier_row FROM public.suppliers WHERE id = p_input->>'supplierId' FOR UPDATE;
  IF supplier_row.is_active = false THEN RAISE EXCEPTION 'Supplier is inactive'; END IF;
  IF NULLIF(p_input->>'purchaseId', '') IS NULL AND payment_amount > supplier_row.debt THEN RAISE EXCEPTION 'Supplier payment exceeds outstanding debt'; END IF;
  IF NULLIF(p_input->>'purchaseId', '') IS NOT NULL THEN
    SELECT * INTO STRICT purchase_row FROM public.purchases
    WHERE id = p_input->>'purchaseId' AND supplier_id = supplier_row.id FOR UPDATE;
    IF purchase_row.status <> 'completed' THEN RAISE EXCEPTION 'Only completed purchases can be paid'; END IF;
    -- Purchase-linked payments may exceed the invoice; supplier debt carries the advance.
  END IF;

  payment_id := 'SPAY-' || replace(gen_random_uuid()::text, '-', '');
  cashbook_id := 'PC-NCC-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.purchase_payments(
    id, purchase_id, supplier_id, amount, payment_method,
    cashbook_transaction_id, status, notes, idempotency_key,
    request_fingerprint, created_by
  ) VALUES (
    payment_id, NULLIF(p_input->>'purchaseId', ''), supplier_row.id, payment_amount,
    payment_method_value, cashbook_id, 'completed', COALESCE(p_input->>'notes', ''),
    payment_key, request_hash, actor.auth_user_id::text
  );
  INSERT INTO public.supplier_debt_transactions(
    id, supplier_id, purchase_id, payment_id, transaction_type, amount_change,
    balance_after, idempotency_key, notes, created_by, transaction_date
  ) VALUES (
    'SDL-' || replace(gen_random_uuid()::text, '-', ''), supplier_row.id,
    NULLIF(p_input->>'purchaseId', ''), payment_id, 'supplier_payment', -payment_amount,
    supplier_row.debt - payment_amount, payment_key, COALESCE(p_input->>'notes', ''),
    actor.auth_user_id::text, now()
  );
  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, supplier_id, purchase_id, purchase_payment_id, value,
    method, payment_method, accounting, status, creator, created_by,
    note, starred, idempotency_key, request_fingerprint, external_reference
  ) VALUES (
    cashbook_id, now(), now(), 'chi', 'supplier_payment', 'out', 'Thanh toán nhà cung cấp',
    supplier_row.name, supplier_row.id, NULLIF(p_input->>'purchaseId', ''), payment_id,
    payment_amount, payment_method_value, payment_method_value, true, 'completed',
    actor.display_name, actor.auth_user_id::text, COALESCE(p_input->>'notes', ''),
    false, payment_key || ':cashbook', request_hash, payment_id
  );
  IF NULLIF(p_input->>'purchaseId', '') IS NOT NULL THEN PERFORM public.p4_recompute_purchase(p_input->>'purchaseId'); END IF;
  PERFORM public.p4_recompute_supplier(supplier_row.id);
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('purchase_payments', 'CREATE', payment_id,
    jsonb_build_object('supplier_id', supplier_row.id, 'purchase_id', NULLIF(p_input->>'purchaseId', ''),
      'amount', payment_amount, 'cashbook_id', cashbook_id), actor.auth_user_id::text, now());
  RETURN COALESCE(public.p4_purchase_response(NULLIF(p_input->>'purchaseId', '')), jsonb_build_object('success', true))
    || public.p4_supplier_response(supplier_row.id)
    || jsonb_build_object('success', true, 'already_recorded', false,
    'payment_id', payment_id, 'purchase_id', NULLIF(p_input->>'purchaseId', ''),
    'supplier_id', supplier_row.id, 'cashbook_transaction_id', cashbook_id,
    'new_debt', supplier_row.debt - payment_amount, 'performed_by', actor.auth_user_id::text);
END;
$$;

-- A versioned endpoint prevents clients from silently using an older server.
CREATE FUNCTION public.rpc_record_purchase_payment_advance(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NULLIF(p_input->>'purchaseId','') IS NULL THEN
    RAISE EXCEPTION 'Cần chọn phiếu mua để ghi khoản thanh toán này.';
  END IF;
  IF COALESCE(p_input->>'amount','') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Số tiền thanh toán phải là số VNĐ nguyên dương.';
  END IF;
  RETURN public.rpc_record_supplier_payment(p_input);
END $$;
REVOKE ALL ON FUNCTION public.rpc_record_purchase_payment_advance(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_purchase_payment_advance(jsonb) TO authenticated;

-- An existing payment with an advance must still allow note/method/amount
-- corrections in Sổ quỹ. Preserve all other amendment and audit rules.
DO $amend$
DECLARE definition text;
  old_rule text := 'IF next_value > round(COALESCE(old_supplier.debt, 0)) + round(entry.value) THEN';
BEGIN
  IF to_regprocedure('public.rpc_amend_cashbook_transaction(text,jsonb)') IS NULL THEN RETURN; END IF;
  definition := pg_get_functiondef('public.rpc_amend_cashbook_transaction(text,jsonb)'::regprocedure);
  IF strpos(definition, old_rule)=0 THEN RAISE EXCEPTION '0134: unexpected supplier payment amendment guard; review the installed function.'; END IF;
  EXECUTE replace(definition,old_rule,
    'IF supplier_payment.purchase_id IS NULL AND next_value > round(COALESCE(old_supplier.debt, 0)) + round(entry.value) THEN');
END $amend$;

INSERT INTO public.schema_migrations(version,description)
VALUES('0134','Allow purchase-linked overpayments and retain supplier advances');
NOTIFY pgrst,'reload schema';
COMMIT;
