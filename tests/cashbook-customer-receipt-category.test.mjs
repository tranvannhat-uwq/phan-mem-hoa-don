import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cashbook = fs.readFileSync(path.join(root, 'js/components/so_quy.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const receiptSubmit = cashbook.slice(
  cashbook.indexOf("receiptForm.addEventListener('submit'"),
  cashbook.indexOf('// 17. Modal actions')
);
const migration = fs.readFileSync(
  path.join(root, 'migrations/0046_non_sales_customer_receipt_history.sql'),
  'utf8'
);

test('every receipt linked to a selected customer updates customer debt', () => {
  assert.match(receiptSubmit, /const selectedCustomerId = selectedOption\?\.dataset\.customerId/);
  assert.match(receiptSubmit, /let matchedCustomer = selectedCustomerId[\s\S]*customerMatches\.length === 1/);
  assert.match(receiptSubmit, /const affectsCustomerDebt = Boolean\(matchedCustomer\)/);
  assert.match(receiptSubmit, /if \(affectsCustomerDebt\) \{[\s\S]*dbRecordCustomerPayment\(/);
});

test('non-sales receipt categories still reduce debt for the selected customer', () => {
  for (const category of [
    'Thu Hộ trợ vận chuyển cho khách',
    'Thu Thư lương thị trường',
    'Thu tiền thưởng tháng',
    'Thu tiền thưởng Quý',
    'Thu tiền phạt',
    'Thu chênh lệch',
    'Khác'
  ]) {
    assert.match(html, new RegExp(`<option value="${category}">${category}<\\/option>`));
  }
  assert.match(receiptSubmit, /const affectsCustomerDebt = Boolean\(matchedCustomer\)/);
  assert.match(receiptSubmit, /Boolean\(matchedCustomer\)[\s\S]*dbRecordCustomerPayment\([\s\S]*matchedCustomer\.id/);
});

test('an unmatched free-text payer can still create a standalone receipt', () => {
  assert.match(receiptSubmit, /if \(affectsCustomerDebt\) \{[\s\S]*\} else \{[\s\S]*dbSaveCashbookTransaction\(newTx\)/);
});

test('salary-deduction sales receipt is available without changing legacy sales receipt routing', () => {
  const category = 'Thu tiền hàng trừ vào lương';
  assert.match(html, new RegExp(`<option value="${category}">${category}<\\/option>`));
  assert.match(receiptSubmit, /const isSalaryDeductionReceipt = normalizedCategory === 'thu tiền hàng trừ vào lương'/);
  assert.match(receiptSubmit, /\(!isSalaryDeductionReceipt && normalizedCategory\.includes\('tiền hàng'\)\)/);
});

test('existing unlinked customer receipts are reconciled safely and once', () => {
  assert.match(migration, /match\.match_count = 1/);
  assert.match(migration, /cashbook\.customer_id IS NULL/);
  assert.match(migration, /NOT EXISTS \([\s\S]*debt\.cashbook_transaction_id = cashbook\.id/);
  assert.match(migration, /SET transaction_type = 'customer_payment'/);
  assert.match(migration, /SET debt = round\(COALESCE\(customer\.debt, 0\) - totals\.receipt_total\)/);
  assert.doesNotMatch(migration, /DELETE FROM/);
});

test('receipt creation forwards selected category and preserves clean notes without forced codes', () => {
  const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');
  const migration0060 = fs.readFileSync(
    path.join(root, 'migrations/0060_customer_receipt_category.sql'),
    'utf8'
  );

  assert.match(receiptSubmit, /dbRecordCustomerPayment\([\s\S]*category\s*\)/);
  assert.doesNotMatch(receiptSubmit, /\$\{category\}\s*-\s*\$\{finalCode\}/);
  assert.match(service, /p_category:\s*category/);
  assert.match(migration0060, /p_category\s+text\s+DEFAULT\s+'Thu tiền khách hàng'/);
  assert.match(migration0060, /clean_notes.*NULLIF\(btrim\(p_notes\)/);
});

