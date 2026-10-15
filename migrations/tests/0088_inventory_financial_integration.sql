-- STAGING ONLY. Synthetic data, rollback-only. Never run on the live project.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.orders LIMIT 1) THEN
    RAISE EXCEPTION 'This fixture requires an empty staging database, not live business data.';
  END IF;
END $$;

INSERT INTO auth.users(id,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('88000000-0000-4000-8000-000000000001','inventory-admin@test.invalid','{}','{}',now(),now()),
       ('88000000-0000-4000-8000-000000000002','inventory-sale@test.invalid','{}','{}',now(),now());
UPDATE public.profiles SET role='admin' WHERE auth_user_id='88000000-0000-4000-8000-000000000001';
INSERT INTO public.companies(id,code,name) VALUES ('INV88-COMP','INV88-COMP','Synthetic company');
UPDATE public.profiles SET company_id='INV88-COMP' WHERE auth_user_id IN
 ('88000000-0000-4000-8000-000000000001','88000000-0000-4000-8000-000000000002');
INSERT INTO public.brands(name,id,company_id) VALUES ('INV88','inv88-brand','INV88-COMP');
INSERT INTO public.products(id,code,variant_code,name,brand,brand_id,packaging_name,package_type,weight_or_volume,unit_name)
VALUES ('inv88-sku','INV88-LON','INV88-LON','Synthetic paint','INV88','inv88-brand','Lon','Lon',1,'kg');
INSERT INTO public.customers(id,code,name,managed_by,status)
VALUES ('inv88-customer','INV88-C','Synthetic customer','inventory-sale@test.invalid','active');
INSERT INTO public.pricelists(id,name,type,price_list_type,is_active,is_available_for_sales)
VALUES ('inv88-prices','Synthetic prices','general','general',true,true);
INSERT INTO public.price_list_items(id,price_list_id,product_id,variant_id,price)
VALUES ('inv88-price','inv88-prices','inv88-sku','inv88-sku',100000);
CREATE TEMP TABLE inventory88_result(order_id text);
GRANT ALL ON inventory88_result TO authenticated;
-- Flush fixture-only debt guards before the fixture customer receives its
-- first business transaction; production creates customers in a prior commit.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000001',true);
SELECT public.rpc_inventory_post('{
 "requestKey":"88000000-0000-4000-8000-000000000011","kind":"count","note":"Synthetic opening count",
 "items":[{"productId":"inv88-sku","quantity":100,"expectedQuantity":0}]
}');
SELECT public.rpc_inventory_activate(true);
-- Emulate an activation committed before checkout. The entire fixture remains
-- one rollback-only transaction, so now() otherwise predates clock_timestamp().
RESET ROLE;
UPDATE public.inventory_control SET activated_at = transaction_timestamp() - interval '1 second' WHERE id;
SET LOCAL ROLE authenticated;
SELECT public.rpc_inventory_window('{"mode":"stock","query":"INV88"}');
SELECT set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000002',true);
INSERT INTO inventory88_result SELECT public.rpc_confirm_order('{
 "idempotencyKey":"88000000-0000-4000-8000-000000000012","customerId":"inv88-customer","pricelistId":"inv88-prices","paidAmount":0,
 "items":[{"variantId":"inv88-sku","quantity":3,"discountType":"percent","discountValue":0}]
}')#>>'{order,id}';
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT quantity FROM public.inventory_balances WHERE product_id='inv88-sku') <> 97
     OR (SELECT debt FROM public.customers WHERE id='inv88-customer') <> 300000 THEN
    RAISE EXCEPTION 'Checkout inventory/debt invariant failed';
  END IF;
END $$;
-- The real app commits checkout before cancellation. Give the synthetic
-- original charge an earlier timestamp so the debt ledger's opening-row
-- ordering does not tie against the reversal in this single transaction.
UPDATE public.customer_debt_transactions SET created_at = transaction_timestamp() - interval '1 second'
WHERE customer_id='inv88-customer' AND transaction_type='order';
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000001',true);
SELECT public.rpc_cancel_order((SELECT order_id FROM inventory88_result),'Synthetic cancellation');
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT quantity FROM public.inventory_balances WHERE product_id='inv88-sku') <> 100
     OR (SELECT debt FROM public.customers WHERE id='inv88-customer') <> 0 THEN
    RAISE EXCEPTION 'Cancellation inventory/debt invariant failed';
  END IF;
END $$;
-- 0089: the real financial RPC still commits while stock is paused. Resume
-- reconciles only stock, then cancellation restores both ledgers normally.
SET LOCAL ROLE authenticated;
SELECT public.rpc_inventory_set_sync(false);
SELECT set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000002',true);
DELETE FROM inventory88_result;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO inventory88_result SELECT public.rpc_confirm_order('{
 "idempotencyKey":"88000000-0000-4000-8000-000000000013","customerId":"inv88-customer","pricelistId":"inv88-prices","paidAmount":0,
 "items":[{"variantId":"inv88-sku","quantity":2,"discountType":"percent","discountValue":0}]
}')#>>'{order,id}';
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT quantity FROM public.inventory_balances WHERE product_id='inv88-sku') <> 100
     OR (SELECT debt FROM public.customers WHERE id='inv88-customer') <> 200000
     OR (SELECT count(*) FROM public.inventory_pending_orders) <> 1 THEN
    RAISE EXCEPTION 'Paused stock / committed finance invariant failed';
  END IF;
END $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000001',true);
SELECT public.rpc_inventory_set_sync(true);
RESET ROLE;
DO $$ BEGIN
  IF (SELECT quantity FROM public.inventory_balances WHERE product_id='inv88-sku') <> 98
     OR (SELECT debt FROM public.customers WHERE id='inv88-customer') <> 200000
     OR EXISTS (SELECT 1 FROM public.inventory_pending_orders)
     OR NOT (SELECT sync_enabled FROM public.inventory_control WHERE id) THEN
    RAISE EXCEPTION 'Resume stock / unchanged finance invariant failed';
  END IF;
END $$;
UPDATE public.customer_debt_transactions SET created_at = transaction_timestamp() - interval '0.5 second'
WHERE order_id=(SELECT order_id FROM inventory88_result) AND transaction_type='order';
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE authenticated;
SELECT public.rpc_cancel_order((SELECT order_id FROM inventory88_result),'Synthetic resumed cancellation');
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT quantity FROM public.inventory_balances WHERE product_id='inv88-sku') <> 100
     OR (SELECT debt FROM public.customers WHERE id='inv88-customer') <> 0 THEN
    RAISE EXCEPTION 'Resumed cancellation inventory/debt invariant failed';
  END IF;
END $$;
SELECT '0089 pause/resume invariants passed; all fixtures will roll back' AS result;
SELECT '0088 inventory and financial invariants passed; all fixtures will roll back' AS result;
ROLLBACK;
