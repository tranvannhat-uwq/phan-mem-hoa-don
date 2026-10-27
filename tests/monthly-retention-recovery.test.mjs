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
    const seed=new Set(['profiles','companies','retention_control','inventory_control']);
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
