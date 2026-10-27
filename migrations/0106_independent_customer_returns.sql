BEGIN;

-- Additive: installing this migration does not rewrite historical documents.
ALTER TABLE public.sales_returns ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'order';
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS seal_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS stock_applied boolean NOT NULL DEFAULT false;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS inventory_document_id uuid;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS revenue_brand_id text;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS revenue_company_id text;
ALTER TABLE public.customer_debt_transactions ADD COLUMN IF NOT EXISTS retention_company_id text;
ALTER TABLE public.sales_returns ADD CONSTRAINT sales_return_source_kind_check
  CHECK (source_kind IN ('order', 'independent'));
ALTER TABLE public.sales_returns ADD CONSTRAINT sales_return_independent_source_check
  CHECK (source_kind <> 'independent' OR (sale_id IS NULL AND order_id IS NULL AND customer_id IS NOT NULL));

CREATE OR REPLACE VIEW public.independent_return_owners WITH (security_invoker = true) AS
SELECT r.id AS return_id, c.name AS customer_name,
  COALESCE(r.company_id, o.company_id) AS company_id,
  COALESCE(o.order_date,o.created_at) AS order_business_date,
  CASE WHEN r.source_kind = 'order' THEN o.salesperson_id ELSE COALESCE(c.managed_by, r.salesperson_id) END AS salesperson_id,
  CASE WHEN r.source_kind = 'order' THEN o.created_by ELSE r.created_by END AS created_by,
  COALESCE(c.managed_by, o.customer_manager_id, r.salesperson_id, 'unassigned') AS customer_manager_id,
  COALESCE(owner.id, c.managed_by, o.customer_manager_id, r.salesperson_id, 'unassigned') AS employee_id,
  COALESCE(owner.display_name, c.managed_by, o.customer_manager_id, 'Chưa phân công') AS employee_name
FROM public.sales_returns r
LEFT JOIN public.orders o ON o.id = r.sale_id
LEFT JOIN public.customers c ON c.id = r.customer_id
LEFT JOIN LATERAL (
  SELECT p.id, p.display_name FROM public.profiles p
  WHERE COALESCE(c.managed_by, o.customer_manager_id, r.salesperson_id) IN (p.id, p.username, p.auth_user_id::text)
  ORDER BY p.id LIMIT 1
) owner ON true;
REVOKE ALL ON public.independent_return_owners FROM PUBLIC, anon, authenticated;

CREATE POLICY independent_returns_select ON public.sales_returns FOR SELECT TO authenticated
USING (source_kind = 'independent' AND public.can_access_customer(customer_id));

