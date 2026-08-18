import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseInvoicePercent,
  sanitizeInvoicePercentInput
} from '../js/domain/invoice-discount.js';

test('order discount accepts Vietnamese decimal percentages while typing', () => {
  assert.equal(sanitizeInvoicePercentInput('15,'), '15,');
  assert.equal(sanitizeInvoicePercentInput('15,2'), '15,2');
  assert.equal(parseInvoicePercent('15,2'), 15.2);
});

test('order discount also accepts decimal points and keeps the 0-100 limit', () => {
  assert.equal(sanitizeInvoicePercentInput('15.25'), '15,25');
  assert.equal(parseInvoicePercent('15.25'), 15.25);
  assert.equal(sanitizeInvoicePercentInput('100,5'), '100');
  assert.equal(parseInvoicePercent('100,5'), 100);
});

test('extra separators and percent symbols cannot corrupt the value', () => {
  assert.equal(sanitizeInvoicePercentInput('15,,2%'), '15,2');
  assert.equal(parseInvoicePercent('abc'), 0);
});
