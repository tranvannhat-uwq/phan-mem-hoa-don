import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function applyCanonicalPurchase('),
  source.indexOf('export async function dbRecordSupplierPayment(')).replace(/^export /gm, '');
function harness(response) {
  const calls = [], toasts = [];
  const context = vm.createContext({
    state: { purchases: [] }, isCloudActive: true,
    supabaseClient: { rpc: async (...args) => { calls.push(args); return response; } },
    showToast: message => toasts.push(message), applyCanonicalSupplier() {},
    console: { warn() {} }
  });
  vm.runInContext(code, context);
  return { context, calls, toasts };
}

test('purchase service sends the entered VAT rate and keeps server amounts in state', async () => {
  const result = { purchase: { id: 'p1', purchaseDate: '2026-10-24', subtotalAmount: '250000',
    vatRate: '8.50', vatAmount: '21250', totalAmount: '271250', paidAmount: '100000', balanceDue: '171250' } };
  const h = harness({ data: result, error: null });
  await h.context.dbCreatePurchase({ supplierId: 's1', vatRate: 8.5, vatAmount: 1, totalAmount: 1,
    items: [{ code: 'VO', name: 'Vỏ', quantity: 2, unitPrice: 125000 }] });
  assert.equal(h.calls[0][0], 'rpc_create_purchase_vat');
  assert.equal(h.calls[0][1].p_input.vatRate, 8.5);
  assert.equal('vatAmount' in h.calls[0][1].p_input, false);
  assert.equal('totalAmount' in h.calls[0][1].p_input, false);
  const purchase = h.context.state.purchases[0];
  assert.equal(purchase.subtotalAmount, 250000);
  assert.equal(purchase.vatRate, 8.5);
  assert.equal(purchase.vatAmount, 21250);
  assert.equal(purchase.totalPayable, 271250);
  assert.equal(purchase.balanceDue, 171250);
});

test('an older server produces a migration message without retrying through a VAT-unaware RPC', async () => {
  const h = harness({ data: null, error: { code: 'PGRST202', message: 'Function missing' } });
  assert.equal(await h.context.dbCreatePurchase({ vatRate: 8 }), false);
  assert.equal(h.calls.length, 1);
  assert.match(h.toasts[0], /0102/);
  assert.equal(h.context.state.purchases.length, 0);
});

test('nonfinite or invalid VAT cannot be serialized into a zero-VAT purchase', async () => {
  const h = harness({ data: {}, error: null });
  for (const vatRate of [NaN, Infinity, -1, 100.01, 8.001]) {
    assert.equal(await h.context.dbCreatePurchase({ vatRate }), false);
  }
  assert.equal(h.calls.length, 0);
  assert.ok(h.toasts.every(message => /VAT/.test(message)));
});
