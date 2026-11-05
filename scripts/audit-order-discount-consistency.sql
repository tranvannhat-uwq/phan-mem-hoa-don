-- Read-only production preflight. Retain the result locally before any repair.
-- A historical event snapshot may legitimately differ from today's order.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
WITH target AS (
  SELECT * FROM public.orders WHERE id = 'HD-20260927-00001974'
), target_customers AS (
  SELECT customer_id FROM target
  UNION SELECT customer_id FROM public.customer_debt_transactions
    WHERE order_id = 'HD-20260927-00001974'
), order_ledger AS (
  SELECT order_id, customer_id, round(sum(COALESCE(debt_change, 0))) AS order_debt,
    count(*) AS ledger_count
  FROM public.customer_debt_transactions
  WHERE transaction_type IN ('order', 'order_amend', 'order_cancel')
  GROUP BY order_id, customer_id
), mismatches AS (
  SELECT sale.id, sale.customer_id, sale.status, sale.subtotal,
    sale.discount_type, sale.discount_value, sale.discount_amount,
    sale.total_payable, sale.paid_amount, sale.shipping_fee_amount,
    sale.debt_amount, ledger.order_debt, ledger.ledger_count,
    (SELECT count(*) FROM public.order_amendments a WHERE a.order_id = sale.id) AS amendment_count,
    (SELECT count(*) FROM public.sales_returns r
      WHERE COALESCE(r.sale_id, r.order_id) = sale.id) AS return_count
  FROM public.orders sale
  JOIN order_ledger ledger ON ledger.order_id = sale.id AND ledger.customer_id = sale.customer_id
  WHERE sale.status = 'settled'
    AND round(COALESCE(sale.debt_amount, sale.total_payable + COALESCE(sale.shipping_fee_amount, 0)))
      IS DISTINCT FROM ledger.order_debt
)
SELECT jsonb_build_object(
  'captured_at', now(),
  'database', current_database(),
  'target_order', (SELECT to_jsonb(t) FROM target t),
  'target_amendments', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at, a.id), '[]')
    FROM public.order_amendments a WHERE a.order_id = 'HD-20260927-00001974'),
  'target_ledger', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at, d.id), '[]')
    FROM public.customer_debt_transactions d WHERE d.order_id = 'HD-20260927-00001974'),
  'target_customers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.code, 'name', c.name, 'debt', c.debt,
      'total_transaction', c.total_transaction, 'total_return', c.total_return,
      'net_revenue', c.net_revenue, 'updated_at', c.updated_at)), '[]')
    FROM public.customers c JOIN target_customers tc ON tc.customer_id = c.id),
  'target_audit', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at, a.id), '[]')
    FROM public.audit_logs a WHERE a.record_id = 'HD-20260927-00001974'),
  'target_returns', (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]')
    FROM public.sales_returns r WHERE COALESCE(r.sale_id, r.order_id) = 'HD-20260927-00001974'),
  'mismatched_order_debt_count', (SELECT count(*) FROM mismatches),
  'mismatched_order_debt', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]') FROM mismatches m),
  'migrations', (SELECT jsonb_agg(version ORDER BY version) FROM public.schema_migrations),
  'snapshot_function', pg_get_functiondef('public.rpc_get_customer_debt_order_event_snapshot(text)'::regprocedure)
) AS audit;
COMMIT;
