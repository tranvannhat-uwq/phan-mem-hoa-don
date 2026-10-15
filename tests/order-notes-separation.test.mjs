import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const invoiceSource = await readFile(new URL('../js/components/invoice.js', import.meta.url), 'utf8');
const historySource = await readFile(new URL('../js/components/history.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
test('customer selection does not overwrite the current order note', () => {
  const functionStart = invoiceSource.indexOf('async function selectInvoiceCustomer(customer) {');
  const functionEnd = invoiceSource.indexOf('\nfunction ', functionStart + 1);
  const selectCustomerBody = invoiceSource.slice(functionStart, functionEnd);

  assert.ok(selectCustomerBody, 'selectInvoiceCustomer function should be present');
  assert.doesNotMatch(selectCustomerBody, /invoice-notes[\s\S]{0,120}customer\.notes/);
});

test('order notes are persisted and restored independently', () => {
  assert.match(invoiceSource, /notes:\s*document\.getElementById\('invoice-notes'\)\.value\.trim\(\)/);
  assert.match(historySource, /getElementById\('invoice-notes'\)\.value\s*=\s*order\.notes\s*\|\|\s*''/);
});

test('customer notes have a separate display from order notes', () => {
  assert.match(htmlSource, /id="selected-customer-notes-lbl"/);
  assert.match(htmlSource, /id="invoice-notes"/);
  assert.match(invoiceSource, /customerNotesLbl\.innerText\s*=\s*customer\.notes\s*\|\|\s*'Không có'/);
});
