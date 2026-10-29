BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';

-- Normalize only the UI's reserved placeholder, including requests from older
-- open tabs. Real inactive/private/unknown price-list IDs still fail the same
-- can_use_price_list check. Ownership, zero balances and audit stay unchanged.
DO $patch$
DECLARE original text;
 anchor text := $anchor$price_list_id text := NULLIF(btrim(p_customer->>'pricelistId'), '');$anchor$;
BEGIN
 original:=pg_get_functiondef('public.rpc_create_quick_customer(jsonb)'::regprocedure);
 IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0131: quick-customer price-list declaration has drifted'; END IF;
 EXECUTE replace(original,anchor,$replacement$price_list_id text := NULLIF(NULLIF(btrim(p_customer->>'pricelistId'), ''), 'custom');$replacement$);
END $patch$;

-- Invoker security is essential: this exposes exactly the rows already visible
-- through orders_select, including its manager/company/price-list restrictions.
-- A bounded POST avoids long customer_id=in.(...) URLs without fan-out queries.
CREATE FUNCTION public.rpc_get_customer_order_window(
 p_customer_ids text[], p_start timestamptz DEFAULT NULL, p_end timestamptz DEFAULT NULL,
 p_status text DEFAULT NULL, p_date_field text DEFAULT 'business',
 p_limit integer DEFAULT 500, p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 PERFORM public.require_authenticated_profile();
 IF p_customer_ids IS NULL OR cardinality(p_customer_ids)=0 THEN RETURN '[]'::jsonb; END IF;
 IF array_ndims(p_customer_ids)<>1 OR cardinality(p_customer_ids)>10000
   OR octet_length(to_jsonb(p_customer_ids)::text)>512000
   OR EXISTS(SELECT 1 FROM unnest(p_customer_ids) id WHERE id IS NULL OR length(id)>240)
   OR p_date_field IS NULL OR p_date_field NOT IN ('business','created')
   OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
   OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 10000000
   OR length(COALESCE(p_status,''))>40
   OR (p_start IS NOT NULL AND p_end IS NOT NULL AND p_start>p_end) THEN
   RAISE EXCEPTION 'Bộ lọc lịch sử đơn hàng không hợp lệ.' USING ERRCODE='22023';
 END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY
   CASE WHEN p_date_field='created' THEN page.created_at END ASC,
   CASE WHEN p_date_field='business' THEN page.order_date END DESC,
   CASE WHEN p_date_field='business' THEN page.created_at END DESC,
   page.id),'[]'::jsonb) INTO result
 FROM (
   SELECT o.* FROM public.orders o
   WHERE o.customer_id=ANY(p_customer_ids)
     AND (p_start IS NULL OR CASE WHEN p_date_field='created' THEN o.created_at ELSE COALESCE(o.order_date,o.created_at) END>=p_start)
     AND (p_end IS NULL OR CASE WHEN p_date_field='created' THEN o.created_at ELSE COALESCE(o.order_date,o.created_at) END<p_end)
     AND (p_status IS NULL
       OR (p_status='settled' AND o.status IN ('settled','completed','complete','confirmed'))
       OR (p_status='cancelled' AND o.status IN ('cancelled','canceled'))
       OR (p_status='all' AND o.status IN ('settled','completed','complete','confirmed','partially_returned','returned'))
       OR (p_status NOT IN ('settled','cancelled','all') AND o.status=p_status))
   ORDER BY CASE WHEN p_date_field='created' THEN o.created_at END ASC,
     CASE WHEN p_date_field='business' THEN o.order_date END DESC,
     CASE WHEN p_date_field='business' THEN o.created_at END DESC,o.id
   LIMIT p_limit OFFSET p_offset
 ) page;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.rpc_get_customer_order_window(text[],timestamptz,timestamptz,text,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_customer_order_window(text[],timestamptz,timestamptz,text,text,integer,integer) TO authenticated;
INSERT INTO public.schema_migrations(version,description)
VALUES('0131','Normalize quick-customer custom placeholder; bounded invoker-security POST order windows instead of oversized ID URLs');
NOTIFY pgrst,'reload schema';
COMMIT;