-- The existing response contract also serves independent returns, without a
-- fabricated order row. Fail closed if the deployed definition has drifted.
DO $migration$
DECLARE original text; patched text;
BEGIN
  SELECT pg_get_functiondef('public.p3_sales_return_response(text)'::regprocedure) INTO original;
  IF original NOT LIKE '%JOIN public.orders sale ON sale.id = sales_return.sale_id%' THEN
    RAISE EXCEPTION '0106: unrecognized sales return response';
  END IF;
  patched := replace(original, 'JOIN public.orders sale ON sale.id = sales_return.sale_id',
    'LEFT JOIN public.orders sale ON sale.id = sales_return.sale_id');
  patched := replace(patched, '''saleId'', sales_return.sale_id,',
    '''sourceKind'', sales_return.source_kind, ''sealConfirmed'', sales_return.seal_confirmed, ''stockApplied'', sales_return.stock_applied, ''companyId'', sales_return.company_id, ''saleId'', sales_return.sale_id,');
  EXECUTE patched;
END $migration$;

CREATE FUNCTION public.rpc_record_independent_return(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE; customer_row public.customers%ROWTYPE;
  product_row public.products%ROWTYPE; prior public.sales_returns%ROWTYPE;
  item jsonb; items jsonb := '[]'::jsonb; stock_items jsonb := '[]'::jsonb;
  request_key uuid; request_hash text; return_id text; ledger_id text;
  quantity numeric; unit_price numeric; deduction numeric; amount numeric; total numeric := 0;
  line_index integer := 0; business_date timestamptz;
  company text; brand_id text; brand_company text; inventory_result jsonb;
  stock_enabled boolean := false;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION 'Chỉ Admin hoặc Kế toán được lập phiếu trả độc lập.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text) > 32000
     OR jsonb_typeof(p_input->'items') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_input->'items') NOT BETWEEN 1 AND 50
     OR COALESCE((p_input->>'sealConfirmed')::boolean, false) IS NOT TRUE
     OR length(btrim(COALESCE(p_input->>'reason', ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Cần xác nhận tem niêm phong, lý do 3–500 ký tự và 1–50 mặt hàng.';
  END IF;
  request_key := (p_input->>'idempotencyKey')::uuid;
  IF request_key IS NULL THEN RAISE EXCEPTION 'Thiếu mã yêu cầu chống ghi trùng.'; END IF;
  business_date := COALESCE(NULLIF(p_input->>'date', '')::timestamptz, now());
  IF business_date > now() + interval '5 minutes' THEN RAISE EXCEPTION 'Ngày trả hàng không được ở tương lai.'; END IF;
  request_hash := md5(p_input::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('independent-return:' || actor.auth_user_id || ':' || request_key, 0));
  SELECT * INTO prior FROM public.sales_returns r
  WHERE r.created_by = actor.auth_user_id::text AND r.idempotency_key = request_key::text;
  IF FOUND THEN
    IF prior.request_fingerprint IS DISTINCT FROM request_hash OR prior.source_kind <> 'independent' THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng với nội dung khác.' USING ERRCODE = '23505';
    END IF;
    RETURN public.p3_sales_return_response(prior.id) || jsonb_build_object('already_recorded', true);
  END IF;
  SELECT * INTO STRICT customer_row FROM public.customers
  WHERE id = p_input->>'customerId' AND deleted_at IS NULL AND COALESCE(status, 'active') = 'active' FOR UPDATE;
  company := COALESCE(NULLIF(p_input->>'companyId', ''), NULLIF(actor.company_id, ''), 'ABS_NORTH');
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = company) THEN RAISE EXCEPTION 'Công ty không hợp lệ.'; END IF;
  IF (SELECT count(DISTINCT value->>'productId') FROM jsonb_array_elements(p_input->'items')) <> jsonb_array_length(p_input->'items') THEN
    RAISE EXCEPTION 'Mỗi SKU chỉ được xuất hiện một lần trong phiếu.';
  END IF;
  -- Canonical identity comes from products; approved receiving prices are
  -- explicit inputs, never silently reconstructed from a deleted invoice.
  FOR item IN SELECT value FROM jsonb_array_elements(p_input->'items') ORDER BY value->>'productId' LOOP
    SELECT * INTO STRICT product_row FROM public.products WHERE id = item->>'productId' AND is_active AND NOT is_legacy FOR SHARE;
    quantity := (item->>'quantity')::numeric; unit_price := (item->>'unitPrice')::numeric;
    deduction := COALESCE((item->>'deductionPercent')::numeric, 0);
    IF quantity IS NULL OR quantity <= 0 OR quantity > 1000000 OR quantity <> round(quantity, 4)
      OR unit_price IS NULL OR unit_price < 0 OR unit_price > 1000000000 OR unit_price <> round(unit_price)
      OR deduction NOT BETWEEN 0 AND 100 OR deduction <> round(deduction, 2) THEN
      RAISE EXCEPTION 'Số lượng, đơn giá hoặc phần trăm khấu trừ không hợp lệ.';
    END IF;
    amount := round(quantity * unit_price * (100 - deduction) / 100);
    total := total + amount;
    IF total > 1000000000000 THEN RAISE EXCEPTION 'Giá trị phiếu vượt giới hạn.'; END IF;
    SELECT b.id, b.company_id INTO brand_id, brand_company FROM public.brands b
    WHERE b.id = product_row.brand_id OR b.name = product_row.brand ORDER BY b.id LIMIT 1;
    items := items || jsonb_build_array(jsonb_build_object(
      'product_id', product_row.id, 'code', COALESCE(product_row.variant_code, product_row.code),
      'name', product_row.name, 'packaging', COALESCE(product_row.packaging_name, product_row.package_type, ''),
      'specification', COALESCE(product_row.display_specification, ''), 'quantity', quantity,
      'unit_price', unit_price, 'deduction', deduction, 'amount', amount,
      'brand_id', COALESCE(brand_id, product_row.brand_id), 'company_id', COALESCE(NULLIF(brand_company, ''), company)));
    stock_items := stock_items || jsonb_build_array(jsonb_build_object('productId', product_row.id, 'quantity', quantity));
  END LOOP;
  IF total <= 0 THEN RAISE EXCEPTION 'Tổng giá trị nhận trả phải lớn hơn 0.'; END IF;
  return_id := 'TR-' || to_char(clock_timestamp() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD') || '-' ||
    lpad(nextval('public.sales_return_display_seq')::text, 8, '0');
  ledger_id := 'DTX-INDEPENDENT-' || gen_random_uuid()::text;
  IF to_regclass('public.inventory_control') IS NOT NULL THEN
    SELECT activated_at IS NOT NULL INTO stock_enabled FROM public.inventory_control WHERE id;
  END IF;
  IF stock_enabled THEN
    inventory_result := public.rpc_inventory_post(jsonb_build_object('requestKey', request_key, 'kind', 'receipt',
      'note', 'Nhận hàng trả ' || return_id, 'items', stock_items));
  END IF;
  INSERT INTO public.sales_returns(id, source_kind, sale_id, order_id, customer_id, salesperson_id, company_id,
    total_return_amount, total_refund, debt_reduction_amount, refund_amount, reason, status,
    created_by, created_at, return_date, updated_by, updated_at, idempotency_key, request_fingerprint,
    debt_ledger_id, seal_confirmed, stock_applied, inventory_document_id)
  VALUES (return_id, 'independent', NULL, NULL, customer_row.id, customer_row.managed_by, company,
    total, total, total, 0, btrim(p_input->>'reason'), 'completed', actor.auth_user_id::text, now(), business_date,
    actor.auth_user_id::text, now(), request_key::text, request_hash, ledger_id, true,
    COALESCE(stock_enabled, false), (inventory_result->>'id')::uuid);
  FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
    line_index := line_index + 1;
    INSERT INTO public.sales_return_items(id, return_id, sale_item_id, product_id, variant_id,
      variant_code_snapshot, product_name, quantity, import_price, refund_price, subtotal,
      discount_type, discount_value, package_type, packaging_name_snapshot, specification_snapshot,
      revenue_brand_id, revenue_company_id)
    VALUES (return_id || '-' || line_index, return_id, NULL, item->>'product_id', item->>'product_id',
      item->>'code', item->>'name', (item->>'quantity')::numeric, (item->>'unit_price')::numeric,
      (item->>'amount')::numeric / (item->>'quantity')::numeric, (item->>'amount')::numeric,
      'percent', (item->>'deduction')::numeric, item->>'packaging', item->>'packaging', item->>'specification',
      item->>'brand_id', item->>'company_id');
  END LOOP;
  INSERT INTO public.customer_debt_transactions(id, customer_id, transaction_type, amount, debt_change,
    balance_before, balance_after, sales_return_id, description, created_by, transaction_date,retention_company_id)
  VALUES (ledger_id, customer_row.id, 'return', total, -total, customer_row.debt, customer_row.debt - total,
    return_id, 'Nhận hàng trả độc lập ' || return_id, actor.auth_user_id::text, business_date,company);
  UPDATE public.customers SET debt = customer_row.debt - total,
    total_return = COALESCE(total_return, 0) + total, net_revenue = COALESCE(net_revenue, 0) - total,
    updated_at = now(), updated_by = actor.auth_user_id::text WHERE id = customer_row.id;
  RETURN public.p3_sales_return_response(return_id);
END $$;

-- Route existing callers through one cancellation contract. Keep the old
-- order-backed implementation private; no alternate PostgREST bypass endpoint.
ALTER FUNCTION public.rpc_cancel_sales_return(text, text) RENAME TO p106_cancel_order_return;
REVOKE ALL ON FUNCTION public.p106_cancel_order_return(text, text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.rpc_cancel_sales_return(p_return_id text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor public.profiles%ROWTYPE; ret public.sales_returns%ROWTYPE;
  customer_row public.customers%ROWTYPE; stock_items jsonb; total numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION '403: accounting role required' USING ERRCODE='42501'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Cần lý do hủy ít nhất 3 ký tự.'; END IF;
  SELECT * INTO STRICT ret FROM public.sales_returns WHERE id = p_return_id FOR UPDATE;
  IF ret.source_kind = 'order' THEN RETURN public.p106_cancel_order_return(p_return_id, p_reason); END IF;
  IF ret.status IN ('cancelled', 'canceled') THEN
    RETURN public.p3_sales_return_response(ret.id) || jsonb_build_object('already_cancelled', true);
  END IF;
  SELECT * INTO STRICT customer_row FROM public.customers WHERE id = ret.customer_id FOR UPDATE;
  total := COALESCE(NULLIF(ret.total_refund, 0), ret.total_return_amount, 0);
  -- A detached historical return may have included a real cash refund.
  -- Such documents must retain the reviewed original cancellation path.
  IF COALESCE(ret.refund_amount, 0) <> 0 OR ret.refund_cashbook_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu có hoàn tiền cũ cần đối soát trước khi hủy.';
  END IF;
  IF ret.stock_applied THEN
    SELECT jsonb_agg(jsonb_build_object('productId', COALESCE(variant_id, product_id), 'quantity', quantity))
    INTO stock_items FROM public.sales_return_items WHERE return_id = ret.id;
    PERFORM public.rpc_inventory_post(jsonb_build_object('requestKey', gen_random_uuid(), 'kind', 'issue',
      'note', 'Hủy nhận hàng trả ' || ret.id, 'items', stock_items));
  END IF;
  INSERT INTO public.customer_debt_transactions(id, customer_id, transaction_type, amount, debt_change,
    balance_before, balance_after, sales_return_id, reversal_of_id, description, created_by, transaction_date,retention_company_id)
  VALUES ('DTX-INDEPENDENT-VOID-' || ret.id, customer_row.id, 'return_cancel', ret.debt_reduction_amount,
    ret.debt_reduction_amount, customer_row.debt, customer_row.debt + ret.debt_reduction_amount,
    ret.id, ret.debt_ledger_id, 'Hủy phiếu nhận trả ' || ret.id || ': ' || btrim(p_reason), actor.auth_user_id::text, now(),ret.company_id);
  UPDATE public.customers SET debt = customer_row.debt + ret.debt_reduction_amount,
    total_return = COALESCE(total_return, 0) - total, net_revenue = COALESCE(net_revenue, 0) + total,
    updated_at = now(), updated_by = actor.auth_user_id::text WHERE id = customer_row.id;
  UPDATE public.sales_returns SET status='cancelled', cancelled_at=now(), cancelled_by=actor.auth_user_id::text,
    cancellation_reason=btrim(p_reason), updated_at=now(), updated_by=actor.auth_user_id::text WHERE id=ret.id;
  RETURN public.p3_sales_return_response(ret.id);
END $$;

REVOKE ALL ON FUNCTION public.rpc_record_independent_return(jsonb), public.rpc_cancel_sales_return(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_independent_return(jsonb), public.rpc_cancel_sales_return(text,text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0106', 'Independent sealed customer returns with signed credit and atomic cancellation') ON CONFLICT DO NOTHING;
COMMIT;
