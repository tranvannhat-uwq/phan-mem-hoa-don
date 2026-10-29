BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0133') THEN
    RAISE EXCEPTION 'Migration 0136 requires migration 0133.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0136') THEN
    RAISE EXCEPTION 'Migration 0136 is already recorded.';
  END IF;
END
$migration$;

-- Preserve existing invoices and older clients: their discount was before VAT.
ALTER TABLE public.purchases ADD COLUMN discount_timing text NOT NULL DEFAULT 'before_vat';
ALTER TABLE public.purchases ADD CONSTRAINT purchases_discount_timing_check
  CHECK (discount_timing IN ('before_vat','after_vat'));
ALTER TABLE public.purchases DROP CONSTRAINT purchases_vat_amounts_check;
ALTER TABLE public.purchases DROP CONSTRAINT purchases_discount_values_check;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_discount_values_check CHECK (
  discount_type IN ('percent', 'amount')
  AND discount_value >= 0 AND discount_amount >= 0
  AND discount_amount <= subtotal_amount + CASE WHEN discount_timing='after_vat' THEN vat_amount ELSE 0 END
  AND (
    (discount_type = 'percent' AND discount_value <= 100
      AND discount_value = round(discount_value, 2)
      AND discount_amount = round((subtotal_amount + CASE WHEN discount_timing='after_vat' THEN vat_amount ELSE 0 END) * discount_value / 100))
    OR (discount_type = 'amount' AND discount_value = round(discount_value)
      AND discount_amount = discount_value)
  )
);
ALTER TABLE public.purchases ADD CONSTRAINT purchases_vat_amounts_check CHECK (
  subtotal_amount >= 0 AND vat_rate BETWEEN 0 AND 100
  AND vat_amount = round((subtotal_amount - CASE WHEN discount_timing='before_vat' THEN discount_amount ELSE 0 END) * vat_rate / 100)
  AND total_amount = subtotal_amount - discount_amount + vat_amount
);

