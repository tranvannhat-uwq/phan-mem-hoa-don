BEGIN;

-- Keep minimal quantity facts for explicitly selected SKUs. No invoice prices,
-- order payloads, customer contact details, debt or inventory are copied.
ALTER TABLE public.products ADD COLUMN retain_dealer_support_history boolean NOT NULL DEFAULT false;
CREATE TABLE public.dealer_support_control (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  selection_confirmed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.dealer_support_control(id) VALUES(true);
CREATE TABLE public.dealer_support_history (
  source_key text PRIMARY KEY CHECK(source_key ~ '^[0-9a-f]{64}$'),
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_id text NOT NULL,
  product_code text NOT NULL,
  product_name text NOT NULL,
  unit_name text NOT NULL,
  brand_id text,
  brand_name text NOT NULL,
  company_id text,
  company_name text NOT NULL,
  quantity numeric NOT NULL CHECK(quantity>0 AND quantity::text NOT IN('NaN','Infinity','-Infinity')),
  returned_quantity numeric NOT NULL DEFAULT 0 CHECK(returned_quantity>=0 AND returned_quantity<=quantity AND returned_quantity::text NOT IN('NaN','Infinity','-Infinity')),
  business_date timestamptz NOT NULL,
  order_cancelled boolean NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dealer_support_customer_date_idx ON public.dealer_support_history(customer_id,business_date DESC,source_key);
ALTER TABLE public.sales_return_items ADD COLUMN dealer_support_source_key text
  REFERENCES public.dealer_support_history(source_key) ON DELETE RESTRICT;
ALTER TABLE public.dealer_support_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dealer_support_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dealer_support_control,public.dealer_support_history FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.p114_source_lines() RETURNS TABLE(
  source_key text,customer_id text,product_id text,product_code text,product_name text,unit_name text,
  brand_id text,brand_name text,company_id text,company_name text,quantity numeric,returned_quantity numeric,
  business_date timestamptz,order_cancelled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT encode(sha256(convert_to(i.id,'UTF8')),'hex'),o.customer_id,p.id,
    COALESCE(NULLIF(i.variant_code_snapshot,''),NULLIF(i.product_code_snapshot,''),p.variant_code,p.code,''),
    COALESCE(NULLIF(i.product_name_snapshot,''),p.name,''),
    COALESCE(NULLIF(i.unit_snapshot,''),NULLIF(p.unit_name,''),NULLIF(to_jsonb(p)->>'unit',''),p.packaging_name,''),
    COALESCE(NULLIF(i.brand_id,''),b.id,p.brand_id),COALESCE(b.name,p.brand,''),
    o.company_id,COALESCE(company.name,o.company_id,''),i.quantity,COALESCE(i.returned_quantity,0),
    COALESCE(o.order_date,o.created_at),o.status IN('cancelled','canceled')
  FROM public.order_items i JOIN public.orders o ON o.id=i.order_id
  JOIN LATERAL (SELECT product.* FROM public.products product
    WHERE product.id IN(NULLIF(i.variant_id,''),i.product_id)
    ORDER BY (product.id=NULLIF(i.variant_id,'')) DESC NULLS LAST,product.id LIMIT 1) p ON p.retain_dealer_support_history
  LEFT JOIN LATERAL (SELECT brand.id,brand.name FROM public.brands brand
    WHERE brand.id=COALESCE(NULLIF(i.brand_id,''),p.brand_id) OR brand.name=COALESCE(NULLIF(i.brand_id,''),p.brand)
    ORDER BY brand.id LIMIT 1) b ON true
  LEFT JOIN public.companies company ON company.id=o.company_id
  WHERE o.status IN('settled','partially_returned','returned','cancelled','canceled')
$$;

CREATE FUNCTION public.p114_preserve_support(p_cutoff timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.p107_is_executing() THEN RAISE EXCEPTION 'Support snapshots require the bound retention transaction' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.p114_source_lines() s JOIN public.dealer_support_history h USING(source_key)
    WHERE s.business_date<p_cutoff AND to_jsonb(s) IS DISTINCT FROM to_jsonb(h)-'saved_at') THEN
    RAISE EXCEPTION 'Lịch sử hàng cấp đã lưu khác chứng từ nguồn; chưa xóa gì, cần đối soát.';
  END IF;
  INSERT INTO public.dealer_support_history(source_key,customer_id,product_id,product_code,product_name,unit_name,
    brand_id,brand_name,company_id,company_name,quantity,returned_quantity,business_date,order_cancelled)
    SELECT * FROM public.p114_source_lines() WHERE business_date<p_cutoff ON CONFLICT(source_key) DO NOTHING;
  -- Current returns against a disappearing source still need to reverse their
  -- quantity fact if cancelled later. This pointer contains no invoice body.
  UPDATE public.sales_return_items ri SET dealer_support_source_key=h.source_key
    FROM public.order_items i,public.dealer_support_history h
    WHERE ri.sale_item_id=i.id AND h.source_key=encode(sha256(convert_to(i.id,'UTF8')),'hex')
      AND h.business_date<p_cutoff;
  IF EXISTS(SELECT 1 FROM public.p114_source_lines() s WHERE s.business_date<p_cutoff
    AND NOT EXISTS(SELECT 1 FROM public.dealer_support_history h WHERE h.source_key=s.source_key)) THEN
    RAISE EXCEPTION 'Chưa lưu đủ lịch sử hàng cấp; đã hủy lần dọn.';
  END IF;
END $$;

CREATE FUNCTION public.p114_guard_product_selection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  IF (TG_OP='INSERT' AND NEW.retain_dealer_support_history)
    OR (TG_OP='UPDATE' AND NEW.retain_dealer_support_history IS DISTINCT FROM OLD.retain_dealer_support_history) THEN
    IF auth.uid() IS NOT NULL THEN
      actor:=public.require_authenticated_profile();
      IF actor.role<>'admin' THEN RAISE EXCEPTION 'Chỉ Admin được chọn SKU giữ lịch sử cấp.' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p114_support_selection BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.p114_guard_product_selection();

CREATE FUNCTION public.p114_return_status_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE adjustment integer; item record;
BEGIN
  adjustment:=(CASE WHEN NEW.status IN('cancelled','canceled') THEN 0 ELSE 1 END)
    -(CASE WHEN OLD.status IN('cancelled','canceled') THEN 0 ELSE 1 END);
  IF adjustment=0 THEN RETURN NEW; END IF;
  FOR item IN SELECT dealer_support_source_key key,sum(quantity) qty FROM public.sales_return_items
    WHERE return_id=NEW.id AND dealer_support_source_key IS NOT NULL GROUP BY dealer_support_source_key ORDER BY dealer_support_source_key LOOP
    UPDATE public.dealer_support_history SET returned_quantity=returned_quantity+adjustment*item.qty WHERE source_key=item.key;
    IF NOT FOUND THEN RAISE EXCEPTION 'Thiếu lịch sử hàng cấp khi đảo phiếu trả; giao dịch đã hủy.'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER p114_support_return AFTER UPDATE OF status ON public.sales_returns
  FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.p114_return_status_changed();

CREATE FUNCTION public.rpc_dealer_support_products(p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; rows_data jsonb; total bigint; confirmed boolean;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role<>'admin' THEN RAISE EXCEPTION 'Chỉ Admin được cấu hình lịch sử hàng cấp.' USING ERRCODE='42501'; END IF;
  IF length(COALESCE(p_search,''))>100 OR p_offset IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Bộ lọc không hợp lệ.';
  END IF;
  SELECT selection_confirmed INTO confirmed FROM public.dealer_support_control WHERE id;
  WITH choices AS (SELECT p.id,COALESCE(p.variant_code,p.code) code,p.name,p.brand,COALESCE(b.company_id,'') company_id,
    COALESCE(company.name,b.company_id,'') company_name,p.is_active,p.retain_dealer_support_history selected,
    (lower(p.name) LIKE 'quạt màu%' OR lower(p.name) LIKE 'ấm chén%') suggested
    FROM public.products p LEFT JOIN LATERAL (SELECT company_id FROM public.brands
      WHERE id=p.brand_id OR name=p.brand ORDER BY id LIMIT 1) b ON true
    LEFT JOIN public.companies company ON company.id=b.company_id
    WHERE NOT p.is_legacy AND (COALESCE(p_search,'')='' OR strpos(lower(concat_ws(' ',p.code,p.variant_code,p.name,p.brand,company.name)),lower(p_search))>0))
  SELECT count(*) INTO total FROM choices;
  WITH choices AS (SELECT p.id,COALESCE(p.variant_code,p.code) code,p.name,p.brand,
    COALESCE(company.name,b.company_id,'') company_name,p.is_active,p.retain_dealer_support_history selected,
    (lower(p.name) LIKE 'quạt màu%' OR lower(p.name) LIKE 'ấm chén%') suggested
    FROM public.products p LEFT JOIN LATERAL (SELECT company_id FROM public.brands
      WHERE id=p.brand_id OR name=p.brand ORDER BY id LIMIT 1) b ON true
    LEFT JOIN public.companies company ON company.id=b.company_id
    WHERE NOT p.is_legacy AND (COALESCE(p_search,'')='' OR strpos(lower(concat_ws(' ',p.code,p.variant_code,p.name,p.brand,company.name)),lower(p_search))>0)
    ORDER BY p.retain_dealer_support_history DESC,suggested DESC,p.name,p.brand,p.id LIMIT p_limit OFFSET p_offset)
  SELECT COALESCE(jsonb_agg(to_jsonb(choices)),'[]') INTO rows_data FROM choices;
  RETURN jsonb_build_object('rows',rows_data,'total',total,'offset',p_offset,'limit',p_limit,'selection_confirmed',confirmed,
    'selected_count',(SELECT count(*) FROM public.products WHERE retain_dealer_support_history));
END $$;

CREATE FUNCTION public.rpc_set_dealer_support_products(p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; item record;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role<>'admin' THEN RAISE EXCEPTION 'Chỉ Admin được chọn SKU giữ lịch sử cấp.' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes)>500 OR octet_length(p_changes::text)>100000 THEN
    RAISE EXCEPTION 'Danh sách thay đổi không hợp lệ.';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
    OR COALESCE(x->>'id','')='' OR jsonb_typeof(x->'selected') IS DISTINCT FROM 'boolean')
    OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_changes) x)<>jsonb_array_length(p_changes) THEN
    RAISE EXCEPTION 'Mỗi SKU cần đúng một lựa chọn có/không.';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) x WHERE NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=x->>'id' AND NOT p.is_legacy)) THEN
    RAISE EXCEPTION 'SKU không còn hợp lệ. Hãy tải lại danh sách.';
  END IF;
  FOR item IN SELECT p.id,(x->>'selected')::boolean selected FROM jsonb_array_elements(p_changes) x
    JOIN public.products p ON p.id=x->>'id' ORDER BY p.id FOR UPDATE OF p LOOP
    UPDATE public.products SET retain_dealer_support_history=item.selected WHERE id=item.id;
  END LOOP;
  UPDATE public.dealer_support_control SET selection_confirmed=true,updated_at=now(),updated_by=actor.auth_user_id WHERE id;
  RETURN jsonb_build_object('success',true,'selected_count',(SELECT count(*) FROM public.products WHERE retain_dealer_support_history));
