import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildRetentionDatabase, asActor, scalar, accountingId, saleId } from './helpers/retention-db.mjs';

let db;
const rpc = async (name, input) => scalar(db, `SELECT public.${name}($1::jsonb) AS value`, [JSON.stringify(input)]);
const call = (name, args) => scalar(db, `SELECT public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS value`, args);
const supplier = async () => (await rpc('rpc_save_supplier', { code: randomUUID(), name: 'Supplier advance test', openingDebt: 0 })).supplier.id;
const purchase = async (supplierId, total = 98788190, paidAmount = 0) => (await rpc('rpc_create_purchase_discount', {
  supplierId, idempotencyKey: randomUUID(), paidAmount, items: [{ code: 'TEST', name: 'Synthetic purchase', quantity: 1, unitPrice: total }]
})).purchase;
const pay = (supplierId, purchaseId, amount, extra = {}) => rpc('rpc_record_purchase_payment_advance', {
  supplierId, purchaseId, amount, paymentMethod: 'cash', idempotencyKey: randomUUID(), ...extra
});

before(async () => {
  db = await buildRetentionDatabase({ maxVersion: 116 });
  for (const name of ['0133_purchase_discount.sql', '0134_purchase_payment_advances.sql']) {
    await db.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  await asActor(db, accountingId);
});
after(async () => { await db?.close(); });

test('full overpayment reaches cashbook, paid amount and supplier credit exactly once', async () => {
  const sid = await supplier(), p = await purchase(sid), key = randomUUID();
  const result = await pay(sid, p.id, 100000000, { idempotencyKey: key });
  assert.equal(result.purchase.paidAmount, 100000000);
  assert.equal(result.purchase.balanceDue, 0);
  assert.equal(result.supplier.debt, -1211810);
  assert.equal(result.supplier.totalPaid, 100000000);
  assert.equal(Number(await scalar(db, 'SELECT value FROM public.cashbook_transactions WHERE id=$1', [result.cashbook_transaction_id])), 100000000);
  const replay = await pay(sid, p.id, 100000000, { idempotencyKey: key });
  assert.equal(replay.already_recorded, true);
  assert.equal(replay.payment_id, result.payment_id);
  assert.equal(Number(await scalar(db, 'SELECT count(*) AS value FROM public.purchase_payments WHERE purchase_id=$1', [p.id])), 1);
  await assert.rejects(pay(sid, p.id, 100000001, { idempotencyKey: key }), /different supplier payment/);
});

test('overpaid vouchers can be amended and cancelled without losing or duplicating credit', async () => {
  const sid = await supplier(), p = await purchase(sid, 100);
  const result = await pay(sid, p.id, 150);
  await call('rpc_amend_cashbook_transaction', [result.cashbook_transaction_id, JSON.stringify({ method: 'bank', note: 'Same amount, changed note' })]);
  await call('rpc_amend_cashbook_transaction', [result.cashbook_transaction_id, JSON.stringify({ value: 170 })]);
  assert.equal(Number(await scalar(db, 'SELECT debt AS value FROM public.suppliers WHERE id=$1', [sid])), -70);
  assert.equal(Number(await scalar(db, 'SELECT paid_amount AS value FROM public.purchases WHERE id=$1', [p.id])), 170);
  const cancelled = await call('rpc_cancel_supplier_payment', [result.payment_id, 'Cancel synthetic advance']);
  assert.equal(cancelled.supplier.debt, 100);
  assert.equal(cancelled.purchase.paidAmount, 0);
  assert.equal(cancelled.purchase.balanceDue, 100);
  assert.equal(Number(await scalar(db, 'SELECT sum(amount_change) AS value FROM public.supplier_debt_transactions WHERE payment_id=$1', [result.payment_id])), 0);
  assert.equal(Number(await scalar(db, 'SELECT sum(CASE WHEN direction=\'out\' THEN -value ELSE value END) AS value FROM public.cashbook_transactions WHERE purchase_payment_id=$1', [result.payment_id])), 0);
  assert.equal((await call('rpc_cancel_supplier_payment', [result.payment_id, 'Retry cancel'])).already_cancelled, true);
});

test('excess on an invoice offsets other supplier debt before creating a credit balance', async () => {
  const sid = await supplier(), first = await purchase(sid, 100, 10);
  const second = await purchase(sid, 50);
  const result = await pay(sid, first.id, 120);
  assert.equal(result.purchase.paidAmount, 130);
  assert.equal(result.purchase.balanceDue, 0);
  assert.equal(result.supplier.debt, 20);
  const next = await pay(sid, second.id, 30);
  assert.equal(next.supplier.debt, -10);
});

test('a fully paid purchase accepts a top-up and cancelling the purchase reverses the full payment', async () => {
  const sid = await supplier(), p = await purchase(sid, 100, 100);
  assert.equal((await pay(sid, p.id, 50)).supplier.debt, -50);
  const result = await call('rpc_cancel_purchase', [p.id, 'Cancel purchase including advance']);
  assert.equal(result.purchase.status, 'cancelled');
  assert.equal(result.purchase.paidAmount, 0);
  assert.equal(result.supplier.debt, 0);
  assert.equal(result.supplier.totalPaid, 0);
  assert.equal(Number(await scalar(db, 'SELECT sum(amount_change) AS value FROM public.supplier_debt_transactions WHERE purchase_id=$1', [p.id])), 0);
});

test('invalid amounts, unrelated purchases and cancelled documents cannot write payments', async () => {
  const sid = await supplier(), other = await supplier(), p = await purchase(sid, 100);
  const count = Number(await scalar(db, 'SELECT count(*) AS value FROM public.purchase_payments'));
  for (const amount of [0, -1, 1.5, 'NaN', 'Infinity']) await assert.rejects(pay(sid, p.id, amount));
  await assert.rejects(pay(other, p.id, 150));
  await assert.rejects(pay(sid, null, 150), /Cần chọn phiếu mua/);
  await assert.rejects(rpc('rpc_record_supplier_payment', { supplierId: sid, amount: 150, idempotencyKey: randomUUID() }), /outstanding debt/);
  await call('rpc_cancel_purchase', [p.id, 'Cancel unpaid test purchase']);
  await assert.rejects(pay(sid, p.id, 150), /Only completed purchases/);
  assert.equal(Number(await scalar(db, 'SELECT count(*) AS value FROM public.purchase_payments')), count);
});

test('sale and anonymous accounts cannot use the advance endpoint', async () => {
  await asActor(db, saleId);
  await assert.rejects(pay('no-supplier', 'no-purchase', 150), /accounting role required/);
  await db.exec('RESET ROLE; SET ROLE anon;');
  await assert.rejects(pay('no-supplier', 'no-purchase', 150), /permission denied/);
  await asActor(db, accountingId);
});

test('supplier advances include retained purchase and payment balances', async () => {
  const sid = await supplier();
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO public.retention_supplier_balances(supplier_id,purchase_carry,paid_carry,cutoff) VALUES($1,1000,800,$2)', [sid, '2026-09-01T00:00:00+07:00']);
  await asActor(db, accountingId);
  const p = await purchase(sid, 100);
  const result = await pay(sid, p.id, 500);
  assert.equal(result.supplier.totalPurchase, 1100);
  assert.equal(result.supplier.totalPaid, 1300);
  assert.equal(result.supplier.debt, -200);
});
