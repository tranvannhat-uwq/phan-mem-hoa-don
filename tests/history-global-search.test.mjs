import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const history = read('js/components/history.js');
const service = read('js/services/supabase.js');
const html = read('index.html');

test('customer search loads matching orders from the selected date window', () => {
  assert.match(history, /dbSearchOrdersForHistory\(searchTerm, window\.startIso, window\.endExclusiveIso\)/);
  assert.match(service, /export async function dbSearchOrdersForHistory/);
  assert.match(service, /createSearchQuery\('customer_name'\)/);
  assert.match(service, /\.in\('customer_id', matchingCustomerIds\)/);
  assert.match(service, /if \(startIso\) scopedRequest = scopedRequest\.gte\('order_date', startIso\)/);
  assert.match(service, /if \(endExclusiveIso\) scopedRequest = scopedRequest\.lt\('order_date', endExclusiveIso\)/);
  assert.match(service, /state\.savedOrders = \[\s*\.\.\.mapped,/);
});

test('search also matches the current linked customer identity', () => {
  assert.match(history, /const orderCustomer = getHistoryCustomer\(o, lookups\)/);
  assert.match(history, /orderCustomer\?\.name/);
  assert.match(history, /orderCustomer\?\.code/);
  assert.match(history, /orderCustomer\?\.phone/);
});

test('text search keeps the selected date filter', () => {
  assert.match(history, /if \(dateMode !== 'all'\)/);
  assert.doesNotMatch(html, /id="history-search-input"[^>]+toàn bộ lịch sử/);
});
