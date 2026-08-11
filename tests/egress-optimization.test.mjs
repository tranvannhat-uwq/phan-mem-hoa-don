import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const service = read('js/services/supabase.js');
const realtime = read('js/services/realtime.js');
const main = read('js/main.js');
const users = read('js/components/users.js');
const dashboard = read('js/components/dashboard.js');
const history = read('js/components/history.js');
const cashbook = read('js/components/so_quy.js');

test('login uses a lean bootstrap and defers historical domains until their panels open', () => {
  assert.match(users, /leanBootstrap:\s*true/);
  assert.match(main, /leanBootstrap:\s*true/);
  assert.match(service, /\.\.\.\(leanBootstrap \? \[\] : \[fetchOrders\(\)\]\)/);
  assert.match(service, /Promise\.all\(leanBootstrap \? \[\] : \[/);
  assert.match(main, /'history-panel': \['orders', 'salesReturns'\]/);
  assert.match(main, /'so-quy-panel': \['cashbook', 'startingBalances'\]/);
  assert.match(main, /loadedPanelDomains\.has\(domain\)/);
  assert.match(main, /pendingPanelDomainLoads\.has\(loadKey\)/);
});

test('customer bootstrap excludes the duplicated legacy debt-history payload', () => {
  assert.match(service, /const CUSTOMER_LIST_COLUMNS = \[/);
  const columns = service.slice(
    service.indexOf('const CUSTOMER_LIST_COLUMNS'),
    service.indexOf('].join', service.indexOf('const CUSTOMER_LIST_COLUMNS'))
  );
  assert.doesNotMatch(columns, /debt_history/);
  assert.match(service, /fetchFullTableData\(tableCustomersName, CUSTOMER_LIST_COLUMNS\)/);
});

test('routine refresh actions do not download every business table', () => {
  assert.doesNotMatch(dashboard, /fetchCloudData/);
  assert.match(history, /ensurePanelCloudData\('history-panel', \{ force: true \}\)/);
  assert.doesNotMatch(history, /await fetchCloudData\(\)/);
  assert.doesNotMatch(cashbook, /await dbFetchCashbookTransactions\(\)/);
  assert.match(cashbook, /dbFetchCashbookTransactionById/);
});

test('realtime applies row deltas and tab visibility does not trigger refetching', () => {
  for (const updater of [
    'applyCashbookRealtimePayload', 'applyCustomerDebtRealtimePayload', 'applyStartingBalanceRealtimePayload',
    'applyProductRealtimePayload', 'applyPricingRealtimePayload', 'applyBrandRealtimePayload'
  ]) {
    assert.match(realtime, new RegExp(`${updater}\\(`));
  }
  assert.doesNotMatch(realtime, /refreshDomains\.add/);
  assert.doesNotMatch(realtime, /addEventListener\('visibilitychange'/);
  assert.match(realtime, /window\.addEventListener\('online'/);
});
