BEGIN;

-- An in-place order amendment posts only its delta. A cancellation must
-- reverse the original charge plus every delta owned by the current customer.
-- Receipts remain independent and active sales returns retain their own effect.
CREATE OR REPLACE FUNCTION public.rpc_cancel_order(p_order_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  sale public.orders%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  charge public.customer_debt_transactions%ROWTYPE;
  original_charge numeric := 0;
  amendment_change numeric := 0;
  active_return_value numeric := 0;
  return_debt_effect numeric := 0;
  remaining_charge numeric := 0;
  new_balance numeric;
  reversal_id text;
  commission_original public.commission_transactions%ROWTYPE;
  commission_remaining numeric;
  basis_remaining numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: Không đủ quyền hủy đơn' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Vui lòng nhập lý do hủy đơn';
  END IF;
  SELECT * INTO STRICT sale FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF sale.status IN ('cancelled', 'canceled') THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true,
      'order_id', sale.id, 'status', sale.status);
  END IF;
  IF sale.status NOT IN ('settled', 'partially_returned', 'returned') THEN
    RAISE EXCEPTION 'Chỉ có thể hủy đơn đã chốt';
  END IF;

  SELECT COALESCE(sum(COALESCE(NULLIF(r.total_refund, 0), r.total_return_amount, 0)), 0)
  INTO active_return_value FROM public.sales_returns r
  WHERE r.sale_id = sale.id AND r.status NOT IN ('cancelled', 'canceled');

  IF sale.customer_id IS NOT NULL THEN
    SELECT * INTO customer_row FROM public.customers
    WHERE id = sale.customer_id FOR UPDATE;
    IF customer_row.id IS NULL THEN
      RAISE EXCEPTION 'Đơn hàng thiếu hồ sơ khách hàng liên kết';
    END IF;
    SELECT * INTO charge FROM public.customer_debt_transactions d
    WHERE d.order_id = sale.id AND d.customer_id = sale.customer_id
      AND d.transaction_type = 'order'
      AND d.reversal_of_id IS NULL ORDER BY d.transaction_date LIMIT 1 FOR UPDATE;
    SELECT COALESCE(sum(d.debt_change), 0) INTO amendment_change
    FROM public.customer_debt_transactions d
    WHERE d.order_id = sale.id
      AND d.customer_id = sale.customer_id
      AND d.transaction_type = 'order_amend';
    original_charge := CASE WHEN charge.id IS NOT NULL THEN COALESCE(charge.debt_change, 0)
      WHEN EXISTS (SELECT 1 FROM public.customer_debt_transactions d
        WHERE d.order_id = sale.id AND d.customer_id = sale.customer_id
          AND d.transaction_type = 'order_amend') THEN 0
      ELSE COALESCE(NULLIF(sale.total_payable, 0), sale.total_amount, 0) END;
    SELECT COALESCE(sum(d.debt_change), 0) INTO return_debt_effect
    FROM public.customer_debt_transactions d
    WHERE d.order_id = sale.id AND d.customer_id = sale.customer_id
      AND d.transaction_type = 'return'
      AND NOT EXISTS (SELECT 1 FROM public.customer_debt_transactions x
        WHERE x.reversal_of_id = d.id);
    remaining_charge := GREATEST(0, original_charge + amendment_change + return_debt_effect);
    new_balance := COALESCE(customer_row.debt, 0) - remaining_charge;
    IF remaining_charge <> 0 THEN
      reversal_id := 'DTX-P13-ORDER-VOID-' || sale.id;
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, order_id, reversal_of_id,
        description, created_by, transaction_date
      ) VALUES (
        reversal_id, sale.customer_id, 'order_cancel', remaining_charge,
        -remaining_charge, customer_row.debt, new_balance, sale.id, charge.id,
        'Hủy đơn ' || sale.id || ': ' || btrim(p_reason),
        actor.auth_user_id::text, now()
      );
    END IF;
    UPDATE public.customers SET debt = new_balance,
      total_transaction = GREATEST(0, COALESCE(total_transaction, 0) - COALESCE(sale.total_payable, sale.total_amount, 0)),
      total_return = GREATEST(0, COALESCE(total_return, 0) - active_return_value),
      net_revenue = GREATEST(0, COALESCE(net_revenue, 0)
        - GREATEST(0, COALESCE(sale.total_payable, sale.total_amount, 0) - active_return_value)),
      updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = sale.customer_id;
  END IF;

  -- Reverse only the commission still active after any prior return reversals.
  FOR commission_original IN
    SELECT c.* FROM public.commission_transactions c
    WHERE c.order_id = sale.id
      AND c.transaction_type NOT IN ('order_cancel_reversal', 'sales_return_reversal', 'sales_return_cancel_reversal')
  LOOP
    SELECT COALESCE(commission_original.commission_amount, 0) + COALESCE(sum(c.commission_amount), 0),
           COALESCE(commission_original.basis_amount, 0) + COALESCE(sum(c.basis_amount), 0)
    INTO commission_remaining, basis_remaining
    FROM public.commission_transactions c
    WHERE c.order_id = sale.id
      AND c.transaction_type IN ('sales_return_reversal', 'sales_return_cancel_reversal')
      AND right(c.id, length(commission_original.id) + 1) = '-' || commission_original.id;
    IF commission_remaining <> 0 OR basis_remaining <> 0 THEN
      INSERT INTO public.commission_transactions(
        id, employee_id, salary_period, order_id, transaction_type,
        calculation_basis, basis_amount, commission_rate, commission_amount,
        rule_id, status, calculated_at, created_at
      ) VALUES (
        'COMM-P13-VOID-' || commission_original.id, commission_original.employee_id,
        commission_original.salary_period, sale.id, 'order_cancel_reversal',
        commission_original.calculation_basis, -basis_remaining,
        commission_original.commission_rate, -commission_remaining,
        commission_original.rule_id, commission_original.status, now(), now()
      ) ON CONFLICT (id) DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.orders SET status = 'cancelled', cancelled_at = now(),
    cancelled_by = actor.auth_user_id::text, cancellation_reason = btrim(p_reason),
    updated_at = now(), updated_by = actor.auth_user_id::text
  WHERE id = sale.id;
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('orders', 'CANCEL', sale.id, to_jsonb(sale),
    jsonb_build_object('status', 'cancelled', 'reason', btrim(p_reason),
      'debt_reversal_id', reversal_id, 'remaining_order_charge', remaining_charge,
      'amendment_debt_change', amendment_change,
      'customer_balance', new_balance, 'customer_credit', GREATEST(-COALESCE(new_balance, 0), 0),
      'independent_payments_preserved', true), actor.auth_user_id::text, now());
  RETURN jsonb_build_object('success', true, 'already_cancelled', false,
    'order_id', sale.id, 'status', 'cancelled', 'customer_id', sale.customer_id,
    'new_debt', new_balance, 'customer_credit', GREATEST(-COALESCE(new_balance, 0), 0),
    'debt_change', -remaining_charge, 'amendment_debt_change', amendment_change,
    'payments_preserved', true,
    'cancelled_by', actor.auth_user_id::text, 'cancellation_reason', btrim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cancel_order(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_order(text, text) TO authenticated;

-- The reported invoice was amended from 212,430 to 5,285,500 VND. Its old
-- cancellation reversed only 212,430, leaving the 5,073,070 amendment delta.
-- Append one compensating row; never rewrite the issued order or prior ledger.
-- The exact document, status and ledger lineage must match before any write.
DO $repair$
DECLARE
  incident_order public.orders%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  original_count bigint;
  original_change numeric;
  amendment_count bigint;
  amendment_change numeric;
  cancellation_count bigint;
  cancellation_change numeric;
  ledger_balance numeric;
  new_balance numeric;
  repair_id text := 'DTX-P83-ORDER-VOID-HD-20261005-00002274';
BEGIN
  SELECT * INTO incident_order FROM public.orders
  WHERE id = 'HD-20261005-00002274' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM public.customer_debt_transactions WHERE id = repair_id) THEN
    RETURN;
  END IF;
  IF incident_order.status NOT IN ('cancelled', 'canceled')
     OR incident_order.customer_id IS NULL
     OR round(COALESCE(incident_order.total_amount, 0)) <> 5285500
     OR round(COALESCE(incident_order.total_payable, 0)) <> 5285500
     OR round(COALESCE(incident_order.debt_before_snapshot, 0)) <> 15471992
     OR round(COALESCE(incident_order.debt_after_snapshot, 0)) <> 20757492
     OR EXISTS (SELECT 1 FROM public.sales_returns r
       WHERE r.sale_id = incident_order.id
         AND r.status NOT IN ('cancelled', 'canceled')) THEN
    RAISE EXCEPTION '0083 repair stopped: incident order does not match the reviewed invoice';
  END IF;

  SELECT count(*), round(COALESCE(sum(d.debt_change), 0))
  INTO original_count, original_change
  FROM public.customer_debt_transactions d
  WHERE d.order_id = incident_order.id
    AND d.customer_id = incident_order.customer_id
    AND d.transaction_type = 'order';
  SELECT count(*), round(COALESCE(sum(d.debt_change), 0))
  INTO amendment_count, amendment_change
  FROM public.customer_debt_transactions d
  WHERE d.order_id = incident_order.id
    AND d.customer_id = incident_order.customer_id
    AND d.transaction_type = 'order_amend';
  SELECT count(*), round(COALESCE(sum(d.debt_change), 0))
  INTO cancellation_count, cancellation_change
  FROM public.customer_debt_transactions d
  WHERE d.order_id = incident_order.id
    AND d.customer_id = incident_order.customer_id
    AND d.transaction_type = 'order_cancel';

  IF original_count <> 1 OR original_change <> 212430
     OR amendment_count < 1 OR amendment_change <> 5073070
     OR cancellation_count <> 1 OR cancellation_change <> -212430 THEN
    RAISE EXCEPTION '0083 repair stopped: incident ledger differs from reviewed amounts (original %, amendment %, cancellation %)',
      original_change, amendment_change, cancellation_change;
  END IF;

  SELECT * INTO STRICT customer_row FROM public.customers
  WHERE id = incident_order.customer_id FOR UPDATE;
  IF round(COALESCE(customer_row.debt, 0)) <> 20545062 THEN
    RAISE EXCEPTION '0083 repair stopped: customer balance changed since reviewed screenshot';
  END IF;
  SELECT state.calculated_balance INTO ledger_balance
  FROM public.p74_customer_debt_ledger_balance(customer_row.id) state;
  IF round(COALESCE(customer_row.debt, 0)) IS DISTINCT FROM ledger_balance THEN
    RAISE EXCEPTION '0083 repair stopped: customer balance already differs from ledger';
  END IF;

  new_balance := round(COALESCE(customer_row.debt, 0)) - amendment_change;
  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change,
    balance_before, balance_after, order_id, description,
    created_by, transaction_date
  ) VALUES (
    repair_id, customer_row.id, 'order_cancel', amendment_change,
    -amendment_change, round(COALESCE(customer_row.debt, 0)), new_balance,
    incident_order.id,
    'Bù đảo phần sửa đơn còn sót khi hủy ' || incident_order.id,
    'migration:0083', now()
  );
  UPDATE public.customers
  SET debt = new_balance, updated_at = now(), updated_by = 'migration:0083'
  WHERE id = customer_row.id;
  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'customers', 'RECONCILE_CANCELLED_AMENDED_ORDER', customer_row.id,
    jsonb_build_object('debt', customer_row.debt),
    jsonb_build_object('debt', new_balance, 'order_id', incident_order.id,
      'original_charge', original_change, 'amendment_change', amendment_change,
      'prior_cancellation', cancellation_change, 'repair_ledger_id', repair_id),
    'migration:0083', now()
  );
END;
$repair$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0083', 'Cancel amended orders using all order debt deltas and repair reviewed invoice HD-20261005-00002274')
ON CONFLICT (version) DO NOTHING;

COMMIT;
