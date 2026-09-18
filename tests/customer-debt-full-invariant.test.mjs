import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations/0074_customer_debt_full_invariant_and_reconciliation.sql'),
  'utf8'
);

test('all debt ledger and cached aggregate changes are checked at transaction end', () => {
  assert.match(sql, /CREATE CONSTRAINT TRIGGER p74_guard_customer_debt_ledger[\s\S]*AFTER INSERT OR UPDATE ON public\.customer_debt_transactions[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER p74_guard_customer_debt_aggregate[\s\S]*AFTER UPDATE ON public\.customers[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /round\(NEW\.balance_after\) IS DISTINCT FROM[\s\S]*round\(NEW\.balance_before \+ NEW\.debt_change\)/);
  assert.match(sql, /customers\.debt=% but ledger arithmetic yields %/);
});

test('reconciliation is role-scoped, audited and never fabricates ledger activity', () => {
  const rpc = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_reconcile_customer_debt'),
    sql.indexOf('-- Targeted production incident repair')
  );
  assert.match(rpc, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(rpc, /RECONCILE_DEBT_AGGREGATE/);
  assert.match(rpc, /UPDATE public\.customers[\s\S]*SET debt = ledger_state\.calculated_balance/);
  assert.doesNotMatch(rpc, /INSERT INTO public\.customer_debt_transactions|UPDATE public\.customer_debt_transactions|DELETE FROM public\.customer_debt_transactions/i);
});

test('the reviewed repair is narrowly gated by all four Thuy VP source documents', () => {
  for (const documentId of [
    'HD-20260918-00001682',
    'HD-20260918-00001684',
    'PT-20260915-00000887',
    'PT-20260918-00000927'
  ]) assert.match(sql, new RegExp(documentId));
  assert.match(sql, /round\(ledger\.debt_change\) = 10660388/);
  assert.match(sql, /round\(ledger\.debt_change\) = 650000/);
  assert.match(sql, /round\(ledger\.debt_change\) = -8000000/);
  assert.match(sql, /round\(ledger\.debt_change\) = -10000000/);
  assert.match(sql, /'reviewed_balance_at_incident', 1358284/);
  assert.doesNotMatch(sql, /calculated_balance <> 1358284[\s\S]*RAISE EXCEPTION/);
});

test('repair preserves immutable business documents and ledger rows', () => {
  assert.doesNotMatch(sql, /DELETE FROM public\.(?:orders|customer_debt_transactions|payments|sales_returns)/i);
  assert.doesNotMatch(sql, /UPDATE public\.customer_debt_transactions/i);
  assert.match(sql, /UPDATE public\.orders sale[\s\S]*debt_before_snapshot/);
});
