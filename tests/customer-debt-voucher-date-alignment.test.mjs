import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations/0063_align_customer_receipt_ledger_dates.sql'), 'utf8');

test('cashbook receipt date amendments append a zero-value debt-date adjustment', () => {
  assert.match(migration, /AFTER UPDATE OF date, transaction_date ON public\.cashbook_transactions/);
  assert.match(migration, /transaction_type = 'payment'/);
  assert.match(migration, /'payment_amend', 0, 0/);
  assert.match(migration, /amends_ledger_id/);
  assert.match(migration, /effective_date IS DISTINCT FROM ledger\.transaction_date/);
  assert.match(migration, /transaction_type = 'payment_amend'/);
  assert.match(migration, /VALUES \('0063',/);
});
