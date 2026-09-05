import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('agent invoice preserves original old debt and latest amended debt without changing shared customer state', () => {
  const invoice = read('js/components/invoice.js');
  const service = read('js/services/supabase.js');

  assert.match(invoice, /type === 'agent'[\s\S]{0,180}dbFetchOrderDebtSnapshot\(order\.id, order\.customerId\)/);
  assert.match(invoice, /getOrderDebtSnapshot\(order, cust, orderDebtSnapshot\)/);
  assert.doesNotMatch(invoice, /debtHistory\.find\(h => h\.id === order\.id\)/);
  assert.match(service, /export async function dbFetchOrderDebtSnapshot/);
  assert.match(service, /rebuildOrderDebtSnapshot\(orderId, customerId, ledgerRows, orderRows\)/);
  assert.match(service, /\.select\('id,customer_id,status,total_payable,total_amount,shipping_fee_value,shipping_fee_amount'\)/);
  assert.match(service, /\.eq\('order_id', orderId\)[\s\S]*\.eq\('customer_id', customerId\)[\s\S]*\.in\('transaction_type', \['order', 'order_amend'\]\)/);
  assert.match(service, /\.order\('created_at', \{ ascending: true \}\)[\s\S]*\.order\('id', \{ ascending: true \}\)/);
  assert.match(service, /const originalCharge = rows\.find\(row => row\.transaction_type === 'order'\) \|\| rows\[0\]/);
  assert.match(service, /debtBefore: Number\(originalCharge\.balance_before\)[\s\S]*debtAfter: Number\(latestChange\.balance_after\)/);
});
