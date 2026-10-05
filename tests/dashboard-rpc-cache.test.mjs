import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'js/components/dashboard.js'), 'utf8')
  .replace(/^import .+;\r?\n/gm, '')
  .replace(/\bexport\s+/g, '');

function dashboardHarness({ chartView = 'month', rpc } = {}) {
  let now = Date.parse('2026-10-05T08:00:00Z');
  const calls = [];
  const toasts = [];
  const errors = [];
  const charts = [];
  const elements = new Map([
    ...['stat-total-revenue', 'stat-total-orders', 'stat-total-debt', 'stat-total-sold-products'].map(id => [id, { innerText: '' }]),
    ['revenue-chart', { getContext: () => ({}) }],
    ['btn-refresh-dashboard-data', {}]
  ]);
  const state = {
    currentUser: { authUserId: 'account-a', username: 'admin', role: 'admin', companyId: 'ABS_NORTH' },
    dashboardFilter: {
      timeRange: 'month', startDate: '', endDate: '', companyId: 'all', brand: 'all',
      saleUser: 'all', customerId: 'all', includeFestivalAllocation: true
    },
    dashboardChartView: chartView,
    dashboardSalesMode: 'net',
    companies: [], brands: [], products: [], users: [], customers: []
  };
  function payload(amount, filters = {}) {
    return {
      summary: { net_sales: amount, gross_sales: amount, order_count: amount, current_debt: amount, sold_quantity: amount },
      series: [{ date: '2026-10-05', amount }], period: { start: filters.start, end: filters.end },
      by_company: [], by_brand: [], by_salesperson: [], by_customer: [], top_skus: [], recent_orders: []
    };
  }
  const sandbox = {
    state,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    document: {
      getElementById: id => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    formatCurrency: value => String(value ?? 0),
    safeCreateIcons() {},
    getUserCompanyId: user => user?.companyId || user?.company_id || 'ABS_NORTH',
    getBrandById: () => null,
    getCompanyNameById: value => value,
    isFestivalBrand: () => false,
    filterLoginEmployeeRevenueRows: rows => rows || [],
    buildDashboardChartSeries: series => ({ labels: ['Revenue'], dataPoints: series.map(row => row.amount) }),
    showToast: (...args) => toasts.push(args),
    console: { error: (...args) => errors.push(args) },
    Chart: class {
      constructor(_context, config) { this.data = config.data; charts.push(this); }
      update() {}
      destroy() {}
    },
    dbFetchPhase5Dashboard: filters => {
      calls.push({ filters: { ...filters }, actor: state.currentUser?.authUserId });
      return rpc ? rpc(filters, calls.length, payload) : Promise.resolve(payload(calls.length, filters));
    }
  };
  vm.runInNewContext(`${source}\nthis.api = { updateDashboardStats, updateRevenueChartForView, setupDashboardFilters, invalidateDashboardPayloadCache };`, sandbox);
  return { ...sandbox.api, state, calls, toasts, errors, charts, elements, payload, advance: ms => { now += ms; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('four renders with the same summary and chart filters share one RPC', async () => {
  const dashboard = dashboardHarness();
  for (let index = 0; index < 4; index += 1) await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 1);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '1');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 1);
  assert.deepEqual(dashboard.errors, []);
});

test('four renders with different summary and chart periods share two RPCs', async () => {
  const dashboard = dashboardHarness({ chartView: 'week' });
  for (let index = 0; index < 4; index += 1) await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 2);
  assert.notEqual(dashboard.calls[0].filters.start, dashboard.calls[1].filters.start);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '1');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 2);
});

test('parallel renders and an explicit refresh share the current pending RPC', async () => {
  const pending = deferred();
  const dashboard = dashboardHarness({ rpc: () => pending.promise });
  const first = dashboard.updateDashboardStats();
  const second = dashboard.updateDashboardStats();
  const refreshed = dashboard.updateDashboardStats({ force: true });
  const chart = dashboard.updateRevenueChartForView('month');
  assert.equal(dashboard.calls.length, 1);
  pending.resolve(dashboard.payload(42));
  await Promise.all([first, second, refreshed, chart]);
  assert.equal(dashboard.calls.length, 1);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '42');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 42);
});

test('manual refresh fetches fresh summary and chart payloads for both periods', async () => {
  const dashboard = dashboardHarness({ chartView: 'week' });
  await dashboard.updateDashboardStats();
  dashboard.setupDashboardFilters();
  await dashboard.elements.get('btn-refresh-dashboard-data').onclick();
  assert.equal(dashboard.calls.length, 4);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '3');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 4);
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 4);
});

test('the ten-second TTL still fetches current cloud data after expiry', async () => {
  const dashboard = dashboardHarness({ chartView: 'week' });
  await dashboard.updateDashboardStats();
  dashboard.advance(9_999);
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 2);
  dashboard.advance(1);
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 4);
});

test('a pending response for old filters cannot render or populate their cache', async () => {
  const oldRequest = deferred();
  const dashboard = dashboardHarness({ rpc: (filters, count, payload) => count === 1 ? oldRequest.promise : Promise.resolve(payload(count, filters)) });
  const oldRender = dashboard.updateDashboardStats();
  dashboard.state.dashboardFilter.customerId = 'customer-b';
  await dashboard.updateDashboardStats();
  oldRequest.resolve(dashboard.payload(100));
  await oldRender;
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '2');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 2);
  dashboard.state.dashboardFilter.customerId = 'all';
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 3);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '3');
});

