import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const css = read('style.css');
const cashbook = read('js/components/so_quy.js');

test('receipt and payment creation use the same wide grouped layout', () => {
  assert.match(html, /id="so-quy-receipt-modal"[\s\S]*cashbook-create-modal-content cashbook-create-receipt/);
  assert.match(html, /id="so-quy-payment-modal"[\s\S]*cashbook-create-modal-content cashbook-create-payment/);
  assert.match(html, /Thông tin phiếu/);
  assert.match(html, /Thông tin khoản thu/);
  assert.match(html, /Thông tin khoản chi/);
  assert.match(css, /\.cashbook-create-modal-content[\s\S]*max-width: 840px/);
  assert.match(css, /\.cashbook-create-grid[\s\S]*grid-template-columns: repeat\(2/);
});

test('receipt categories include variance collection', () => {
  assert.match(html, /<option value="Thu chênh lệch">Thu chênh lệch<\/option>/);
});

test('creation layout stays responsive and preserves every form binding', () => {
  for (const id of [
    'receipt-code', 'receipt-time', 'receipt-category', 'receipt-payer',
    'receipt-value', 'receipt-method', 'receipt-accounting', 'receipt-note',
    'payment-code', 'payment-time', 'payment-category', 'payment-recipient',
    'payment-value', 'payment-method', 'payment-accounting', 'payment-note'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(cashbook, new RegExp(`'${id}'`));
  }
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.cashbook-create-grid \{ grid-template-columns: 1fr/);
});
