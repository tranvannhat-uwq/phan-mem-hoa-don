import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const saleA = 'a0000000-0000-4000-8000-000000000001';
const saleB = 'b0000000-0000-4000-8000-000000000002';
const admin = 'c0000000-0000-4000-8000-000000000003';
const migration = () => readFile(new URL('../migrations/0099_customer_debt_order_event_snapshot.sql', import.meta.url), 'utf8');

async function as(userId) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec('SET ROLE authenticated');
}

async function snapshot(ledgerId) {
  return (await db.query('SELECT public.rpc_get_customer_debt_order_event_snapshot($1) AS value', [ledgerId])).rows[0].value;
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.profiles (
      auth_user_id uuid PRIMARY KEY,
      role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.customers (id text PRIMARY KEY);
    CREATE TABLE public.customer_access (user_id uuid NOT NULL, customer_id text NOT NULL);
    CREATE TABLE public.customer_debt_transactions (
      id text PRIMARY KEY, customer_id text NOT NULL, order_id text,
      transaction_type text NOT NULL, amount numeric, debt_change numeric
    );
    CREATE TABLE public.orders (
      id text PRIMARY KEY, customer_id text NOT NULL, customer_name text,
      order_date timestamptz, status text, items jsonb, subtotal numeric,
      total_market numeric, discount_amount numeric, total_payable numeric, notes text
    );
    CREATE TABLE public.order_amendments (
      id text PRIMARY KEY, order_id text NOT NULL, old_data jsonb NOT NULL,
      new_data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, description text);
    CREATE FUNCTION public.require_authenticated_profile() RETURNS public.profiles
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE actor public.profiles%ROWTYPE;
    BEGIN
      SELECT * INTO actor FROM public.profiles
      WHERE auth_user_id = auth.uid() AND is_active;
      IF NOT FOUND THEN RAISE EXCEPTION 'active profile required'; END IF;
      RETURN actor;
    END $$;
    CREATE FUNCTION public.can_access_customer(p_customer_id text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.profiles profile
        WHERE profile.auth_user_id = auth.uid() AND profile.is_active
          AND (profile.role IN ('admin', 'accounting') OR EXISTS (
            SELECT 1 FROM public.customer_access access
            WHERE access.user_id = auth.uid() AND access.customer_id = p_customer_id
          ))
      )
    $$;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
  `);
  try {
    await db.exec(await migration());
  } catch (error) {
    throw new Error(`0099 migration failed to apply in PGlite: ${error.message}\n${error.where || ''}`);
  }
  await db.exec(`
    INSERT INTO public.profiles(auth_user_id, role) VALUES
      ('${saleA}', 'sale'), ('${saleB}', 'sale'), ('${admin}', 'admin');
    INSERT INTO public.customers(id) VALUES ('customer-a'), ('customer-b');
    INSERT INTO public.customer_access(user_id, customer_id) VALUES
      ('${saleA}', 'customer-a'), ('${saleB}', 'customer-b');
    INSERT INTO public.orders(id, customer_id, customer_name, order_date, status, items,
      subtotal, total_market, discount_amount, total_payable, notes)
    VALUES ('order-moved', 'customer-b', 'Buyer B', '2026-10-18T10:00:00Z', 'settled',
      '[{"productName":"New item","quantity":1,"price":200}]', 200, 200, 0, 200, 'new state');
    INSERT INTO public.order_amendments(id, order_id, old_data, new_data, created_at)
    VALUES ('OAM-order-moved-0001', 'order-moved',
      '{"id":"order-moved","customer_id":"customer-a","customer_name":"Buyer A","order_date":"2026-10-17T10:00:00Z","status":"settled","items":[{"productName":"Old item","quantity":1,"price":100}],"subtotal":100,"total_market":100,"discount_amount":0,"total_payable":100,"notes":"old state"}',
      '{"id":"order-moved","customer_id":"customer-b","customer_name":"Buyer B","order_date":"2026-10-18T10:00:00Z","status":"settled","items":[{"productName":"New item","quantity":1,"price":200}],"subtotal":200,"total_market":200,"discount_amount":0,"total_payable":200,"notes":"new state"}',
      '2026-10-18T10:00:00Z');
    INSERT INTO public.customer_debt_transactions(id, customer_id, order_id, transaction_type, amount, debt_change)
    VALUES ('DTX-ORDER-order-moved', 'customer-a', 'order-moved', 'order', 100, 100),
      ('DTX-OAM-OUT-order-moved-0001', 'customer-a', 'order-moved', 'order_amend', 100, -100),
      ('DTX-OAM-IN-order-moved-0001', 'customer-b', 'order-moved', 'order_amend', 200, 200);
  `);
});

after(async () => { if (db) await db.close(); });

test('debt event snapshots preserve transfer-out, transfer-in and original customer views', async () => {
  await as(saleA);
  const transferOut = await snapshot('DTX-OAM-OUT-order-moved-0001');
  const original = await snapshot('DTX-ORDER-order-moved');
  assert.equal(transferOut.available, true);
  assert.equal(transferOut.event_context, 'transfer_out');
  assert.equal(transferOut.order.customer_id, 'customer-a');
  assert.equal(transferOut.order.customer_name, 'Buyer A');
  assert.equal(Number(transferOut.order.total_payable), 100);
  assert.equal(transferOut.order.items[0].productName, 'Old item');
  assert.equal(original.available, true);
  assert.equal(original.order.customer_id, 'customer-a');
  assert.equal(Number(original.order.total_payable), 100);

  await as(saleB);
  const transferIn = await snapshot('DTX-OAM-IN-order-moved-0001');
  assert.equal(transferIn.available, true);
  assert.equal(transferIn.event_context, 'transfer_in');
  assert.equal(transferIn.order.customer_id, 'customer-b');
  assert.equal(transferIn.order.customer_name, 'Buyer B');
  assert.equal(Number(transferIn.order.total_payable), 200);
  assert.equal(transferIn.order.items[0].productName, 'New item');
});

test('debt event RPC rejects a user without access to the ledger customer', async () => {
  await as(saleA);
  await assert.rejects(snapshot('DTX-OAM-IN-order-moved-0001'), /customer debt source is unavailable/);
});
