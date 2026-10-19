BEGIN;

-- Older catalog rows can store their sellable package in packaging_name while
-- package_type is empty. Treat either field as the package discriminator in
-- the bounded invoice search and family picker.
CREATE OR REPLACE FUNCTION public.rpc_egress_search_products(
  p_query text DEFAULT '', p_limit integer DEFAULT 30,
  p_after_code text DEFAULT NULL, p_after_id text DEFAULT NULL,
  p_saleable_only boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  query_text text := btrim(COALESCE(p_query, ''));
  normalized_query text;
  query_terms text[];
  safe_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 50);
  page jsonb; result jsonb; has_more boolean; page_length integer;
BEGIN
  PERFORM public.require_authenticated_profile();
  IF octet_length(query_text) > 240
    OR (p_after_code IS NULL) <> (p_after_id IS NULL)
    OR octet_length(COALESCE(p_after_code, '')) > 256
    OR octet_length(COALESCE(p_after_id, '')) > 256 THEN
    RAISE EXCEPTION 'Invalid product lookup filter.' USING ERRCODE = '22023';
  END IF;

  normalized_query := btrim(regexp_replace(
    public.egress_fold_vietnamese(query_text), '[^a-z0-9]+', ' ', 'g'));
  query_terms := regexp_split_to_array(normalized_query, '[[:space:]]+');

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
    WHERE (normalized_query = '' OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(query_terms) AS query_term(token)
      WHERE query_term.token <> ''
        AND position(query_term.token IN btrim(regexp_replace(
          public.egress_fold_vietnamese(concat_ws(' ', p.code,
            COALESCE(p.variant_code, ''), COALESCE(p.base_code, ''), p.name,
            p.brand, COALESCE(p.package_type, ''), COALESCE(p.packaging_name, ''),
            COALESCE(p.package_weight::text, ''), COALESCE(p.weight_or_volume::text, ''),
            COALESCE(p.package_weight_unit, ''), COALESCE(p.unit_name, ''),
            COALESCE(p.display_specification, ''), COALESCE(p.barcode, ''))),
          '[^a-z0-9]+', ' ', 'g'))) = 0
    ))
      AND (NOT COALESCE(p_saleable_only, false) OR
        (p.is_active = true AND p.is_legacy = false
          AND COALESCE(NULLIF(p.package_type, ''), NULLIF(p.packaging_name, '')) IS NOT NULL))
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
      RAISE EXCEPTION 'Product lookup row exceeds the 32 KiB response cap.' USING ERRCODE = '54000';
    END IF;
    page := page - (page_length - 1);
    has_more := true;
  END LOOP;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_egress_product_family(
  p_product_id text, p_limit integer DEFAULT 50, p_after_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  source_product public.products%ROWTYPE;
  safe_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  page jsonb; result jsonb; has_more boolean; page_length integer;
BEGIN
  PERFORM public.require_authenticated_profile();
  IF p_product_id IS NULL OR p_product_id = '' OR octet_length(p_product_id) > 256
    OR octet_length(COALESCE(p_after_id, '')) > 256 THEN
    RAISE EXCEPTION 'Invalid product family filter.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO source_product FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('data', '[]'::jsonb, 'hasMore', false, 'nextCursor', NULL);
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(candidate) ORDER BY candidate.id), '[]'::jsonb)
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
      AND (p.id = source_product.id OR (
        lower(p.name) = lower(source_product.name)
        AND lower(p.brand) = lower(source_product.brand)
        AND ((NULLIF(source_product.product_group_id, '') IS NOT NULL
            AND p.product_group_id = source_product.product_group_id)
          OR (NULLIF(source_product.base_code, '') IS NOT NULL
            AND p.base_code = source_product.base_code))))
      AND (p_after_id IS NULL OR p.id > p_after_id)
    ORDER BY p.id
    LIMIT safe_limit + 1
  ) candidate;

  has_more := jsonb_array_length(page) > safe_limit;
  IF has_more THEN page := page - (jsonb_array_length(page) - 1); END IF;
  LOOP
    page_length := jsonb_array_length(page);
    result := jsonb_build_object(
      'data', page, 'hasMore', has_more,
      'nextCursor', CASE WHEN page_length = 0 THEN NULL ELSE page->(page_length - 1)->>'id' END);
    EXIT WHEN octet_length(result::text) <= 32768;
    IF page_length <= 1 THEN
      RAISE EXCEPTION 'Product family row exceeds the 32 KiB response cap.' USING ERRCODE = '54000';
    END IF;
    page := page - (page_length - 1);
    has_more := true;
  END LOOP;
  RETURN result;
END $$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0096', 'Use package name fallback in invoice product lookup');
NOTIFY pgrst, 'reload schema';
COMMIT;
