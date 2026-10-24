BEGIN;

-- Purchase existing shell SKUs from Products. A paint SKU is not a shell SKU:
-- never manufacture a new "VO-..." identity from a finished-paint variant.
CREATE FUNCTION public.rpc_purchase_catalog(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE query_text text; terms text[]; shell_search boolean; page_limit integer;
  after_rank integer; after_code text; after_id text; rows_json jsonb; result jsonb;
BEGIN
  PERFORM private.inventory_require_manager();
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'object' OR octet_length(p_filters::text)>2048
    OR length(COALESCE(p_filters->>'query',''))>80 THEN
    RAISE EXCEPTION 'Bộ lọc mua hàng không hợp lệ.';
  END IF;
  page_limit := COALESCE((p_filters->>'limit')::integer,30);
  IF page_limit NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Mỗi trang cần 1–30 dòng.'; END IF;
  query_text := public.egress_normalize_catalog_text(COALESCE(p_filters->>'query',''));
  terms := CASE WHEN query_text='' THEN ARRAY[]::text[] ELSE string_to_array(query_text,' ') END;
  shell_search := 'vo'=ANY(terms);
  IF p_filters->'cursor' IS NOT NULL AND p_filters->'cursor' <> 'null'::jsonb THEN
    IF jsonb_typeof(p_filters->'cursor') <> 'object'
      OR COALESCE(p_filters->'cursor'->>'source','') NOT IN ('product','material')
      OR NULLIF(p_filters->'cursor'->>'code','') IS NULL
      OR NULLIF(p_filters->'cursor'->>'id','') IS NULL THEN
      RAISE EXCEPTION 'Cursor mua hàng không hợp lệ.';
    END IF;
    after_rank := CASE WHEN p_filters->'cursor'->>'source'='product' THEN 0 ELSE 1 END;
    after_code := p_filters->'cursor'->>'code';
    after_id := p_filters->'cursor'->>'id';
  END IF;
  WITH catalog AS (
    SELECT 0 AS rank,'product:'||p.id AS id,'product'::text AS source,p.id AS product_id,
      CASE WHEN public.egress_normalize_catalog_text(p.code) ~ '^vo '
        THEN btrim(p.code) ELSE btrim(p.variant_code) END AS code,
      p.name,p.brand,
      COALESCE(NULLIF(btrim(p.packaging_name),''),NULLIF(btrim(p.package_type),''),'cái') AS purchase_unit,
      p.purchase_price AS unit_price,true AS is_active,
      public.egress_normalize_catalog_text(concat_ws(' ',p.code,p.variant_code,p.base_code,p.name,p.brand)) AS search_text
    FROM public.products p WHERE p.is_active AND NOT p.is_legacy
      AND (public.egress_normalize_catalog_text(p.code) ~ '^vo '
        OR public.egress_normalize_catalog_text(COALESCE(p.variant_code,'')) ~ '^vo ')
    UNION ALL
    SELECT 1,i.id::text,'material',NULL,i.code,i.name,NULL,i.purchase_unit,
      NULL::numeric,i.is_active,public.egress_normalize_catalog_text(i.code||' '||i.name)
    FROM public.bom_items i
    WHERE i.is_active AND (to_jsonb(i)->>'source_product_id') IS NULL
      AND (NOT shell_search OR i.kind<>'packaging')
  ), candidates AS (
    SELECT * FROM catalog c
    WHERE NOT EXISTS (SELECT 1 FROM unnest(terms) t WHERE strpos(c.search_text,t)=0)
      AND (after_rank IS NULL OR (c.rank,c.code,c.id)>(after_rank,after_code,after_id))
    ORDER BY c.rank,c.code,c.id LIMIT page_limit+1
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(c)-'rank'-'search_text' ORDER BY rank,code,id),'[]'::jsonb)
  INTO rows_json FROM candidates c;
  result := jsonb_build_object('rows',rows_json,'hasMore',jsonb_array_length(rows_json)>page_limit,'nextCursor',NULL);
  IF jsonb_array_length(rows_json)>page_limit THEN rows_json:=rows_json-page_limit; END IF;
  WHILE octet_length(rows_json::text)>30000 LOOP
    IF jsonb_array_length(rows_json)<=1 THEN RAISE EXCEPTION 'Dòng danh mục vượt giới hạn phản hồi.'; END IF;
    rows_json:=rows_json-(jsonb_array_length(rows_json)-1);
    result:=jsonb_set(result,'{hasMore}','true'::jsonb);
  END LOOP;
  result:=jsonb_set(result,'{rows}',rows_json);
  IF (result->>'hasMore')::boolean THEN
    result:=jsonb_set(result,'{nextCursor}',jsonb_build_object(
      'source',rows_json->-1->>'source','code',rows_json->-1->>'code','id',rows_json->-1->>'id'));
  END IF;
  PERFORM private.inventory_charge(octet_length(result::text)*2+8192);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.rpc_purchase_catalog(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_purchase_catalog(jsonb) TO authenticated;

-- Cached old browsers must not create synthetic shells for every paint SKU.
CREATE OR REPLACE FUNCTION public.rpc_bom_add_product_packaging() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.inventory_require_manager();
  RAISE EXCEPTION 'Vỏ được lấy trực tiếp từ Danh sách sản phẩm. Tải lại trang để dùng danh mục mới.';
END $$;
REVOKE ALL ON FUNCTION public.rpc_bom_add_product_packaging() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_bom_add_product_packaging() TO authenticated;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0105','Use existing product shell SKUs in the purchase picker instead of generated packaging');
NOTIFY pgrst, 'reload schema';
COMMIT;
