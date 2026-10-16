-- STAGING ONLY. Synthetic SKUs, rollback-only. Never run on production.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.orders LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.profiles LIMIT 1) THEN
    RAISE EXCEPTION 'This fixture requires an empty staging database.';
  END IF;
END $$;

INSERT INTO auth.users(id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('91000000-0000-4000-8000-000000000001', 'inventory-pages@test.invalid', '{}', '{}', now(), now());
UPDATE public.profiles SET role = 'admin' WHERE auth_user_id = '91000000-0000-4000-8000-000000000001';
INSERT INTO public.companies(id, code, name) VALUES ('INV91-COMP', 'INV91-COMP', 'Synthetic company');
UPDATE public.profiles SET company_id = 'INV91-COMP' WHERE auth_user_id = '91000000-0000-4000-8000-000000000001';
INSERT INTO public.brands(name, id, company_id) VALUES ('INV91', 'inv91-brand', 'INV91-COMP');
INSERT INTO public.products(id, code, variant_code, name, brand, brand_id, packaging_name,
                            package_type, weight_or_volume, unit_name)
SELECT 'inv91-sku-' || lpad(n::text, 3, '0'), 'INV91-' || lpad(n::text, 3, '0'),
       'INV91-' || lpad(n::text, 3, '0'), 'Synthetic product ' || n,
       'INV91', 'inv91-brand', 'Lon', 'Lon', 1, 'kg'
FROM generate_series(1, 35) AS n;

CREATE TEMP TABLE inventory91_pages(step text PRIMARY KEY, result jsonb);
GRANT ALL ON inventory91_pages TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
INSERT INTO inventory91_pages SELECT 'first', public.rpc_inventory_window('{"mode":"stock","limit":15}');
INSERT INTO inventory91_pages
SELECT 'second', public.rpc_inventory_window(jsonb_build_object(
  'mode', 'stock', 'limit', 15, 'cursor', (SELECT result->>'nextCursor' FROM inventory91_pages WHERE step = 'first')));
INSERT INTO inventory91_pages
SELECT 'third', public.rpc_inventory_window(jsonb_build_object(
  'mode', 'stock', 'limit', 15, 'cursor', (SELECT result->>'nextCursor' FROM inventory91_pages WHERE step = 'second')));
INSERT INTO inventory91_pages SELECT 'search', public.rpc_inventory_window('{"mode":"stock","limit":15,"query":"INV91-035"}');
RESET ROLE;

DO $$ BEGIN
  IF (SELECT jsonb_array_length(result->'rows') FROM inventory91_pages WHERE step = 'first') <> 15
     OR (SELECT result->>'hasMore' FROM inventory91_pages WHERE step = 'first') <> 'true'
     OR (SELECT jsonb_array_length(result->'rows') FROM inventory91_pages WHERE step = 'second') <> 15
     OR (SELECT result->>'hasMore' FROM inventory91_pages WHERE step = 'second') <> 'true'
     OR (SELECT jsonb_array_length(result->'rows') FROM inventory91_pages WHERE step = 'third') <> 5
     OR (SELECT result->>'hasMore' FROM inventory91_pages WHERE step = 'third') <> 'false'
     OR (SELECT jsonb_array_length(result->'rows') FROM inventory91_pages WHERE step = 'search') <> 1
     OR (SELECT result->'rows'->0->>'product_id' FROM inventory91_pages WHERE step = 'search') <> 'inv91-sku-035'
  THEN RAISE EXCEPTION 'Inventory 15-row pagination or search failed'; END IF;
END $$;

SELECT '0091 pagination and distant search passed; fixtures will roll back' AS result;
ROLLBACK;
