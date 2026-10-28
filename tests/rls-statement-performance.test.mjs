import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildRetentionDatabase, asActor, scalar, adminId, accountingId, saleId } from './helpers/retention-db.mjs';

let db;
const otherId = '12400000-0000-4000-8000-000000000004';
const unknownId = '12400000-0000-4000-8000-000000000005';
const tables = ['customers', 'products', 'orders', 'draft_orders', 'brands', 'pricelists', 'customer_assignments'];
const expected = new Map();
let oldPolicyMetadata;
async function metadata() {
  return (await db.query(`SELECT tablename,policyname,permissive,roles,cmd FROM pg_policies
    WHERE schemaname='public' ORDER BY tablename,policyname`)).rows;
}
async function snapshot(id, maintenance, active = true) {
  await db.exec('RESET ROLE');
  await db.query('UPDATE system_maintenance SET enabled=$1', [maintenance]);
  await db.query('UPDATE profiles SET is_active=$1 WHERE auth_user_id=$2', [active, saleId]);
  await asActor(db, id);
  const result = {};
  for (const table of tables) result[table] = await scalar(db,
    `SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) AS value FROM public.${table}`);
  return result;
}

before(async () => {
  db = await buildRetentionDatabase({ maxVersion: 123 });
  await db.exec(`INSERT INTO auth.users(id,email) VALUES ('${otherId}','other-sale@test.invalid');
    INSERT INTO customers(id,code,name,managed_by) VALUES
      ('scope-uuid','S-1','UUID owner','${saleId}'),
      ('scope-case','S-2','Case owner','RETENTION-SALE@TEST.INVALID'),
      ('scope-alias','S-3','Alias owner','retention-sale@other.invalid'),
      ('scope-other','S-4','Other owner','other-sale@test.invalid'),
      ('scope-assigned','S-5','Assigned alias','other-sale@test.invalid'),
      ('scope-expired','S-6','Expired assignment','other-sale@test.invalid'),
      ('scope-inactive','S-7','Inactive assignment','other-sale@test.invalid'),
      ('scope-null','S-8','No owner',NULL);
    INSERT INTO customer_assignments(id,customer_id,employee_id,is_active,assigned_to) VALUES
      ('scope-a1','scope-assigned','RETENTION-SALE@OTHER.INVALID',true,NULL),
      ('scope-a2','scope-expired','${saleId}',true,now()-interval '1 day'),
      ('scope-a3','scope-inactive','retention-sale@test.invalid',false,NULL);`);
  oldPolicyMetadata = await metadata();
  for (const maintenance of [false, true]) for (const id of [adminId, accountingId, saleId, otherId, unknownId]) {
    expected.set(`${id}:${maintenance}:true`, await snapshot(id, maintenance));
  }
  expected.set(`${saleId}:false:false`, await snapshot(saleId, false, false));
  await db.exec('RESET ROLE');
  await db.exec(await readFile(new URL('../migrations/0124_statement_scoped_rls_checks.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });

test('optimized policies preserve exact row visibility for every role, unknown/inactive profiles and maintenance', async () => {
  await db.exec('RESET ROLE');
  assert.deepEqual(await metadata(), oldPolicyMetadata, 'roles, commands and restrictive policies stay intact');
  for (const [key, value] of expected) {
    const [id, maintenance, active] = key.split(':');
    assert.deepEqual(await snapshot(id, maintenance === 'true', active === 'true'), value, key);
  }
});

test('customer scope matches the original helper including aliases, expiration and inactive assignments', async () => {
  await db.exec('RESET ROLE; UPDATE system_maintenance SET enabled=false; UPDATE profiles SET is_active=true;');
  await asActor(db, saleId);
  const ids = await scalar(db, 'SELECT jsonb_agg(id ORDER BY id) AS value FROM customers');
  assert.ok(ids.includes('scope-uuid') && ids.includes('scope-case') && ids.includes('scope-alias') && ids.includes('scope-assigned'));
  assert.ok(!ids.includes('scope-other') && !ids.includes('scope-expired') && !ids.includes('scope-inactive'));
  await db.exec('RESET ROLE');
  for (const id of [saleId, otherId, unknownId]) {
    await asActor(db, id);
    await db.exec('RESET ROLE');
    const mismatches = await scalar(db, `SELECT count(*) AS value FROM customers c
      WHERE public.can_access_customer(c.id) IS DISTINCT FROM
        (c.id IN (SELECT public.rls_my_customer_ids()))`);
    assert.equal(Number(mismatches), 0, id);
  }
});

test('profile helpers become InitPlans and access is rechecked on the next statement', async () => {
  await asActor(db, saleId);
  const plan = JSON.stringify((await db.query('EXPLAIN (VERBOSE,FORMAT JSON) SELECT count(*) FROM products')).rows);
  assert.match(plan, /InitPlan/);
  assert.match(plan, /current_profile_role/);
  await db.exec('RESET ROLE');
  await db.query('UPDATE profiles SET is_active=false WHERE auth_user_id=$1', [saleId]);
  await asActor(db, saleId);
  assert.equal(Number(await scalar(db, 'SELECT count(*) AS value FROM products')), 0);
  await db.exec('RESET ROLE');
  await db.query('UPDATE profiles SET is_active=true WHERE auth_user_id=$1', [saleId]);
  await asActor(db, saleId);
  assert.ok(Number(await scalar(db, 'SELECT count(*) AS value FROM products')) > 0);
});

test('anonymous access and Sale writes remain denied; migration can be reapplied', async () => {
  await db.exec('RESET ROLE; SET ROLE anon');
  await assert.rejects(db.query('SELECT * FROM public.rls_my_customer_ids()'), /permission denied/);
  await assert.rejects(db.query('SELECT id FROM public.customers'), /permission denied/);
  await asActor(db, saleId);
  assert.equal((await db.query("UPDATE customers SET name='unauthorized' WHERE id='scope-uuid' RETURNING id")).rows.length, 0);
  await assert.rejects(db.exec("INSERT INTO products(id,code,name) VALUES ('forbidden','forbidden','forbidden')"), /row-level security/);
  await db.exec('RESET ROLE');
  await db.exec(await readFile(new URL('../migrations/0124_statement_scoped_rls_checks.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await metadata(), oldPolicyMetadata);
});
