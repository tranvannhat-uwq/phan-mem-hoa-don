import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildRetentionDatabase, asActor, scalar, accountingId, adminId } from './helpers/retention-db.mjs';
import { getCashbookDisplayCode } from '../js/domain/cashbook.js';

let db, beforeRows, auditCount, triggerHash, legacySupplierId;
const rpc = (name, input) => scalar(db, `SELECT public.${name}($1::jsonb) AS value`, [JSON.stringify(input)]);
const call = (name, args) => scalar(db, `SELECT public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS value`, args);
const create = extra => rpc('rpc_create_cashbook_transaction', { type: 'chi', partner: 'Synthetic recipient', value: 100, idempotencyKey: randomUUID(), ...extra });
const migrate = async file => db.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));

before(async () => {
  db = await buildRetentionDatabase({ maxVersion: 116 });
  await migrate('0133_purchase_discount.sql'); await migrate('0134_purchase_payment_advances.sql');
  await asActor(db, accountingId);
  const supplier = await rpc('rpc_save_supplier', { code: 'SHORT-CODE', name: 'Display code test', openingDebt: 0 });
  const p = await rpc('rpc_create_purchase_discount', { supplierId: supplier.supplier.id, idempotencyKey: randomUUID(), items: [{ code: 'TEST', name: 'Synthetic purchase', quantity: 1, unitPrice: 98788190 }] });
  const payment = await rpc('rpc_record_purchase_payment_advance', { supplierId: supplier.supplier.id, purchaseId: p.purchase.id, amount: 100000000, idempotencyKey: randomUUID() });
  legacySupplierId = payment.cashbook_transaction_id;
  await create({ type: 'thu' });
  await db.exec('RESET ROLE');
  beforeRows = (await db.query('SELECT * FROM public.cashbook_transactions ORDER BY id')).rows;
  auditCount = await scalar(db, 'SELECT count(*) AS value FROM public.audit_logs');
  triggerHash = await scalar(db, 'SELECT public.p107_trigger_fingerprint() AS value');
  await migrate('0135_cashbook_display_numbers.sql');
  await asActor(db, accountingId);
});
after(async () => { await db?.close(); });

test('migration gives existing vouchers unique numbers while preserving every financial field and audit row', async () => {
  const rows = (await db.query('SELECT * FROM public.cashbook_transactions ORDER BY id')).rows;
  assert.deepEqual(rows.map(({ display_number, ...row }) => row), beforeRows);
  assert.equal(new Set(rows.map(row => row.display_number)).size, rows.length);
  assert.ok(rows.every(row => Number(row.display_number) > 0));
  await db.exec('RESET ROLE');
  assert.equal(await scalar(db, 'SELECT count(*) AS value FROM public.audit_logs'), auditCount);
  assert.equal(await scalar(db, 'SELECT public.p107_trigger_fingerprint() AS value'), triggerHash);
  await asActor(db, accountingId);
  const supplierRow = rows.find(row => row.id === legacySupplierId);
  assert.match(getCashbookDisplayCode(supplierRow), /^PC-\d{6}$/);
  assert.equal(Number(supplierRow.value), 100000000);
});

test('new command responses return a short code immediately and retries keep the same number', async () => {
  const input = { idempotencyKey: randomUUID(), externalReference: 'MY-REFERENCE', type: 'chi', partner: 'Test', value: 100, transactionDate: '2026-10-29T08:00:00Z' };
  const first = await rpc('rpc_create_cashbook_transaction', input);
  const replay = await rpc('rpc_create_cashbook_transaction', input);
  assert.match(getCashbookDisplayCode(first.transaction), /^PC-\d{6}$/);
  assert.equal(first.transaction.externalReference, 'MY-REFERENCE');
  assert.equal(replay.transaction.displayNumber, first.transaction.displayNumber);
  assert.equal(replay.transaction.id, first.transaction.id);
  assert.equal(replay.already_recorded, true);
  const amended = await call('rpc_amend_cashbook_transaction', [first.transaction.id, JSON.stringify({ value: 125 })]);
  assert.equal(amended.transaction.displayNumber, first.transaction.displayNumber);
  const cancelled = await call('rpc_cancel_cashbook_entry', [first.transaction.id, 'Cancel synthetic voucher']);
  assert.equal(cancelled.transaction.displayNumber, first.transaction.displayNumber);
  const reversalNumber = await scalar(db, 'SELECT display_number AS value FROM public.cashbook_transactions WHERE id=$1', [cancelled.reversal_id]);
  assert.notEqual(String(reversalNumber), first.transaction.displayNumber);
});

test('date-window reads and independent finance accounts receive unique numbers', async () => {
  const accounting = await create();
  await asActor(db, adminId); const admin = await create({ type: 'thu' });
  assert.notEqual(admin.transaction.displayNumber, accounting.transaction.displayNumber);
  assert.match(getCashbookDisplayCode(admin.transaction), /^PT-\d{6}$/);
  const result = await call('rpc_get_cashbook_window', ['2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z']);
  assert.ok(result.data.find(row => row.id === legacySupplierId).display_number);
  await asActor(db, accountingId);
});

test('backup captures display numbers and their sequence so restored vouchers keep their codes', async () => {
  await asActor(db, adminId);
  await call('rpc_set_maintenance_mode', [true, 'Synthetic display-code backup test']);
  const result = await call('rpc_prepare_monthly_retention', [randomUUID(), true]);
  const payload = JSON.parse(result.backup_text);
  assert.ok(payload.columns.cashbook_transactions.includes('display_number'));
  assert.ok(payload.tables.cashbook_transactions.every(row => Number(row.display_number) > 0));
  assert.ok(payload.sequences.cashbook_voucher_display_seq);
  const max = Math.max(...payload.tables.cashbook_transactions.map(row => Number(row.display_number)));
  assert.ok(Number(payload.sequences.cashbook_voucher_display_seq.last_value) >= max);
  await call('rpc_set_maintenance_mode', [false, 'Synthetic backup complete']);
  await asActor(db, accountingId);
});

test('API accounts cannot allocate their own display numbers or mutate cashbook rows directly', async () => {
  await assert.rejects(db.query("SELECT nextval('public.cashbook_voucher_display_seq')"), /permission denied/);
  await assert.rejects(db.query('UPDATE public.cashbook_transactions SET display_number=999 WHERE id=$1', [legacySupplierId]), /permission denied|append-only|reviewed/);
  await db.exec('RESET ROLE; SET ROLE anon;');
  await assert.rejects(create(), /permission denied/);
  await asActor(db, accountingId);
});
