import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/customers.js', import.meta.url), 'utf8');
const editor = source.slice(source.indexOf('export function openCustomerModal('), source.indexOf('export async function deleteCustomer('))
  .replace(/^export /gm, '');
const service = readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
const cache = service.slice(service.indexOf('function writeLocalJsonCache('), service.indexOf('// Cloud is authoritative.'))
  .replace(/^export /gm, '');
const fields = ['cust-code', 'cust-name', 'cust-phone', 'cust-address', 'cust-notes', 'cust-province', 'cust-pricelist', 'cust-managed-by', 'cust-debt', 'cust-assigned-brand'];

function harness({ role = 'sale', deferred = false, storageLimit = Infinity, storageEntries = [] } = {}) {
  const nodes = new Map();
  const storage = new Map(storageEntries);
  const calls = { quick: [], direct: [], refresh: [], detail: [], render: 0, toasts: [], cacheKeys: [] };
  const pending = [];
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: '', textContent: '', innerText: '', innerHTML: '', hidden: false, disabled: false,
        dataset: {}, style: {}, readOnly: false, scrollTop: 123,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
          toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
        closest: () => null, querySelector: () => node('modal-body'),
        scrollIntoView() {}, focus() {}, hasAttribute() { return false; }, setAttribute() {},
        reset() { for (const field of fields) node(field).value = field === 'cust-debt' ? '0' : ''; } });
    }
    return nodes.get(id);
  }
  const state = { currentUser: { id: 'sale-profile', username: 'sales@test.invalid', displayName: 'Kinh doanh kiểm thử', role },
    customers: [], brands: [], pricelists: [], users: [], activeCustomerId: 'draft-customer', invoiceItems: [{ id: 'draft-line', quantity: 3 }] };
  const context = vm.createContext({ state, isCloudActive: true, document: { getElementById: node }, console: { ...console, warn() {} },
    localStorage: {
      get length() { return storage.size; },
      key: index => [...storage.keys()][index] ?? null,
      removeItem: key => storage.delete(key),
      setItem(key, value) {
        calls.cacheKeys.push(key);
        const size = [...storage.values()].reduce((sum, entry) => sum + entry.length, 0)
          - (storage.get(key)?.length || 0) + value.length;
        if (size > storageLimit) throw new DOMException('Browser storage quota exceeded', 'QuotaExceededError');
        storage.set(key, value);
      }
    }, makeSelectSearchable() {}, safeCreateIcons() {},
    generateUniqueCustomerCode: province => `KH-${province || 'DL'}-1000`,
    isSameUser: (a, b) => a === b,
    showToast: (...args) => calls.toasts.push(args),
    openCustomerDetailModal: index => calls.detail.push(index),
    renderAll: () => { calls.render++; },
    dbCreateQuickCustomer: data => {
      calls.quick.push(data);
      return deferred ? new Promise(resolve => pending.push(resolve))
        : Promise.resolve({ ...data, managedBy: 'authoritative-owner', debt: 0 });
    },
    dbSaveCustomer: async data => { calls.direct.push(data); return true; },
    dbFetchCustomerById: async id => { calls.refresh.push(id); return false; } });
  vm.runInContext(`let customerFormSession=0; let customerSaveInFlight=false; ${cache}\n${editor}`, context);
  const run = code => vm.runInContext(code, context);
  return { state, node, calls, pending, run, storage,
    fill() {
      node('cust-name').value = 'Đại lý mới'; node('cust-phone').value = '0901234567';
      node('cust-province').value = 'HN'; node('cust-address').value = 'Địa chỉ kiểm thử';
      node('cust-notes').value = 'Gọi trước khi giao';
    } };
}

test('Sale opens the new basic form with automatic identity and without requiring a price list', async () => {
  const h = harness();
  h.run('openCustomerModal()');
  assert.equal(h.node('customer-modal').classList.contains('sale-customer-create'), true);
  assert.equal(h.node('cust-code').readOnly, true);
  assert.equal(h.node('cust-pricelist').value, '');
  assert.equal(h.node('customer-create-context').hidden, false);
  assert.match(h.node('customer-create-context').textContent, /Kinh doanh kiểm thử/);
  assert.equal(h.node('btn-save-customer-submit').textContent, 'Tạo khách hàng');
  h.fill();
  await h.run('saveCustomer()');
  assert.equal(h.calls.quick.length, 1);
  assert.equal(h.calls.direct.length, 0, 'Sale must never use a direct customer-table upsert');
  assert.equal(h.state.customers.length, 1);
  assert.equal(h.state.customers[0].managedBy, 'authoritative-owner');
  assert.equal(h.state.customers[0].debt, 0);
  assert.equal(h.calls.quick[0].brandDiscounts.province, 'HN');
  assert.equal(h.calls.quick[0].notes, 'Gọi trước khi giao');
  assert.equal(h.state.activeCustomerId, 'draft-customer');
  assert.deepEqual(h.state.invoiceItems, [{ id: 'draft-line', quantity: 3 }]);
  assert.equal(h.node('customer-modal').classList.contains('active'), false);
});

test('missing visible required fields block save and Sale cannot edit existing customers', async () => {
  const h = harness();
  h.run('openCustomerModal()');
  await h.run('saveCustomer()');
  assert.equal(h.calls.quick.length, 0);
  assert.match(h.calls.toasts.at(-1)[0], /tên khách hàng/);
  h.state.customers.push({ id: 'existing' });
  h.run('openCustomerModal(0)');
  assert.deepEqual(h.calls.detail, [0]);
  h.node('customer-edit-index').value = '0'; h.node('customer-edit-id').value = 'existing';
  await h.run('saveCustomer()');
  assert.equal(h.calls.direct.length, 0);
  assert.equal(h.calls.quick.length, 0);
});

