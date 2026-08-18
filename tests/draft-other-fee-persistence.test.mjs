import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

test('draft updates persist the Thu khac fields used by the displayed total', () => {
  const commonRow = service.slice(
    service.indexOf('const commonRow = {'),
    service.indexOf("const dbRow = order.status === 'draft'", service.indexOf('const commonRow = {'))
  );

  assert.match(commonRow, /shipping_fee_value:\s*order\.shippingFeeValue \|\| 0/);
  assert.match(commonRow, /shipping_fee_amount:\s*order\.shippingFeeAmount \|\| 0/);
});

test('legacy draft schemas retain a narrow compatibility retry', () => {
  assert.match(service, /shipping_fee_\(\?:value\|amount\)[\s\S]*delete dbRow\.shipping_fee_value;[\s\S]*delete dbRow\.shipping_fee_amount;/);
});
