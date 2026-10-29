import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/purchases.js', import.meta.url), 'utf8');
function harness(response = async () => ({ rows: [], hasMore: false })) {
  let nextTimer = 0, focusCount = 0;
  const timers = new Map(), requests = [], classes = new Set(['purchase-entry-material-search']);
  const document = { activeElement: null };
  const name = { value: 'Vật tư chưa có <mới>', type: 'search', selectionStart: 4, selectionEnd: 7, selectionDirection: 'forward', error: 'Chọn danh mục', attrs: {},
    classList: { toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key) },
    setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
    setCustomValidity(value) { this.error = value; }, focus() { document.activeElement = name; focusCount++; },
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
    matches: key => key === '.purchase-entry-material-search' && classes.has('purchase-entry-material-search')
  };
  const results = { id: 'result-list', hidden: true, innerHTML: '' };
  const fields = { '.purchase-entry-name': name, '.purchase-entry-material-results': results,
    '.purchase-entry-code': { value: 'USER-CODE', readOnly: true }, '.purchase-entry-unit': { value: 'kg', readOnly: true },
    '.purchase-entry-qty': { value: '217.72' }, '.purchase-entry-price': { value: '127800' },
    '.purchase-entry-item-source span': { textContent: 'Từ danh mục' }, '.purchase-entry-switch-source': { textContent: 'Nhập tay' } };
  const modal = {};
  const row = { isConnected: true, dataset: { mode: 'material', catalogId: '' }, closest: () => modal,
    querySelector: key => key === '.purchase-entry-material-search' ? (classes.has('purchase-entry-material-search') ? name : null) : fields[key],
    querySelectorAll: () => [], remove() { throw new Error('Must not replace the row'); } };
  name.closest = selector => selector === '.purchase-entry-material-search' ? (classes.has('purchase-entry-material-search') ? name : null) : row;
  const context = vm.createContext({ document, modal, Event, updateTotals() {}, escapeHtml: value => String(value), formatCurrency: value => String(value),
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id),
    bomGateway: { searchPurchaseItems: async filters => { requests.push(filters); return response(filters); } } });
  vm.runInContext(source.slice(source.indexOf('function closePurchaseMaterialResults('), source.indexOf('function normalizeSupplierSearch(')), context);
  return { row, name, fields, results, document, context, requests, get focusCount() { return focusCount; },
    search() { context.searchPurchaseMaterials(row); }, async flush() { const entry = [...timers].at(-1); if (entry) { timers.delete(entry[0]); await entry[1](); } } };
}

test('a successful empty search converts the row in place and preserves typed name, quantity, price and caret', async () => {
  const h = harness(); h.document.activeElement = h.name;
  h.search(); await h.flush();
  assert.equal(h.row.dataset.mode, 'manual'); assert.equal(h.row.dataset.catalogId, '');
  assert.equal(h.name.value, 'Vật tư chưa có <mới>');
  assert.equal(h.name.error, ''); assert.equal(h.name.type, 'text');
  assert.equal(h.name.selectionStart, 4); assert.equal(h.name.selectionEnd, 7);
  assert.equal(h.fields['.purchase-entry-qty'].value, '217.72');
  assert.equal(h.fields['.purchase-entry-price'].value, '127800');
  assert.equal(h.fields['.purchase-entry-code'].value, 'USER-CODE');
  assert.equal(h.fields['.purchase-entry-unit'].value, 'kg');
  assert.equal(h.fields['.purchase-entry-code'].readOnly, false);
  assert.equal(h.fields['.purchase-entry-switch-source'].textContent, 'Chọn danh mục');
  assert.equal(h.results.hidden, true);
});

test('automatic fallback does not move focus away from another field', async () => {
  const h = harness(); const quantity = h.fields['.purchase-entry-qty']; h.document.activeElement = quantity;
  h.search(); await h.flush();
  assert.equal(h.row.dataset.mode, 'manual');
  assert.equal(h.document.activeElement, quantity); assert.equal(h.focusCount, 0);
});

test('manual source buttons preserve existing field values in both directions', () => {
  const h = harness(); h.row.dataset.catalogId = 'catalog-id';
  h.context.switchPurchaseItemMode(h.row);
  assert.equal(h.row.dataset.mode, 'manual'); assert.equal(h.name.error, '');
  assert.equal(h.name.value, 'Vật tư chưa có <mới>'); assert.equal(h.fields['.purchase-entry-code'].value, 'USER-CODE');
  h.context.switchPurchaseItemMode(h.row);
  assert.equal(h.row.dataset.mode, 'material'); assert.equal(h.row.dataset.catalogId, '');
  assert.equal(h.name.value, 'Vật tư chưa có <mới>');
  assert.equal(h.fields['.purchase-entry-unit'].value, 'kg');
  assert.equal(h.fields['.purchase-entry-code'].readOnly, true);
  assert.match(h.name.error, /Chọn vật tư/); assert.equal(h.name.attrs.role, 'combobox');
});

test('blank queries, selected catalog items, more results and request failures do not trigger fallback', async () => {
  for (const variant of ['blank', 'selected', 'more', 'error', 'matches']) {
    const h = harness(async () => {
      if (variant === 'error') throw new Error('Connection error');
      return { rows: variant === 'matches' ? [{ id: 'known', name: 'Known', code: 'K' }] : [], hasMore: variant === 'more' };
    });
    if (variant === 'blank') h.name.value = '  ';
    if (variant === 'selected') h.row.dataset.catalogId = 'known';
    h.search(); await h.flush(); assert.equal(h.row.dataset.mode, 'material', variant);
  }
});

test('an older empty response cannot overwrite a newer successful catalog search', async () => {
  const resolve = [];
  const h = harness(() => new Promise(done => resolve.push(done)));
  h.search(); const first = h.flush();
  h.name.value = 'Known item'; h.search(); const second = h.flush();
  resolve[1]({ rows: [{ id: 'known', name: 'Known item', code: 'K' }] }); await second;
  resolve[0]({ rows: [] }); await first;
  assert.equal(h.row.dataset.mode, 'material'); assert.equal(h.name.value, 'Known item');
  assert.equal(h.row.purchaseMaterialMatches[0].id, 'known');
});

test('Vietnamese composition invalidates an in-flight response and searches only when composition finishes', async () => {
  const handlers = {};
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.context.itemBody = { addEventListener: (key, handler) => { handlers[key] = handler; } };
  h.name.dispatchEvent = () => handlers.input({ target: h.name, isComposing: false });
  vm.runInContext(source.slice(source.indexOf("    itemBody?.addEventListener('compositionstart'"), source.indexOf("    itemBody?.addEventListener('keydown'")), h.context);
  h.search(); const pending = h.flush();
  handlers.compositionstart({ target: h.name });
  handlers.input({ target: h.name, isComposing: true });
  resolve({ rows: [] }); await pending;
  assert.equal(h.row.dataset.mode, 'material'); assert.equal(h.requests.length, 1);
  handlers.compositionend({ target: h.name });
  const finished = h.flush(); resolve({ rows: [] }); await finished;
  assert.equal(h.row.dataset.mode, 'manual'); assert.equal(h.name.value, 'Vật tư chưa có <mới>');
});
