import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domain = await import(pathToFileURL(path.join(root, 'js/domain/cashbook.js')));
const cashbookUi = fs.readFileSync(path.join(root, 'js/components/so_quy.js'), 'utf8');
const supabase = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

test('canonical customer payment always uses the debt reversal route', () => {
  assert.equal(domain.isCustomerDebtReceipt({
    type: 'thu', transactionType: 'customer_payment', debtImpact: false
  }), true);
  assert.equal(domain.isCustomerDebtReceipt({
    type: 'thu', transaction_type: 'customer_payment'
  }), true);
});

test('legacy customer receipts remain cancellable after a page reload', () => {
  assert.equal(domain.isCustomerDebtReceipt({
    type: 'thu', category: 'Thu nợ khách hàng'
  }), true);
  assert.equal(domain.isCustomerDebtReceipt({
    type: 'thu', category: 'Thu tiền hàng', debtImpact: false
  }), false);
  assert.equal(domain.isCustomerDebtReceipt({
    type: 'chi', category: 'Thu nợ khách hàng'
  }), false);
});

test('Cloud mapper retains cancellation routing fields', () => {
  assert.match(supabase, /transactionType:\s*t\.transaction_type \|\| null/);
  assert.match(supabase, /debtImpact:\s*t\.transaction_type === 'customer_payment'/);
});

test('UI sends the canonical Cloud id to the database classifier', () => {
  assert.match(cashbookUi, /const cashbookId = getCanonicalCashbookId\(t\)/);
  assert.match(cashbookUi, /dbCancelCashbookEntry\(cashbookId/);
  assert.doesNotMatch(cashbookUi, /isCustomerDebtReceipt\(t\)/);
});

test('database classification is the primary atomic RPC for legacy receipts', () => {
  assert.match(supabase, /supabaseClient\.rpc\('rpc_cancel_cashbook_entry',[\s\S]*p_cashbook_id: cashbookId/);
  assert.doesNotMatch(supabase, /Customer receipt must be cancelled by rpc_cancel_customer_payment/);
  assert.match(supabase, /missingCompatibilityRpc[\s\S]*rpc_cancel_cashbook_transaction/);
  assert.match(cashbookUi, /await dbRefreshCustomerFinancialState\(savedToCloud\.customer_id\)/);
  assert.match(cashbookUi, /await dbFetchCashbookTransactions\(\)/);
  assert.doesNotMatch(cashbookUi, /Number\(savedToCloud\.new_debt\)/);
});

test('cancelled receipts reload the authoritative ledger and expose the audit rows', () => {
  assert.match(supabase, /fetchFullTableData\(tableCustomerDebtTransactionsName\)/);
  assert.match(supabase, /payment_cancel:\s*'payment_cancel'/);
  assert.match(supabase, /customer\.debtHistory = mergeCustomerDebtHistory\(/);
  assert.match(cashbookUi, /activeFilters\.statusCancelled = true/);
});
