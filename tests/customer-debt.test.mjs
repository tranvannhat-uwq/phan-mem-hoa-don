import assert from 'node:assert/strict';
import {
  chargeCustomerDebt,
  collectCustomerDebt,
  getOrderOutstandingAmount,
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

console.log('customer-debt.test.mjs: all assertions passed');
