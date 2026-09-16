import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

test('products and payroll groups are loaded through all Cloud pages', () => {
  assert.match(source, /const prodData = await collectAllPages\(/);
  assert.match(source, /from\(tableProductsName\)[\s\S]{0,160}select\('\*', \{ count: 'exact' \}\)[\s\S]{0,160}range\(offset, end\)/);
  assert.match(source, /const data = await collectAllPages\([\s\S]{0,160}from\(tablePayrollProductGroupsName\)[\s\S]{0,160}range\(offset, end\)/);
});

test('bulk product import checks every existing product page before upserting', () => {
  assert.match(source, /const existingProducts = await collectAllPages\([\s\S]{0,220}select\('id,code,brand', \{ count: 'exact' \}\)[\s\S]{0,160}range\(offset, end\)/);
});
