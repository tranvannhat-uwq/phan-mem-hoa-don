-- STAGING ONLY. Synthetic data, rollback-only. Never run on production.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.orders LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.profiles LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.bom_items LIMIT 1) THEN
    RAISE EXCEPTION 'This fixture requires an empty staging database.';
  END IF;
END $$;

INSERT INTO auth.users(id,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('92000000-0000-4000-8000-000000000001','bom92@test.invalid','{}','{}',now(),now());
UPDATE public.profiles SET role='admin' WHERE auth_user_id='92000000-0000-4000-8000-000000000001';
INSERT INTO public.companies(id,code,name) VALUES('BOM92-COMP','BOM92-COMP','Synthetic company');
UPDATE public.profiles SET company_id='BOM92-COMP' WHERE auth_user_id='92000000-0000-4000-8000-000000000001';
INSERT INTO public.brands(name,id,company_id) VALUES('BOM92','bom92-brand','BOM92-COMP');
INSERT INTO public.products(id,code,variant_code,name,brand,brand_id,packaging_name,package_type,weight_or_volume,unit_name)
VALUES('bom92-sku','BOM92-SKU','BOM92-SKU','Synthetic paint','BOM92','bom92-brand','Lon','Lon',1,'kg');

CREATE TEMP TABLE bom92_values(step text PRIMARY KEY,result jsonb);
GRANT ALL ON bom92_values TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000001',true);
INSERT INTO bom92_values VALUES('raw',public.rpc_bom_save_item('{"code":"BOM92-RAW","name":"Synthetic raw","kind":"raw","baseUnit":"kg","purchaseUnit":"bag","purchaseToBase":25}'));
INSERT INTO bom92_values VALUES('semi',public.rpc_bom_save_item('{"code":"BOM92-SEMI","name":"Synthetic semi","kind":"semi","baseUnit":"kg","purchaseUnit":"kg","purchaseToBase":1}'));
INSERT INTO bom92_values VALUES('pack',public.rpc_bom_save_item('{"code":"BOM92-PACK","name":"Synthetic pack","kind":"packaging","baseUnit":"pcs","purchaseUnit":"box","purchaseToBase":100}'));
INSERT INTO bom92_values SELECT 'semi-draft',public.rpc_bom_save_draft(jsonb_build_object(
  'outputKind','semi','outputId',(SELECT result->>'id' FROM bom92_values WHERE step='semi'),
  'outputQuantity',10,'lines',jsonb_build_array(jsonb_build_object('itemId',
    (SELECT result->>'id' FROM bom92_values WHERE step='raw'),'quantity',12))));
SELECT public.rpc_bom_publish((SELECT result->>'id' FROM bom92_values WHERE step='semi-draft')::uuid);
INSERT INTO bom92_values SELECT 'sku-draft',public.rpc_bom_save_draft(jsonb_build_object(
  'outputKind','sku','outputId','bom92-sku','outputQuantity',5,'lines',jsonb_build_array(
    jsonb_build_object('itemId',(SELECT result->>'id' FROM bom92_values WHERE step='semi'),'quantity',5),
    jsonb_build_object('itemId',(SELECT result->>'id' FROM bom92_values WHERE step='pack'),'quantity',5))));
SELECT public.rpc_bom_publish((SELECT result->>'id' FROM bom92_values WHERE step='sku-draft')::uuid);
SELECT public.rpc_bom_post_item(jsonb_build_object('requestKey','92000000-0000-4000-8000-000000000011',
  'kind','receipt','itemId',(SELECT result->>'id' FROM bom92_values WHERE step='raw'),'quantity',2,'unit','purchase'));
SELECT public.rpc_bom_post_item(jsonb_build_object('requestKey','92000000-0000-4000-8000-000000000012',
  'kind','receipt','itemId',(SELECT result->>'id' FROM bom92_values WHERE step='pack'),'quantity',1,'unit','purchase'));
INSERT INTO bom92_values SELECT 'semi-run',public.rpc_bom_run(jsonb_build_object(
  'requestKey','92000000-0000-4000-8000-000000000013',
  'versionId',(SELECT result->>'id' FROM bom92_values WHERE step='semi-draft'),'quantity',10));
INSERT INTO bom92_values SELECT 'retry',public.rpc_bom_run(jsonb_build_object(
  'requestKey','92000000-0000-4000-8000-000000000013',
  'versionId',(SELECT result->>'id' FROM bom92_values WHERE step='semi-draft'),'quantity',10));
INSERT INTO bom92_values SELECT 'sku-run',public.rpc_bom_run(jsonb_build_object(
  'requestKey','92000000-0000-4000-8000-000000000014',
  'versionId',(SELECT result->>'id' FROM bom92_values WHERE step='sku-draft'),'quantity',5));
INSERT INTO bom92_values SELECT 'search',public.rpc_bom_window('{"mode":"items","query":"BOM92-PACK","limit":15}');
DO $$
DECLARE failed boolean:=false;
BEGIN
  BEGIN
    PERFORM public.rpc_bom_run(jsonb_build_object('requestKey','92000000-0000-4000-8000-000000000015',
      'versionId',(SELECT result->>'id' FROM bom92_values WHERE step='sku-draft'),'quantity',20));
  EXCEPTION WHEN OTHERS THEN failed:=position('không đủ tồn' IN SQLERRM)>0; END;
  IF NOT failed THEN RAISE EXCEPTION 'Underflow was not rejected'; END IF;
END $$;
RESET ROLE;

DO $$ BEGIN
  IF (SELECT result->>'replayed' FROM bom92_values WHERE step='retry')<>'true'
    OR (SELECT result->>'id' FROM bom92_values WHERE step='retry')<>
       (SELECT result->>'id' FROM bom92_values WHERE step='semi-run')
    OR (SELECT quantity FROM public.bom_item_balances WHERE item_id=(SELECT result->>'id' FROM bom92_values WHERE step='raw')::uuid)<>38
    OR (SELECT quantity FROM public.bom_item_balances WHERE item_id=(SELECT result->>'id' FROM bom92_values WHERE step='semi')::uuid)<>5
    OR (SELECT quantity FROM public.bom_item_balances WHERE item_id=(SELECT result->>'id' FROM bom92_values WHERE step='pack')::uuid)<>95
    OR (SELECT quantity FROM public.inventory_balances WHERE product_id='bom92-sku')<>5
    OR (SELECT count(*) FROM public.bom_runs)<>2
    OR (SELECT count(*) FROM public.inventory_movements WHERE production_run_id IS NOT NULL)<>1
    OR (SELECT jsonb_array_length(result->'rows') FROM bom92_values WHERE step='search')<>1
  THEN RAISE EXCEPTION 'BOM two-stage invariant failed'; END IF;
END $$;
SELECT '0092 BOM two-stage invariants passed; fixtures will roll back' AS result;
ROLLBACK;
