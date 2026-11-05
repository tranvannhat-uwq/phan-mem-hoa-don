import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { getOrderFinancialBreakdown } from '../js/domain/order-financials.js';
import { buildCustomerDebtDisplayHistory } from '../js/domain/customer-debt.js';

const historyUi = fs.readFileSync(new URL('../js/components/history.js', import.meta.url), 'utf8');
const paymentSummarySource = historyUi.slice(
  historyUi.indexOf('function getHistoryOrderPaymentSummary('),
  historyUi.indexOf('function historyOrderDetailId(')
);
const sandbox = {};
vm.runInNewContext(`${paymentSummarySource}; this.paymentSummary = getHistoryOrderPaymentSummary;`, sandbox);

test('history detail agrees with its row total for legacy percent discounts stored as zero', () => {
  const order = {
    items: [{ quantity: 2, unitPrice: 1319600 }],
    subtotal: 2639200, discountType: 'percent', discountValue: 3,
    discountAmount: 0, totalPayable: 2560024
  };
  const amounts = getOrderFinancialBreakdown(order);
  const summary = sandbox.paymentSummary(order, amounts);
  assert.equal(summary.invoiceDiscount, 79176);
  assert.equal(summary.customerPayable, 2560024);
  assert.equal(summary.totalGoods - summary.invoiceDiscount, summary.customerPayable);
});

test('invoice discount excludes product discounts and preserves the original discount after a return', () => {
  const order = {
    id: 'sale', pricingVersion: 'p1-v1', status: 'partially_returned',
    items: [{ quantity: 2, unitPrice: 100000, finalUnitPrice: 90000 }],
    totalMarket: 200000, subtotal: 180000, totalDiscount: 38000,
    discountAmount: 18000, totalPayable: 162000
  };
  const amounts = getOrderFinancialBreakdown(order, [{saleId: 'sale', totalRefund: 81000}]);
  assert.equal(sandbox.paymentSummary(order, amounts).invoiceDiscount, 18000);
  assert.equal(amounts.totalPayment, 81000);
});

test('folded order amendments link to the snapshot matching the displayed amount', () => {
  const rows = [
    { id: 'original', orderId: 'sale', transactionType: 'order', type: 'charge', debtChange: 2560024, postedAt: '2026-09-28T00:00:00Z' },
    { id: 'amend-1', orderId: 'sale', transactionType: 'order_amend', amendsLedgerId: 'original', debtChange: 79176, postedAt: '2026-10-01T00:00:00Z' },
    { id: 'amend-2', orderId: 'sale', transactionType: 'order_amend', amendsLedgerId: 'amend-1', debtChange: -79176, postedAt: '2026-10-02T00:00:00Z' }
  ];
  const history = buildCustomerDebtDisplayHistory(rows, 2560024);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, 'original');
  assert.equal(history[0].orderEventLedgerId, 'amend-2');
  assert.equal(history[0].amount, 2560024);
  assert.equal(rows[0].orderEventLedgerId, undefined, 'projection must not mutate source ledger');
});

test('an amendment followed by a transfer keeps the new customer snapshot isolated', () => {
  const history = buildCustomerDebtDisplayHistory([
    { id: 'transfer-in', orderId: 'sale', transactionType: 'order_amend', amendsLedgerId: 'other-customer-ledger', debtChange: 100, postedAt: '2026-10-01T00:00:00Z' },
    { id: 'amend-new', orderId: 'sale', transactionType: 'order_amend', amendsLedgerId: 'transfer-in', debtChange: 20, postedAt: '2026-10-02T00:00:00Z' }
  ], 120);
  assert.equal(history.length, 1);
  assert.equal(history[0].orderEventLedgerId, 'amend-new');
  assert.equal(history[0].amount, 120);
});

test('customer detail modal requests the folded event and displays the current zero discount', async () => {
  const source = fs.readFileSync(new URL('../js/components/customers.js', import.meta.url), 'utf8');
  const modalSource = source.slice(source.indexOf('async function openCustomerDebtSourceDetail('),
    source.indexOf('function renderCustomerDetailSummary('));
  const elements = new Map();
  let requestedId;
  const context = {
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id, {style: {}, classList: {add() {}}});
      return elements.get(id);
    }},
    dbFetchCustomerDebtOrderEventSnapshot: async id => {
      requestedId = id;
      return {available: true, order_id: 'sale', customer_id: 'buyer', event_context: 'amendment',
        order: {id: 'sale', customer_id: 'buyer', customer_name: 'Buyer', status: 'settled',
          items: [], subtotal: 2639200, discount_amount: 0, total_payable: 2639200}};
    },
    debtSourceMeta: (label, value) => `${label}:${value}`,
    formatCurrency: value => String(value), formatDateOnly: value => String(value),
    escapeCustomerHtml: value => String(value), safeCreateIcons() {}
  };
  vm.runInNewContext(`${modalSource}; this.open = openCustomerDebtSourceDetail;`, context);
  await context.open({kind: 'order', id: 'sale'},
    {id: 'original', orderEventLedgerId: 'DTX-OAM-sale-0001'}, {id: 'buyer'});
  assert.equal(requestedId, 'DTX-OAM-sale-0001');
  assert.equal(elements.get('customer-debt-source-title').innerText, 'Đơn sau lần điều chỉnh: sale');
  assert.match(elements.get('customer-debt-source-totals').innerHTML, />-0</);
  assert.match(elements.get('customer-debt-source-totals').innerHTML, />2639200</);
});
