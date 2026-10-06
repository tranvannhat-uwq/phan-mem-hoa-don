-- Run only on an isolated Supabase staging database after migration 0083.
-- All fixtures and mutations are rolled back.
BEGIN;

INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000',
  '83000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'p83-accounting@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now());
INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES ('p83-accounting', '83000000-0000-4000-8000-000000000001',
  'p83-accounting@test.invalid', 'P83 Accounting', 'accounting', true);

INSERT INTO public.customers(id, code, name, debt, total_transaction,
  net_revenue, status)
VALUES
  ('p83-amended', 'P83-AMENDED', 'P83 Amended', 5285500, 5285500, 5285500, 'active'),
  ('p83-transfer-old', 'P83-OLD', 'P83 Transfer Old', 0, 0, 0, 'active'),
  ('p83-transfer-new', 'P83-NEW', 'P83 Transfer New', 2000000, 2000000, 2000000, 'active');

INSERT INTO public.orders(id, customer_id, customer_name, items,
  total_payable, total_amount, debt_amount, paid_amount, net_revenue,
  status, created_by, order_date, created_at)
VALUES
  ('P83-ORDER-AMENDED', 'p83-amended', 'P83 Amended', '[]'::jsonb,
   5285500, 5285500, 5285500, 0, 5285500, 'settled',
   '83000000-0000-4000-8000-000000000001', now(), now()),
  ('P83-ORDER-TRANSFER', 'p83-transfer-new', 'P83 Transfer New', '[]'::jsonb,
   2000000, 2000000, 2000000, 0, 2000000, 'settled',
   '83000000-0000-4000-8000-000000000001', now(), now());

INSERT INTO public.customer_debt_transactions(id, customer_id,
  transaction_type, amount, debt_change, balance_before, balance_after,
  order_id, description, created_by, transaction_date)
VALUES
  ('P83-CHARGE', 'p83-amended', 'order', 212430, 212430,
   0, 212430, 'P83-ORDER-AMENDED', 'Original charge', 'migration:test', now()),
  ('P83-AMEND', 'p83-amended', 'order_amend', 5073070, 5073070,
   212430, 5285500, 'P83-ORDER-AMENDED', 'In-place amendment', 'migration:test', now()),
  ('P83-TRANSFER-CHARGE', 'p83-transfer-old', 'order', 1000000, 1000000,
   0, 1000000, 'P83-ORDER-TRANSFER', 'Old customer charge', 'migration:test', now()),
  ('P83-TRANSFER-OUT', 'p83-transfer-old', 'order_amend', 1000000, -1000000,
   1000000, 0, 'P83-ORDER-TRANSFER', 'Transfer out', 'migration:test', now()),
  ('P83-TRANSFER-IN', 'p83-transfer-new', 'order_amend', 2000000, 2000000,
   0, 2000000, 'P83-ORDER-TRANSFER', 'Transfer in', 'migration:test', now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',
  '83000000-0000-4000-8000-000000000001', true);

CREATE TEMP TABLE p83_amended_result AS
SELECT public.rpc_cancel_order('P83-ORDER-AMENDED', 'Staging amended cancellation') AS result;
CREATE TEMP TABLE p83_transfer_result AS
SELECT public.rpc_cancel_order('P83-ORDER-TRANSFER', 'Staging transferred cancellation') AS result;
CREATE TEMP TABLE p83_retry_result AS
SELECT public.rpc_cancel_order('P83-ORDER-AMENDED', 'Staging retry') AS result;

SET CONSTRAINTS ALL IMMEDIATE;

DO $assert$
BEGIN
  IF (SELECT (result->>'new_debt')::numeric FROM p83_amended_result) <> 0
     OR (SELECT (result->>'debt_change')::numeric FROM p83_amended_result) <> -5285500
     OR (SELECT debt FROM public.customers WHERE id = 'p83-amended') <> 0
     OR (SELECT debt_change FROM public.customer_debt_transactions
       WHERE id = 'DTX-P13-ORDER-VOID-P83-ORDER-AMENDED') <> -5285500
     OR (SELECT count(*) FROM public.customer_debt_transactions
       WHERE order_id = 'P83-ORDER-AMENDED' AND transaction_type = 'order_cancel') <> 1
     OR (SELECT (result->>'already_cancelled')::boolean FROM p83_retry_result) IS NOT TRUE THEN
    RAISE EXCEPTION '0083 amended-order cancellation failed';
  END IF;

  IF (SELECT (result->>'new_debt')::numeric FROM p83_transfer_result) <> 0
     OR (SELECT (result->>'debt_change')::numeric FROM p83_transfer_result) <> -2000000
     OR (SELECT debt FROM public.customers WHERE id = 'p83-transfer-old') <> 0
     OR (SELECT debt FROM public.customers WHERE id = 'p83-transfer-new') <> 0
     OR (SELECT debt_change FROM public.customer_debt_transactions
       WHERE id = 'DTX-P13-ORDER-VOID-P83-ORDER-TRANSFER') <> -2000000 THEN
    RAISE EXCEPTION '0083 transferred-order cancellation failed';
  END IF;
END;
$assert$;

SELECT '0083 amended and transferred order reversals passed' AS result;
ROLLBACK;
