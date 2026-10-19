import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as catalog from '../js/domain/product-catalog.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const executable = name => read(name).replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
const utils = read('js/utils.js');
const brandResolver = utils.slice(utils.indexOf('export function getBrandById'), utils.indexOf('export function getBrandName')).replace('export ', '');
const brands = [
  { id: 'brand_nano10mb', name: 'NANO10 MB' },
  { id: 'brand_covanano', name: 'COVA NANO' },
  { id: 'brand_festivanano', name: 'FESTIVA NANO' }
];
const actor = { authUserId: 'sale-1', id: 'sale-1', username: 'sale', role: 'sale' };
const json = value => JSON.parse(JSON.stringify(value));
const page = (rows, hasMore = false, nextCursor = null) => Object.assign(rows, { hasMore, nextCursor });
const sku = (id, brand = 'NANO10 MB') => ({
  id, code: id, baseCode: id, name: 'Sơn lót chống kiềm', brand,
  packagingName: 'Lon', packageWeight: 5, packageWeightUnit: 'kg',
  isActive: true, isLegacy: false
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function inputElement() {
  const attributes = new Map();
  return {
    value: '', style: {}, dataset: {},
    addEventListener() {},
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name)
  };
}
function suggestionList() {
  return {
    innerHTML: '', style: {}, items: [], loadMore: null,
    insertAdjacentHTML(_position, html) { this.innerHTML += html; },
    querySelectorAll() {
      this.items = [...this.innerHTML.matchAll(/data-family-index="(\d+)"/g)].map(match => ({
        dataset: { familyIndex: match[1] }, handlers: {},
        addEventListener(name, callback) { this.handlers[name] = callback; }
      }));
      return this.items;
    },
    querySelector() {
      if (!this.innerHTML.includes('data-load-more-products')) return null;
      this.loadMore = { handlers: {}, addEventListener(name, callback) { this.handlers[name] = callback; } };
      return this.loadMore;
    }
  };
}
function invoiceHarness(search) {
  const input = inputElement();
  const list = suggestionList();
  const state = {
    currentUser: { ...actor }, brands, products: [], invoiceItems: [],
    activeCustomerId: 'customer-1', activeCustomerBrand: 'NANO10 MB'
  };
  const requests = [];
  const toasts = [];
  const opened = [];
  const documentEvents = new Map();
  const context = vm.createContext({
    ...catalog, state, input, list, console, setTimeout, clearTimeout,
    isCloudActive: true,
    makeSelectSearchable() {},
    currentBusinessDateTimeInputValue: () => '',
    document: {
      addEventListener(name, handler) {
        if (!documentEvents.has(name)) documentEvents.set(name, []);
        documentEvents.get(name).push(handler);
      },
      getElementById: id => ({ 'invoice-product-search': input, 'invoice-product-suggestions': list }[id] || null)
    },
    showToast: (...args) => toasts.push(args),
    dbSearchInvoiceProducts: async (query, options) => {
      requests.push({ query, ...json(options) });
      return search(query, options, requests.length);
    },
    recordOpened: (...args) => opened.push(args)
  });
  vm.runInContext(brandResolver + executable('js/components/invoice.js') + `
    openVariantPicker = async (...args) => recordOpened(...args);
    this.api = {
      start(query) {
        input.value = query;
        resetInvoiceProductSearch();
        return refreshInvoiceProductSuggestions(query, invoiceProductSearchSequence, input, list);
      },
      refresh() { return refreshInvoiceProductSuggestions(input.value, invoiceProductSearchSequence, input, list); },
      more() { return loadMoreInvoiceProductSuggestions(input.value, invoiceProductSearchSequence, invoiceProductScope(), input, list); },
      add: addProductToInvoice,
      setup: setupInvoiceCreator,
      families: () => getInvoiceProductFamilies(state.products)
    };`, context);
  return { ...context.api, state, input, list, requests, toasts, opened, documentEvents };
}

test('a page containing only another brand still exposes Load more and the next eligible family is selectable', async () => {
  const cursor = { code: 'C-40', id: 'other-40' };
  const harness = invoiceHarness((_query, options) => options.cursor
    ? page([sku('NT-Đ1')])
    : page([sku('CT-Đ1', 'COVA NANO')], true, cursor));
  await harness.start('Sơn lót');
  assert.match(harness.list.innerHTML, /data-load-more-products/);
  assert.doesNotMatch(harness.list.innerHTML, /Không tìm thấy sản phẩm/);
  await harness.more();
  assert.match(harness.list.innerHTML, /NT-Đ1/);
  assert.equal(harness.list.items.length, 1);
  assert.deepEqual(harness.requests[1].cursor, cursor);
  harness.list.items[0].handlers.click();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(harness.opened[0][0].baseCode, 'NT-Đ1');
  assert.equal(harness.requests.length, 2);
});

test('responses for the old customer cannot replace results for a different brand with the same query', async () => {
  const old = deferred();
  const harness = invoiceHarness((_query, options) => options.brand === 'NANO10 MB'
    ? old.promise : page([sku('CT-Đ1', 'COVA NANO')]));
  const pending = harness.start('Sơn lót');
  harness.state.activeCustomerId = 'customer-2';
  harness.state.activeCustomerBrand = 'COVA NANO';
  await harness.refresh();
  old.resolve(page([sku('NT-Đ1')]));
  assert.equal(await pending, false);
  assert.match(harness.list.innerHTML, /CT-Đ1/);
  assert.doesNotMatch(harness.list.innerHTML, /NT-Đ1/);
  assert.equal(harness.requests.length, 2);
});

test('late responses for an earlier keyword do not override the current search', async () => {
  const old = deferred();
  const harness = invoiceHarness(query => query === 'Sơn lót' ? old.promise : page([sku('NT-B1')]));
  const pending = harness.start('Sơn lót');
  await harness.start('NT-B1');
  old.resolve(page([sku('NT-Đ1')]));
  assert.equal(await pending, false);
  assert.match(harness.list.innerHTML, /NT-B1/);
  assert.doesNotMatch(harness.list.innerHTML, /NT-Đ1/);
});

test('pressing Enter during an in-flight lookup shares the request and selects the exact SKU', async () => {
  const remote = deferred();
  const harness = invoiceHarness(() => remote.promise);
  const suggestions = harness.start('NT-Đ1');
  const add = harness.add();
  assert.equal(harness.requests.length, 1);
  remote.resolve(page([sku('NT-Đ1')]));
  await Promise.all([suggestions, add]);
  assert.equal(harness.opened.length, 1);
  assert.equal(harness.opened[0][2], 'NT-Đ1');
});

test('a failed Load more retains the cursor and previous products for a retry', async () => {
  const harness = invoiceHarness((_query, _options, call) => {
    if (call === 1) return page([sku('NT-Đ1')], true, { code: 'NT-Đ1', id: 'NT-Đ1' });
    if (call === 2) throw new Error('Network interrupted');
    return page([sku('NT-Đ2')]);
  });
  await harness.start('Sơn lót');
  await harness.more();
  assert.match(harness.list.innerHTML, /Không tải thêm được/);
  assert.match(harness.list.innerHTML, /NT-Đ1/);
  await harness.more();
  assert.match(harness.list.innerHTML, /NT-Đ1/);
  assert.match(harness.list.innerHTML, /NT-Đ2/);
  assert.doesNotMatch(harness.list.innerHTML, /Không tải thêm được/);
  assert.deepEqual(harness.requests[1].cursor, harness.requests[2].cursor);
});

test('Load more can redraw its clicked row without the outside-click handler hiding the new results', () => {
  const harness = invoiceHarness(() => page([]));
  harness.setup();
  const click = harness.documentEvents.get('click')[0];
  harness.list.style.display = 'block';
  const detachedRow = {};
  click({ target: detachedRow, composedPath: () => [detachedRow, harness.list] });
  assert.equal(harness.list.style.display, 'block');
  click({ target: {}, composedPath: () => [] });
  assert.equal(harness.list.style.display, 'none');
});

test('a failed server request with an unrelated partial local catalog reports a loading error', async () => {
  const harness = invoiceHarness(() => { throw new Error('Offline'); });
  harness.state.products = [sku('CT-Đ1', 'COVA NANO')];
  harness.input.value = 'NT-Đ1';
  await harness.add();
  assert.equal(harness.opened.length, 0);
  assert.match(harness.toasts.at(-1)[0], /Không tải được sản phẩm/);
  assert.doesNotMatch(harness.toasts.at(-1)[0], /Không tìm thấy/);
});

test('local fallback recognizes canonical brand IDs and spelling while retaining Festiva', () => {
  const harness = invoiceHarness(() => page([]));
  harness.state.activeCustomerBrand = 'brand_nano10mb';
  harness.state.products = [
    sku('NT-Đ1', 'nano10 mb'), sku('CT-Đ1', 'COVA NANO'), sku('FT-1', 'FESTIVA NANO'),
    { ...sku('ARCHIVED'), isActive: false }, { ...sku('LEGACY'), isLegacy: true }
  ];
  assert.deepEqual(json(harness.families().map(family => family.baseCode)).sort(), ['FT-1', 'NT-Đ1']);
});

function serviceHarness(rpc) {
  const state = { currentUser: { ...actor }, brands };
  const calls = [];
  const context = vm.createContext({ state, console, createEgressMeter: () => ({}) });
  context.client = { async rpc(name, args) { calls.push({ name, args: json(args) }); return rpc(name, args); } };
  vm.runInContext(brandResolver + executable('js/services/supabase.js') + `
    supabaseClient = client; isCloudActive = true;
    this.api = { search: dbSearchInvoiceProducts, family: dbFetchInvoiceProductFamily };`, context);
  return { ...context.api, state, calls };
}

test('the Cloud adapter sends the canonical customer brand and maps packaging_name-only SKUs', async () => {
  const harness = serviceHarness(() => ({ data: { data: [{ id: 'sku', code: 'NT-Đ1', packaging_name: 'Lon' }], hasMore: false }, error: null }));
  const rows = await harness.search('  Sơn lót  ', { brand: 'NANO10 MB' });
  assert.equal(harness.calls[0].name, 'rpc_egress_search_invoice_products');
  assert.equal(harness.calls[0].args.p_brand, 'brand_nano10mb');
  assert.equal(harness.calls[0].args.p_query, 'Sơn lót');
  assert.equal(rows[0].packageType, 'Lon');
});

test('an older database uses the bounded compatibility RPC and preserves its pagination', async () => {
  const cursor = { code: 'AA-40', id: 'id-40' };
  const harness = serviceHarness(name => name === 'rpc_egress_search_invoice_products'
    ? { data: null, error: { code: 'PGRST202' } }
    : { data: { data: [], hasMore: true, nextCursor: cursor }, error: null });
  const rows = await harness.search('Sơn lót', { brand: 'NANO10 MB' });
  assert.equal(rows.hasMore, true);
  assert.deepEqual(json(rows.nextCursor), cursor);
  assert.equal(harness.calls[1].name, 'rpc_egress_search_products');
  assert.equal(harness.calls[1].args.p_saleable_only, true);
});

test('permission failures and a changed login session do not trigger compatibility reads', async () => {
  const denied = serviceHarness(() => ({ data: null, error: { code: '42501', message: 'Permission denied' } }));
  await assert.rejects(denied.search('Sơn lót'), /Permission denied|\[object Object\]/);
  assert.equal(denied.calls.length, 1);
  const remote = deferred();
  const harness = serviceHarness(() => remote.promise);
  const pending = harness.search('Sơn lót');
  harness.state.currentUser = { ...actor, authUserId: 'sale-2' };
  remote.resolve({ data: { data: [] }, error: null });
  await assert.rejects(pending, /Phiên truy cập đã thay đổi/);
  assert.equal(harness.calls.length, 1);
});
