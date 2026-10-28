import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/customers.js', import.meta.url), 'utf8');
const summaryAndOpen = source.slice(source.indexOf('function renderCustomerDetailSummary('),
  source.indexOf('window.toggleCustomerDebtAdjustments'));
const close = source.slice(source.indexOf('export function closeCustomerDetailModal()'),
  source.indexOf('// Bổ sung danh sách nhân viên'));
const customer = id => ({ id, code: `CODE-${id}`, name: `Khách ${id}`, phone: `PHONE-${id}`,
  address: `ADDRESS-${id}`, notes: `NOTE-${id}`, assignedBrand: `BRAND-${id}`, managedBy: `MANAGER-${id}`,
  pricelistId: 'retail', debt: 100, debtHistory: [{ id: `LEDGER-${id}`, type: 'charge',
    amount: 100, debtBefore: 0, debtAfter: 100, date: '2026-10-28T00:00:00Z', note: `HISTORY-${id}` }] });

function harness({ cloud = true, role = 'admin' } = {}) {
  const nodes = new Map();
  const financial = [];
  const amendments = [];
  const support = [];
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { innerText: '', innerHTML: '', dataset: {}, style: {}, scrollTop: 100,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name) },
        setAttribute(name, value) { this[name] = String(value); },
        querySelector: () => node('modal-body'), querySelectorAll: () => [] });
    }
    return nodes.get(id);
  }
  const defer = (list, id) => new Promise((resolve, reject) => list.push({ id, resolve, reject }));
  const state = { customers: [customer('A'), customer('B')], currentUser: { role }, users: [],
    pricelists: [], salesReturns: [], retentionEpoch: 0 };
  const context = vm.createContext({ state, isCloudActive: cloud,
    document: { getElementById: node },
    dbRefreshCustomerFinancialState: id => defer(financial, id),
    dbFetchRevertibleOrderAmendments: id => defer(amendments, id),
    renderDealerSupportHistory: id => { support.push(id); },
    formatPhoneNumber: value => value, getProvinceNameByCode: () => '', getManagerDisplayName: value => value,
    formatCurrency: value => `${value} đ`, safeCreateIcons() {},
    getCustomerMetrics: c => ({ grossSales: c.debt * 2, netSales: c.debt * 2, totalReturns: 0,
      returnRate: 0, totalPayments: 0 }),
    withCustomerReturnDocuments: history => history, buildCustomerDebtDisplayHistory: history => [...history],
    getCustomerDebtBusinessDate: entry => entry.date, getCustomerDebtPostingDate: entry => entry.date,
    getCustomerDebtSource: () => null, escapeCustomerHtml: value => String(value), console });
  vm.runInContext(`let customerDetailRequest = 0; let customerDebtAdjustmentsHidden = false;
    ${summaryAndOpen}\n${close}`.replace(/^export /gm, ''), context);
  return { state, node, financial, amendments, support,
    open: index => vm.runInContext(`openCustomerDetailModal(${index})`, context),
    close: () => vm.runInContext('closeCustomerDetailModal()', context),
    finish(index, overrides = {}) {
      financial[index].resolve({ ...state.customers.find(c => c.id === financial[index].id), ...overrides });
      amendments[index]?.resolve([]);
    } };
}

test('selecting another customer replaces identity, export target and old financials before the network responds', async () => {
  const h = harness();
  const first = h.open(0);
  h.finish(0);
  await first;
  assert.match(h.node('detail-debt-history-body').innerHTML, /HISTORY-A/);
  h.close();

  const second = h.open(1);
  assert.equal(h.node('customer-detail-modal').dataset.customerId, 'B');
  assert.match(h.node('customer-detail-modal-title').innerText, /CODE-B/);
  for (const [field, expected] of Object.entries({ code: 'CODE-B', name: 'Khách B', phone: 'PHONE-B',
    address: 'ADDRESS-B', manager: 'MANAGER-B', notes: 'NOTE-B', pricelist: 'Khách lẻ (Nhập tay)' })) {
    assert.equal(h.node(`detail-cust-${field}`).innerText, expected);
  }
  assert.match(h.node('detail-cust-brand').innerHTML, /BRAND-B/);
  for (const field of ['debt', 'sales-gross', 'returns-total', 'sales-net', 'return-rate', 'total-payments']) {
    assert.equal(h.node(`detail-cust-${field}`).innerText, 'Đang tải...');
  }
  assert.equal(h.node('btn-open-customer-order-export')['data-customer-id'], 'B');
  assert.match(h.node('detail-debt-history-body').innerHTML, /Đang tải/);
  assert.doesNotMatch(h.node('detail-debt-history-body').innerHTML, /HISTORY-A/);
  assert.equal(h.node('modal-body').scrollTop, 0);
  assert.deepEqual(h.support, ['A', 'B']);
  // Both reads start immediately, so their network latency is not added together.
  assert.equal(h.financial[1].id, 'B');
  assert.equal(h.amendments[1].id, 'B');
  h.finish(1, { debt: 250 });
  await second;
  assert.equal(h.node('detail-cust-debt').innerText, '250 đ');
  assert.match(h.node('detail-debt-history-body').innerHTML, /HISTORY-B/);
});

