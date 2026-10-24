BEGIN;

-- Keep a separate material for each sellable SKU, including variants and brands
-- that happen to share a displayed code. Existing generic packaging is retained.
ALTER TABLE public.bom_items ADD COLUMN source_product_id text
  REFERENCES public.products(id) ON DELETE SET NULL;
ALTER TABLE public.bom_items ADD CONSTRAINT bom_items_source_product_unique UNIQUE (source_product_id);
ALTER TABLE public.bom_items ADD CONSTRAINT bom_items_source_product_packaging
  CHECK (source_product_id IS NULL OR kind = 'packaging');

CREATE FUNCTION private.bom_add_product_packaging() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE added integer;
BEGIN
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  PERFORM private.inventory_guard_storage();
  INSERT INTO public.bom_items(code, name, kind, base_unit, purchase_unit,
    purchase_to_base, source_product_id)
  SELECT
    'VO-' || left(p.sku_code, 38) || '-' || left(md5(p.id), 16),
    left(concat_ws(' · ', 'VỎ ' || upper(p.package_name) || ' ' || p.sku_code,
      NULLIF(btrim(p.brand), ''),
      NULLIF(btrim(concat_ws(' ', COALESCE(p.weight_or_volume, p.package_weight)::text,
        COALESCE(NULLIF(p.unit_name, ''), p.package_weight_unit))), ''), p.name), 120),
    'packaging', 'cái', 'cái', 1, p.id
  FROM (
    SELECT products.*,
      COALESCE(NULLIF(btrim(variant_code), ''), btrim(code)) AS sku_code,
      COALESCE(NULLIF(btrim(packaging_name), ''), NULLIF(btrim(package_type), '')) AS package_name
    FROM public.products
    WHERE is_active AND NOT is_legacy
  ) p
  WHERE p.package_name IS NOT NULL AND p.sku_code <> ''
    AND NOT EXISTS (SELECT 1 FROM public.bom_items i WHERE i.source_product_id = p.id)
  ON CONFLICT (source_product_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  -- A large catalogue must still fit within the shared module storage budget.
  PERFORM private.inventory_guard_storage();
  RETURN jsonb_build_object('created', added);
END $$;

CREATE FUNCTION public.rpc_bom_add_product_packaging() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; result jsonb;
BEGIN
  actor := private.inventory_require_manager();
  IF actor.role <> 'admin' THEN
    RAISE EXCEPTION 'Chỉ Admin được bổ sung danh mục vỏ sản phẩm.' USING ERRCODE = '42501';
  END IF;
  result := private.bom_add_product_packaging();
  PERFORM private.inventory_charge(8704);
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION private.bom_add_product_packaging() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_bom_add_product_packaging() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_bom_add_product_packaging() TO authenticated;

-- Populate the current catalogue now. Admin can add shells for new SKUs later
-- from the purchase form. No stock, prices or financial records are written.
SELECT private.bom_add_product_packaging();
INSERT INTO public.schema_migrations(version, description)
VALUES ('0101', 'Separate packaging material for every active sellable product SKU');
COMMIT;
