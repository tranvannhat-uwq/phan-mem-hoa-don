import assert from 'node:assert/strict';
import {
  chargeCustomerDebt,
  collectCustomerDebt,
  getNeutralizedOrderDebtEntryIds,
  getOrderDebtSnapshot,
  getOrderOutstandingAmount,
  mergeCustomerDebtHistory,
  reduceCustomerDebtForReturn,
  restoreCustomerDebtForCancelledReturn
} from '../js/domain/customer-debt.js';

assert.equal(getOrderOutstandingAmount({ totalPayable: 100000, shippingFeeAmount: 15000, paidAmount: 20000 }), 95000);
assert.equal(getOrderOutstandingAmount({ amountDue: 240000, totalPayable: 100000 }), 240000);

let debt = 100000;
debt = chargeCustomerDebt(debt, 250000);
assert.equal(debt, 350000, 'A finalized order increases receivable debt');
debt = collectCustomerDebt(debt, 125000);
assert.equal(debt, 225000, 'A receipt reduces receivable debt');
debt = reduceCustomerDebtForReturn(debt, 250000);
assert.equal(debt, -25000, 'A return can create a customer credit');
debt = restoreCustomerDebtForCancelledReturn(debt, 250000);
assert.equal(debt, 225000, 'Cancelling a return reverses exactly one return');

const mergedHistory = mergeCustomerDebtHistory([
  { id: 'HD-001', type: 'charge', amount: 1840000, debtAfter: 1840400 },
  { id: 'legacy-payment', type: 'payment', amount: 400 }
], [
  {
    id: 'dtx-ord-HD-001',
    orderId: 'HD-001',
    transactionType: 'order',
    type: 'charge',
    amount: 1840000,
    debtBefore: 400,
    debtAfter: 1840400
  }
]);
assert.deepEqual(mergedHistory.map(item => item.id), ['legacy-payment', 'dtx-ord-HD-001']);

assert.deepEqual(getOrderDebtSnapshot({ id: 'HD-001' }, { debtHistory: mergedHistory }), {
  debtBefore: 400,
  debtAfter: 1840400
}, 'Invoice debt uses the ledger orderId instead of mistaking the ledger id for an order id');

assert.deepEqual(getOrderDebtSnapshot({ id: 'HD-002' }, { debtHistory: [] }, {
  orderId: 'HD-002', debtBefore: -13898778, debtAfter: -407803
}), { debtBefore: -13898778, debtAfter: -407803 }, 'A targeted cloud snapshot is accepted without mutating customer state');

const compactedIds = getNeutralizedOrderDebtEntryIds([
  { id: 'charge-old', orderId: 'HD-OLD', transactionType: 'order', debtChange: 13490975 },
  { id: 'reverse-old', orderId: 'HD-OLD', transactionType: 'order_cancel', debtChange: -13490975, reversalOfId: 'charge-old' },
  { id: 'charge-new', orderId: 'HD-NEW', transactionType: 'order', debtChange: 13490975 },
  { id: 'unrelated-adjust', transactionType: 'adjust', debtChange: -1000 }
]);
assert.deepEqual([...compactedIds].sort(), ['charge-old', 'reverse-old']);

console.log('customer-debt.test.mjs: all assertions passed');
