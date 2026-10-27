import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar} from './helpers/retention-db.mjs';
import {encryptRetentionBackup,decryptRetentionBackup} from '../js/services/retention-backup.js';
import {buildStagingRecoverySql} from '../scripts/restore-retention-backup.mjs';

test('downloaded encrypted recovery file restores real financial rows only into empty matching staging',async()=>{
  const source=await buildRetentionDatabase();let target;
  try {
    await asActor(source);
    const old=new Date(Date.parse((await scalar(source,'SELECT rpc_retention_status() AS value')).next_cutoff)-86400000).toISOString();
    await scalar(source,'SELECT rpc_confirm_order($1) AS value',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date:old,idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:10}]})]);
    await scalar(source,"SELECT rpc_record_customer_receipt('retention-customer',100,'Synthetic payment','cash',$1,'Thu tiền khách hàng',$2) AS value",[randomUUID(),old]);
    await scalar(source,"SELECT rpc_set_maintenance_mode(true,'Synthetic rehearsal') AS value");
    const prepared=await scalar(source,'SELECT rpc_prepare_monthly_retention($1,false) AS value',[randomUUID()]);
    const file=await encryptRetentionBackup(prepared,'Synthetic rehearsal password');
    const {payload}=await decryptRetentionBackup(file,'Synthetic rehearsal password',{jobId:prepared.job_id,sha256:prepared.backup_sha256});
    const sql=buildStagingRecoverySql(payload);
    target=await buildRetentionDatabase();
    await assert.rejects(target.exec(sql),/isolated empty staging connection/);await target.exec('ROLLBACK');
    await target.exec("SELECT set_config('app.retention_restore_target','ISOLATED_EMPTY_STAGING',false)");
    await assert.rejects(target.exec(sql),/must be empty/);await target.exec('ROLLBACK');
    assert.equal(Number(await scalar(target,'SELECT count(*) AS value FROM customers')),1);
    const seed=new Set(['profiles','companies','retention_control','inventory_control','dealer_support_control']);
    await target.exec('SET session_replication_role=replica');
    for(const name of Object.keys(payload.tables).filter(name=>!seed.has(name)))await target.exec(`DELETE FROM public."${name}"`);
    await target.exec('SET session_replication_role=origin');
    await target.exec(sql);
    assert.equal(Number(await scalar(target,"SELECT debt AS value FROM customers WHERE id='retention-customer'")),900);
    assert.equal(Number(await scalar(target,'SELECT count(*) AS value FROM orders')),1);
    assert.equal(Number(await scalar(target,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('retention-customer')")),900);
    const actual=await scalar(target,"SELECT to_jsonb(c) AS value FROM customers c WHERE id='retention-customer'");
    assert.deepEqual(actual,payload.tables.customers.find(c=>c.id==='retention-customer'));
  } finally { await source.close();if(target)await target.close(); }
});

test('a subsequent encrypted backup restores archived support facts and retained return links',async()=>{
  const source=await buildRetentionDatabase();let target;
  const call=(name,args=[])=>scalar(source,`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
  try {
    await asActor(source);await call('rpc_set_dealer_support_products',[JSON.stringify([{id:'retention-sku',selected:true}])]);
    const cutoff=(await call('rpc_retention_status')).next_cutoff;
    const old=new Date(Date.parse(cutoff)-86400000).toISOString();
    const sale=(await call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date:old,idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:3}]})])).order.id;
    await source.exec('RESET ROLE');const item=await scalar(source,'SELECT id AS value FROM order_items WHERE order_id=$1',[sale]);await asActor(source);
    await call('rpc_record_sales_return_credit',[JSON.stringify({orderId:sale,idempotencyKey:randomUUID(),reason:'Synthetic support restore',items:[{saleItemId:item,quantity:1}]})]);
    await call('rpc_set_maintenance_mode',[true,'Synthetic support recovery']);
    const first=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
    await call('rpc_execute_monthly_retention',[first.job_id,first.backup_sha256,'XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(cutoff))]);
    await source.exec('RESET ROLE');const next=new Date(cutoff);next.setUTCMonth(next.getUTCMonth()+1);
    await source.exec(`CREATE OR REPLACE FUNCTION p107_cutoff() RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT '${next.toISOString()}'::timestamptz$$`);
    await asActor(source,undefined,1);const p=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
    const encrypted=await encryptRetentionBackup(p,'Synthetic support restore password');
    const {payload}=await decryptRetentionBackup(encrypted,'Synthetic support restore password');
    assert.equal(payload.tables.dealer_support_history.length,1);assert.ok(payload.tables.sales_return_items[0].dealer_support_source_key);
    const sql=buildStagingRecoverySql(payload);target=await buildRetentionDatabase();
    await target.exec("SELECT set_config('app.retention_restore_target','ISOLATED_EMPTY_STAGING',false);SET session_replication_role=replica");
    const seeds=new Set(['profiles','companies','retention_control','inventory_control','dealer_support_control']);
    for(const name of Object.keys(payload.tables).filter(name=>!seeds.has(name)))await target.exec(`DELETE FROM public."${name}"`);
    await target.exec('SET session_replication_role=origin');await target.exec(sql);
    assert.deepEqual((await target.query('SELECT to_jsonb(h) AS value FROM dealer_support_history h')).rows.map(row=>row.value),payload.tables.dealer_support_history);
    assert.equal(Number(await scalar(target,'SELECT count(*) AS value FROM sales_return_items WHERE dealer_support_source_key IS NOT NULL')),1);
    await asActor(target,undefined,1);const h=await scalar(target,"SELECT rpc_dealer_support_history('retention-customer') AS value");
    assert.equal(Number(h.summary[0].remaining),2);
  } finally {await source.close();if(target)await target.close();}
});