test('pending submission is locked; a server failure keeps entered values and allows a retry', async () => {
  const h = harness({ deferred: true });
  h.run('openCustomerModal()'); h.fill();
  const first = h.run('saveCustomer()');
  await h.run('saveCustomer()');
  assert.equal(h.calls.quick.length, 1);
  assert.equal(h.node('btn-save-customer-submit').disabled, true);
  h.pending[0](false); await first;
  assert.equal(h.node('cust-name').value, 'Đại lý mới');
  assert.equal(h.node('customer-modal').classList.contains('active'), true);
  assert.equal(h.node('btn-save-customer-submit').disabled, false);
  assert.equal(h.state.customers.length, 0);
  const second = h.run('saveCustomer()');
  h.pending[1]({ ...h.calls.quick[1], managedBy: 'saved-owner' }); await second;
  assert.equal(h.state.customers.length, 1);
  assert.equal(h.node('btn-save-customer-submit').textContent, 'Tạo khách hàng');
});

test('Admin/Accounting retains the profile save path and required price-list validation', async () => {
  for (const role of ['admin', 'accounting']) {
    const h = harness({ role });
    h.run('openCustomerModal()'); h.fill();
    h.node('cust-pricelist').value = '';
    await h.run('saveCustomer()');
    assert.equal(h.calls.direct.length, 0);
    assert.match(h.calls.toasts.at(-1)[0], /bảng giá/);
    h.node('cust-pricelist').value = 'custom';
    await h.run('saveCustomer()');
    assert.equal(h.calls.direct.length, 1);
    assert.equal(h.calls.quick.length, 0);
    assert.equal(h.node('customer-create-context').hidden, true);
    assert.equal(h.node('cust-code').readOnly, false);
  }
});

test('saving a customer edit on Cloud completes when browser storage is full', async () => {
  const h = harness({ role: 'accounting', storageLimit: 0 });
  h.state.customers.push({ id: 'existing', code: 'KH-HN-1000', name: 'Tên cũ', phone: '0901234567',
    assignedBrand: 'Tất cả', pricelistId: 'custom', brandDiscounts: { province: 'HN' } });
  h.run('openCustomerModal(0)');
  h.node('cust-name').value = 'Tên đã cập nhật';
  await h.run('saveCustomer()');

  assert.equal(h.calls.direct.length, 1);
  assert.deepEqual(h.calls.cacheKeys, ['billing_system_customers__sale-profile%7Caccounting%7C']);
  assert.equal(h.state.customers[0].name, 'Tên đã cập nhật');
  assert.equal(h.node('customer-modal').classList.contains('active'), false);
  assert.equal(h.node('btn-save-customer-submit').disabled, false);
  assert.equal(h.calls.render, 1);
  assert.deepEqual(h.calls.toasts, [['Cập nhật khách hàng thành công!']]);
});

test('customer cache frees quota by removing only other scoped snapshots and retries once', () => {
  const activeKey = 'billing_system_customers__sale-profile%7Csale%7C';
  const otherKey = 'billing_system_customers__other-profile%7Csale%7C';
  const localKey = 'billing_system_customers';
  const h = harness({ storageLimit: 200, storageEntries: [
    [activeKey, '[]'], [otherKey, 'x'.repeat(170)], [localKey, '["local-only"]'],
    ['sb-auth-token', 'session']
  ] });
  const customer = { id: 'updated', debt: 120000, debtHistory: [{ id: 'charge' }], returnDocuments: [{ id: 'return' }] };
  h.state.customers.push(customer);
  h.run('cacheCustomersLocally()');

  assert.deepEqual(h.calls.cacheKeys, [activeKey, activeKey]);
  assert.equal(h.storage.has(otherKey), false);
  assert.equal(h.storage.get(localKey), '["local-only"]');
  assert.equal(h.storage.get('sb-auth-token'), 'session');
  assert.deepEqual(JSON.parse(h.storage.get(activeKey)), [{ id: 'updated', debt: 120000, debtHistory: [{ id: 'charge' }] }]);
  assert.deepEqual(customer.returnDocuments, [{ id: 'return' }]);

  const lastSnapshot = h.storage.get(activeKey);
  customer.name = 'x'.repeat(200);
  h.run('cacheCustomersLocally()');
  assert.equal(h.storage.get(activeKey), lastSnapshot, 'keep the last usable snapshot when cleanup cannot free enough space');
});

test('a late completion does not import customer data after logout or close a newly opened form', async () => {
  const h = harness({ deferred: true });
  h.run('openCustomerModal()'); h.fill();
  const first = h.run('saveCustomer()');
  h.run('closeCustomerModal(); openCustomerModal()'); h.fill();
  h.node('cust-name').value = 'Khách tiếp theo';
  h.pending[0]({ ...h.calls.quick[0] }); await first;
  assert.equal(h.node('customer-modal').classList.contains('active'), true);
  assert.equal(h.node('cust-name').value, 'Khách tiếp theo');

  h.node('cust-code').value = 'KH-HN-2000';
  h.node('cust-phone').value = '0901234568';
  const second = h.run('saveCustomer()');
  h.state.currentUser = null;
  h.pending[1]({ ...h.calls.quick[1] }); await second;
  assert.equal(h.state.customers.length, 1);
  assert.equal(h.calls.refresh.length, 1);
});
