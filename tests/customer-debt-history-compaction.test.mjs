import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer history hides only exact order reversal pairs and keeps an audit toggle', () => {
  const html = read('index.html');
  const customers = read('js/components/customers.js');
  const debt = read('js/domain/customer-debt.js');

  assert.match(html, /id="customer-debt-show-technical"/);
  assert.match(customers, /getNeutralizedOrderDebtEntryIds\(history\)/);
  assert.match(customers, /class="customer-debt-neutralized-row" style="display:none;"/);
  assert.match(customers, /technicalHistoryToggle\.onchange/);
  assert.match(debt, /reversalOfId \?\? reversal\?\.reversal_of_id/);
  assert.match(debt, /toDebtAmount\(originalChange \+ reversalChange\) !== 0/);
  assert.doesNotMatch(customers, /\.filter\([^\n]*transactionType[^\n]*order_cancel/);
});
