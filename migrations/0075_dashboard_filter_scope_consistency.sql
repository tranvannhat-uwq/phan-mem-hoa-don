BEGIN;

-- Dashboard filters must describe one authoritative scope.  The previous
-- implementation filtered item_rows by an exact brand_id string, while the
-- KPI/series/rankings still aggregated visible_orders.  That made a valid
-- company + brand selection show numbers in the KPI but empty item charts.
-- This revision resolves both canonical and legacy brand representations and
-- derives every item-level aggregate from the same scoped item set.
CREATE OR REPLACE FUNCTION public.rpc_get_phase5_dashboard(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  start_at timestamptz;
  end_at timestamptz;
  company_filter text := NULLIF(btrim(COALESCE(p_filters->>'company_id', '')), '');
  brand_filter text := NULLIF(btrim(COALESCE(p_filters->>'brand_id', '')), '');
  salesperson_filter text := NULLIF(btrim(COALESCE(p_filters->>'salesperson_id', '')), '');
  customer_filter text := NULLIF(btrim(COALESCE(p_filters->>'customer_id', '')), '');
  sales_mode text := CASE WHEN lower(COALESCE(p_filters->>'sales_mode', 'net')) = 'gross' THEN 'gross' ELSE 'net' END;
  include_festival boolean := CASE
    WHEN lower(COALESCE(p_filters->>'include_festival_allocation', 'true')) IN ('0', 'false', 'no', 'off') THEN false
    ELSE true
  END;
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  start_at := COALESCE(NULLIF(p_filters->>'start', '')::timestamptz, date_trunc('month', now()));
  end_at := COALESCE(NULLIF(p_filters->>'end', '')::timestamptz, now() + interval '1 day');
  IF end_at <= start_at OR end_at - start_at > interval '5 years' THEN
    RAISE EXCEPTION 'Invalid reporting date range';
  END IF;

  WITH visible_orders AS (
    SELECT sale.*,
      COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''), 'unassigned') managed_salesperson_id
    FROM public.orders sale
    LEFT JOIN public.customers customer ON customer.id = sale.customer_id
    WHERE COALESCE(sale.order_date, sale.created_at) >= start_at
      AND COALESCE(sale.order_date, sale.created_at) < end_at
      AND sale.status NOT IN ('cancelled', 'canceled', 'draft')
      AND (actor.role <> 'sale' OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''))
        IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (customer_filter IS NULL OR customer_filter = 'all' OR sale.customer_id = customer_filter)
      AND (actor.role = 'sale' OR salesperson_filter IS NULL OR salesperson_filter = 'all'
        OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''), 'unassigned') = salesperson_filter)
  ), attributed_items AS (
    SELECT
      item.id,
      item.order_id,
      item.brand_id,
      item.product_code_snapshot,
      item.variant_code_snapshot,
      item.product_name_snapshot,
      item.quantity,
      item.returned_quantity,
      item.returned_amount,
      sale.customer_id,
      sale.customer_name,
      sale.company_id,
      sale.managed_salesperson_id,
      sale.order_date,
      sale.created_at AS order_created_at,
      COALESCE(
        NULLIF(CASE WHEN include_festival THEN snapshot.payload->>'revenueCompany' ELSE NULL END, ''),
        NULLIF(brand.company_id, ''),
        sale.company_id
      ) AS revenue_company_id,
      COALESCE(
        NULLIF(brand.id, ''),
        NULLIF(CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END, ''),
        NULLIF(snapshot.payload->>'brand', ''),
        NULLIF(item.brand_id, ''),
        'unassigned'
      ) AS revenue_brand_id,
      COALESCE(
        NULLIF(brand.name, ''),
        NULLIF(CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END, ''),
        NULLIF(snapshot.payload->>'brand', ''),
        NULLIF(item.brand_id, ''),
        'unassigned'
      ) AS revenue_brand_name,
      COALESCE(item.line_total, 0) AS line_gross,
      CASE
        -- net_amount was added after older order_items had already been
        -- written. Preserve those rows, but do not turn a fully returned item
        -- (net_amount = 0, returned_quantity > 0) back into gross revenue.
        WHEN item.net_amount IS NULL THEN COALESCE(item.line_total, 0)
        WHEN item.net_amount = 0
          AND COALESCE(item.returned_quantity, 0) = 0
          AND COALESCE(item.returned_amount, 0) = 0
          THEN COALESCE(item.line_total, 0)
        ELSE item.net_amount
      END AS line_net
    FROM visible_orders sale
    JOIN public.order_items item ON item.order_id = sale.id
    LEFT JOIN LATERAL (
      SELECT json_item.payload
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(sale.items) = 'array' THEN sale.items ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS json_item(payload, ordinal)
      WHERE json_item.payload->>'id' = item.id
        OR item.id = sale.id || '-item-' || json_item.ordinal::text
        OR (json_item.payload->>'variantId' = item.variant_id
          AND json_item.payload->>'productCode' = item.product_code_snapshot)
      ORDER BY CASE
        WHEN json_item.payload->>'id' = item.id THEN 0
        WHEN item.id = sale.id || '-item-' || json_item.ordinal::text THEN 1
        ELSE 2
      END, json_item.ordinal
      LIMIT 1
    ) snapshot ON true
    LEFT JOIN LATERAL (
      SELECT b.id, b.name, b.company_id
      FROM public.brands b
      WHERE (NULLIF(COALESCE(
          CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END,
          snapshot.payload->>'brand', item.brand_id), '') IS NOT NULL AND (
          b.id = COALESCE(
            CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END,
            snapshot.payload->>'brand', item.brand_id)
          OR b.name = COALESCE(
            CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END,
            snapshot.payload->>'brand', item.brand_id)
          OR lower(btrim(b.name)) = lower(btrim(COALESCE(
            CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END,
            snapshot.payload->>'brand', item.brand_id)))
        ))
      ORDER BY CASE WHEN b.id = COALESCE(
        CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END,
        snapshot.payload->>'brand', item.brand_id) THEN 0 ELSE 1 END
      LIMIT 1
    ) brand ON true
    WHERE (company_filter IS NULL OR company_filter = 'all'
      OR COALESCE(
        NULLIF(CASE WHEN include_festival THEN snapshot.payload->>'revenueCompany' ELSE NULL END, ''),
        NULLIF(brand.company_id, ''),
        sale.company_id
      ) = company_filter)
      AND (brand_filter IS NULL OR brand_filter = 'all'
        OR COALESCE(
          CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END,
          snapshot.payload->>'brand', item.brand_id) = brand_filter
        OR lower(btrim(COALESCE(
          CASE WHEN include_festival THEN snapshot.payload->>'revenueBrand' ELSE snapshot.payload->>'productBrand' END,
          snapshot.payload->>'brand', item.brand_id))) = lower(brand_filter)
        OR item.brand_id = brand_filter
        OR lower(btrim(item.brand_id)) = lower(brand_filter)
        OR brand.id = brand_filter
        OR lower(btrim(COALESCE(brand.name, ''))) = lower(brand_filter))
  ), scoped_orders AS (
    SELECT sale.*
    FROM visible_orders sale
    WHERE EXISTS (SELECT 1 FROM attributed_items item WHERE item.order_id = sale.id)
  ), valid_returns AS (
    SELECT ret.*
    FROM public.sales_returns ret
    JOIN scoped_orders sale ON sale.id = ret.sale_id
    WHERE ret.status NOT IN ('cancelled', 'canceled')
      AND COALESCE(ret.return_date, ret.created_at) >= start_at
      AND COALESCE(ret.return_date, ret.created_at) < end_at
  ), valid_payments AS (
    SELECT pay.*
    FROM public.payments pay
    WHERE pay.status = 'completed'
      AND pay.created_at >= start_at
      AND pay.created_at < end_at
      AND EXISTS (SELECT 1 FROM scoped_orders sale WHERE sale.id = pay.order_id)
  ), customer_scope AS (
    SELECT customer.*
    FROM public.customers customer
    WHERE (actor.role <> 'sale' OR customer.managed_by IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (customer_filter IS NULL OR customer_filter = 'all' OR customer.id = customer_filter)
  ), scoped_order_totals AS (
    SELECT
      sale.id,
      sale.customer_id,
      sale.customer_name,
      sale.company_id,
      sale.managed_salesperson_id,
      sale.order_date,
      sale.created_at,
      sum(item.line_gross) AS gross_sales,
      sum(item.line_net) AS net_sales
    FROM scoped_orders sale
    JOIN attributed_items item ON item.order_id = sale.id
    GROUP BY sale.id, sale.customer_id, sale.customer_name, sale.company_id,
      sale.managed_salesperson_id, sale.order_date, sale.created_at
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object('start', start_at, 'end', end_at),
    'summary', jsonb_build_object(
      'gross_sales', COALESCE((SELECT sum(gross_sales) FROM scoped_order_totals), 0),
      'returns', COALESCE((SELECT sum(greatest(line_gross - line_net, 0)) FROM attributed_items), 0),
      'net_sales', COALESCE((SELECT sum(net_sales) FROM scoped_order_totals), 0),
      'collected', COALESCE((SELECT sum(amount) FROM valid_payments), 0),
      'debt_issued', COALESCE((SELECT sum(GREATEST(sale.debt_amount, 0)) FROM scoped_orders sale), 0),
      'debt_collected', COALESCE((SELECT sum(-debt.debt_change)
        FROM public.customer_debt_transactions debt
        WHERE debt.transaction_date >= start_at
          AND debt.transaction_date < end_at
          AND debt.debt_change < 0
          AND EXISTS (SELECT 1 FROM customer_scope c WHERE c.id = debt.customer_id)), 0),
      'current_debt', COALESCE((SELECT sum(debt) FROM customer_scope), 0),
      'order_count', (SELECT count(*) FROM scoped_orders),
      'sold_quantity', COALESCE((SELECT sum(GREATEST(quantity - COALESCE(returned_quantity, 0), 0)) FROM attributed_items), 0)
    ),
    'by_company', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', revenue_company_id,
        'amount', sum(CASE WHEN sales_mode = 'gross' THEN line_gross ELSE line_net END)
      ) x
      FROM attributed_items
      GROUP BY revenue_company_id
    ) q), '[]'::jsonb),
    'by_brand', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', revenue_brand_id,
        'name', max(revenue_brand_name),
        'amount', sum(CASE WHEN sales_mode = 'gross' THEN line_gross ELSE line_net END)
      ) x
      FROM attributed_items
      GROUP BY revenue_brand_id
    ) q), '[]'::jsonb),
    'by_salesperson', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', managed_salesperson_id,
        'amount', sum(CASE WHEN sales_mode = 'gross' THEN line_gross ELSE line_net END)
      ) x
      FROM attributed_items
      GROUP BY managed_salesperson_id
    ) q), '[]'::jsonb),
    'kpi_by_employee', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'net_sales')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', managed_salesperson_id,
        'gross_sales', sum(line_gross),
        'returns', sum(greatest(line_gross - line_net, 0)),
        'net_sales', sum(line_net),
        'collected', COALESCE((SELECT sum(pay.amount) FROM valid_payments pay
          WHERE pay.order_id IN (SELECT DISTINCT employee_item.order_id FROM attributed_items employee_item
            WHERE employee_item.managed_salesperson_id = items.managed_salesperson_id)), 0),
        'debt_issued', COALESCE((SELECT sum(GREATEST(sale.debt_amount, 0)) FROM scoped_orders sale
          WHERE sale.managed_salesperson_id = items.managed_salesperson_id), 0)
      ) x
      FROM attributed_items items
      GROUP BY managed_salesperson_id
    ) q), '[]'::jsonb),
    'by_customer', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', customer_id,
        'name', max(customer_name),
        'amount', sum(CASE WHEN sales_mode = 'gross' THEN line_gross ELSE line_net END)
      ) x
      FROM attributed_items
      GROUP BY customer_id
    ) q), '[]'::jsonb),
    'series', COALESCE((SELECT jsonb_agg(x ORDER BY x->>'date') FROM (
      SELECT jsonb_build_object(
        'date', to_char(date_trunc('day', COALESCE(order_date, order_created_at) AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD'),
        'amount', sum(CASE WHEN sales_mode = 'gross' THEN line_gross ELSE line_net END)
      ) x
      FROM attributed_items
      GROUP BY date_trunc('day', COALESCE(order_date, order_created_at) AT TIME ZONE 'Asia/Bangkok')
    ) q), '[]'::jsonb),
    'top_skus', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'quantity')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'code', COALESCE(variant_code_snapshot, product_code_snapshot, 'unknown'),
        'name', max(product_name_snapshot),
        'quantity', sum(GREATEST(quantity - COALESCE(returned_quantity, 0), 0)),
        'amount', sum(CASE WHEN sales_mode = 'gross' THEN line_gross ELSE line_net END)
      ) x
      FROM attributed_items
      GROUP BY COALESCE(variant_code_snapshot, product_code_snapshot, 'unknown')
      ORDER BY sum(GREATEST(quantity - COALESCE(returned_quantity, 0), 0)) DESC
      LIMIT 10
    ) q), '[]'::jsonb),
    'recent_orders', COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.order_date DESC) FROM (
      SELECT totals.id, totals.customer_id, totals.customer_name, totals.company_id,
        totals.gross_sales AS total_payable, totals.net_sales AS net_revenue,
        COALESCE(totals.order_date, totals.created_at) AS order_date,
        sale.status
      FROM scoped_order_totals totals
      JOIN scoped_orders sale ON sale.id = totals.id
      ORDER BY COALESCE(totals.order_date, totals.created_at) DESC
      LIMIT 10
    ) q), '[]'::jsonb),
    -- Kept in the contract so clients can safely send the toggle. Revenue
    -- attribution uses persisted item fields plus the saved revenue snapshot;
    -- legacy order JSON is not trusted as an authorization source.
    'include_festival_allocation', include_festival
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0075', 'Keep dashboard KPI and breakdowns in one resolved brand/company filter scope')
ON CONFLICT (version) DO NOTHING;

COMMIT;
