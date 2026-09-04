import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canAdjustOrderBusinessDate,
  currentBusinessDateTimeInputValue,
  orderDateToDateTimeInputValue,
  parseOrderBusinessDateTimeInput
} from '../js/domain/order-business-date.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration0059 = fs.readFileSync(path.join(root, 'migrations/0059_allow_order_date_amendment.sql'), 'utf8');
const invoiceSource = fs.readFileSync(path.join(root, 'js/components/invoice.js'), 'utf8');
const historySource = fs.readFileSync(path.join(root, 'js/components/history.js'), 'utf8');
const supabaseSource = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

test('permission helper allows only admin and accounting to adjust order business date', () => {
  assert.equal(canAdjustOrderBusinessDate({ role: 'admin' }), true);
  assert.equal(canAdjustOrderBusinessDate({ role: 'accounting' }), true);
  assert.equal(canAdjustOrderBusinessDate({ role: 'sale' }), false);
  assert.equal(canAdjustOrderBusinessDate({ role: 'warehouse' }), false);
  assert.equal(canAdjustOrderBusinessDate(null), false);
  assert.equal(canAdjustOrderBusinessDate(undefined), false);
});

test('orderDateToDateTimeInputValue formats ISO date strings to local HTML5 datetime-local format', () => {
  const iso = '2026-08-15T14:30:00+07:00';
  const val = orderDateToDateTimeInputValue(iso);
  assert.equal(val, '2026-08-15T14:30');

  assert.equal(orderDateToDateTimeInputValue(''), '');
  assert.equal(orderDateToDateTimeInputValue(null, 'fallback'), 'fallback');
});

test('parseOrderBusinessDateTimeInput parses and validates order datetime inputs', () => {
  const now = new Date('2026-08-15T15:00:00+07:00');

  // Valid past datetime
  const validPast = parseOrderBusinessDateTimeInput('2026-08-15T10:30', now);
  assert.equal(validPast.ok, true);
  assert.equal(validPast.value, '2026-08-15T10:30:00+07:00');
  assert.equal(validPast.dateKey, '2026-08-15');

  // Nonexistent dates
  assert.equal(parseOrderBusinessDateTimeInput('2026-02-30T10:00', now).ok, false);
  assert.equal(parseOrderBusinessDateTimeInput('invalid', now).ok, false);

  // Future datetime beyond grace tolerance is rejected
  assert.equal(parseOrderBusinessDateTimeInput('2026-08-16T10:00', now).ok, false);
  assert.equal(parseOrderBusinessDateTimeInput('2026-08-15T16:00', now).ok, false);
});

test('invoice UI syncs datetime-local input correctly without invalid date values', () => {
  // Must use datetime-local formatted value in reset and setup
  assert.doesNotMatch(invoiceSource, /syncInvoiceBusinessDateControl\(currentBusinessDateInputValue\(\)/);
  assert.match(invoiceSource, /syncInvoiceBusinessDateControl\(currentBusinessDateTimeInputValue\(\),\s*false\)/);

  // syncInvoiceBusinessDateControl must handle value > currentMax
  assert.match(invoiceSource, /input\.max\s*=\s*value\s*&&\s*value\s*>\s*currentMax\s*\?\s*value\s*:\s*currentMax/);
});

test('history loads order date into datetime-local control on edit', () => {
  assert.match(
    historySource,
    /syncInvoiceBusinessDateControl\(\s*isCopy\s*\?\s*currentBusinessDateTimeInputValue\(\)\s*:\s*orderDateToDateTimeInputValue\(order\.date\),\s*isReadOnly\s*\)/
  );
});

test('migration 0059 allows order_date amendment in rpc_amend_order', () => {
  // Reads target_order_date from p_order->>'date' or preserves original
  assert.match(migration0059, /target_order_date\s*:=\s*original_order\.order_date;/);
  assert.match(migration0059, /target_order_date\s*:=\s*\(p_order->>'date'\)::timestamptz;/);

  // Guards against future dates
  assert.match(migration0059, /Order date cannot be in the future/);
  assert.match(migration0059, /IF target_order_date > now\(\) THEN\s*target_order_date := now\(\);/);

  // Updates orders.order_date to target_order_date
  assert.match(migration0059, /order_date = target_order_date/);

  // Updates order_items.created_at to target_order_date
  assert.match(migration0059, /target_order_date\s*\);[\s\S]*END LOOP;[\s\S]*-- Update customer debt/);

  // Aligns customer debt transactions
  assert.match(migration0059, /UPDATE public\.customer_debt_transactions ledger[\s\S]*SET transaction_date = target_order_date/);

  // Asserts amended_order.order_date matches target_order_date
  assert.match(migration0059, /IF amended_order\.order_date IS DISTINCT FROM target_order_date/);

  // Updates draft trigger to allow admin and accounting to update draft created_at
  assert.match(migration0059, /IF actor\.role IN \('admin', 'accounting'\) THEN\s*RETURN NEW;/);
  assert.match(migration0059, /NEW\.created_at := OLD\.created_at;/);

  // Records migration
  assert.match(migration0059, /VALUES \('0059',/);
});

test('supabase dbSaveOrder sends date for draft and settled orders', () => {
  assert.match(supabaseSource, /created_at:\s*order\.date\s*\|\|\s*order\.createdAt\s*\|\|\s*new Date\(\)\.toISOString\(\)/);
  assert.match(supabaseSource, /order_date:\s*order\.date\s*\|\|\s*order\.orderDate\s*\|\|\s*new Date\(\)\.toISOString\(\)/);
  assert.match(supabaseSource, /date:\s*order\.date\s*\|\|\s*new Date\(\)\.toISOString\(\)/);
});
