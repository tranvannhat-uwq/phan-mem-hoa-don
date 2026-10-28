BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0122') THEN RAISE EXCEPTION '0123 requires 0122'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.p114_preserve_support(timestamptz)'::regprocedure
    AND md5(replace(prosrc,chr(13),''))='aeaeab2718c08fe7512410cc8b4075a8')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.rpc_dealer_support_history(text,integer,integer)'::regprocedure
    AND md5(replace(prosrc,chr(13),''))='cb2e1230b1458ef28aebb62328443ab0') THEN
    RAISE EXCEPTION '0123: support functions differ from the reviewed version';
  END IF;
END $guard$;

-- Retain only the source order's note alongside existing quantity facts.
-- Do not change quantities, product units, financials or access permissions.
ALTER TABLE public.dealer_support_history ADD COLUMN IF NOT EXISTS order_notes text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.p114_preserve_support(p_cutoff timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.p107_is_executing() THEN RAISE EXCEPTION 'Support snapshots require the bound retention transaction' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.p118_purge_support_lines() s JOIN public.dealer_support_history h USING(source_key)
    WHERE s.business_date<p_cutoff AND to_jsonb(s) IS DISTINCT FROM to_jsonb(h)-'saved_at'-'order_notes') THEN
    RAISE EXCEPTION 'Lịch sử hàng cấp đã lưu khác chứng từ nguồn; chưa xóa gì, cần đối soát.';
  END IF;
  INSERT INTO public.dealer_support_history(source_key,customer_id,product_id,product_code,product_name,unit_name,
    brand_id,brand_name,company_id,company_name,quantity,returned_quantity,business_date,order_cancelled)
    SELECT * FROM public.p118_purge_support_lines() WHERE business_date<p_cutoff ON CONFLICT(source_key) DO NOTHING;
  UPDATE public.dealer_support_history h SET order_notes=COALESCE(o.notes,'')
    FROM public.order_items i JOIN public.orders o ON o.id=i.order_id
    WHERE h.source_key=encode(sha256(convert_to(i.id,'UTF8')),'hex') AND h.customer_id=o.customer_id
      AND h.business_date<p_cutoff AND COALESCE(o.order_date,o.created_at)<p_cutoff
      AND h.order_notes IS DISTINCT FROM COALESCE(o.notes,'');
  UPDATE public.sales_return_items ri SET dealer_support_source_key=h.source_key
    FROM public.order_items i,public.dealer_support_history h
    WHERE ri.sale_item_id=i.id AND h.source_key=encode(sha256(convert_to(i.id,'UTF8')),'hex')
      AND h.business_date<p_cutoff;
  IF EXISTS(SELECT 1 FROM public.p118_purge_support_lines() s WHERE s.business_date<p_cutoff
    AND NOT EXISTS(SELECT 1 FROM public.dealer_support_history h WHERE h.source_key=s.source_key)) THEN
    RAISE EXCEPTION 'Chưa lưu đủ lịch sử hàng cấp; đã hủy lần dọn.';
  END IF;
END $$;

-- Enrich only this customer's requested page; never ship all their invoices.
CREATE OR REPLACE FUNCTION public.rpc_dealer_support_history(p_customer_id text,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; rows_data jsonb; summaries jsonb; total bigint;
BEGIN
  actor:=public.require_authenticated_profile();
  IF NOT COALESCE(public.can_access_customer(p_customer_id),false) THEN RAISE EXCEPTION 'Không có quyền xem khách này.' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Phân trang không hợp lệ.'; END IF;
  WITH all_rows AS (SELECT h.source_key,h.customer_id,h.product_id,h.product_code,h.product_name,h.unit_name,h.brand_id,h.brand_name,
      h.company_id,h.company_name,h.quantity,h.returned_quantity,h.business_date,h.order_cancelled,true archived
    FROM public.dealer_support_history h WHERE h.customer_id=p_customer_id
    UNION ALL SELECT s.*,false FROM public.p114_source_lines() s WHERE s.customer_id=p_customer_id
      AND NOT EXISTS(SELECT 1 FROM public.dealer_support_history h WHERE h.source_key=s.source_key)),
  paged AS MATERIALIZED (SELECT * FROM all_rows ORDER BY business_date DESC,source_key LIMIT p_limit OFFSET p_offset),
  live_notes AS (
    SELECT encode(sha256(convert_to(i.id,'UTF8')),'hex') source_key,o.notes
    FROM public.orders o JOIN public.order_items i ON i.order_id=o.id
    WHERE o.customer_id=p_customer_id
      AND EXISTS(SELECT 1 FROM paged p WHERE p.source_key=encode(sha256(convert_to(i.id,'UTF8')),'hex')))
  SELECT (SELECT count(*) FROM all_rows),
    COALESCE(jsonb_agg(to_jsonb(p)||jsonb_build_object('order_notes',COALESCE(n.notes,h.order_notes,''))
      ORDER BY p.business_date DESC,p.source_key) FILTER(WHERE p.source_key IS NOT NULL),'[]')
    INTO total,rows_data FROM paged p LEFT JOIN live_notes n USING(source_key)
      LEFT JOIN public.dealer_support_history h ON h.source_key=p.source_key AND h.customer_id=p_customer_id;
  WITH all_rows AS (SELECT h.product_id,h.product_code,h.product_name,h.unit_name,h.brand_name,h.company_name,h.quantity,h.returned_quantity,h.order_cancelled
      FROM public.dealer_support_history h WHERE h.customer_id=p_customer_id
    UNION ALL SELECT s.product_id,s.product_code,s.product_name,s.unit_name,s.brand_name,s.company_name,s.quantity,s.returned_quantity,s.order_cancelled
      FROM public.p114_source_lines() s WHERE s.customer_id=p_customer_id
      AND NOT EXISTS(SELECT 1 FROM public.dealer_support_history h WHERE h.source_key=s.source_key)),
  grouped AS (SELECT product_id,product_code,product_name,unit_name,brand_name,company_name,
    COALESCE(sum(quantity) FILTER(WHERE NOT order_cancelled),0) issued,
    COALESCE(sum(returned_quantity) FILTER(WHERE NOT order_cancelled),0) returned,
    COALESCE(sum(quantity-returned_quantity) FILTER(WHERE NOT order_cancelled),0) remaining
    FROM all_rows GROUP BY product_id,product_code,product_name,unit_name,brand_name,company_name)
  SELECT COALESCE(jsonb_agg(to_jsonb(grouped) ORDER BY product_name,brand_name,company_name),'[]') INTO summaries FROM grouped;
  RETURN jsonb_build_object('rows',rows_data,'summary',summaries,'total',total,'offset',p_offset,'limit',p_limit,
    'selection_confirmed',(SELECT selection_confirmed FROM public.dealer_support_control WHERE id));
END $$;

-- Fill notes on previously retained rows only when their exact source survives.
-- Notes of orders already deleted before this migration remain unknown/blank.
UPDATE public.dealer_support_history h SET order_notes=COALESCE(o.notes,'')
  FROM public.order_items i JOIN public.orders o ON o.id=i.order_id
  WHERE h.source_key=encode(sha256(convert_to(i.id,'UTF8')),'hex') AND h.customer_id=o.customer_id
    AND h.order_notes IS DISTINCT FROM COALESCE(o.notes,'');

INSERT INTO public.schema_migrations(version,description)
  VALUES ('0123','Show exact source order notes in dealer support history and retain notes with quantity facts') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
