import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const history = fs.readFileSync(path.join(root, 'js/components/history.js'), 'utf8');
const lookupSource = history.slice(
  history.indexOf('function createHistoryLookups'),
  history.indexOf('function getHistoryCustomer')
);

test('historical returns still protect order edits and contribute to the correct financial period', () => {
  assert.match(lookupSource, /const activeReturnsByOrderId = new Map\(\)/);
  assert.match(lookupSource, /const periodActiveReturnsByOrderId = new Map\(\)/);

  const actionInsert = lookupSource.indexOf('activeReturnsByOrderId.get(orderId).push(item)');
  const dateFilter = lookupSource.indexOf("if (dateMode !== 'all'");
  const periodInsert = lookupSource.indexOf('periodActiveReturnsByOrderId.get(orderId).push(item)');
  assert.ok(actionInsert >= 0 && actionInsert < dateFilter, 'action lookup must be populated before date filtering');
  assert.ok(periodInsert > dateFilter, 'financial-period lookup must be populated after date filtering');

  assert.match(history, /lookups\.activeReturnsByOrderId\.get\(String\(order\.id\)\)/);
  assert.match(history, /Array\.from\(lookups\.periodActiveReturnsByOrderId\.values\(\)\)\.flat\(\)/);
});

test('both history views omit return management actions and their handlers', () => {
  assert.doesNotMatch(history, /history-return-(?:btn|print-btn|cancel-btn)|showReturnBtn/);
  assert.doesNotMatch(history, /openSalesReturnModal|processSalesReturnSubmit|cancelSalesReturn/);
  assert.match(history, /export function printReturnSlip/);
});
