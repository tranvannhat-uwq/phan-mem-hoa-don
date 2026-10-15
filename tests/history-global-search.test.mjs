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
  assert.match(service, /const applyDateWindow = request => applyHistoryOrderWindow\(request, startIso, endExclusiveIso\)/);
  assert.match(service, /function applyHistoryOrderWindow\(query, startIso = null, endExclusiveIso = null\)/);
  assert.match(service, /order_date\.gte\.\$\{startIso\}/);
  assert.match(service, /order_date\.lt\.\$\{endExclusiveIso\}/);
  assert.match(service, /return filter \? query\.or\(filter\) : query/);
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
