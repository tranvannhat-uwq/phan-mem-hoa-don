import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId} from './helpers/retention-db.mjs';

test('large audit payloads preserve exactly the same connected rows after the narrow-key upgrade',async()=>{
  const db=await buildRetentionDatabase({maxVersion:118});
  try {
    await asActor(db);
    const create=async()=> (await scalar(db,'SELECT rpc_confirm_order($1) AS value',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:1}]})])).order.id;
    const kept=await create(),unrelated=await create();await db.exec('RESET ROLE');
    await db.query(`INSERT INTO retention_review_orders(order_id,reasons,source_snapshot,cutoff,kept_by)
      VALUES($1,'["Synthetic review"]','{}',p107_cutoff(),$2)`,[kept,adminId]);
    // Load the pre-compaction legacy shape that is present in real archives.
    await db.exec('SET session_replication_role=replica');
    await db.query(`INSERT INTO audit_logs(id,table_name,action,record_id,old_data,new_data)
      SELECT 'large-audit-'||n,'orders','UPDATE',CASE WHEN n<=3 THEN $1 ELSE $2 END,
      jsonb_build_object('payload',repeat(md5(n::text),256)),jsonb_build_object('payload',repeat(md5((n+1)::text),256))
      FROM generate_series(1,1500) n`,[kept,unrelated]);
    await db.exec('SET session_replication_role=origin');
    assert.ok(Number(await scalar(db,"SELECT octet_length(old_data::text) AS value FROM audit_logs WHERE id='large-audit-1'"))>=8192);
    const old=(await db.query('SELECT * FROM p118_kept_rows() ORDER BY table_name,row_id')).rows;
    const before=await scalar(db,'SELECT p107_fingerprint(true) AS value');
    const migration=await readFile(new URL('../migrations/0119_retention_lookup_key_performance.sql',import.meta.url),'utf8');
    await db.exec(migration.replace(/\r?\n/g,'\r\n'));
    assert.equal(await scalar(db,'SELECT p107_fingerprint(true) AS value'),before,'Installation must not touch business data or review metadata');
    const current=(await db.query('SELECT * FROM p118_kept_rows() ORDER BY table_name,row_id')).rows;
    assert.deepEqual(current,old);
    assert.equal(current.filter(r=>r.row_id.startsWith('large-audit-')).length,3,'Unrelated large documents must not be retained');
    await db.exec('BEGIN READ ONLY');
    const profiled=(await db.query('SELECT * FROM p119_related_rows($1) ORDER BY table_name,row_id',[[kept]])).rows;
    assert.deepEqual(profiled,current);await db.exec('ROLLBACK');
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_review_orders')),1,'Read-only profiling cannot create holds');
    await asActor(db);
    await assert.rejects(db.query('SELECT * FROM p119_related_rows($1)',[[kept]]),/permission denied/);
  }finally{await db.close();}
});

test('scalar key expressions match composite and nullable JSON keys without loading payload fields',async()=>{
  const db=await buildRetentionDatabase();
  try {
    await db.exec(`CREATE TABLE public.synthetic_key_shape(id text,order_id text,product_id text,ledger_id text,period text,payload jsonb);
      INSERT INTO synthetic_key_shape VALUES(NULL,'O-1','SKU"2',NULL,NULL,'{"unused":"body"}'),
        (NULL,NULL,NULL,'L-1',NULL,'{}'),('ID-1','O-2','SKU-3',NULL,NULL,'{}');`);
    const expression=await scalar(db,"SELECT p119_row_key_sql('synthetic_key_shape','row alias') AS value");
    const rows=(await db.query(`SELECT ${expression} AS fast,p118_row_key(to_jsonb("row alias")) AS original FROM synthetic_key_shape "row alias"`)).rows;
    assert.ok(rows.every(r=>r.fast===r.original));
    const injectedAlias='t); DROP TABLE orders; --';
    const quoted=await scalar(db,'SELECT p119_row_key_sql($1,$2) AS value',['orders',injectedAlias]);
    assert.equal(quoted,'"t); DROP TABLE orders; --".id::text');
    assert.equal(await scalar(db,"SELECT p119_is_kept('orders','not-held') AS value"),false);
  }finally{await db.close();}
});
