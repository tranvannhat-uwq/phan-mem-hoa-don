import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const invoice = read('js/components/invoice.js');
const html = read('index.html');

test('retail invoice uses the shorter title and hides company and warehouse rows only in retail mode', () => {
  const printFlow = invoice.slice(
    invoice.indexOf('export async function renderAndPrintOrder'),
    invoice.indexOf('export function setupPrintTypeModal')
  );

  assert.match(printFlow, /type === 'retail'[\s\S]{0,100}titleEl\.innerText = 'HÓA ĐƠN'/);
  assert.doesNotMatch(printFlow, /titleEl\.innerText = 'HÓA ĐƠN BÁN LẺ'/);
  assert.match(printFlow, /companyLargeEl\.style\.display = type === 'retail' \? 'none' : ''/);
  assert.match(printFlow, /warehouseRowEl\.style\.display = type === 'retail' \? 'none' : ''/);
  assert.match(html, /id="print-warehouse-row"/);
});

test('sales invoice prints the managed business name instead of the paint brand label', () => {
  assert.match(html, /<strong>Kinh Doanh QL:<\/strong>\s*<span id="print-customer-manager"/);
  assert.doesNotMatch(html, /<strong>Hãng sơn:<\/strong>\s*<span id="print-order-brand"/);
  assert.match(invoice, /const managerName = getUserDisplayName\(managerId, managerId \|\| 'N\/A', state\.users\)/);
  assert.match(invoice, /if \(managerEl\) managerEl\.innerText = managerName/);
});
