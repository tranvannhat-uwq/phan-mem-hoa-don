import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('customer form reports hidden searchable-select validation instead of silently blocking submit', () => {
  const html = read('index.html');
  const customers = read('js/components/customers.js');
  const css = read('style.css');
  assert.match(html, /<form id="customer-form" novalidate>/);
  assert.match(customers, /function validateCustomerForm\(\)/);
  assert.match(customers, /\['cust-province', 'Vui lòng chọn Tỉnh\/Thành phố\.'\]/);
  assert.match(customers, /querySelector\('\.searchable-select-trigger'\)/);
  assert.match(customers, /showToast\(message, 'warning'\)/);
  assert.match(css, /\.searchable-select-trigger\.customer-field-invalid/);
});

test('customer form no longer exposes per-brand discount inputs', () => {
  const html = read('index.html');
  const customers = read('js/components/customers.js');
  assert.doesNotMatch(html, /cust-brand-discounts-section|customer-brand-discounts-container|cust-brand-disc/);
  assert.doesNotMatch(customers, /cust-brand-discounts-section|customer-brand-discounts-container|cust-brand-disc/);
  assert.doesNotMatch(html, /Tự thiết lập bên dưới/);
  assert.match(customers, /const brandDiscounts = isEditing \? \{ \.\.\.\(editedCustomer\?\.brandDiscounts \|\| \{\}\) \} : \{\}/);
});

test('light success buttons keep readable green text', () => {
  const css = read('style.css');
  assert.doesNotMatch(css, /\.btn-primary, \.btn-indigo, \.btn-danger, \.btn-success/);
  assert.match(css, /\.btn-success\s*\{[\s\S]*?background-color:\s*#e9f9f0;[\s\S]*?color:\s*#15803d !important;/);
});
