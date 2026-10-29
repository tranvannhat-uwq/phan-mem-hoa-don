import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getCashbookDisplayCode, getCanonicalCashbookId } from '../js/domain/cashbook.js';

const ui = readFileSync(new URL('../js/components/so_quy.js', import.meta.url), 'utf8');
const payment = { id: 'PC-NCC-c9d604cdce92424383361a71a6a93afd', cloudId: 'PC-NCC-c9d604cdce92424383361a71a6a93afd', displayNumber: '42', type: 'chi', value: 100000000, status: 'completed', partner: 'Việt Long' };

test('cashbook labels are short, stable and separate from financial IDs', () => {
  assert.equal(getCashbookDisplayCode(payment), 'PC-000042');
  assert.equal(getCanonicalCashbookId(payment), payment.id);
  assert.equal(getCashbookDisplayCode({ ...payment, type: 'thu' }), 'PT-000042');
  assert.equal(getCashbookDisplayCode({ direction: 'out', display_number: 7 }), 'PC-000007');
  assert.equal(getCashbookDisplayCode({ ...payment, displayNumber: '1000000' }), 'PC-1000000');
  assert.equal(getCashbookDisplayCode({ ...payment, status: 'cancelled', value: 10 }), 'PC-000042');
  assert.equal(getCashbookDisplayCode({ id: 'LEGACY-CODE' }), 'LEGACY-CODE');
  assert.equal(getCashbookDisplayCode({ id: 'old', displayNumber: 'invalid' }), 'old');
});

test('Cloud snapshots preserve display numbers without replacing row identities', () => {
  const service = readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(service.slice(service.indexOf('function mapCashbookTransaction('), service.indexOf('export function applyCashbookRealtimePayload(')), context);
  const mapped = context.mapCashbookTransaction({ ...payment, displayNumber: undefined, display_number: 42 });
  assert.equal(getCashbookDisplayCode(mapped), 'PC-000042');
  assert.equal(mapped.id, payment.id); assert.equal(mapped.cloudId, payment.id);
  assert.equal(context.mapCashbookTransaction(payment).displayNumber, '42');
});

test('inline details use the short code while action data attributes retain the canonical ID', () => {
  const context = vm.createContext({
    getCashbookDisplayCode, escapeCashbookHtml: value => String(value ?? ''), isCancelledStatus: () => false,
    getLegacyReceiptCustomer: () => null, canEditCashbookTransaction: () => true, isPaidStatus: () => true, formatDateTime: () => '29/10/2026',
    formatCurrency: value => `${value} ₫`, getCashbookMethodLabel: () => 'Tiền mặt', getTransactionPartnerAddress: () => ''
  });
  vm.runInContext(ui.slice(ui.indexOf('function renderCashbookInlineDetail('), ui.indexOf('function renderCashbookPagination(')), context);
  const html = context.renderCashbookInlineDetail(payment);
  assert.match(html, /<span>PC-000042<\/span>/);
  assert.match(html, new RegExp(`data-id="${payment.id}"`));
  assert.doesNotMatch(html, /<span>PC-NCC-/);
});

test('Excel exports the same code as the UI without changing the source transaction', () => {
  let sheet;
  const context = vm.createContext({ getCashbookDisplayCode, formatDateTime: () => '29/10/2026', getTransactionPartnerAddress: () => '', showToast() {}, XLSX: {
    utils: { book_new: () => ({}), aoa_to_sheet: data => { sheet = data; return {}; }, book_append_sheet() {} }, writeFile() {}
  } });
  vm.runInContext(ui.slice(ui.indexOf('function exportSoQuyToExcel(')), context);
  context.exportSoQuyToExcel([payment]);
  assert.equal(sheet[1][0], 'PC-000042');
  assert.equal(payment.id, 'PC-NCC-c9d604cdce92424383361a71a6a93afd');
  assert.match(ui, /\[t\.id, getCashbookDisplayCode\(t\), t\.externalReference\]/);
  assert.match(ui, /getCanonicalCashbookId\(t\)/);
});
