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
  detail_limit integer := LEAST(GREATEST(COALESCE(NULLIF(p_input->>'detail_limit', '')::integer, 50), 1), 100);
  detail_offset integer := GREATEST(COALESCE(NULLIF(p_input->>'detail_offset', '')::integer, 0), 0);
  include_summary boolean := COALESCE(NULLIF(p_input->>'include_summary', '')::boolean, true);
  include_series boolean := COALESCE(NULLIF(p_input->>'include_series', '')::boolean, true);
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
    -- Attribution intentionally follows the salesperson managing the customer,
    -- matching the canonical dashboard rule in migration 0033.  The user who
    -- created or finalized an order is not the report owner.
    SELECT sale.*, COALESCE(owner.id, NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''), 'unassigned') AS employee_id,
      COALESCE(owner.display_name, NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''), 'Chưa phân công') AS employee_name
    FROM public.orders sale
    LEFT JOIN public.customers customer ON customer.id = sale.customer_id
    LEFT JOIN LATERAL (
      SELECT profile.id, profile.display_name
      FROM public.profiles profile
      WHERE profile.id = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''))
         OR profile.username = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''))
         OR profile.auth_user_id::text = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''))
      LIMIT 1
    ) owner ON true
    WHERE sale.status NOT IN ('cancelled', 'canceled', 'draft')
      AND (actor.role <> 'sale' OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''))
        IN (actor.id, actor.username, actor.auth_user_id::text))
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
    -- Debt movements use the same current customer-manager ownership as sales.
    SELECT ledger.*, COALESCE(owner.id, NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''), 'unassigned') AS report_employee_id,
      COALESCE(owner.display_name, NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''), 'Chưa phân công') AS report_employee_name
    FROM public.customer_debt_transactions ledger
    LEFT JOIN public.customers customer ON customer.id = ledger.customer_id
    LEFT JOIN public.orders origin_order ON origin_order.id = ledger.order_id
    LEFT JOIN LATERAL (
      SELECT profile.id, profile.display_name
      FROM public.profiles profile
      WHERE profile.id = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
        OR profile.username = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
        OR profile.auth_user_id::text = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
      LIMIT 1
    ) owner ON true
    WHERE ledger.transaction_date >= start_at AND ledger.transaction_date < end_at
      AND (requested_company IS NULL OR EXISTS (
        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company
      ))
      AND (actor.role <> 'sale' OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
        IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (requested_employee IS NULL OR COALESCE(owner.id, NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''), 'unassigned') = requested_employee)
  ), ledger_to_end AS (
    SELECT COALESCE(owner.id, NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''), 'unassigned') AS employee_id,
      sum(COALESCE(ledger.debt_change, 0)) AS debt_balance
    FROM public.customer_debt_transactions ledger
    LEFT JOIN public.customers customer ON customer.id = ledger.customer_id
    LEFT JOIN public.orders origin_order ON origin_order.id = ledger.order_id
    LEFT JOIN LATERAL (
      SELECT profile.id FROM public.profiles profile
      WHERE profile.id = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
        OR profile.username = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
        OR profile.auth_user_id::text = COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
      LIMIT 1
    ) owner ON true
    WHERE ledger.transaction_date < end_at
      AND (requested_company IS NULL OR EXISTS (
        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company
      ))
      AND (actor.role <> 'sale' OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''))
        IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (requested_employee IS NULL OR COALESCE(owner.id, NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''), 'unassigned') = requested_employee)
    GROUP BY COALESCE(owner.id, NULLIF(customer.managed_by, ''), NULLIF(origin_order.customer_manager_id, ''), 'unassigned')
  ), cashbook_rows AS (
    -- "Đã thu" is sourced directly from valid incoming customer receipts in
    -- the cashbook.  Cancelled/reversal vouchers cannot contribute twice.
    SELECT cashbook.*, COALESCE(owner.id, NULLIF(customer.managed_by, ''), 'unassigned') AS report_employee_id,
      COALESCE(owner.display_name, NULLIF(customer.managed_by, ''), 'Chưa phân công') AS report_employee_name
    FROM public.cashbook_transactions cashbook
    JOIN public.customers customer ON customer.id = cashbook.customer_id
    LEFT JOIN LATERAL (
      SELECT profile.id, profile.display_name
      FROM public.profiles profile
      WHERE profile.id = NULLIF(customer.managed_by, '')
         OR profile.username = NULLIF(customer.managed_by, '')
         OR profile.auth_user_id::text = NULLIF(customer.managed_by, '')
      LIMIT 1
    ) owner ON true
    WHERE COALESCE(cashbook.transaction_date, cashbook.date) >= start_at
      AND COALESCE(cashbook.transaction_date, cashbook.date) < end_at
      AND lower(COALESCE(cashbook.type, '')) = 'thu'
      AND (cashbook.direction IS NULL OR lower(cashbook.direction) = 'in')
      AND COALESCE(cashbook.value, 0) > 0
      AND lower(COALESCE(cashbook.status, '')) NOT IN ('cancelled', 'canceled', 'đã hủy', 'da huy')
      AND cashbook.reversal_of_id IS NULL
      AND lower(COALESCE(cashbook.transaction_type, '')) NOT LIKE '%reversal%'
      AND (requested_company IS NULL OR EXISTS (
        SELECT 1 FROM public.orders sale WHERE sale.id = cashbook.order_id AND sale.company_id = requested_company
      ))
      AND (actor.role <> 'sale' OR NULLIF(customer.managed_by, '') IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (requested_employee IS NULL OR COALESCE(owner.id, NULLIF(customer.managed_by, ''), 'unassigned') = requested_employee)
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
    SELECT report_employee_id AS employee_id, max(report_employee_name) AS employee_name,
      COALESCE(sum(GREATEST(COALESCE(debt_change, 0), 0)), 0) AS debt_increased,
      COALESCE(sum(GREATEST(-COALESCE(debt_change, 0), 0)), 0) AS debt_decreased
    FROM ledger_rows GROUP BY report_employee_id
  ), cashbook_metrics AS (
    SELECT report_employee_id AS employee_id, max(report_employee_name) AS employee_name,
      COALESCE(sum(COALESCE(value, 0)), 0) AS collected
    FROM cashbook_rows GROUP BY report_employee_id
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
    UNION SELECT employee_id FROM cashbook_metrics
  ), row_data AS (
    SELECT keys.employee_id,
      COALESCE(profile.display_name, orders.employee_name, returns.employee_name, cashbook.employee_name, ledgers.employee_name, keys.employee_id, 'Chưa phân công') AS employee_name,
      COALESCE(profile.username, keys.employee_id) AS employee_code,
      COALESCE(orders.order_count, 0) AS order_count, COALESCE(orders.sold_quantity, 0) AS sold_quantity,
      COALESCE(orders.gross_sales, 0) AS gross_sales, COALESCE(orders.discount_amount, 0) AS discount_amount,
      COALESCE(orders.net_sales, 0) AS net_sales, COALESCE(returns.return_count, 0) AS return_count,
      COALESCE(returns.return_quantity, 0) AS return_quantity, COALESCE(returns.return_amount, 0) AS return_amount,
      COALESCE(cashbook.collected, 0) AS collected, COALESCE(ledgers.debt_increased, 0) AS debt_increased,
      COALESCE(ledgers.debt_decreased, 0) AS debt_decreased, COALESCE(balance.debt_balance, 0) AS debt_balance,
      COALESCE(commission.commission_amount, 0) AS commission_amount, COALESCE(kpi.kpi_target, 0) AS kpi_target,
      CASE WHEN COALESCE(kpi.kpi_target, 0) > 0 THEN round(COALESCE(orders.net_sales, 0) * 100 / kpi.kpi_target, 2) ELSE NULL END AS kpi_completion_percent
    FROM employee_keys keys
    LEFT JOIN public.profiles profile ON profile.id = keys.employee_id
    LEFT JOIN order_metrics orders ON orders.employee_id = keys.employee_id
    LEFT JOIN return_metrics returns ON returns.employee_id = keys.employee_id
    LEFT JOIN ledger_metrics ledgers ON ledgers.employee_id = keys.employee_id
    LEFT JOIN cashbook_metrics cashbook ON cashbook.employee_id = keys.employee_id
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
      SELECT to_char(COALESCE(transaction_date, date) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'), 0, 0, 0,
        COALESCE(value, 0), 0 FROM cashbook_rows
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
    UNION ALL
    SELECT COALESCE(transaction_date, date), 'Phiếu thu', id,
      COALESCE(note, partner, transaction_type), value, 'cashbook' FROM cashbook_rows WHERE requested_employee IS NOT NULL
  ), paged_details AS (
    SELECT * FROM detail_rows ORDER BY document_date DESC, document_id DESC LIMIT detail_limit OFFSET detail_offset
  )
  SELECT jsonb_build_object(
    'metadata', jsonb_build_object('start', start_at, 'end', end_at, 'timezone', 'Asia/Ho_Chi_Minh',
      'employee_id', requested_employee, 'company_id', requested_company, 'limit', page_limit, 'offset', page_offset,
      'detail_limit', detail_limit, 'detail_offset', detail_offset, 'detail_total', (SELECT count(*) FROM detail_rows)),
    'total', (SELECT count(*) FROM row_data),
    'summary', CASE WHEN include_summary THEN jsonb_build_object('order_count', COALESCE((SELECT sum(order_count) FROM row_data), 0),
      'sold_quantity', COALESCE((SELECT sum(sold_quantity) FROM row_data), 0), 'gross_sales', COALESCE((SELECT sum(gross_sales) FROM row_data), 0),
      'discount_amount', COALESCE((SELECT sum(discount_amount) FROM row_data), 0), 'net_sales', COALESCE((SELECT sum(net_sales) FROM row_data), 0),
      'return_amount', COALESCE((SELECT sum(return_amount) FROM row_data), 0), 'collected', COALESCE((SELECT sum(collected) FROM row_data), 0),
      'debt_increased', COALESCE((SELECT sum(debt_increased) FROM row_data), 0), 'debt_decreased', COALESCE((SELECT sum(debt_decreased) FROM row_data), 0),
      'debt_balance', COALESCE((SELECT sum(debt_balance) FROM row_data), 0), 'commission_amount', COALESCE((SELECT sum(commission_amount) FROM row_data), 0)) ELSE '{}'::jsonb END,
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(row)) FROM paged_rows row), '[]'::jsonb),
    'series', CASE WHEN include_series THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('date', day_key, 'gross_sales', gross_sales, 'net_sales', net_sales,
      'return_amount', return_amount, 'collected', collected, 'order_count', order_count) ORDER BY day_key) FROM series), '[]'::jsonb) ELSE '[]'::jsonb END,
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
CREATE INDEX IF NOT EXISTS employee_report_cashbook_date_customer_idx
  ON public.cashbook_transactions(transaction_date, customer_id)
  WHERE type = 'thu';
CREATE INDEX IF NOT EXISTS employee_report_commission_date_employee_idx
  ON public.commission_transactions(calculated_at, employee_id);

REVOKE ALL ON FUNCTION public.rpc_get_employee_business_report(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_employee_business_report(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0067', 'Paginate employee report drill-down and omit unused aggregates')
ON CONFLICT (version) DO NOTHING;

COMMIT;
