BEGIN;

-- The old browser search ignored Vietnamese accents. Keep that behavior for
-- bounded server lookup, including text stored in decomposed Unicode form.
CREATE FUNCTION public.egress_fold_vietnamese(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = '' AS $$
  SELECT pg_catalog.translate(
    pg_catalog.lower(pg_catalog.normalize(p_text, 'NFC')),
    'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ',
    repeat('a', 17) || repeat('e', 11) || repeat('i', 5) ||
    repeat('o', 17) || repeat('u', 11) || repeat('y', 5) || 'd'
  )
$$;

-- Invoice lookup is deliberately a separate API from the legacy full-row,
-- exact-count pagination RPC. SECURITY INVOKER leaves the existing customer
-- assignment and product policies in force for each returned row.
CREATE FUNCTION public.rpc_egress_search_customers(
  p_query text DEFAULT '', p_limit integer DEFAULT 30,
  p_after_code text DEFAULT NULL, p_after_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  query_text text := btrim(COALESCE(p_query, ''));
  folded_query text := public.egress_fold_vietnamese(query_text);
  safe_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 50);
  page jsonb; result jsonb; has_more boolean; page_length integer;
BEGIN
  PERFORM public.require_authenticated_profile();
  IF octet_length(query_text) > 240
    OR (p_after_code IS NULL) <> (p_after_id IS NULL)
    OR octet_length(COALESCE(p_after_code, '')) > 256
    OR octet_length(COALESCE(p_after_id, '')) > 256 THEN
    RAISE EXCEPTION 'Invalid customer lookup filter.' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(candidate) ORDER BY candidate.code, candidate.id), '[]'::jsonb)
  INTO page FROM (
    SELECT c.id, c.code, c.name, c.phone, c.phone2, c.address,
      c.assigned_brand, c.brand_discounts, c.shipping_support, c.debt,
      c.pricelist_id, c.default_price_list_id, c.customer_group_id,
      c.managed_by, c.status, c.deleted_at, c.notes, c.updated_at
    FROM public.customers c
    WHERE (query_text = '' OR position(folded_query in public.egress_fold_vietnamese(c.code)) > 0
      OR position(folded_query in public.egress_fold_vietnamese(c.name)) > 0
      OR position(folded_query in public.egress_fold_vietnamese(COALESCE(c.phone, ''))) > 0
      OR position(folded_query in public.egress_fold_vietnamese(COALESCE(c.phone2, ''))) > 0)
      AND (p_after_code IS NULL OR (c.code, c.id) > (p_after_code, p_after_id))
    ORDER BY c.code, c.id
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
      RAISE EXCEPTION 'Customer lookup row exceeds the 32 KiB response cap.' USING ERRCODE = '54000';
    END IF;
    page := page - (page_length - 1);
    has_more := true;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION public.rpc_egress_customer_detail(p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.require_authenticated_profile();
  IF p_id IS NULL OR p_id = '' OR octet_length(p_id) > 256 THEN
    RAISE EXCEPTION 'Invalid customer ID.' USING ERRCODE = '22023';
  END IF;
  SELECT to_jsonb(c) INTO result FROM (
    SELECT id, code, name, phone, phone2, email, facebook, birthday,
      gender, avatar_url, province, ward, customer_group_id, company_name,
      tax_code, invoice_address, address, status, created_by,
      assigned_brand, brand_discounts, shipping_support, debt,
      total_transaction, total_return, net_revenue,
      imported_debt_baseline, imported_total_transaction_baseline,
      imported_total_return_baseline, imported_net_revenue_baseline,
      imported_last_order_at_baseline, imported_created_at_baseline,
      financial_baseline_imported_at, last_order_at, last_payment_at,
      notes, pricelist_id, default_price_list_id, managed_by,
      created_at, updated_at, deleted_at
    FROM public.customers WHERE id = p_id
  ) c;
  IF result IS NOT NULL AND octet_length(result::text) > 32768 THEN
    RAISE EXCEPTION 'Customer detail exceeds the 32 KiB response cap.' USING ERRCODE = '54000';
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.rpc_egress_search_products(
  p_query text DEFAULT '', p_limit integer DEFAULT 30,
  p_after_code text DEFAULT NULL, p_after_id text DEFAULT NULL,
  p_saleable_only boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  query_text text := btrim(COALESCE(p_query, ''));
  folded_query text := public.egress_fold_vietnamese(query_text);
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
    WHERE (query_text = '' OR position(folded_query in public.egress_fold_vietnamese(p.code)) > 0
      OR position(folded_query in public.egress_fold_vietnamese(COALESCE(p.variant_code, ''))) > 0
      OR position(folded_query in public.egress_fold_vietnamese(COALESCE(p.base_code, ''))) > 0
      OR position(folded_query in public.egress_fold_vietnamese(p.name)) > 0
      OR position(folded_query in public.egress_fold_vietnamese(p.brand)) > 0
      OR position(folded_query in public.egress_fold_vietnamese(COALESCE(p.barcode, ''))) > 0)
      AND (NOT COALESCE(p_saleable_only, false) OR
        (p.is_active = true AND p.is_legacy = false AND NULLIF(p.package_type, '') IS NOT NULL))
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

CREATE FUNCTION public.rpc_egress_product_detail(p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.require_authenticated_profile();
  IF p_id IS NULL OR p_id = '' OR octet_length(p_id) > 256 THEN
    RAISE EXCEPTION 'Invalid product ID.' USING ERRCODE = '22023';
  END IF;
  SELECT to_jsonb(p) INTO result FROM (
    SELECT id, code, variant_code, product_group_id, base_product_id,
      parent_product_id, base_code, name, brand, brand_id, product_group,
      payroll_product_group_id, package_type, packaging_name, package_weight,
      weight_or_volume, package_weight_unit, unit_name,
      display_specification, conversion_quantity, barcode, purchase_price,
      is_active, is_legacy, created_at, updated_at
    FROM public.products WHERE id = p_id
  ) p;
  IF result IS NOT NULL AND octet_length(result::text) > 32768 THEN
    RAISE EXCEPTION 'Product detail exceeds the 32 KiB response cap.' USING ERRCODE = '54000';
  END IF;
  RETURN result;
END $$;

-- A matched SKU is not enough to render a variant picker: fetch its exact
-- family in bounded pages instead of loading the entire product catalogue.
CREATE FUNCTION public.rpc_egress_product_family(
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
      AND NULLIF(p.package_type, '') IS NOT NULL
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

REVOKE ALL ON FUNCTION public.egress_fold_vietnamese(text),
  public.rpc_egress_search_customers(text,integer,text,text),
  public.rpc_egress_customer_detail(text),
  public.rpc_egress_search_products(text,integer,text,text,boolean),
  public.rpc_egress_product_detail(text),
  public.rpc_egress_product_family(text,integer,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.egress_fold_vietnamese(text),
  public.rpc_egress_search_customers(text,integer,text,text),
  public.rpc_egress_customer_detail(text),
  public.rpc_egress_search_products(text,integer,text,text,boolean),
  public.rpc_egress_product_detail(text),
  public.rpc_egress_product_family(text,integer,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0090', 'RLS-scoped bounded customer and product lookup for low-egress invoice search');
NOTIFY pgrst, 'reload schema';
COMMIT;
