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

test('return action buttons use every active return even when its date is outside the report window', () => {
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

test('active return actions expose a clearly labelled view button', () => {
  assert.match(history, /history-return-print-btn[^>]*title="Xem\/In phiếu trả/);
  assert.match(history, /history-return-print-btn[^>]*aria-label="Xem\/In phiếu trả[^>]*>[\s\S]*Xem phiếu/);
});
