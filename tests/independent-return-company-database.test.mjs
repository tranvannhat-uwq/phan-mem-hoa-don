import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { buildRetentionDatabase, asActor, scalar, adminId, accountingId, saleId } from './helpers/retention-db.mjs';

let db;
const migration = await readFile(new URL('../migrations/0138_seed_default_companies.sql', import.meta.url), 'utf8');
const stateSource = await readFile(new URL('../js/state.js', import.meta.url), 'utf8');
const DEFAULT_COMPANIES = JSON.parse(JSON.stringify(vm.runInNewContext(
  stateSource.slice(0, stateSource.indexOf('// Đối tượng')).replace('export const DEFAULT_COMPANIES =', 'const DEFAULT_COMPANIES =') + '\nDEFAULT_COMPANIES;'
)));
const input = companyId => ({ customerId: 'retention-customer', companyId, sealConfirmed: true,
  reason: 'Trả', idempotencyKey: randomUUID(),
  items: [{ productId: 'retention-sku', quantity: 1, unitPrice: 838700, deductionPercent: 0 }] });
const record = payload => scalar(db, 'SELECT public.rpc_record_independent_return($1::jsonb) AS value', [JSON.stringify(payload)]);
const balance = async () => {
  await db.exec('RESET ROLE');
  return Number(await scalar(db, "SELECT debt AS value FROM public.customers WHERE id = 'retention-customer'"));
};

before(async () => { db = await buildRetentionDatabase({ maxVersion: 137 }); });
after(async () => { await db?.close(); });

test('missing default master data reproduces the screenshot error; migration fills all UI companies', async () => {
  // Legacy installations have no seeded company rows, unlike the old test fixture.
  await db.exec('DELETE FROM public.companies');
  await asActor(db);
  await assert.rejects(record(input('ABS_NORTH')), /Công ty không hợp lệ/);
  assert.equal(await balance(), 0);
  await db.exec(migration);
  const { rows } = await db.query('SELECT id, code, name, address, status FROM public.companies ORDER BY id');
  assert.deepEqual(rows, [...DEFAULT_COMPANIES].sort((a, b) => a.id.localeCompare(b.id)));
});

test('reapplying the migration preserves customized and unrelated company records', async () => {
  await db.exec(`UPDATE public.companies SET name = 'Custom legal name', address = 'Custom address', status = 'inactive' WHERE id = 'ABS_SOUTH';
    INSERT INTO public.companies(id,code,name) VALUES ('OTHER','OTHER','Other company');`);
  const beforeRows = (await db.query('SELECT * FROM public.companies ORDER BY id')).rows;
  await db.exec(migration);
  assert.deepEqual((await db.query('SELECT * FROM public.companies ORDER BY id')).rows, beforeRows);
});

test('Admin and Accounting can record, retry and cancel returns for every default company', async () => {
  for (const actor of [adminId, accountingId]) {
    for (const company of DEFAULT_COMPANIES) {
      const debtBefore = await balance();
      const payload = input(company.id);
      await asActor(db, actor);
      const result = await record(payload);
      assert.equal(Number(result.new_debt), debtBefore - 838700);
      const retry = await record(payload);
      assert.equal(retry.return_id, result.return_id);
      assert.equal(retry.already_recorded, true);
      assert.equal(await balance(), debtBefore - 838700);
      const ret = (await db.query('SELECT company_id, refund_amount FROM public.sales_returns WHERE id=$1', [result.return_id])).rows[0];
      assert.equal(ret.company_id, company.id);
      assert.equal(Number(ret.refund_amount), 0);
      const ledger = (await db.query('SELECT debt_change, retention_company_id FROM public.customer_debt_transactions WHERE sales_return_id=$1', [result.return_id])).rows;
      assert.equal(ledger.length, 1);
      assert.equal(Number(ledger[0].debt_change), -838700);
      assert.equal(ledger[0].retention_company_id, company.id);
      assert.equal(Number(await scalar(db, 'SELECT count(*) AS value FROM public.cashbook_transactions WHERE sales_return_id=$1', [result.return_id])), 0);
      await asActor(db, actor);
      await scalar(db, 'SELECT public.rpc_cancel_sales_return($1,$2) AS value', [result.return_id, 'Synthetic cancellation']);
      assert.equal(await balance(), debtBefore);
    }
  }
});

test('unknown companies and Sales users are still rejected without changing debt or documents', async () => {
  const debtBefore = await balance();
  const countBefore = await scalar(db, 'SELECT count(*) AS value FROM public.sales_returns');
  await asActor(db);
  await assert.rejects(record(input('UNKNOWN-COMPANY')), /Công ty không hợp lệ/);
  await asActor(db, saleId);
  await assert.rejects(record(input('ABS_NORTH')), /Admin hoặc Kế toán/);
  assert.equal(await balance(), debtBefore);
  assert.equal(await scalar(db, 'SELECT count(*) AS value FROM public.sales_returns'), countBefore);
});
