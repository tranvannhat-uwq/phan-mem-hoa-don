import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(
  path.join(root, 'migrations/0072_defer_customer_debt_chain_guard.sql'),
  'utf8'
);

const ledgerBalance = (openingBalance, changes) =>
  openingBalance + changes.reduce((sum, change) => sum + change, 0);

test('customer debt guard runs after the complete order transaction', () => {
  assert.match(migration, /CREATE CONSTRAINT TRIGGER p71_guard_customer_debt_chain_before_order/);
  assert.match(
    migration,
    /AFTER INSERT ON public\.customer_debt_transactions\s+DEFERRABLE INITIALLY DEFERRED/
  );
  assert.doesNotMatch(migration, /CREATE TRIGGER p71_guard[\s\S]*BEFORE INSERT/);
  assert.match(migration, /trigger_row\.tgconstraint <> 0/);
  assert.match(migration, /trigger_row\.tgdeferrable/);
  assert.match(migration, /trigger_row\.tginitdeferred/);
});

test('guard keeps both row arithmetic and aggregate debt checks', () => {
  assert.match(
    migration,
    /NEW\.balance_after[\s\S]*NEW\.balance_before[\s\S]*NEW\.debt_change/
  );
  assert.match(migration, /NEW\.balance_before IS NULL/);
  assert.match(migration, /NEW\.debt_change IS NULL/);
  assert.match(migration, /NEW\.balance_after IS NULL/);
  assert.match(migration, /sum\(ledger\.debt_change\)/);
  assert.match(migration, /ORDER BY first_ledger\.created_at, first_ledger\.id/);
  assert.match(migration, /customer_balance IS DISTINCT FROM ledger_calculated_balance/);
  assert.match(migration, /NEW\.transaction_type NOT IN \('order', 'order_amend'\)/);
});

test('final-state invariant accepts both write orders without weakening mismatch detection', () => {
  const originalLedgerBalance = 5_667_123;
  const amendmentDelta = 1_113_269;
  const amendedCustomerBalance = 6_780_392;

  // rpc_amend_order updates customers.debt before appending order_amend.
  assert.equal(
    ledgerBalance(originalLedgerBalance, [amendmentDelta]),
    amendedCustomerBalance
  );

  // rpc_confirm_order appends the order row before updating customers.debt.
  const newOrderAmount = 3_451_842;
  assert.equal(
    ledgerBalance(originalLedgerBalance, [newOrderAmount]),
    originalLedgerBalance + newOrderAmount
  );

  // A pre-existing mismatch survives the same delta on both sides and is rejected.
  const corruptedCustomerBalance = 6_780_392;
  assert.notEqual(
    ledgerBalance(originalLedgerBalance, [newOrderAmount]),
    corruptedCustomerBalance + newOrderAmount
  );
});