CREATE OR REPLACE FUNCTION public.p4_purchase_response(p_purchase_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'success', true,
    'purchase', jsonb_build_object(
      'id', purchase.id, 'code', purchase.code,
      'supplierId', purchase.supplier_id, 'supplierName', supplier.name,
      'supplierCode', supplier.code, 'invoiceNumber', purchase.invoice_number,
      'purchaseDate', purchase.purchase_date, 'status', purchase.status,
      'subtotalAmount', purchase.subtotal_amount, 'discountType', purchase.discount_type,
      'discountValue', purchase.discount_value, 'discountAmount', purchase.discount_amount,
      'discountTiming', purchase.discount_timing,
      'vatRate', purchase.vat_rate,
      'vatAmount', purchase.vat_amount, 'totalAmount', purchase.total_amount, 'paidAmount', purchase.paid_amount,
      'balanceDue', purchase.balance_due, 'paymentMethod', purchase.payment_method,
      'notes', purchase.notes, 'createdBy', purchase.created_by,
      'cancelledBy', purchase.cancelled_by, 'cancelledAt', purchase.cancelled_at,
      'cancellationReason', purchase.cancellation_reason,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', item.id, 'lineNumber', item.line_number, 'code', item.item_code,
          'name', item.item_name, 'unit', item.unit, 'quantity', item.quantity,
          'unitPrice', item.unit_price, 'lineTotal', item.line_total
        ) ORDER BY item.line_number)
        FROM public.purchase_items item WHERE item.purchase_id = purchase.id
      ), '[]'::jsonb),
      'payments', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', payment.id, 'amount', payment.amount,
          'paymentMethod', payment.payment_method,
          'cashbookTransactionId', payment.cashbook_transaction_id,
          'status', payment.status, 'notes', payment.notes,
          'createdBy', payment.created_by, 'createdAt', payment.created_at,
          'cancelledAt', payment.cancelled_at,
          'cancellationReason', payment.cancellation_reason
        ) ORDER BY payment.created_at)
        FROM public.purchase_payments payment WHERE payment.purchase_id = purchase.id
      ), '[]'::jsonb)
    )
  )
  FROM public.purchases purchase
  JOIN public.suppliers supplier ON supplier.id = purchase.supplier_id
  WHERE purchase.id = p_purchase_id
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_purchase(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  supplier_row public.suppliers%ROWTYPE;
  existing_purchase public.purchases%ROWTYPE;
  purchase_id text;
  purchase_code text;
  purchase_key text := NULLIF(btrim(p_input->>'idempotencyKey'), '');
  purchase_method text := lower(COALESCE(NULLIF(p_input->>'paymentMethod', ''), 'cash'));
  purchase_date_value timestamptz;
  normalized_items jsonb;
  request_hash text;
  total_value numeric;
  subtotal_value numeric;
  vat_value numeric;
  vat_rate_text text := COALESCE(NULLIF(p_input->>'vatRate', ''), '0');
  vat_rate_value numeric;
  discount_type_text text := COALESCE(NULLIF(p_input->>'discountType', ''), 'amount');
  discount_value_text text := COALESCE(NULLIF(p_input->>'discountValue', ''), '0');
  discount_type_value text;
  discount_value numeric;
  discount_amount_value numeric := 0;
  discount_timing_value text := COALESCE(NULLIF(p_input->>'discountTiming',''),'before_vat');
  discount_base_value numeric;
  initial_paid numeric := round(COALESCE(NULLIF(p_input->>'paidAmount', '')::numeric, 0));
  payment_id text;
  cashbook_id text;
  ledger_id text;
  running_balance numeric;
  item_record record;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF vat_rate_text !~ '^[0-9]{1,3}([.][0-9]{1,2})?$' THEN
    RAISE EXCEPTION 'VAT phải là số từ 0 đến 100, tối đa 2 chữ số thập phân.';
  END IF;
  vat_rate_value := round(vat_rate_text::numeric, 2);
  IF vat_rate_value > 100 THEN
    RAISE EXCEPTION 'VAT phải là số từ 0 đến 100, tối đa 2 chữ số thập phân.';
  END IF;
  IF discount_type_text NOT IN ('percent', 'amount') THEN
    RAISE EXCEPTION 'Loại giảm giá phải là phần trăm hoặc VNĐ.';
  END IF;
  IF discount_timing_value NOT IN ('before_vat','after_vat') THEN
    RAISE EXCEPTION 'Chọn giảm giá trước VAT hoặc sau VAT.';
  END IF;
  IF discount_type_text = 'percent' THEN
    IF discount_value_text !~ '^[0-9]+([.][0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'Giảm giá theo %% phải từ 0 đến 100, tối đa 2 chữ số thập phân.';
    END IF;
    discount_value := round(discount_value_text::numeric, 2);
    IF discount_value > 100 THEN
      RAISE EXCEPTION 'Giảm giá theo %% phải từ 0 đến 100, tối đa 2 chữ số thập phân.';
    END IF;
  ELSE
    IF discount_value_text !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Giảm giá VNĐ phải là số nguyên không âm.';
    END IF;
    discount_value := discount_value_text::numeric;
  END IF;
  discount_type_value := discount_type_text;
  IF purchase_key IS NULL OR length(purchase_key) < 8 OR length(purchase_key) > 128 THEN
    RAISE EXCEPTION 'A stable purchase idempotency key (8..128 chars) is required';
  END IF;
  IF purchase_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Payment method must be cash, bank or wallet';
  END IF;
  IF NULLIF(p_input->>'paidAmount', '') IS NOT NULL
     AND (p_input->>'paidAmount') !~ '^[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Initial payment must be a finite nonnegative number';
  END IF;
  IF jsonb_typeof(COALESCE(p_input->'items', '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(p_input->'items', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_input->'items', '[]'::jsonb)) > 100 THEN
    RAISE EXCEPTION 'Purchase requires 1..100 item rows';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_input->'items') item
    WHERE NULLIF(btrim(item->>'code'), '') IS NULL
       OR NULLIF(btrim(item->>'name'), '') IS NULL
       OR COALESCE(item->>'quantity', '') !~ '^[0-9]+([.][0-9]+)?$'
       OR COALESCE(item->>'unitPrice', '') !~ '^[0-9]+([.][0-9]+)?$'
       OR COALESCE(NULLIF(item->>'quantity', '')::numeric, 0) <= 0
       OR COALESCE(NULLIF(item->>'unitPrice', '')::numeric, -1) < 0
  ) THEN RAISE EXCEPTION 'Every purchase row requires code, name, positive quantity and nonnegative unit price'; END IF;

  SELECT jsonb_agg(jsonb_build_object(
      'code', upper(btrim(item->>'code')), 'name', btrim(item->>'name'),
      'unit', COALESCE(btrim(item->>'unit'), ''),
      'quantity', (item->>'quantity')::numeric,
      'unitPrice', round((item->>'unitPrice')::numeric)
    ) ORDER BY ordinal),
    sum(round((item->>'quantity')::numeric * round((item->>'unitPrice')::numeric)))
  INTO normalized_items, total_value
  FROM jsonb_array_elements(p_input->'items') WITH ORDINALITY payload(item, ordinal);

  subtotal_value := total_value;
  vat_value := round(subtotal_value * vat_rate_value / 100);
  discount_base_value := subtotal_value + CASE WHEN discount_timing_value='after_vat' THEN vat_value ELSE 0 END;
  IF discount_type_value = 'amount' AND discount_value > discount_base_value THEN
    RAISE EXCEPTION 'Giảm giá VNĐ không được vượt quá số tiền được giảm.';
  END IF;
  discount_amount_value := CASE WHEN discount_type_value = 'percent'
    THEN round(discount_base_value * discount_value / 100) ELSE discount_value END;
  IF discount_timing_value='before_vat' THEN
    vat_value := round((subtotal_value - discount_amount_value) * vat_rate_value / 100);
  END IF;
  total_value := subtotal_value - discount_amount_value + vat_value;
  IF initial_paid < 0 OR initial_paid > total_value THEN
    RAISE EXCEPTION 'Initial payment must be between zero and the database-calculated purchase total';
  END IF;
  purchase_date_value := COALESCE(NULLIF(p_input->>'purchaseDate', '')::timestamptz, now());
  request_hash := md5(jsonb_build_object(
    'supplierId', p_input->>'supplierId', 'invoiceNumber', COALESCE(p_input->>'invoiceNumber', ''),
    'purchaseDate', purchase_date_value, 'paidAmount', initial_paid,
    'paymentMethod', purchase_method, 'notes', COALESCE(p_input->>'notes', ''),
    'items', normalized_items
  )::text);

  -- Preserve fingerprints for VAT-free requests recorded before this upgrade.
  IF vat_rate_value <> 0 THEN
    request_hash := md5(request_hash || ':vat:' || vat_rate_value::text);
  END IF;
  -- Keep zero-discount fingerprints compatible with existing purchase retries.
  IF discount_value <> 0 THEN
    request_hash := md5(request_hash || ':discount:' || discount_type_value || ':' || discount_value::text);
    IF discount_timing_value='after_vat' THEN
      request_hash := md5(request_hash || ':discount-timing:after_vat');
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || purchase_key, 0));
  SELECT * INTO existing_purchase FROM public.purchases
  WHERE created_by = actor.auth_user_id::text AND idempotency_key = purchase_key;
  IF FOUND THEN
    IF existing_purchase.request_fingerprint <> request_hash THEN
      RAISE EXCEPTION '409: idempotency key was already used with a different purchase payload' USING ERRCODE = '23505';
    END IF;
    RETURN public.p4_purchase_response(existing_purchase.id)
      || public.p4_supplier_response(existing_purchase.supplier_id)
      || jsonb_build_object('already_recorded', true);
  END IF;

  SELECT * INTO STRICT supplier_row FROM public.suppliers
  WHERE id = p_input->>'supplierId' FOR UPDATE;
  IF supplier_row.is_active = false THEN RAISE EXCEPTION 'Supplier is inactive'; END IF;

  purchase_id := 'PUR-' || replace(gen_random_uuid()::text, '-', '');
  purchase_code := 'PM-' || to_char(purchase_date_value, 'YYYYMMDD') || '-' ||
    lpad(nextval('public.purchase_display_seq')::text, 8, '0');
  INSERT INTO public.purchases(
    id, code, supplier_id, invoice_number, purchase_date, status,
    total_amount, subtotal_amount, discount_type, discount_value, discount_amount, discount_timing,
    vat_rate, vat_amount, paid_amount, balance_due, payment_method, notes,
    idempotency_key, request_fingerprint, created_by, updated_by
  ) VALUES (
    purchase_id, purchase_code, supplier_row.id, NULLIF(btrim(p_input->>'invoiceNumber'), ''),
    purchase_date_value, 'completed', total_value, subtotal_value, discount_type_value,
    discount_value, discount_amount_value, discount_timing_value, vat_rate_value, vat_value, initial_paid,
    total_value - initial_paid, purchase_method, COALESCE(p_input->>'notes', ''),
    purchase_key, request_hash, actor.auth_user_id::text, actor.auth_user_id::text
  );

  FOR item_record IN
    SELECT item, ordinal FROM jsonb_array_elements(normalized_items) WITH ORDINALITY payload(item, ordinal)
  LOOP
    INSERT INTO public.purchase_items(
      id, purchase_id, line_number, item_code, item_name, unit,
      quantity, unit_price, line_total
    ) VALUES (
      'PIT-' || replace(gen_random_uuid()::text, '-', ''), purchase_id, item_record.ordinal,
      item_record.item->>'code', item_record.item->>'name', item_record.item->>'unit',
      (item_record.item->>'quantity')::numeric, (item_record.item->>'unitPrice')::numeric,
      round((item_record.item->>'quantity')::numeric * (item_record.item->>'unitPrice')::numeric)
    );
  END LOOP;

  running_balance := supplier_row.debt + total_value;
  ledger_id := 'SDL-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.supplier_debt_transactions(
    id, supplier_id, purchase_id, transaction_type, amount_change,
    balance_after, idempotency_key, notes, created_by, transaction_date
  ) VALUES (
    ledger_id, supplier_row.id, purchase_id, 'purchase', total_value,
    running_balance, purchase_key || ':purchase', 'Ghi nhận ' || purchase_code,
    actor.auth_user_id::text, purchase_date_value
  );

  IF initial_paid > 0 THEN
    payment_id := 'SPAY-' || replace(gen_random_uuid()::text, '-', '');
    cashbook_id := 'PC-NCC-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.purchase_payments(
      id, purchase_id, supplier_id, amount, payment_method,
      cashbook_transaction_id, status, notes, idempotency_key,
      request_fingerprint, created_by, created_at
    ) VALUES (
      payment_id, purchase_id, supplier_row.id, initial_paid, purchase_method,
      cashbook_id, 'completed', 'Thanh toán khi lập ' || purchase_code,
      purchase_key || ':initial-payment', request_hash, actor.auth_user_id::text, purchase_date_value
    );
    running_balance := running_balance - initial_paid;
    INSERT INTO public.supplier_debt_transactions(
      id, supplier_id, purchase_id, payment_id, transaction_type,
      amount_change, balance_after, idempotency_key, notes, created_by, transaction_date
    ) VALUES (
      'SDL-' || replace(gen_random_uuid()::text, '-', ''), supplier_row.id, purchase_id,
      payment_id, 'supplier_payment', -initial_paid, running_balance,
      purchase_key || ':initial-payment', 'Thanh toán ' || purchase_code,
      actor.auth_user_id::text, purchase_date_value
    );
    INSERT INTO public.cashbook_transactions(
      id, date, transaction_date, type, transaction_type, direction, category,
      partner, supplier_id, purchase_id, purchase_payment_id, value,
      method, payment_method, accounting, status, creator, created_by,
      note, starred, idempotency_key, request_fingerprint, external_reference
    ) VALUES (
      cashbook_id, purchase_date_value, purchase_date_value, 'chi', 'supplier_payment', 'out',
      'Thanh toán nhà cung cấp', supplier_row.name, supplier_row.id, purchase_id,
      payment_id, initial_paid, purchase_method, purchase_method, true, 'completed',
      actor.display_name, actor.auth_user_id::text, 'Thanh toán ' || purchase_code,
      false, purchase_key || ':supplier-cashbook', request_hash, purchase_code
    );
  END IF;

  PERFORM public.p4_recompute_purchase(purchase_id);
  PERFORM public.p4_recompute_supplier(supplier_row.id);
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('purchases', 'CREATE', purchase_id,
    jsonb_build_object('supplier_id', supplier_row.id, 'total_amount', total_value,
      'subtotal_amount', subtotal_value, 'discount_type', discount_type_value,
      'discount_value', discount_value, 'discount_amount', discount_amount_value,
      'discount_timing', discount_timing_value,
      'vat_rate', vat_rate_value, 'vat_amount', vat_value,
      'paid_amount', initial_paid, 'idempotency_key', purchase_key),
    actor.auth_user_id::text, now());
  RETURN public.p4_purchase_response(purchase_id)
    || public.p4_supplier_response(supplier_row.id)
    || jsonb_build_object(
    'already_recorded', false, 'performed_by', actor.auth_user_id::text
  );
END;
$$;

-- New clients use a versioned entry point so an older server cannot silently
-- ignore discount timing. The inner RPC enforces roles and idempotency.
CREATE OR REPLACE FUNCTION public.rpc_create_purchase_vat(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.rpc_create_purchase(p_input)
$$;
CREATE OR REPLACE FUNCTION public.rpc_create_purchase_discount(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.rpc_create_purchase(p_input)
$$;
CREATE FUNCTION public.rpc_create_purchase_tax_discount(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.rpc_create_purchase(p_input)
$$;
REVOKE ALL ON FUNCTION public.rpc_create_purchase_tax_discount(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_tax_discount(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_create_purchase_vat(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_vat(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_create_purchase_discount(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_discount(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.p4_purchase_response(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_create_purchase(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_purchase(jsonb) TO authenticated;
INSERT INTO public.schema_migrations(version, description)
VALUES ('0136', 'Purchase discounts before or after VAT to match supplier invoices');
NOTIFY pgrst,'reload schema';
COMMIT;
