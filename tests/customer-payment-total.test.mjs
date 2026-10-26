import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { getCustomerTotalPayments } from '../js/domain/customer-debt.js';

const payment = (id, amount, extra = {}) => ({
  id, type: 'payment', transactionType: 'payment', amount, debtChange: -amount, ...extra
});
const amendment = (id, target, change, extra = {}) => ({
  id, type: 'adjust', transactionType: 'payment_amend',
  amount: Math.abs(change), debtChange: change, amendsLedgerId: target, ...extra
});

test('corrected receipts reconcile the reported totals without changing customer debt', () => {
  const otherReceipts = [20000000, 25000000, 25000000, 6980000, 3200000,
    17794000, 10000000, 20500000, 10000000, 7688000];
  const history = [
    ...otherReceipts.map((amount, index) => payment(`receipt-${index}`, amount)),
    payment('corrected-receipt', 80000000),
    amendment('correction', 'corrected-receipt', 39200320)
  ];
  assert.equal(history.filter(row => row.type === 'payment').reduce((sum, row) => sum + row.amount, 0), 226162000);
  const original = structuredClone(history);
  assert.equal(getCustomerTotalPayments(history), 186961680);
  assert.equal(215717258 - getCustomerTotalPayments(history), 28755578);
  assert.deepEqual(history, original, 'Computing the summary never rewrites ledger records');
});

test('successive increases, decreases, date edits and voided edits use the effective receipt', () => {
  const history = [payment('p', 5000000),
    amendment('a', 'p', -2000000, { postedAt: '2026-10-01T01:00:00Z' }),
    amendment('b', 'a', 1000000, { postedAt: '2026-10-02T01:00:00Z' }),
    amendment('date', 'p', 0, { postedAt: '2026-10-03T01:00:00Z' }),
    amendment('void', 'p', -9000000, { voidedByAmendmentId: 'undo' })];
  assert.equal(getCustomerTotalPayments(history), 6000000);
});

test('cancelling an amended receipt does not subtract its cancellation twice', () => {
  const history = [payment('p', 80000000, { cashbookTransactionId: 'PT-1' }),
    amendment('a', 'p', 39200320, { cashbookTransactionId: 'PT-1' }),
    { id: 'cancel', type: 'payment_cancel', transactionType: 'payment_cancel',
      amount: 40799680, debtChange: 40799680, reversalOfId: 'p', cashbookTransactionId: 'PT-1' },
    payment('remaining', 20000000)];
  assert.equal(getCustomerTotalPayments(history), 20000000);
});

test('relinking a receipt removes it from the old customer and counts it for the new customer', () => {
  const oldHistory = [payment('p', 5000000),
    amendment('out', 'p', 5000000, { transactionType: 'payment_relink' })];
  const newHistory = [amendment('in', 'p', -5000000, { transactionType: 'payment_relink' })];
  assert.equal(getCustomerTotalPayments(oldHistory), 0);
  assert.equal(getCustomerTotalPayments(newHistory), 5000000);
});

test('legacy receipts and unlinked cancellations retain their existing meaning', () => {
  assert.equal(getCustomerTotalPayments([
    { type: 'payment', amount: '10000000' },
    { id: 'cancel', type: 'payment_cancel', amount: 2000000 },
    { id: 'adjust', type: 'adjust', amount: 1000000, note: 'Hủy phiếu thu cũ' }
  ]), 7000000);
  assert.equal(getCustomerTotalPayments(null), 0);
});

test('orders, returns, debt adjustments and suppressed history do not inflate receipts', () => {
  assert.equal(getCustomerTotalPayments([
    payment('p', 3000000),
    payment('suppressed', 7000000, { historyCorrectionKey: 'duplicate' }),
    { id: 'order', type: 'charge', transactionType: 'order', amount: 10000000, debtChange: 10000000 },
    { id: 'return', type: 'return', amount: 1000000, debtChange: -1000000 },
    { id: 'adjust', type: 'adjust', amount: 2000000, debtChange: -2000000 }
  ]), 3000000);
});

test('stored customer totals and order-based fallback both use effective receipts', () => {
  const source = readFileSync(new URL('../js/components/customers.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function getCustomerMetrics(');
  const end = source.indexOf('\nfunction getCustomerLastTransactionDate(', start);
  const metrics = vm.runInNewContext(`${source.slice(start, end).replace('export ', '')}; getCustomerMetrics`, {
    getCustomerTotalPayments, parseImportedNumber: value => Number(value || 0), getTimestamp: () => 0,
    state: { savedOrders: [{ customerId: 'c', status: 'settled', totalPayable: 215717258 }], salesReturns: [] }
  });
  const customer = { id: 'c', name: 'Customer', debt: 28755578,
    debtHistory: [payment('p', 226162000), amendment('a', 'p', 39200320)] };
  for (const input of [customer, { ...customer, totalTransaction: 215717258 }]) {
    const result = metrics(input);
    assert.equal(result.totalPayments, 186961680);
    assert.equal(result.currentDebt, 28755578);
    assert.equal(result.grossSales - result.totalPayments, result.currentDebt);
  }
});
