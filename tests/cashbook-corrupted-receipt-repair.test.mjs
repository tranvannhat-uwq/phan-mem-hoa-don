import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cashbook = fs.readFileSync(path.join(root, 'js/components/so_quy.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');
const migration0061 = fs.readFileSync(path.join(root, 'migrations/0061_repair_customer_receipt_categories.sql'), 'utf8');

test('mapCashbookTransaction repairs corrupted receipt note and category', () => {
  assert.match(service, /Auto-heal corrupted receipt note & category from previous bug/);
  assert.match(service, /TTM\\d\+\$\/i\.test\(cleanNote\)/);
  assert.match(service, /cleanNote\.replace\(\/\^HD:\\s\*\/\i, ''\)\.replace\(\/\\s\*-\\s\*TTM\\d\+\$\/i, ''\)\.trim\(\)/);
});

test('getCashbookTransactions repairs stored transactions and syncs to cloud', () => {
  assert.match(cashbook, /repairedForCloud\.push\(updated\)/);
  assert.match(cashbook, /syncRepairedReceiptsToCloud/);
  assert.match(cashbook, /dbAmendCashbookTransaction\(id,\s*\{[\s\S]*category:\s*item\.category/);
});

test('migration 0061 restores category and cleans note in database', () => {
  assert.match(migration0061, /UPDATE public\.cashbook_transactions/);
  assert.match(migration0061, /regexp_replace\(note,\s*'\^HD:\\s\*',\s*'',\s*'i'\)/);
  assert.match(migration0061, /UPDATE public\.customer_debt_transactions/);
  assert.match(migration0061, /schema_migrations[\s\S]*0061/);
});
