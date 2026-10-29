import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/purchases.js', import.meta.url), 'utf8');
const quoteRows = [{ quantity: 1200, price: 39000 }, { quantity: 3000, price: 40000 }, { quantity: 217.72, price: 127800 }];
function harness({ rows = quoteRows, timing = 'after_vat', type = 'amount', discount = 2208860 } = {}) {
  const fields = new Map();
  const node = id => {
    if (!fields.has(id)) fields.set(id, { value: '', textContent: '', setCustomValidity(message) { this.error = message; } });
    return fields.get(id);
  };
  node('#purchase-paid-input').value = '0'; node('#purchase-vat-rate').value = '8';
  node('#purchase-discount-timing').value = timing; node('#purchase-discount-type').value = type; node('#purchase-discount-value').value = String(discount);
  const lines = rows.map(row => ({ querySelector: selector => ({ value: String(selector.includes('qty') ? row.quantity : row.price), textContent: '' }) }));
  const modal = { querySelector: node, querySelectorAll: () => lines };
  const context = vm.createContext({ formatCurrency: amount => String(amount) });
  vm.runInContext(source.slice(source.indexOf('function updateTotals('), source.indexOf('function updatePurchasePaymentPreview(')), context);
  return { node, calculate() { context.updateTotals(modal); } };
}

test('entering quote 891 numbers produces its exact VAT, discount and final total in the form', () => {
  const h = harness(); h.calculate();
  assert.equal(h.node('#purchase-entry-subtotal').textContent, '194624616');
  assert.equal(h.node('#purchase-entry-vat-total').textContent, '15569969');
  assert.equal(h.node('#purchase-entry-discount-total').textContent, '−2208860');
  assert.equal(h.node('#purchase-entry-total').textContent, '207985725');
  assert.equal(h.node('#purchase-entry-debt-total').textContent, '207985725');
  assert.equal(h.node('#purchase-paid-input').max, '207985725');
  h.node('#purchase-discount-timing').value = 'before_vat'; h.calculate();
  assert.equal(h.node('#purchase-entry-vat-total').textContent, '15393260');
  assert.equal(h.node('#purchase-entry-total').textContent, '207809016');
});

test('percentage base and VND limits follow the selected before/after VAT mode', () => {
  const h = harness({ rows: [{ quantity: 1, price: 250000 }], type: 'percent', discount: 10 }); h.calculate();
  assert.equal(h.node('#purchase-entry-discount-total').textContent, '−27000');
  assert.equal(h.node('#purchase-entry-total').textContent, '243000');
  assert.match(h.node('#purchase-discount-description').textContent, /tổng gồm VAT/);
  h.node('#purchase-discount-type').value = 'amount'; h.node('#purchase-discount-value').value = '270001'; h.calculate();
  assert.equal(h.node('#purchase-discount-value').max, '270000');
  assert.match(h.node('#purchase-discount-value').error, /tổng gồm VAT/);
  h.node('#purchase-discount-timing').value = 'before_vat'; h.node('#purchase-discount-value').value = '20000'; h.calculate();
  assert.equal(h.node('#purchase-discount-value').max, '250000');
  assert.equal(h.node('#purchase-entry-vat-total').textContent, '18400');
});

test('new forms default to after VAT and printed invoices preserve the saved calculation mode', () => {
  let printed = '';
  const context = vm.createContext({ itemRow: () => '', escapeHtml: value => String(value ?? ''), purchaseDate: () => '29/10/2026', purchaseTotal: p => p.totalAmount,
    purchaseOverpayment: () => 0, formatCurrency: value => String(value), window: { open: () => ({ document: { write: html => { printed = html; }, close() {} }, focus() {}, print() {} }) } });
  vm.runInContext(source.slice(source.indexOf('function purchaseModal('), source.indexOf('function purchaseDetail(')), context);
  assert.match(context.purchaseModal(), /id="purchase-discount-timing"[^>]*>[\s\S]*?<option value="after_vat">Sau VAT<\/option>/);
  vm.runInContext(source.slice(source.indexOf('function printPurchase('), source.indexOf('function attachEvents(')), context);
  context.printPurchase({ id: 'quote891', totalAmount: 207985725, subtotalAmount: 194624616, discountType: 'amount', discountAmount: 2208860, discountTiming: 'after_vat', vatRate: 8, vatAmount: 15569969, paidAmount: 0, balanceDue: 207985725 });
  assert.match(printed, /VAT \(8%\): 15569969/);
  assert.match(printed, /Sau VAT: −2208860/);
  assert.match(printed, /Tổng gồm VAT: 207985725/);
});
