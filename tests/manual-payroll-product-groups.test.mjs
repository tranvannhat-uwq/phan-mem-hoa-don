import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('payroll product groups are a separate manually managed catalog', () => {
  const sql = read('migrations/0073_manual_payroll_product_groups.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.payroll_product_groups/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS payroll_product_group_id text/i);
  assert.match(sql, /FOREIGN KEY \(payroll_product_group_id\)[\s\S]*REFERENCES public\.payroll_product_groups\(id\)/i);
  assert.match(sql, /public\.is_admin_or_accounting\(\)/i);
  assert.doesNotMatch(sql, /GRANT\s+DELETE\s+ON TABLE public\.payroll_product_groups/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.payroll_product_groups[\s\S]*SELECT[\s\S]*FROM\s+public\.products/i);
});

test('product grouping UI only assigns existing accounting groups', () => {
  const html = read('index.html');
  const products = read('js/components/products.js');
  assert.match(html, /id="btn-manage-payroll-product-groups"/);
  assert.match(html, /<select class="form-control" id="prod-product-group">/);
  assert.doesNotMatch(html, /<input[^>]+id="prod-product-group"/);
  assert.match(products, /findPayrollProductGroup\(payrollGroupValue\)/);
  assert.match(products, /unknownPayrollGroups\.add\(payrollGroupValue\)/);
  assert.match(products, /Nhóm chưa được Kế toán tạo hoặc đã ngừng dùng/);
  assert.doesNotMatch(products, /dbSavePayrollProductGroup\([^)]*payrollGroupValue/);
});

test('Excel order exports include a filterable product group column', () => {
  const customers = read('js/components/customers.js');
  assert.match(customers, /'Mã hàng', 'Tên hàng', 'Nhóm sản phẩm', 'Thương hiệu'/);
  assert.match(customers, /'Nhóm sản phẩm': getItemPayrollProductGroupName\(item\)/);
  assert.match(customers, /worksheet\['!autofilter'\]/);
  assert.match(customers, /worksheet\['!freeze'\]/);
});

