import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/purchases.js', import.meta.url), 'utf8');
const sample = { id: 'p1', supplierId: 's1', code: 'PM-1', status: 'completed', totalAmount: 98788190, paidAmount: 0, balanceDue: 98788190, items: [] };
function uiContext() {
  const context = vm.createContext({ formatCurrency: value => `${value} ₫`, escapeHtml: value => String(value ?? ''), purchaseDate: () => '29/10/2026', purchaseCreatorName: () => 'Kế toán', statusLabel: () => 'Hoàn thành' });
  vm.runInContext(source.slice(source.indexOf('function purchaseTotal('), source.indexOf('function purchaseDate(')), context);
  vm.runInContext(source.slice(source.indexOf('function purchaseDetail('), source.indexOf('function updateTotals(')), context);
  vm.runInContext(source.slice(source.indexOf('function updatePurchasePaymentPreview('), source.indexOf('function closePurchaseMaterialResults(')), context);
  return context;
}

test('payment amount has no invoice ceiling and an overpaid or settled invoice shows its credit', () => {
  const context = uiContext();
  const html = context.purchaseDetail(sample);
  const input = html.match(/<input[^>]*class="purchase-pay-amount"[^>]*>/)[0];
  assert.doesNotMatch(input, /\bmax=/);
  const settled = context.purchaseDetail({ ...sample, balanceDue: 0, paidAmount: 100000000 });
  assert.match(settled, /purchase-pay-amount/);
  assert.match(settled, /Trả vượt giá trị phiếu/);
  assert.match(settled, /1211810 ₫/);
});

test('payment preview reports the excess without modifying the entered amount', () => {
  const input = { value: '100000000' }, preview = { textContent: '' };
  uiContext().updatePurchasePaymentPreview({ dataset: { balanceDue: '98788190' }, querySelector: selector => selector.includes('amount') ? input : preview });
  assert.match(preview.textContent, /1211810 ₫/);
  assert.equal(input.value, '100000000');
});

test('payment button sends the full amount and rejects invalid money before calling Cloud', async () => {
  let click;
  const calls = [], toasts = [], input = { value: '100000000', focus() {} };
  const box = { dataset: { balanceDue: '98788190' }, querySelector: selector => selector.includes('amount') ? input : { value: 'cash' } };
  const button = { dataset: { id: 'p1' }, closest: () => box, addEventListener: (event, fn) => { click = fn; } };
  const context = vm.createContext({ state: { purchases: [sample] }, panel: { querySelectorAll: () => [button] }, pendingSupplierPaymentKeys: new Map(), newKey: () => 'payment-attempt-key', showToast: message => toasts.push(message), renderPurchasesPanel() {}, dbRecordSupplierPayment: async data => { calls.push(data); return { success: true }; } });
  vm.runInContext(source.slice(source.indexOf("  panel.querySelectorAll('.purchase-pay-btn')"), source.indexOf("  panel.querySelectorAll('.purchase-cancel-payment-btn')")), context);
  await click({ stopPropagation() {} });
  assert.equal(calls[0].amount, 100000000);
  assert.equal(button.disabled, false);
  input.value = '0'; await click({ stopPropagation() {} });
  assert.equal(calls.length, 1);
  assert.match(toasts.at(-1), /nguyên dương/);
});

const service = readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
function serviceContext(response) {
  const calls = [], toasts = [];
  const context = vm.createContext({ state: { purchases: [], suppliers: [] }, isCloudActive: true,
    supabaseClient: { rpc: async (...args) => { calls.push(args); return response; } }, showToast: message => toasts.push(message), console: { warn() {} } });
  vm.runInContext(service.slice(service.indexOf('function applyCanonicalSupplier('), service.indexOf('export async function dbCancelSupplierPayment(')).replace(/^export /gm, ''), context);
  return { context, calls, toasts };
}

test('service uses the advance RPC and retains the full payment and signed supplier debt', async () => {
  const h = serviceContext({ data: { purchase: { ...sample, paidAmount: 100000000, balanceDue: 0 }, supplier: { id: 's1', debt: -1211810, totalPaid: 100000000 } } });
  await h.context.dbRecordSupplierPayment({ supplierId: 's1', purchaseId: 'p1', amount: 100000000, idempotencyKey: 'payment-attempt-key' });
  assert.equal(h.calls[0][0], 'rpc_record_purchase_payment_advance');
  assert.equal(h.calls[0][1].p_input.amount, 100000000);
  assert.equal(h.context.state.purchases[0].paidAmount, 100000000);
  assert.equal(h.context.state.suppliers[0].debt, -1211810);
});

test('missing advance migration fails clearly without retrying through the old RPC', async () => {
  const h = serviceContext({ error: { code: 'PGRST202', message: 'Missing function' } });
  assert.equal(await h.context.dbRecordSupplierPayment({ supplierId: 's1', purchaseId: 'p1', amount: 100000000 }), false);
  assert.equal(h.calls.length, 1);
  assert.match(h.toasts[0], /0134/);
  for (const amount of [0, -1, 0.5, NaN, Infinity]) assert.equal(await h.context.dbRecordSupplierPayment({ purchaseId: 'p1', amount }), false);
  assert.equal(h.calls.length, 1);
});
