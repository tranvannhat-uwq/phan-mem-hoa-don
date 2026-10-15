-- Empty Supabase staging only. Synthetic Auth and catalogue rows are rolled back.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.orders LIMIT 1) THEN
    RAISE EXCEPTION 'Lookup fixture requires empty staging, not live business data.';
  END IF;
END $$;

INSERT INTO auth.users(id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('91000000-0000-4000-8000-000000000001', 'lookup-sale@test.invalid', '{}', '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000002', 'lookup-other@test.invalid', '{}', '{}', now(), now());

INSERT INTO public.customers(id, code, name, managed_by, status)
VALUES
  ('lookup-visible', 'LOOKUP-C1', 'Nguyễn Văn An', 'lookup-sale@test.invalid', 'active'),
  ('lookup-hidden', 'LOOKUP-C2', 'Nguyễn Văn Bình', 'lookup-other@test.invalid', 'active');
INSERT INTO public.products(id, code, name, brand, package_type, is_active, is_legacy)
VALUES ('lookup-sku', 'LOOKUP-P1', 'Sơn bóng', 'Đức Thịnh', 'Lon', true, false);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
DO $$
DECLARE customers jsonb; products jsonb; family jsonb;
BEGIN
  customers := public.rpc_egress_search_customers('Nguyen', 30);
  IF jsonb_array_length(customers->'data') <> 1
    OR customers->'data'->0->>'id' <> 'lookup-visible'
    OR public.rpc_egress_customer_detail('lookup-hidden') IS NOT NULL
    OR octet_length(customers::text) > 32768 THEN
    RAISE EXCEPTION 'Customer search, RLS or response bound failed';
  END IF;
  products := public.rpc_egress_search_products('son', 40, NULL, NULL, true);
  family := public.rpc_egress_product_family('lookup-sku', 50);
  IF jsonb_array_length(products->'data') <> 1
    OR products->'data'->0->>'id' <> 'lookup-sku'
    OR jsonb_array_length(family->'data') <> 1
    OR octet_length(products::text) > 32768 THEN
    RAISE EXCEPTION 'Product search, family or response bound failed';
  END IF;
END $$;
RESET ROLE;
SELECT '0090 bounded lookup and RLS invariants passed; all fixtures will roll back' AS result;
ROLLBACK;
