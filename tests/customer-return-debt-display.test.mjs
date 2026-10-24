import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { withCustomerReturnDocuments, buildCustomerDebtDisplayHistory } from '../js/domain/customer-debt.js';

const returned = overrides => ({ id: 'RET-01', customerId: 'c1', saleId: 'HD-01', totalRefund: 2166592,
  debtReductionAmount: 0, refundAmount: 2166592, status: 'completed',
  createdAt: '2026-10-24T07:37:00Z', ...overrides });

test('a fully refunded return shows its full document value while preserving the -23 debt balance', () => {
  const original = [{ id: 'local-return', type: 'return', salesReturnId: 'RET-01', orderId: 'HD-01',
    amount: 0, debtBefore: -23, debtAfter: -23, date: '2026-10-24T07:37:00Z' }];
  const rows = buildCustomerDebtDisplayHistory(withCustomerReturnDocuments(original, [returned()], 'c1'), -23);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].returnTotalAmount, 2166592);
  assert.equal(rows[0].cashRefundAmount, 2166592);
  assert.equal(rows[0].debtChange, 0);
  assert.equal(rows[0].debtBefore, -23);
  assert.equal(rows[0].debtAfter, -23);
  assert.equal(original[0].returnTotalAmount, undefined);
});

test('cash-only documents missing a ledger row remain visible after a reload with zero debt movement', () => {
  const rows = buildCustomerDebtDisplayHistory(withCustomerReturnDocuments([], [returned()], 'c1'), -23);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].salesReturnId, 'RET-01');
  assert.equal(rows[0].debtChange, 0);
  assert.equal(rows[0].debtBefore, -23);
  assert.equal(rows[0].debtAfter, -23);
});

test('a partial refund distinguishes the return total, debt reduction and cash and never double-counts', () => {
  const document = returned({ debtReductionAmount: 500000, refundAmount: 1666592 });
  const ledger = [{ id: 'ledger', type: 'return', transactionType: 'return', salesReturnId: document.id,
    amount: 500000, debtChange: -500000, debtBefore: 500000, debtAfter: 0, date: document.createdAt }];
  const rows = buildCustomerDebtDisplayHistory(withCustomerReturnDocuments(ledger, [document], 'c1'), 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].returnTotalAmount, 2166592);
  assert.equal(rows[0].cashRefundAmount, 1666592);
  assert.equal(rows[0].debtChange, -500000);
  assert.equal(rows[0].debtBefore, 500000);
  assert.equal(rows[0].debtAfter, 0);
});

test('the retained-credit policy displays the entire return reducing an already negative balance', () => {
  const document = returned({ debtReductionAmount:2166592,refundAmount:0 });
  const ledger = [{ id:'credit', type:'return', transactionType:'return', salesReturnId:document.id,
    amount:2166592,debtChange:-2166592,debtBefore:-23,debtAfter:-2166615,date:document.createdAt }];
  const [row] = buildCustomerDebtDisplayHistory(withCustomerReturnDocuments(ledger,[document],'c1'),-2166615);
  assert.equal(row.returnTotalAmount,2166592);
  assert.equal(row.cashRefundAmount,0);
  assert.equal(row.debtBefore,-23);
  assert.equal(row.debtAfter,-2166615);
});

test('cancelled, other-customer and missing-debt ledgers do not create fictitious movements', () => {
  const old = [{ id: 'old-local', type: 'return', salesReturnId: 'RET-01', amount: 0 }];
  assert.deepEqual(withCustomerReturnDocuments(old, [returned({ status: 'cancelled' })], 'c1'), []);
  assert.deepEqual(withCustomerReturnDocuments([], [returned({ customerId: 'c2' })], 'c1'), []);
  assert.deepEqual(withCustomerReturnDocuments([], [returned({ debtReductionAmount: 10, refundAmount: 2166582 })], 'c1'), []);
});

test('return rows open their return document rather than the original order', () => {
  const source = readFileSync(new URL('../js/components/customers.js', import.meta.url), 'utf8');
  const start = source.indexOf('function getCustomerDebtSource(');
  const end = source.indexOf('function getCustomerDebtSourceDisplayCode(', start);
  const resolve = vm.runInNewContext(`${source.slice(start, end)}; getCustomerDebtSource`);
  const result = resolve({ type: 'return', orderId: 'HD-01', salesReturnId: 'RET-01' });
  assert.equal(result.kind, 'return');
  assert.equal(result.id, 'RET-01');
  assert.equal(resolve({ type: 'charge', orderId: 'HD-01' }).kind, 'order');
});
