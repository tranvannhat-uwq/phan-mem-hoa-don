import assert from 'node:assert/strict';
import {
  chargeCustomerDebt,
  collectCustomerDebt,
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

console.log('customer-debt.test.mjs: all assertions passed');
