BEGIN;

-- Migration 0060: Customer receipt records actual category and preserves user note
-- Allow customer receipts to record their chosen category (such as 'Thu tiền phạt',
-- 'Thu Hộ trợ vận chuyển cho khách', 'Thu chênh lệch', etc.) instead of hardcoding
-- 'Thu tiền khách hàng', and preserve user notes without forcing default strings.

DROP FUNCTION IF EXISTS public.rpc_record_customer_receipt(text, numeric, text, text, text);

CREATE OR REPLACE FUNCTION public.rpc_record_customer_receipt(
  p_customer_id text,
  p_amount numeric,
  p_notes text,
  p_payment_method text,
  p_idempotency_key text,
  p_category text DEFAULT 'Thu tiền khách hàng'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  existing_entry public.cashbook_transactions%ROWTYPE;
  request_hash text;
  cashbook_id text;
  payment_id text;
  ledger_id text;
  new_balance numeric;
  normalized_method text := lower(COALESCE(NULLIF(p_payment_method, ''), 'cash'));
  resolved_category text := COALESCE(NULLIF(btrim(p_category), ''), 'Thu tiền khách hàng');
  clean_notes text := NULLIF(btrim(p_notes), '');
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF p_customer_id IS NULL OR p_customer_id = '' OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Customer and a positive receipt amount are required';
  END IF;
  IF normalized_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Payment method must be cash, bank or wallet';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8
     OR length(p_idempotency_key) > 128 THEN
    RAISE EXCEPTION 'A stable receipt idempotency key (8..128 chars) is required';
  END IF;

  request_hash := md5(jsonb_build_object(
    'customerId', p_customer_id, 'amount', round(p_amount),
    'notes', COALESCE(clean_notes, ''), 'paymentMethod', normalized_method,
    'category', resolved_category
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || p_idempotency_key, 0));

  SELECT * INTO existing_entry
  FROM public.cashbook_transactions
  WHERE created_by = actor.auth_user_id::text
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing_entry.request_fingerprint <> request_hash
       OR existing_entry.transaction_type <> 'customer_payment' THEN
      RAISE EXCEPTION '409: idempotency key was already used with a different receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.p2_cashbook_response(existing_entry.id) || jsonb_build_object(
      'already_recorded', true,
      'new_debt', (SELECT balance_after FROM public.customer_debt_transactions
        WHERE cashbook_transaction_id = existing_entry.id AND transaction_type = 'payment'
        ORDER BY transaction_date LIMIT 1),
      'customer_credit', GREATEST(-COALESCE((SELECT balance_after
        FROM public.customer_debt_transactions
        WHERE cashbook_transaction_id = existing_entry.id AND transaction_type = 'payment'
        ORDER BY transaction_date LIMIT 1), 0), 0)
    );
  END IF;

  SELECT * INTO STRICT customer_row
  FROM public.customers
  WHERE id = p_customer_id
    AND COALESCE(status, 'active') = 'active'
    AND deleted_at IS NULL
  FOR UPDATE;

  cashbook_id := 'PT-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
    lpad(nextval('public.cashbook_display_seq')::text, 8, '0');
  payment_id := 'PAY-' || gen_random_uuid()::text;
  ledger_id := 'DTX-PAY-' || gen_random_uuid()::text;
  new_balance := round(COALESCE(customer_row.debt, 0)) - round(p_amount);

  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, customer_id, value, method, payment_method, accounting, status,
    creator, created_by, note, starred, idempotency_key, request_fingerprint
  ) VALUES (
    cashbook_id, now(), now(), 'thu', 'customer_payment', 'in', resolved_category,
    customer_row.name, customer_row.id, round(p_amount), normalized_method,
    normalized_method, true, 'completed', actor.display_name, actor.auth_user_id::text,
    clean_notes, false, p_idempotency_key, request_hash
  );

  INSERT INTO public.payments(
    id, customer_id, amount, payment_method, status, cashbook_transaction_id,
    idempotency_key, request_fingerprint, created_by, created_at
  ) VALUES (
    payment_id, customer_row.id, round(p_amount), normalized_method, 'completed',
    cashbook_id, p_idempotency_key, request_hash, actor.auth_user_id::text, now()
  );

  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, cashbook_transaction_id, description, idempotency_key,
    created_by, transaction_date
  ) VALUES (
    ledger_id, customer_row.id, 'payment', round(p_amount), -round(p_amount),
    round(COALESCE(customer_row.debt, 0)), new_balance, cashbook_id,
    COALESCE(clean_notes, resolved_category), p_idempotency_key,
    actor.auth_user_id::text, now()
  );

  UPDATE public.customers
  SET debt = new_balance,
      last_payment_at = now(),
      updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = customer_row.id;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, new_data, performed_by, created_at
  ) VALUES (
    'cashbook_transactions', 'CUSTOMER_RECEIPT', cashbook_id,
    jsonb_build_object(
      'cashbook_id', cashbook_id,
      'customer_id', customer_row.id,
      'amount', round(p_amount),
      'balance_before', round(COALESCE(customer_row.debt, 0)),
      'balance_after', new_balance,
      'payment_method', normalized_method,
      'category', resolved_category,
      'notes', clean_notes
    ),
    actor.auth_user_id::text, now()
  );

  RETURN public.p2_cashbook_response(cashbook_id) || jsonb_build_object(
    'new_debt', new_balance,
    'customer_credit', GREATEST(-new_balance, 0),
    'cashbook_id', cashbook_id,
    'payment_id', payment_id,
    'ledger_id', ledger_id
  );
END;
$$;

-- 5-parameter backward compatibility wrapper:
CREATE OR REPLACE FUNCTION public.rpc_record_customer_receipt(
  p_customer_id text,
  p_amount numeric,
  p_notes text,
  p_payment_method text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN public.rpc_record_customer_receipt(
    p_customer_id, p_amount, p_notes, p_payment_method, p_idempotency_key, 'Thu tiền khách hàng'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_record_customer_receipt(text, numeric, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_customer_receipt(text, numeric, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_record_customer_receipt(text, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_customer_receipt(text, numeric, text, text, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0060', 'Customer receipt records actual category and preserves note')
ON CONFLICT (version) DO NOTHING;

COMMIT;
