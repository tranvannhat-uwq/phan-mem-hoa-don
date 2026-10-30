import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildRetentionDatabase, asActor, scalar, accountingId, saleId } from './helpers/retention-db.mjs';

test('supplier cashbook service sends the supplier ID and applies authoritative balances; missing RPC never falls back', async () => {
  const source = await readFile(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export async function dbSaveCashbookTransaction('), source.indexOf('export async function dbSaveStartingBalances(')).replace(/^export /gm, '');
  const calls = [], suppliers = [];
  let rejection = null;
  const context = vm.createContext({ isCloudActive: true, console: { warn() {} }, showToast() {},
    applyCanonicalSupplier: supplier => suppliers.push(supplier), supabaseClient: { rpc: async (name, args) => {
      calls.push({ name, args });
      return rejection ? { error: rejection } : { data: { success: true, supplier: { id: 'sun', debt: 5838 },
        transaction: { id: 'server-id', supplierId: 'sun', purchasePaymentId: 'payment-1' } } };
    } } });
  vm.runInContext(code, context);
  const tx = { id: 'draft-id', type: 'chi', supplierId: 'sun', category: 'Chi tiền nhập hàng', value: 287867520,
    date: '2026-10-30T02:03:00Z', idempotencyKey: 'stable-supplier-payment' };
  assert.equal((await context.dbSaveCashbookTransaction(tx)).success, true);
  assert.equal(calls[0].name, 'rpc_create_supplier_cashbook_payment');
  assert.equal(calls[0].args.p_input.supplierId, 'sun');
  assert.equal(calls[0].args.p_input.transactionDate, tx.date);
  assert.equal(tx.id, 'server-id'); assert.equal(suppliers[0].debt, 5838);
  rejection = { code: 'PGRST202', message: 'missing' };
  let error = '';
  assert.equal(await context.dbSaveCashbookTransaction(tx, { onError: message => { error = message; } }), false);
  assert.match(error, /0137/); assert.equal(calls.length, 2);
  assert.equal(calls[1].name, 'rpc_create_supplier_cashbook_payment');
  rejection = null;
  await context.dbSaveCashbookTransaction({ ...tx, supplierId: null });
  assert.equal(calls[2].name, 'rpc_create_cashbook_transaction');
  await context.dbSaveCashbookTransaction({ ...tx, category: 'Khác' });
  assert.equal(calls[3].name, 'rpc_create_cashbook_transaction');
});

test('supplier payment matching rejects partial names, empty codes and duplicate names', async () => {
  const source = await readFile(new URL('../js/components/so_quy.js', import.meta.url), 'utf8');
  const context = vm.createContext({ state: { currentUser: { role: 'accounting' }, suppliers: [
    { id: 'sun', name: 'Sun Chem', code: 'SUN' }, { id: 'empty', name: 'Other', code: '' }
  ] }, normalizeText: value => String(value || '').trim().toLowerCase(), isCancelledStatus: status => status === 'cancelled' });
  vm.runInContext(source.slice(source.indexOf('function findSupplierByInput('), source.indexOf('function populatePaymentRecipientDatalist(')), context);
  assert.equal(context.findSupplierByInput('Unknown'), null);
  assert.equal(context.findSupplierByInput('Sun Chem extra'), null);
  assert.equal(context.findSupplierByInput('Sun Chem — SUN').id, 'sun');
  context.state.suppliers.push({ id: 'duplicate', name: 'Sun Chem', code: 'SUN2' });
  assert.equal(context.findSupplierByInput('Sun Chem'), null);
  const tx = { type: 'chi', transactionType: 'manual_chi', category: 'Chi tiền nhập hàng', partner: 'Sun Chem — SUN', status: 'completed' };
  assert.equal(context.getLegacySupplierPayment(tx).id, 'sun');
  for (const override of [{ purchasePaymentId: 'paid' }, { status: 'cancelled' }, { category: 'Khác' }, { customerId: 'customer' }, { reversalOfId: 'original' }]) {
    assert.equal(context.getLegacySupplierPayment({ ...tx, ...override }), null);
  }
});

test('cashbook supplier debt creation and same-voucher reconciliation are atomic, idempotent, reversible and finance-only', async () => {
  const db = await buildRetentionDatabase({ maxVersion: 136 });
  try {
    const migration = await readFile(new URL('../migrations/0137_cashbook_supplier_debt_payments.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await asActor(db, accountingId);
    await scalar(db, `SELECT rpc_save_supplier($1::jsonb) AS value`, [JSON.stringify({ id: 'sun', code: 'SUN', name: 'Sun Chem', openingDebt: 287873358 })]);
    const createManual = input => scalar(db, 'SELECT rpc_create_cashbook_transaction($1::jsonb) AS value', [JSON.stringify(input)]);
    const create = input => scalar(db, 'SELECT rpc_create_supplier_cashbook_payment($1::jsonb) AS value', [JSON.stringify(input)]);
    const reconcile = (id, supplier = 'sun') => scalar(db, 'SELECT rpc_reconcile_supplier_cashbook_payment($1,$2) AS value', [id, supplier]);
    const template = { type: 'chi', category: 'Chi tiền nhập hàng', partner: 'Sun Chem', value: 79563600, method: 'cash',
      accounting: false, note: 'Keep original note', transactionDate: '2026-10-30T01:56:00Z', idempotencyKey: 'sun-old-001466' };
    const first = await createManual(template);
    const second = await createManual({ ...template, value: 101736000, idempotencyKey: 'sun-old-001468' });
    const third = await createManual({ ...template, value: 106567920, idempotencyKey: 'sun-old-001469' });
    const countBefore = await scalar(db, 'SELECT count(*)::int AS value FROM cashbook_transactions');
    const original = await scalar(db, 'SELECT to_jsonb(c) AS value FROM cashbook_transactions c WHERE id=$1', [first.cashbook_id]);
    for (const voucher of [first, second, third]) {
      const result = await reconcile(voucher.cashbook_id);
      assert.equal(result.already_reconciled, false);
      assert.equal(result.transaction.id, voucher.cashbook_id);
      assert.ok(result.transaction.purchasePaymentId);
      assert.equal((await reconcile(voucher.cashbook_id)).already_reconciled, true);
    }
    const directory = await scalar(db, 'SELECT rpc_supplier_directory(0,200) AS value');
    assert.equal(directory.rows.find(s => s.id === 'sun').debt, 5838);
    assert.equal(directory.rows.find(s => s.id === 'sun').total_paid, 287867520);
    assert.equal(Date.parse(directory.rows.find(s => s.id === 'sun').last_payment_at), Date.parse(template.transactionDate));
    assert.equal(await scalar(db, 'SELECT count(*)::int AS value FROM cashbook_transactions'), countBefore);
    const saved = await scalar(db, 'SELECT to_jsonb(c) AS value FROM cashbook_transactions c WHERE id=$1', [first.cashbook_id]);
    for (const field of ['id', 'value', 'date', 'transaction_date', 'accounting', 'category', 'method', 'note', 'display_number', 'created_by']) assert.equal(saved[field], original[field], field);
    assert.equal(Date.parse(await scalar(db, 'SELECT created_at AS value FROM purchase_payments WHERE id=$1', [saved.purchase_payment_id])), Date.parse(original.transaction_date));
    assert.equal(await scalar(db, 'SELECT count(*)::int AS value FROM supplier_debt_transactions WHERE payment_id IS NOT NULL'), 3);

    // New form creates both records or neither, preserving the selected time.
    const beforeFailure = await scalar(db, 'SELECT count(*)::int AS value FROM cashbook_transactions');
    await assert.rejects(create({ ...template, supplierId: 'sun', value: 5839, idempotencyKey: 'sun-too-much' }), /vượt công nợ/);
    await assert.rejects(create({ ...template, supplierId: 'sun', value: 0.5, idempotencyKey: 'sun-fraction' }), /nguyên/);
    await assert.rejects(create({ ...template, supplierId: 'sun', category: 'Khác', idempotencyKey: 'sun-wrong-category' }), /Chỉ ghi công nợ/);
    assert.equal(await scalar(db, 'SELECT count(*)::int AS value FROM cashbook_transactions'), beforeFailure);
    const input = { ...template, supplierId: 'sun', value: 5838, idempotencyKey: 'sun-final-payment' };
    const final = await create(input);
    assert.equal(final.supplier.debt, 0); assert.equal(final.transaction.date, original.transaction_date);
    assert.equal((await create(input)).already_recorded, true);
    await assert.rejects(create({ ...input, value: 100 }), /different cashbook payload/);
    await assert.rejects(reconcile(final.cashbook_id, 'unknown'), /no rows/);

    // Standard amendment and cancellation still operate on the linked payment.
    const amended = await scalar(db, 'SELECT rpc_amend_cashbook_transaction($1,$2::jsonb) AS value', [final.cashbook_id, JSON.stringify({ value: 5800, reason: 'Correct amount', note: 'Corrected' })]);
    assert.ok(amended.success);
    const cancelled = await scalar(db, 'SELECT rpc_cancel_cashbook_entry($1,$2) AS value', [final.cashbook_id, 'Cancel test payment']);
    assert.ok(cancelled.success);
    const afterCancel = await scalar(db, 'SELECT rpc_supplier_directory(0,200) AS value');
    assert.equal(afterCancel.rows.find(s => s.id === 'sun').debt, 5838);
    await assert.rejects(reconcile(final.cashbook_id), /đã thanh toán/);
    await scalar(db, 'SELECT rpc_cancel_cashbook_entry($1,$2) AS value', [final.cashbook_id, 'Retry cancellation']);
    assert.equal((await scalar(db, 'SELECT rpc_supplier_directory(0,200) AS value')).rows.find(s => s.id === 'sun').debt, 5838);

    const wrongPartner = await createManual({ ...template, partner: 'Someone else', value: 1, idempotencyKey: 'wrong-partner-legacy' });
    await assert.rejects(reconcile(wrongPartner.cashbook_id), /không khớp/);
    await db.exec('RESET ROLE');
    await db.exec("UPDATE retention_control SET cutoff='2026-11-01T00:00:00+07:00' WHERE id");
    await asActor(db, accountingId);
    await assert.rejects(create({ ...input, idempotencyKey: 'closed-period-create' }), /Kỳ trước/);
    await assert.rejects(reconcile(wrongPartner.cashbook_id), /không khớp/);
    await db.exec('RESET ROLE');
    await db.exec('UPDATE retention_control SET cutoff=NULL WHERE id');
    await asActor(db, saleId);
    await assert.rejects(create({ ...input, idempotencyKey: 'sale-denied' }), /Admin|Kế toán/);
    await assert.rejects(reconcile(first.cashbook_id), /Admin|Kế toán/);
    await db.exec('RESET ROLE; SET ROLE anon');
    await assert.rejects(create(input), /permission denied/);
    await assert.rejects(reconcile(first.cashbook_id), /permission denied/);
  } finally { await db.close(); }
});
