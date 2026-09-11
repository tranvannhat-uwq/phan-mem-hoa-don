import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('agent invoice reads only the server-owned snapshot and fails closed when it is unavailable', () => {
  const invoice = read('js/components/invoice.js');
  const service = read('js/services/supabase.js');

  assert.match(invoice, /type === 'agent'[\s\S]{0,180}dbFetchOrderDebtSnapshot\(order\.id, order\.customerId\)/);
  assert.match(invoice, /!orderDebtSnapshot\)[\s\S]{0,220}dừng in[\s\S]{0,120}return false;/i);
  assert.match(invoice, /getOrderDebtSnapshot\(order, cust, orderDebtSnapshot\)/);
  assert.match(invoice, /Nợ sau hóa đơn/);
  assert.doesNotMatch(invoice, /oldDebt\s*=\s*newDebt\s*-\s*getOrderOutstandingAmount\(order\)/);
  assert.match(service, /export async function dbFetchOrderDebtSnapshot/);
  assert.match(service, /rpc\('rpc_get_order_debt_snapshot',[\s\S]{0,180}p_order_id: orderId,[\s\S]{0,100}p_customer_id: customerId/);
  assert.doesNotMatch(service, /export async function dbFetchOrderDebtSnapshot[\s\S]{0,1800}\.from\(tableCustomerDebtTransactionsName\)/);
  assert.doesNotMatch(service, /export async function dbFetchOrderDebtSnapshot[\s\S]{0,1800}rebuildOrderDebtSnapshot/);
});