END $$;

CREATE FUNCTION public.rpc_dealer_support_history(p_customer_id text,p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
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
  paged AS (SELECT * FROM all_rows ORDER BY business_date DESC,source_key LIMIT p_limit OFFSET p_offset)
  SELECT (SELECT count(*) FROM all_rows),COALESCE(jsonb_agg(to_jsonb(paged)),'[]') INTO total,rows_data FROM paged;
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

-- Extend the SAME backup, lock scope and atomic purge; never a post-delete task.
DO $migration$
DECLARE original text; anchor text; addition text;
BEGIN
  SELECT pg_get_functiondef('public.p107_snapshot_tables(boolean)'::regprocedure) INTO original;
  anchor:='''retention_retired_requests'',''activity_logs_archive_pre_20260804''';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0114: snapshot contract changed'; END IF;
  EXECUTE replace(original,anchor,'''retention_retired_requests'',''dealer_support_control'',''dealer_support_history'',''activity_logs_archive_pre_20260804''');
  SELECT pg_get_functiondef('public.p107_preview(boolean)'::regprocedure) INTO original;
  anchor:='SELECT jsonb_object_agg(key,jsonb_array_length(value)) INTO counts FROM jsonb_each(plan);';
  addition:=$patch$
  IF NOT COALESCE((SELECT selection_confirmed FROM public.dealer_support_control WHERE id),false) THEN
    blockers:=blockers||jsonb_build_array('Chưa xác nhận danh sách SKU giữ lịch sử hàng cấp. Vào Cấu hình, chọn và lưu danh sách trước khi dọn.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.p114_source_lines() s WHERE s.business_date<boundary AND
    (s.customer_id IS NULL OR s.quantity IS NULL OR s.quantity<=0 OR s.returned_quantity<0 OR s.returned_quantity>s.quantity
      OR s.quantity::text IN('NaN','Infinity','-Infinity') OR s.returned_quantity::text IN('NaN','Infinity','-Infinity')
      OR s.returned_quantity<COALESCE((SELECT sum(ri.quantity) FROM public.sales_return_items ri JOIN public.sales_returns r ON r.id=ri.return_id
        WHERE encode(sha256(convert_to(ri.sale_item_id,'UTF8')),'hex')=s.source_key AND r.status NOT IN('cancelled','canceled')),0))) THEN
    blockers:=blockers||jsonb_build_array('Hàng cấp thuộc kỳ xóa thiếu khách hoặc sai số lượng/trả hàng; cần đối soát trước.');
  END IF;
  counts:=counts||jsonb_build_object('support_history',(SELECT count(*) FROM public.p114_source_lines() s WHERE s.business_date<boundary));
  $patch$;
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0114: preview contract changed'; END IF;
  EXECUTE replace(original,anchor,anchor||addition);
  SELECT pg_get_functiondef('public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure) INTO original;
  anchor:='-- Snapshot every master field';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0114: purge contract changed'; END IF;
  EXECUTE replace(original,anchor,'PERFORM public.p114_preserve_support(job.cutoff);'||chr(10)||'  '||anchor);
END $migration$;

DO $permissions$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'p114_%' OR p.proname IN('rpc_dealer_support_products','rpc_set_dealer_support_products','rpc_dealer_support_history')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',entry.signature);
  END LOOP;
END $permissions$;
GRANT EXECUTE ON FUNCTION public.rpc_dealer_support_products(text,integer,integer),public.rpc_set_dealer_support_products(jsonb),
  public.rpc_dealer_support_history(text,integer,integer) TO authenticated;
UPDATE public.retention_control SET expected_trigger_hash=public.p107_trigger_fingerprint() WHERE id;
INSERT INTO public.schema_migrations(version,description) VALUES ('0114','Minimal SKU-selected dealer support history retained atomically beyond invoice deletion') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
