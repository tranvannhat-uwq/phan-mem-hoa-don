import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const history = fs.readFileSync(path.join(root, 'js/components/history.js'), 'utf8');
const markup = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const returnFlow = history.slice(
  history.indexOf('export function openSalesReturnModal'),
  history.indexOf('export async function processSalesReturnSubmit')
);

test('sales return uses the saved order unit price as the refundable unit price by default', () => {
  assert.match(
    returnFlow,
    /orderUnitPrice = Math\.round\(Math\.max\(0, Number\(item\.unitPrice \?\? item\.listPrice \?\? item\.price \?\? 0\)\)\)/
  );
  assert.match(returnFlow, /refundableUnitPrice = orderUnitPrice/);
  assert.match(returnFlow, /data-order-unit-price="\$\{orderUnitPrice\}"/);
  assert.match(returnFlow, /data-refund-unit-price="\$\{refundableUnitPrice\}"/);
  assert.match(returnFlow, /formatCurrency\(orderUnitPrice\)\}<\/td>/);
  assert.match(returnFlow, /return-refund-price-lbl">\$\{formatCurrency\(refundableUnitPrice\)\}/);
  assert.doesNotMatch(returnFlow, /orderDiscountRatio|storedTotalPayable|calculatedSaleUnitPrice|item\.finalUnitPrice/);
});

test('sales return applies only the accountant-entered deduction to the order unit price', () => {
  assert.match(returnFlow, /getAttribute\('data-refund-unit-price'\)/);
  assert.match(returnFlow, /refundPrice = Math\.round\(refundableUnitPrice \* \(1 - deductionPercent \/ 100\)\)/);
  assert.match(returnFlow, /subtotal = Math\.round\(refundableUnitPrice \* qty \* \(1 - deductionPercent \/ 100\)\)/);
  assert.doesNotMatch(returnFlow, /getAttribute\('data-unit-price'\)/);
});

test('sales return summary shows gross value, effective deduction percent and final refund', () => {
  assert.match(markup, /id="return-gross-total-lbl"/);
  assert.match(markup, /Chiết khấu \(<span id="return-deduction-percent-lbl">0%<\/span>\)/);
  assert.match(markup, /id="return-deduction-amount-lbl"/);
  assert.match(markup, /Tổng tiền hoàn:/);
  assert.match(returnFlow, /grossReturnTotal \+= grossSubtotal/);
  assert.match(returnFlow, /totalDeduction \+= grossSubtotal - subtotal/);
  assert.match(returnFlow, /totalDeduction \* 100 \/ grossReturnTotal/);
});
