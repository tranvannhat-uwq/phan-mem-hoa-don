import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,accountingId} from './helpers/retention-db.mjs';
test('PostgREST-style READ ONLY reports work before and after purge and still reject stale epochs',async()=>{
  const db=await buildRetentionDatabase();
  const call=(name,args=[])=>scalar(db,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
  async function readReports(epoch) {
    await asActor(db,undefined,epoch);await db.exec('BEGIN READ ONLY');
    try {
      assert.equal(await scalar(db,"SELECT current_setting('transaction_read_only') AS value"),'on');
      for(const name of ['rpc_get_phase5_dashboard','rpc_get_phase5_report','rpc_get_employee_business_report','rpc_list_independent_returns'])assert.ok(await call(name,['{}']));
      const start=new Date();start.setUTCDate(1);start.setUTCHours(0,0,0,0);
      assert.ok(await call('rpc_get_cashbook_window',[start.toISOString(),new Date(Date.now()+86400000).toISOString()]));
    }finally{await db.exec('ROLLBACK');}
  }
  try {
    await readReports(0);
    await asActor(db);await call('rpc_set_maintenance_mode',[true,'Synthetic maintenance']);
    const p=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
    const confirm='XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(p.preview.cutoff));
    await call('rpc_execute_monthly_retention',[p.job_id,p.backup_sha256,confirm]);
    await readReports(1);
    await asActor(db,accountingId,1);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_customer_balances')),0,'Maintenance also hides the new direct-read checkpoint table from staff');
    await asActor(db,undefined,1);await call('rpc_set_maintenance_mode',[false,'Synthetic end maintenance']);
    await asActor(db,accountingId,1);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_customer_balances')),1);
    await asActor(db,undefined,0);await db.exec('BEGIN READ ONLY');
    await assert.rejects(call('rpc_get_phase5_dashboard',['{}']),/RETENTION_EPOCH_CHANGED/);await db.exec('ROLLBACK');
  }finally{await db.close();}
});
