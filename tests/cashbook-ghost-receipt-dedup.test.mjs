import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domainCashbook = await import('../js/domain/cashbook.js');
const cashbookSrc = fs.readFileSync(path.join(root, 'js/components/so_quy.js'), 'utf8');
const supabaseSrc = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');
const migration0062 = fs.readFileSync(path.join(root, 'migrations/0062_purge_ghost_customer_receipts.sql'), 'utf8');

test('purgeGhostCustomerReceipts eliminates ghost TTM receipts that duplicate an authoritative PT receipt', () => {
  const transactions = [
    {
      id: 'PT-20260905-00000616',
      cloudId: 'PT-20260905-00000616',
      date: '2026-09-05T13:48:00.000Z',
      type: 'thu',
      category: 'Thu tiền khách hàng',
      partner: 'Chung Huyền - Lạng Sơn',
      value: 1385510,
      note: 'HD: Thu tiền thưởng tháng - TTM000001',
      status: 'Đã thanh toán',
      transactionType: 'customer_payment',
      debtImpact: true
    },
    {
      id: 'TTM000001',
      cloudId: 'PT-20260905-00000616',
      date: '2026-09-05T13:48:00.000Z',
      type: 'thu',
      category: 'Thu tiền thưởng tháng',
      partner: 'Chung Huyền - Lạng Sơn',
      value: 1385510,
      note: '',
      status: 'Đã thanh toán'
    },
    {
      id: 'TTM000099',
      date: '2026-09-05T10:00:00.000Z',
      type: 'thu',
      category: 'Thu khác',
      partner: 'Người nộp vãng lai',
      value: 500000,
      note: 'Thu hoàn ứng',
      status: 'Đã thanh toán'
    }
  ];

  const purged = domainCashbook.purgeGhostCustomerReceipts(transactions);
  assert.equal(purged.length, 2);
  assert.ok(purged.some(t => t.id === 'PT-20260905-00000616'), 'Authoritative PT receipt must be retained');
  assert.ok(purged.some(t => t.id === 'TTM000099'), 'Legitimate standalone receipt must be retained');
  assert.ok(!purged.some(t => t.id === 'TTM000001'), 'Ghost TTM000001 duplicate receipt must be purged');
});

test('purgeGhostCustomerReceipts handles time-window and partner match without cloudId link', () => {
  const transactions = [
    {
      id: 'PT-20260905-00000614',
      date: '2026-09-05T13:45:00.000Z',
      type: 'thu',
      category: 'Thu tiền khách hàng',
      partner: 'Chung Huyền - Lạng Sơn',
      value: 1853743,
      note: 'Thu Thư lương thị trường - TTM000003',
      status: 'Đã thanh toán'
    },
    {
      id: 'TTM000003',
      date: '2026-09-05T13:45:00.000Z',
      type: 'thu',
      category: 'Thu Thư lương thị trường',
      partner: 'Chung Huyền - Lạng Sơn',
      value: 1853743,
      note: '',
      status: 'Đã thanh toán'
    }
  ];

  const purged = domainCashbook.purgeGhostCustomerReceipts(transactions);
  assert.equal(purged.length, 1);
  assert.equal(purged[0].id, 'PT-20260905-00000614');
});

test('getCashbookTransactions in so_quy.js integrates purgeGhostCustomerReceipts', () => {
  assert.match(cashbookSrc, /import\s*\{[^}]*purgeGhostCustomerReceipts[^}]*\}\s*from\s*['"]\.\.\/domain\/cashbook\.js/);
  assert.match(cashbookSrc, /const deduped = purgeGhostCustomerReceipts\(repaired\);/);
  assert.match(cashbookSrc, /localStorage\.setItem\('billing_system_cashbook_transactions',\s*JSON\.stringify\(deduped\)\);/);
});

test('receiptForm submission in so_quy.js guards against double submit and stale finalCode', () => {
  assert.match(cashbookSrc, /let isSubmittingReceipt = false;/);
  assert.match(cashbookSrc, /if \(isSubmittingReceipt\) return;/);
  assert.match(cashbookSrc, /submitBtn\.disabled = true;/);
  assert.match(cashbookSrc, /t\.id !== finalCode/);
  assert.match(cashbookSrc, /purgeGhostCustomerReceipts\(cleanedTxs\)/);
  assert.match(cashbookSrc, /finally\s*\{[\s\S]*isSubmittingReceipt = false;[\s\S]*submitBtn\.disabled = false;/);
});

test('supabase.js integrates purgeGhostCustomerReceipts on loading transactions', () => {
  assert.match(supabaseSrc, /import\s*\{[^}]*purgeGhostCustomerReceipts[^}]*\}\s*from\s*['"]\.\.\/domain\/cashbook\.js/);
  assert.match(supabaseSrc, /purgeGhostCustomerReceipts\(merged\)/);
});

test('migration 0062 safely cancels ghost duplicate TTM receipts without data loss', () => {
  assert.match(migration0062, /UPDATE public\.cashbook_transactions/);
  assert.match(migration0062, /SET status = 'Đã hủy'/);
  assert.match(migration0062, /id ~\* '\^TTM\\d\+\$'/);
  assert.match(migration0062, /EXISTS\s*\(\s*SELECT 1 FROM public\.cashbook_transactions pt\s*WHERE pt\.id ~\* '\^PT-'\s*AND pt\.type = 'thu'/);
  assert.match(migration0062, /schema_migrations[\s\S]*0062/);
  assert.doesNotMatch(migration0062, /DELETE FROM/);
});
