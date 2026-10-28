import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildRetentionDatabase, asActor, scalar, saleId } from './helpers/retention-db.mjs';

test('the existing quick-create command works for Sale without direct table write permission or an assigned price list', async () => {
  const db = await buildRetentionDatabase();
  try {
    await asActor(db, saleId);
    await db.exec('BEGIN; SAVEPOINT denied');
    await assert.rejects(() => db.exec("INSERT INTO public.customers(id,code,name) VALUES ('forbidden','FORBIDDEN','Synthetic denied write')"), /row-level security|permission denied/i);
    await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied');
    const id = `sale-customer-${randomUUID()}`;
    const result = await scalar(db, 'SELECT public.rpc_create_quick_customer($1) AS value', [JSON.stringify({
      id, code: `KH-TEST-${randomUUID()}`, name: 'Synthetic Sale-created customer', phone: '0900000012',
      address: 'Synthetic address', province: 'HN', assignedBrand: 'Tất cả', notes: 'Synthetic directory note',
      managedBy: 'someone-else', pricelistId: null, debt: 999999, totalTransaction: 888888
    })]);
    assert.equal(result.success, true);
    assert.equal(result.customer.managedBy, 'retention-sale@test.invalid');
    assert.equal(Number(result.customer.debt), 0);
    assert.equal(Number(result.customer.totalTransaction), 0);
    assert.equal(result.customer.brandDiscounts.province, 'HN');
    const row = await scalar(db, 'SELECT to_jsonb(c) AS value FROM public.customers c WHERE id=$1', [id]);
    assert.equal(row.notes, 'Synthetic directory note');
    assert.equal(row.province, 'HN');
    assert.equal(row.managed_by, 'retention-sale@test.invalid');
    await db.exec('SAVEPOINT no_edits');
    await db.query("UPDATE public.customers SET name='Unauthorized edit' WHERE id=$1", [id]);
    assert.equal(await scalar(db, 'SELECT name AS value FROM public.customers WHERE id=$1', [id]), 'Synthetic Sale-created customer');
    await db.exec('ROLLBACK TO SAVEPOINT no_edits; ROLLBACK');
  } finally { await db.close(); }
});
