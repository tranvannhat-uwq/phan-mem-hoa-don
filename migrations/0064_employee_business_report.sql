BEGIN;

-- Read-only, server-authoritative employee business report.  This migration
-- deliberately adds no trigger and does not change any operational records.
CREATE OR REPLACE FUNCTION public.rpc_get_employee_business_report(p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  start_at timestamptz;
  end_at timestamptz;
  requested_employee text := NULLIF(btrim(COALESCE(p_input->>'employee_id', '')), '');
  requested_company text := NULLIF(btrim(COALESCE(p_input->>'company_id', '')), '');
  page_limit integer := LEAST(GREATEST(COALESCE(NULLIF(p_input->>'limit', '')::integer, 25), 1), 100);
  page_offset integer := GREATEST(COALESCE(NULLIF(p_input->>'offset', '')::integer, 0), 0);
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  start_at := COALESCE(NULLIF(p_input->>'start', '')::timestamptz,
    date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh');
  end_at := COALESCE(NULLIF(p_input->>'end', '')::timestamptz, now());
  IF end_at <= start_at OR end_at - start_at > interval '366 days' THEN
    RAISE EXCEPTION 'Invalid reporting date range' USING ERRCODE = '22023';
  END IF;
  IF requested_employee = 'all' THEN requested_employee := NULL; END IF;
  IF requested_company = 'all' THEN requested_company := NULL; END IF;

  -- A Sale can only ever request their own report.  The canonical profile id
  -- avoids trusting a browser-provided username or role.
  IF actor.role = 'sale' THEN
    requested_employee := actor.id;
  ELSIF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION 'Insufficient permission' USING ERRCODE = '42501';
  END IF;

  WITH authorized_orders AS (
    SELECT sale.*, COALESCE(owner.id, NULLIF(sale.salesperson_id, ''), NULLIF(sale.created_by, ''), 'unassigned') AS employee_id,
      COALESCE(owner.display_name, NULLIF(sale.salesperson_id, ''), NULLIF(sale.created_by, ''), 'Chưa phân công') AS employee_name
    FROM public.orders sale
    LEFT JOIN LATERAL (
      SELECT profile.id, profile.display_name
      FROM public.profiles profile
      WHERE profile.id IN (sale.salesperson_id, sale.created_by)
         OR profile.username IN (sale.salesperson_id, sale.created_by)
         OR profile.auth_user_id::text IN (sale.salesperson_id, sale.created_by)
      ORDER BY CASE WHEN profile.id = sale.salesperson_id THEN 0 ELSE 1 END, profile.id
      LIMIT 1
    ) owner ON true
    WHERE sale.status NOT IN ('cancelled', 'canceled', 'draft')
      AND (actor.role <> 'sale' OR sale.salesperson_id IN (actor.id, actor.username, actor.auth_user_id::text)
        OR sale.created_by IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (requested_company IS NULL OR sale.company_id = requested_company)
  ), visible_orders AS (
    SELECT * FROM authorized_orders sale
    WHERE COALESCE(sale.order_date, sale.created_at) >= start_at
      AND COALESCE(sale.order_date, sale.created_at) < end_at
      AND (requested_employee IS NULL OR sale.employee_id = requested_employee)
  ), return_rows AS (
    SELECT ret.*, sale.employee_id, sale.employee_name
    FROM public.sales_returns ret
    JOIN authorized_orders sale ON sale.id = ret.sale_id
    WHERE ret.status NOT IN ('cancelled', 'canceled')
      AND COALESCE(ret.return_date, ret.created_at) >= start_at
      AND COALESCE(ret.return_date, ret.created_at) < end_at
      AND (requested_employee IS NULL OR sale.employee_id = requested_employee)
  ), ledger_rows AS (
    SELECT ledger.*, COALESCE(owner.id, NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''), 'unassigned') AS employee_id,
      COALESCE(owner.display_name, NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''), 'Chưa phân công') AS employee_name
    FROM public.customer_debt_transactions ledger
    LEFT JOIN public.customer_debt_transactions reversed_source ON reversed_source.id = ledger.reversal_of_id
    LEFT JOIN LATERAL (
      SELECT profile.id, profile.display_name
      FROM public.profiles profile
      WHERE profile.id = COALESCE(NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''))
        OR profile.username = COALESCE(NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''))
        OR profile.auth_user_id::text = COALESCE(NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''))
      LIMIT 1
    ) owner ON true
    WHERE ledger.transaction_date >= start_at AND ledger.transaction_date < end_at
      AND NULLIF(COALESCE(ledger.employee_id, reversed_source.employee_id), '') IS NOT NULL
      AND (requested_company IS NULL OR EXISTS (
        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company
      ))
      AND (actor.role <> 'sale' OR COALESCE(ledger.employee_id, reversed_source.employee_id) IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (requested_employee IS NULL OR COALESCE(owner.id, ledger.employee_id, reversed_source.employee_id) = requested_employee)
  ), ledger_to_end AS (
    SELECT COALESCE(owner.id, NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''), 'unassigned') AS employee_id,
      sum(COALESCE(ledger.debt_change, 0)) AS debt_balance
    FROM public.customer_debt_transactions ledger
    LEFT JOIN public.customer_debt_transactions reversed_source ON reversed_source.id = ledger.reversal_of_id
    LEFT JOIN LATERAL (
      SELECT profile.id FROM public.profiles profile
      WHERE profile.id = COALESCE(NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''))
        OR profile.username = COALESCE(NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''))
        OR profile.auth_user_id::text = COALESCE(NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''))
      LIMIT 1
    ) owner ON true
    WHERE ledger.transaction_date < end_at AND NULLIF(COALESCE(ledger.employee_id, reversed_source.employee_id), '') IS NOT NULL
      AND (requested_company IS NULL OR EXISTS (
        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company
      ))
      AND (actor.role <> 'sale' OR COALESCE(ledger.employee_id, reversed_source.employee_id) IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (requested_employee IS NULL OR COALESCE(owner.id, ledger.employee_id, reversed_source.employee_id) = requested_employee)
    GROUP BY COALESCE(owner.id, NULLIF(ledger.employee_id, ''), NULLIF(reversed_source.employee_id, ''), 'unassigned')
  ), commission_rows AS (
    SELECT tx.employee_id, sum(COALESCE(tx.commission_amount, 0)) AS commission_amount
    FROM public.commission_transactions tx
    WHERE tx.status NOT IN ('cancelled', 'canceled')
      AND COALESCE(tx.calculated_at, tx.created_at) >= start_at
      AND COALESCE(tx.calculated_at, tx.created_at) < end_at
      AND (requested_company IS NULL OR EXISTS (
        SELECT 1 FROM public.orders sale WHERE sale.id = tx.order_id AND sale.company_id = requested_company
      ))
      AND (actor.role <> 'sale' OR tx.employee_id = actor.id)
      AND (requested_employee IS NULL OR tx.employee_id = requested_employee)
    GROUP BY tx.employee_id
  ), order_metrics AS (
    SELECT sale.employee_id, max(sale.employee_name) AS employee_name, count(*) AS order_count,
      COALESCE(sum((SELECT sum(GREATEST(COALESCE(item.quantity, 0) - COALESCE(item.returned_quantity, 0), 0)) FROM public.order_items item WHERE item.order_id = sale.id)), 0) AS sold_quantity,
      sum(COALESCE(NULLIF(sale.subtotal, 0), NULLIF(sale.total_market, 0), sale.total_payable, 0)) AS gross_sales,
      sum(COALESCE(NULLIF(sale.discount_amount, 0), sale.total_discount, 0)) AS discount_amount,
      sum(COALESCE(NULLIF(sale.net_revenue, 0), sale.total_payable, 0)) AS net_sales
    FROM visible_orders sale GROUP BY sale.employee_id
  ), return_metrics AS (
    SELECT employee_id, max(employee_name) AS employee_name, count(*) AS return_count,
      COALESCE(sum(COALESCE(NULLIF(total_refund, 0), total_return_amount, 0)), 0) AS return_amount,
      COALESCE(sum((SELECT sum(COALESCE(item.quantity, 0)) FROM public.sales_return_items item WHERE item.return_id = ret.id)), 0) AS return_quantity
    FROM return_rows ret GROUP BY employee_id
  ), ledger_metrics AS (
    SELECT employee_id, max(employee_name) AS employee_name,
      COALESCE(sum(GREATEST(COALESCE(debt_change, 0), 0)), 0) AS debt_increased,
      COALESCE(sum(GREATEST(-COALESCE(debt_change, 0), 0)), 0) AS debt_decreased,
      COALESCE(sum(CASE WHEN transaction_type IN ('payment', 'payment_amend') AND debt_change < 0
        AND reversal_of_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.customer_debt_transactions reversed WHERE reversed.reversal_of_id = ledger_rows.id)
        THEN -debt_change ELSE 0 END), 0) AS collected
    FROM ledger_rows GROUP BY employee_id
  ), kpi_metrics AS (
    SELECT target.employee_id, sum(target.target_amount) FILTER (WHERE target.target_type = 'net_sales') AS kpi_target
    FROM public.kpi_targets target
    WHERE target.period BETWEEN to_char(start_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM')
      AND to_char((end_at - interval '1 second') AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM')
      AND (actor.role <> 'sale' OR target.employee_id = actor.id)
      AND (requested_employee IS NULL OR target.employee_id = requested_employee)
    GROUP BY target.employee_id
  ), employee_keys AS (
    SELECT employee_id FROM order_metrics UNION SELECT employee_id FROM return_metrics
    UNION SELECT employee_id FROM ledger_metrics UNION SELECT employee_id FROM commission_rows
    UNION SELECT employee_id FROM kpi_metrics UNION SELECT employee_id FROM ledger_to_end
  ), row_data AS (
    SELECT keys.employee_id,
      COALESCE(profile.display_name, orders.employee_name, returns.employee_name, ledgers.employee_name, keys.employee_id, 'Chưa phân công') AS employee_name,
      COALESCE(profile.username, keys.employee_id) AS employee_code,
      COALESCE(orders.order_count, 0) AS order_count, COALESCE(orders.sold_quantity, 0) AS sold_quantity,
      COALESCE(orders.gross_sales, 0) AS gross_sales, COALESCE(orders.discount_amount, 0) AS discount_amount,
      COALESCE(orders.net_sales, 0) AS net_sales, COALESCE(returns.return_count, 0) AS return_count,
      COALESCE(returns.return_quantity, 0) AS return_quantity, COALESCE(returns.return_amount, 0) AS return_amount,
      COALESCE(ledgers.collected, 0) AS collected, COALESCE(ledgers.debt_increased, 0) AS debt_increased,
      COALESCE(ledgers.debt_decreased, 0) AS debt_decreased, COALESCE(balance.debt_balance, 0) AS debt_balance,
      COALESCE(commission.commission_amount, 0) AS commission_amount, COALESCE(kpi.kpi_target, 0) AS kpi_target,
      CASE WHEN COALESCE(kpi.kpi_target, 0) > 0 THEN round(COALESCE(orders.net_sales, 0) * 100 / kpi.kpi_target, 2) ELSE NULL END AS kpi_completion_percent
    FROM employee_keys keys
    LEFT JOIN public.profiles profile ON profile.id = keys.employee_id
    LEFT JOIN order_metrics orders ON orders.employee_id = keys.employee_id
    LEFT JOIN return_metrics returns ON returns.employee_id = keys.employee_id
    LEFT JOIN ledger_metrics ledgers ON ledgers.employee_id = keys.employee_id
    LEFT JOIN ledger_to_end balance ON balance.employee_id = keys.employee_id
    LEFT JOIN commission_rows commission ON commission.employee_id = keys.employee_id
    LEFT JOIN kpi_metrics kpi ON kpi.employee_id = keys.employee_id
  ), paged_rows AS (
    SELECT * FROM row_data ORDER BY net_sales DESC, employee_name, employee_id LIMIT page_limit OFFSET page_offset
  ), series AS (
    SELECT day_key, sum(gross_sales) AS gross_sales, sum(net_sales) AS net_sales,
      sum(return_amount) AS return_amount, sum(collected) AS collected, sum(order_count) AS order_count
    FROM (
      SELECT to_char(COALESCE(order_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day_key,
        COALESCE(NULLIF(subtotal, 0), NULLIF(total_market, 0), total_payable, 0) AS gross_sales,
        COALESCE(NULLIF(net_revenue, 0), total_payable, 0) AS net_sales, 0::numeric AS return_amount,
        0::numeric AS collected, 1::numeric AS order_count FROM visible_orders
      UNION ALL
      SELECT to_char(COALESCE(return_date, created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'), 0, 0,
        COALESCE(NULLIF(total_refund, 0), total_return_amount, 0), 0, 0 FROM return_rows
      UNION ALL
      SELECT to_char(transaction_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'), 0, 0, 0,
        CASE WHEN transaction_type IN ('payment', 'payment_amend') AND debt_change < 0 AND reversal_of_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.customer_debt_transactions reversed WHERE reversed.reversal_of_id = ledger_rows.id)
          THEN -debt_change ELSE 0 END, 0 FROM ledger_rows
    ) movements GROUP BY day_key
  ), detail_rows AS (
    SELECT COALESCE(order_date, created_at) AS document_date, 'Đơn hàng'::text AS document_type, id AS document_id,
      customer_name AS description, COALESCE(NULLIF(net_revenue, 0), total_payable, 0) AS amount, 'order'::text AS source
    FROM visible_orders WHERE requested_employee IS NOT NULL
    UNION ALL
    SELECT COALESCE(return_date, created_at), 'Trả hàng', id, COALESCE(reason, sale_id),
      COALESCE(NULLIF(total_refund, 0), total_return_amount, 0), 'return' FROM return_rows WHERE requested_employee IS NOT NULL
    UNION ALL
    SELECT transaction_date, CASE WHEN debt_change < 0 THEN 'Thu nợ' ELSE 'Biến động công nợ' END, id,
      COALESCE(description, transaction_type), debt_change, 'debt' FROM ledger_rows WHERE requested_employee IS NOT NULL
  ), paged_details AS (
    SELECT * FROM detail_rows ORDER BY document_date DESC, document_id DESC LIMIT 100
  )
  SELECT jsonb_build_object(
    'metadata', jsonb_build_object('start', start_at, 'end', end_at, 'timezone', 'Asia/Ho_Chi_Minh',
      'employee_id', requested_employee, 'company_id', requested_company, 'limit', page_limit, 'offset', page_offset),
    'total', (SELECT count(*) FROM row_data),
    'summary', jsonb_build_object('order_count', COALESCE((SELECT sum(order_count) FROM row_data), 0),
      'sold_quantity', COALESCE((SELECT sum(sold_quantity) FROM row_data), 0), 'gross_sales', COALESCE((SELECT sum(gross_sales) FROM row_data), 0),
      'discount_amount', COALESCE((SELECT sum(discount_amount) FROM row_data), 0), 'net_sales', COALESCE((SELECT sum(net_sales) FROM row_data), 0),
      'return_amount', COALESCE((SELECT sum(return_amount) FROM row_data), 0), 'collected', COALESCE((SELECT sum(collected) FROM row_data), 0),
      'debt_increased', COALESCE((SELECT sum(debt_increased) FROM row_data), 0), 'debt_decreased', COALESCE((SELECT sum(debt_decreased) FROM row_data), 0),
      'debt_balance', COALESCE((SELECT sum(debt_balance) FROM row_data), 0), 'commission_amount', COALESCE((SELECT sum(commission_amount) FROM row_data), 0)),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(row)) FROM paged_rows row), '[]'::jsonb),
    'series', COALESCE((SELECT jsonb_agg(jsonb_build_object('date', day_key, 'gross_sales', gross_sales, 'net_sales', net_sales,
      'return_amount', return_amount, 'collected', collected, 'order_count', order_count) ORDER BY day_key) FROM series), '[]'::jsonb),
    'details', COALESCE((SELECT jsonb_agg(to_jsonb(detail)) FROM paged_details detail), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE INDEX IF NOT EXISTS employee_report_orders_date_company_idx
  ON public.orders(order_date, company_id);
CREATE INDEX IF NOT EXISTS employee_report_returns_date_sale_idx
  ON public.sales_returns(return_date, sale_id);
CREATE INDEX IF NOT EXISTS employee_report_debt_date_employee_idx
  ON public.customer_debt_transactions(transaction_date, employee_id);
CREATE INDEX IF NOT EXISTS employee_report_commission_date_employee_idx
  ON public.commission_transactions(calculated_at, employee_id);

REVOKE ALL ON FUNCTION public.rpc_get_employee_business_report(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_employee_business_report(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0064', 'Read-only, server-authoritative employee business report')
ON CONFLICT (version) DO NOTHING;

COMMIT;