test('logout and another account do not reuse or display an old account response', async () => {
  const oldRequest = deferred();
  const dashboard = dashboardHarness({ rpc: (filters, count, payload) => count === 1 ? oldRequest.promise : Promise.resolve(payload(count, filters)) });
  const oldRender = dashboard.updateDashboardStats();
  dashboard.state.currentUser = null;
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 1);
  dashboard.state.currentUser = { authUserId: 'account-b', username: 'admin-b', role: 'admin', companyId: 'ABS_NORTH' };
  await dashboard.updateDashboardStats();
  oldRequest.resolve(dashboard.payload(100));
  await oldRender;
  assert.equal(dashboard.calls.length, 2);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '2');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 2);
});

test('account, role and company changes invalidate otherwise identical cached filters', async () => {
  const dashboard = dashboardHarness();
  await dashboard.updateDashboardStats();
  dashboard.state.currentUser = { ...dashboard.state.currentUser, authUserId: 'account-b', username: 'admin-b' };
  await dashboard.updateDashboardStats();
  dashboard.state.currentUser.role = 'accounting';
  await dashboard.updateDashboardStats();
  dashboard.state.currentUser.companyId = 'ABS_SOUTH';
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 4);
});

test('late failures for old filters do not clear the latest results or show an error', async () => {
  const oldRequest = deferred();
  const dashboard = dashboardHarness({ rpc: (filters, count, payload) => count === 1 ? oldRequest.promise : Promise.resolve(payload(count, filters)) });
  const oldRender = dashboard.updateDashboardStats();
  dashboard.state.dashboardFilter.customerId = 'customer-b';
  await dashboard.updateDashboardStats();
  oldRequest.reject(new Error('Old request failed'));
  await oldRender;
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '2');
  assert.deepEqual(dashboard.toasts, []);
  assert.deepEqual(dashboard.errors, []);
});

test('late chart responses cannot replace a newer chart view', async () => {
  const oldRequest = deferred();
  const dashboard = dashboardHarness({ rpc: (filters, count, payload) => count === 1 ? oldRequest.promise : Promise.resolve(payload(count, filters)) });
  dashboard.state.dashboardChartView = 'week';
  const oldChart = dashboard.updateRevenueChartForView('week');
  dashboard.state.dashboardChartView = 'year';
  await dashboard.updateRevenueChartForView('year');
  oldRequest.resolve(dashboard.payload(100));
  await oldChart;
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 2);
});

test('a failed current request can be retried without retaining a rejected in-flight entry', async () => {
  const dashboard = dashboardHarness({ rpc: (filters, count, payload) => {
    if (count === 1) throw new Error('Connection lost');
    return Promise.resolve(payload(count, filters));
  } });
  assert.equal(await dashboard.updateDashboardStats(), null);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '—');
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 2);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '2');
});

test('manual refresh reports a chart failure without a false success message', async () => {
  const dashboard = dashboardHarness({ chartView: 'week', rpc: (filters, count, payload) => {
    if (count === 2) return Promise.reject(new Error('Chart unavailable'));
    return Promise.resolve(payload(count, filters));
  } });
  dashboard.setupDashboardFilters();
  await dashboard.elements.get('btn-refresh-dashboard-data').onclick();
  assert.equal(dashboard.calls.length, 2);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '1');
  assert.equal(dashboard.toasts.filter(([, kind]) => kind === 'danger').length, 1);
  assert.equal(dashboard.toasts.some(([message]) => message === 'Đã làm mới dữ liệu mới nhất!'), false);
});

test('business change invalidation refreshes both periods immediately and passive renders reuse them', async () => {
  const dashboard = dashboardHarness({ chartView: 'week' });
  await dashboard.updateDashboardStats();
  dashboard.invalidateDashboardPayloadCache();
  for (let index = 0; index < 4; index += 1) await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 4);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '3');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 4);
});

test('renders following a business change share fresh work and ignore the earlier snapshot', async () => {
  const oldRequest = deferred();
  const freshRequest = deferred();
  const dashboard = dashboardHarness({ rpc: (_filters, count) => count === 1 ? oldRequest.promise : freshRequest.promise });
  const oldRender = dashboard.updateDashboardStats();
  dashboard.invalidateDashboardPayloadCache();
  const freshRenders = Array.from({ length: 4 }, () => dashboard.updateDashboardStats());
  assert.equal(dashboard.calls.length, 2);
  freshRequest.resolve(dashboard.payload(200));
  await Promise.all(freshRenders);
  oldRequest.resolve(dashboard.payload(100));
  await oldRender;
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '200');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 200);
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 2);
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '200');
});

test('an old chart response cannot repopulate cache after a business change', async () => {
  const oldChart = deferred();
  const chartStarted = deferred();
  const dashboard = dashboardHarness({ chartView: 'week', rpc: (filters, count, payload) => {
    if (count === 2) { chartStarted.resolve(); return oldChart.promise; }
    return Promise.resolve(payload(count, filters));
  } });
  const oldRender = dashboard.updateDashboardStats();
  await chartStarted.promise;
  dashboard.invalidateDashboardPayloadCache();
  await dashboard.updateDashboardStats();
  oldChart.resolve(dashboard.payload(100));
  await oldRender;
  assert.equal(dashboard.elements.get('stat-total-revenue').innerText, '3');
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 4);
  await dashboard.updateDashboardStats();
  assert.equal(dashboard.calls.length, 4);
  assert.equal(dashboard.charts[0].data.datasets[0].data[0], 4);
});
