import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const history = fs.readFileSync(path.join(root, 'js/components/history.js'), 'utf8');
const returnFlow = history.slice(
  history.indexOf('export function openSalesReturnModal'),
  history.indexOf('export async function processSalesReturnSubmit')
);

test('sales return shows the saved order unit price separately from the refundable unit price', () => {
  assert.match(
    returnFlow,
    /orderUnitPrice = Math\.round\(Math\.max\(0, Number\(item\.unitPrice \?\? item\.listPrice \?\? item\.price \?\? 0\)\)\)/
  );
  assert.match(
    returnFlow,
    /item\.finalUnitPrice \?\? item\.salePrice \?\? item\.finalPrice \?\? calculatedSaleUnitPrice/
  );
  assert.match(returnFlow, /data-order-unit-price="\$\{orderUnitPrice\}"/);
  assert.match(returnFlow, /data-refund-unit-price="\$\{refundableUnitPrice\}"/);
  assert.match(returnFlow, /formatCurrency\(orderUnitPrice\)\}<\/td>/);
  assert.match(returnFlow, /return-refund-price-lbl">\$\{formatCurrency\(refundableUnitPrice\)\}/);
});

test('sales return deductions are applied to the refundable price, not the displayed order price', () => {
  assert.match(returnFlow, /getAttribute\('data-refund-unit-price'\)/);
  assert.match(returnFlow, /refundPrice = Math\.round\(refundableUnitPrice \* \(1 - deductionPercent \/ 100\)\)/);
  assert.match(returnFlow, /subtotal = Math\.round\(refundableUnitPrice \* qty \* \(1 - deductionPercent \/ 100\)\)/);
  assert.doesNotMatch(returnFlow, /getAttribute\('data-unit-price'\)/);
});
