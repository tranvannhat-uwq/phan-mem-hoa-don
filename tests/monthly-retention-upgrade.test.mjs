import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar} from './helpers/retention-db.mjs';
import {buildRetentionUpgrade} from '../scripts/build-retention-upgrade.mjs';
import {readFile} from 'node:fs/promises';
test('reviewed deployment bundle rolls back the compatibility check and installs atomically without purging',async()=>{
  const db=await buildRetentionDatabase({maxVersion:105});
  try {
    await asActor(db);
    await scalar(db,'SELECT rpc_confirm_order($1) AS value',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:2}]})]);
    await db.exec('RESET ROLE');
    // Production drafts predate order_date. New installs copied the newer
    // orders shape; verify this upgrade against the actual legacy variant.
    const legacyMissing={draft_orders:['salesperson_id','customer_manager_id','revenue_brand_id','total_amount','paid_amount',
      'debt_amount','returned_amount','net_revenue','order_date','confirmed_at','cancelled_by'],
      purchases:['subtotal_amount','vat_rate','vat_amount'],bom_items:['source_product_id']};
    for(const [table,columns] of Object.entries(legacyMissing)) {
      for(const column of columns)await db.exec(`ALTER TABLE public.${table} DROP COLUMN ${column}`);
    }
    const customer=await scalar(db,"SELECT to_jsonb(c) AS value FROM customers c WHERE id='retention-customer'");
    const order=await scalar(db,'SELECT to_jsonb(o) AS value FROM orders o');
    await db.exec(await buildRetentionUpgrade({dryRun:true}));
    assert.equal(await scalar(db,"SELECT to_regclass('public.retention_control') AS value"),null);
    assert.equal(Number(await scalar(db,"SELECT count(*) AS value FROM schema_migrations WHERE version IN('0106','0107','0108','0109')")),0);
    await db.exec(await buildRetentionUpgrade({dryRun:false}));
    assert.equal(Number(await scalar(db,'SELECT epoch AS value FROM retention_control')),0);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);
    assert.deepEqual(await scalar(db,"SELECT to_jsonb(c) AS value FROM customers c WHERE id='retention-customer'"),customer);
    assert.deepEqual(await scalar(db,'SELECT to_jsonb(o) AS value FROM orders o'),order);
    await assert.rejects(db.exec(await buildRetentionUpgrade({dryRun:false})),/already present/);
    await db.exec('ROLLBACK');
  } finally {await db.close();}
});

test('0118 rehearses and installs on populated 0117 without modifying business rows, and rejects drift',async()=>{
  const db=await buildRetentionDatabase({maxVersion:117});
  try {
    await asActor(db);await scalar(db,'SELECT rpc_confirm_order($1) AS value',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:2}]})]);
    await db.exec('RESET ROLE');
    const before=await scalar(db,"SELECT p107_fingerprint(true) AS value");
    const source=await readFile(new URL('../migrations/0118_retention_reconciliation_holds.sql',import.meta.url),'utf8');
    // SQL Editor and Windows can normalize pasted scripts to CRLF.
    await db.exec(source.replace(/COMMIT;\s*$/,'ROLLBACK;').replace(/\r?\n/g,'\r\n'));
    assert.equal(await scalar(db,"SELECT to_regclass('public.retention_review_orders') AS value"),null);
    assert.equal(await scalar(db,'SELECT p107_fingerprint(true) AS value'),before);
    await db.exec("BEGIN;CREATE OR REPLACE FUNCTION p107_plan(p_cutoff timestamptz) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT '{}'::jsonb $$;COMMIT;");
    await assert.rejects(db.exec(source),/unreviewed retention function/);await db.exec('ROLLBACK');
    const original=(await buildRetentionDatabase({maxVersion:117}));
    try {const definition=await scalar(original,"SELECT pg_get_functiondef('p107_plan(timestamptz)'::regprocedure) AS value");await db.exec(definition);}finally{await original.close();}
    await db.exec(source);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_review_orders')),0);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);
    assert.equal(Number(await scalar(db,'SELECT epoch AS value FROM retention_control')),0);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders')),1);
    assert.equal(Number(await scalar(db,"SELECT debt AS value FROM customers WHERE id='retention-customer'")),200);
  }finally{await db.close();}
});
