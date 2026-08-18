import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('retail and sales invoice prints use one sales-discount row', () => {
  const invoice = read('js/components/invoice.js');
  const html = read('index.html');
  const printStart = invoice.indexOf("export async function renderAndPrintOrder");
  const printEnd = invoice.indexOf('export function openPrintTypeModal', printStart);
  const printFlow = invoice.slice(printStart, printEnd);

  assert.doesNotMatch(printFlow, /Chiết khấu bán lẻ/);
  assert.doesNotMatch(printFlow, />Giảm giá\$\{/);
  assert.doesNotMatch(printFlow, /Cộng tiền hàng/);
  assert.match(printFlow, /Chiết khấu bán hàng\$\{order\.discountType/);
  assert.match(printFlow, /formatNumber\(printDiscount\)/);
  assert.match(html, /<span>Chiết khấu bán hàng:<\/span>\s*<span id="print-discount-amount">/);
});

test('sales invoice prints the KiotViet-style money rows in accounting order', () => {
  const invoice = read('js/components/invoice.js');
  const printStart = invoice.indexOf("export async function renderAndPrintOrder");
  const printEnd = invoice.indexOf('export function openPrintTypeModal', printStart);
  const printFlow = invoice.slice(printStart, printEnd);
  const labels = [
    '>Cộng:<',
    '>Chiết khấu bán hàng',
    '>Cước Vận Chuyển<',
    '>Tổng tiền sau chiết khấu<',
    '>Thanh toán<'
  ];
  const positions = labels.map(label => printFlow.indexOf(label));

  positions.forEach((position, index) => {
    assert.ok(position >= 0, `missing print row: ${labels[index]}`);
    if (index > 0) assert.ok(position > positions[index - 1], `${labels[index]} is out of order`);
  });
  assert.match(printFlow, /formatNumber\(printShippingFee\)/);
  assert.match(printFlow, /formatNumber\(printTotalAfterDiscount\)/);
  assert.match(printFlow, /formatNumber\(printPaidAmount\)/);
  assert.doesNotMatch(printFlow, />Tạm tính</);
  assert.doesNotMatch(printFlow, />TỔNG THANH TOÁN</);
});
