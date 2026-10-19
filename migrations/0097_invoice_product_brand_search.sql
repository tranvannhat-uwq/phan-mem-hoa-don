BEGIN;

CREATE FUNCTION public.egress_normalize_catalog_text(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = '' AS $$
  SELECT btrim(regexp_replace(public.egress_fold_vietnamese(p_text), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Filter the customer's brand before LIMIT. Filtering the first 40 rows in
-- the browser can otherwise hide every match belonging to that customer.
-- Keep the existing generic RPC available for older frontend releases.
CREATE FUNCTION public.rpc_egress_search_invoice_products(
  p_query text DEFAULT '', p_limit integer DEFAULT 40,
  p_after_code text DEFAULT NULL, p_after_id text DEFAULT NULL,
  p_brand text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  query_text text := btrim(COALESCE(p_query, ''));
  normalized_query text;
  query_terms text[];
  brand_text text := btrim(COALESCE(p_brand, ''));
  normalized_brand text;
  target_brand_id text;
  target_brand_name text;
  safe_limit integer := LEAST(GREATEST(COALESCE(p_limit, 40), 1), 50);
  page jsonb; result jsonb; has_more boolean; page_length integer;
BEGIN
  PERFORM public.require_authenticated_profile();
  IF octet_length(query_text) > 240 OR octet_length(brand_text) > 256
    OR (p_after_code IS NULL) <> (p_after_id IS NULL)
    OR octet_length(COALESCE(p_after_code, '')) > 256
    OR octet_length(COALESCE(p_after_id, '')) > 256 THEN
    RAISE EXCEPTION 'Invalid invoice product lookup filter.' USING ERRCODE = '22023';
  END IF;

  normalized_query := public.egress_normalize_catalog_text(query_text);
  IF normalized_query = '' THEN
    RETURN jsonb_build_object('data', '[]'::jsonb, 'hasMore', false, 'nextCursor', NULL);
  END IF;
  query_terms := regexp_split_to_array(normalized_query, '[[:space:]]+');
  normalized_brand := public.egress_normalize_catalog_text(brand_text);
  IF normalized_brand IN ('', 'all', 'tat ca') THEN
    normalized_brand := NULL;
  ELSE
    SELECT b.id, public.egress_normalize_catalog_text(b.name)
      INTO target_brand_id, target_brand_name
    FROM public.brands b
    WHERE b.id = brand_text
      OR public.egress_normalize_catalog_text(b.id) = normalized_brand
      OR public.egress_normalize_catalog_text(b.name) = normalized_brand
    ORDER BY (b.id = brand_text) DESC, b.id
    LIMIT 1;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(candidate) ORDER BY candidate.code, candidate.id), '[]'::jsonb)
  INTO page FROM (
    SELECT p.id, p.code, p.variant_code, p.product_group_id,
      p.base_product_id, p.parent_product_id, p.base_code,
      p.name, p.brand, p.brand_id, p.product_group,
      p.payroll_product_group_id, p.package_type, p.packaging_name,
      p.package_weight, p.weight_or_volume, p.package_weight_unit,
      p.unit_name, p.display_specification, p.conversion_quantity,
      p.barcode, p.purchase_price, p.is_active, p.is_legacy,
      p.created_at, p.updated_at
    FROM public.products p
    WHERE p.is_active = true AND p.is_legacy = false
      AND COALESCE(NULLIF(p.package_type, ''), NULLIF(p.packaging_name, '')) IS NOT NULL
      AND (normalized_brand IS NULL
        OR p.brand_id = target_brand_id
        OR public.egress_normalize_catalog_text(p.brand) = target_brand_name
        OR public.egress_normalize_catalog_text(p.brand) = normalized_brand
        OR public.egress_normalize_catalog_text(p.brand_id) = normalized_brand
        OR replace(public.egress_normalize_catalog_text(p.brand), ' ', '') IN ('festiva', 'festivanano')
        OR p.brand_id = 'brand_festivanano')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.unnest(query_terms) AS query_term(token)
        WHERE query_term.token <> ''
          AND position(query_term.token IN public.egress_normalize_catalog_text(concat_ws(' ',
            p.code, p.variant_code, p.base_code, p.name, p.brand,
            p.package_type, p.packaging_name, p.package_weight::text,
            p.weight_or_volume::text, p.package_weight_unit, p.unit_name,
            p.display_specification, p.barcode))) = 0
      )
      AND (p_after_code IS NULL OR (p.code, p.id) > (p_after_code, p_after_id))
    ORDER BY p.code, p.id
    LIMIT safe_limit + 1
  ) candidate;

  has_more := jsonb_array_length(page) > safe_limit;
  IF has_more THEN page := page - (jsonb_array_length(page) - 1); END IF;
  LOOP
    page_length := jsonb_array_length(page);
    result := jsonb_build_object(
      'data', page, 'hasMore', has_more,
      'nextCursor', CASE WHEN page_length = 0 THEN NULL ELSE
        jsonb_build_object('code', page->(page_length - 1)->>'code',
                           'id', page->(page_length - 1)->>'id') END);
    EXIT WHEN octet_length(result::text) <= 32768;
    IF page_length <= 1 THEN
      RAISE EXCEPTION 'Invoice product lookup row exceeds the 32 KiB response cap.' USING ERRCODE = '54000';
    END IF;
    page := page - (page_length - 1);
    has_more := true;
  END LOOP;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.egress_normalize_catalog_text(text),
  public.rpc_egress_search_invoice_products(text,integer,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.egress_normalize_catalog_text(text),
  public.rpc_egress_search_invoice_products(text,integer,text,text,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0097', 'Apply invoice customer brand before bounded product search pagination');
NOTIFY pgrst, 'reload schema';
COMMIT;
