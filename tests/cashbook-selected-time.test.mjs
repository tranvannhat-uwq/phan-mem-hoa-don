import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const cashbook = read('js/components/so_quy.js');
const service = read('js/services/supabase.js');
const migration = read('migrations/0068_preserve_customer_receipt_transaction_time.sql');

test('selected receipt time is sent through the customer-receipt command', () => {
  assert.match(cashbook, /category,\s*newTx\.date/);
  assert.match(service, /p_transaction_date:\s*transactionDate \|\| new Date\(\)\.toISOString\(\)/);
  assert.match(service, /Cloud chưa hỗ trợ ngày giờ phiếu thu đã chọn[\s\S]*phiếu chưa được tạo/);
});

test('migration 0068 preserves one business timestamp across customer receipt records', () => {
  assert.match(migration, /p_transaction_date timestamptz DEFAULT NULL/);
  assert.match(migration, /receipt_date timestamptz := COALESCE\(p_transaction_date, now\(\)\)/);
  assert.match(migration, /cashbook_id, receipt_date, receipt_date, 'thu', 'customer_payment'/);
  assert.match(migration, /actor\.auth_user_id::text, receipt_date/);
  assert.match(migration, /last_payment_at = GREATEST/);
  assert.match(migration, /6-parameter compatibility wrapper/);
  assert.match(migration, /VALUES \('0068', 'Preserve selected transaction time for customer receipts'\)/);
});

test('manual receipt and payment reject an invalid selected time before saving', () => {
  assert.match(cashbook, /Vui lòng chọn ngày giờ lập phiếu thu hợp lệ/);
  assert.match(cashbook, /Vui lòng chọn ngày giờ lập phiếu chi hợp lệ/);
  assert.match(cashbook, /date: selectedTime\.toISOString\(\)/);
});