test('a slower previous customer response cannot overwrite the most recent selection', async () => {
  const h = harness();
  const first = h.open(0);
  const second = h.open(1);
  h.finish(1, { debt: 250 });
  await second;
  h.finish(0, { debt: 999 });
  await first;
  assert.equal(h.node('customer-detail-modal').dataset.customerId, 'B');
  assert.equal(h.node('detail-cust-debt').innerText, '250 đ');
  assert.match(h.node('detail-debt-history-body').innerHTML, /HISTORY-B/);
  assert.doesNotMatch(h.node('detail-debt-history-body').innerHTML, /HISTORY-A/);
});

test('closing and reopening even the same customer invalidates the earlier request', async () => {
  const h = harness();
  const first = h.open(0);
  h.close();
  const second = h.open(0);
  h.finish(1, { debt: 250 });
  await second;
  h.finish(0, { debt: 999 });
  await first;
  assert.equal(h.node('detail-cust-debt').innerText, '250 đ');
});

test('late responses do not update a closed popup or a changed session', async () => {
  for (const change of ['close', 'logout', 'role', 'epoch']) {
    const h = harness();
    const pending = h.open(0);
    if (change === 'close') h.close();
    if (change === 'logout') h.state.currentUser = null;
    if (change === 'role') h.state.currentUser.role = 'sale';
    if (change === 'epoch') h.state.retentionEpoch += 1;
    h.finish(0);
    await pending;
    assert.equal(h.node('detail-cust-debt').innerText, 'Đang tải...');
    assert.match(h.node('detail-debt-history-body').innerHTML, /Đang tải/);
    if (change === 'close') {
      assert.equal(h.node('customer-detail-modal').classList.contains('active'), false);
      assert.equal(h.node('customer-detail-modal').dataset.customerId, undefined);
    }
  }
});

test('a failed cloud refresh shows an error instead of presenting cached financials as current', async () => {
  for (const reject of [false, true]) {
    const h = harness();
    const pending = h.open(1);
    if (reject) h.financial[0].reject(new Error('Network unavailable'));
    else h.financial[0].resolve(false);
    h.amendments[0].resolve([]);
    await pending;
    assert.equal(h.node('detail-cust-name').innerText, 'Khách B');
    assert.equal(h.node('detail-cust-debt').innerText, 'Chưa tải được');
    assert.match(h.node('detail-debt-history-body').innerHTML, /Không thể tải công nợ/);
    assert.doesNotMatch(h.node('detail-debt-history-body').innerHTML, /HISTORY-B/);
  }
});

test('an optional amendment lookup failure does not hide customer history', async () => {
  const h = harness();
  const pending = h.open(1);
  h.financial[0].resolve(h.state.customers[1]);
  h.amendments[0].reject(new Error('Unavailable'));
  await pending;
  assert.equal(h.node('detail-cust-debt').innerText, '100 đ');
  assert.match(h.node('detail-debt-history-body').innerHTML, /HISTORY-B/);
});

test('offline mode retains local history and sales users skip the amendment lookup', async () => {
  const h = harness({ cloud: false, role: 'sale' });
  const pending = h.open(1);
  assert.equal(h.node('detail-cust-debt').innerText, '100 đ');
  assert.equal(h.amendments.length, 0);
  h.financial[0].resolve(false);
  await pending;
  assert.match(h.node('detail-debt-history-body').innerHTML, /HISTORY-B/);
});
