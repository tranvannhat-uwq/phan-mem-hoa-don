import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(
  path.join(root, 'migrations/0069_authoritative_invoice_debt_snapshots.sql'),
  'utf8'
);

test('invoice debt snapshots are persisted, backfilled and maintained inside the order transaction', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS debt_before_snapshot numeric/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS debt_after_snapshot numeric/);
  assert.match(migration, /JOIN LATERAL[\s\S]*customer_debt_transactions[\s\S]*ORDER BY ledger\.created_at, ledger\.id/);
  assert.match(migration, /sum\(ledger\.debt_change\)/);
  assert.match(migration, /CREATE TRIGGER p69_set_order_debt_snapshot[\s\S]*BEFORE INSERT OR UPDATE OF customer_id, total_amount, items ON public\.orders/);
  assert.match(migration, /NEW\.debt_before_snapshot := current_customer_debt/);
  assert.match(migration, /NEW\.debt_after_snapshot := NEW\.debt_before_snapshot[\s\S]*NEW\.debt_amount/);
  assert.match(migration, /NEW\.customer_id IS DISTINCT FROM OLD\.customer_id/);
  assert.match(migration, /NEW\.total_amount IS NOT DISTINCT FROM OLD\.total_amount[\s\S]*NEW\.items IS NOT DISTINCT FROM OLD\.items[\s\S]*must not rewrite the invoice-at-issue snapshot/);
  assert.doesNotMatch(migration, /UPDATE public\.customer_debt_transactions|DELETE FROM public\.customer_debt_transactions/i);
});

test('snapshot read RPC is authenticated, customer-scoped and rejects missing snapshots', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.rpc_get_order_debt_snapshot/);
  assert.match(migration, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(migration, /actor\.role = 'sale' AND NOT public\.can_access_customer\(sale\.customer_id\)/);
  assert.match(migration, /Invoice debt snapshot is unavailable/);
  assert.match(migration, /'debtBefore', round\(sale\.debt_before_snapshot\)/);
  assert.match(migration, /'debtAfter', round\(sale\.debt_after_snapshot\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_get_order_debt_snapshot\(text, text\)[\s\S]*FROM PUBLIC, anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_get_order_debt_snapshot\(text, text\)[\s\S]*TO authenticated/);
});
