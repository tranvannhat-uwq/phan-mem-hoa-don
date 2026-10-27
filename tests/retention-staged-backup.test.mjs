import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,accountingId,saleId} from './helpers/retention-db.mjs';
import {prepareStagedRetentionBackup} from '../js/services/retention-download.js';
import {encryptRetentionBackup,decryptRetentionBackup} from '../js/services/retention-backup.js';
import {retentionConfirmation} from '../js/domain/data-retention.js';
import {buildStagingRecoverySql} from '../scripts/restore-retention-backup.mjs';

function caller(db,intercept=()=>{}) {
  return async(name,args)=>{
    const values={rpc_start_retention_backup:[args.p_request_key],rpc_stage_retention_backup_table:[args.p_id,args.p_table],
      rpc_finish_retention_backup:[args.p_id],rpc_retention_backup_parts:[args.p_id,args.p_table,args.p_offset]}[name];
    assert.ok(values,`Unexpected RPC ${name}`);
    const result=await scalar(db,`SELECT ${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,values);
    await intercept(name,args,result);return result;
  };
}
async function maintenance(db) {await asActor(db);await scalar(db,"SELECT rpc_set_maintenance_mode(true,'Synthetic staged backup') AS value");}
async function stageAll(db,id) {
  const s=await scalar(db,'SELECT rpc_start_retention_backup($1) AS value',[id]);
  for(const name of s.tables)await scalar(db,'SELECT rpc_stage_retention_backup_table($1,$2) AS value',[id,name]);
  return s;
}

test('staged Unicode recovery equals the full snapshot, survives purge and restores into empty staging',async()=>{
  const db=await buildRetentionDatabase();let target;
  try {
    await asActor(db);
    const cutoff=(await scalar(db,'SELECT rpc_retention_status() AS value')).next_cutoff;
    const old=new Date(Date.parse(cutoff)-86400000).toISOString();
    await scalar(db,'SELECT rpc_confirm_order($1) AS value',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date:old,
      idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:2}]})]);
    await db.exec(`RESET ROLE; SET session_replication_role=replica;
      INSERT INTO activity_logs(id,operation_key,actor_id,actor_name,action,module,target_type,target_id,old_value,new_value,created_at)
      SELECT 'staged-large-'||n,'staged-large-'||n,'10700000-0000-4000-8000-000000000001','Synthetic','UPDATE','orders','order','fixture-'||n,
        jsonb_build_object('payload',repeat('Việt 😃 " \\ ',1800)),jsonb_build_object('payload',repeat(md5(n::text),100)),now()
      FROM generate_series(1,120) n;
      SET session_replication_role=origin;`);
    await maintenance(db);
    const id=randomUUID();await db.exec('BEGIN');
    const oldPrepared=await scalar(db,'SELECT rpc_prepare_monthly_retention($1,false) AS value',[id]);
    await db.exec('ROLLBACK;RESET ROLE');await asActor(db);
    const progress=[];const prepared=await prepareStagedRetentionBackup(caller(db),id,t=>progress.push(t));
    const before=JSON.parse(oldPrepared.backup_text),after=JSON.parse(prepared.backup_text);
    after.created_at=before.created_at;assert.deepEqual(after,before);
    assert.equal(createHash('sha256').update(prepared.backup_text).digest('hex'),prepared.backup_sha256);
    assert.ok(progress.some(t=>/Đang tải/.test(t)));assert.ok(Buffer.byteLength(prepared.backup_text)>1024*1024);
    await db.exec('RESET ROLE');
    assert.ok(Number(await scalar(db,'SELECT max(octet_length(body)) AS value FROM retention_backup_parts'))<=262144);
    assert.ok(Number(await scalar(db,'SELECT count(*) AS value FROM retention_backup_parts'))>55);
    await asActor(db);
    const again=await prepareStagedRetentionBackup(caller(db),id);assert.equal(again.backup_text,prepared.backup_text);
    const file=await encryptRetentionBackup(prepared,'Synthetic staged recovery password');
    const {payload}=await decryptRetentionBackup(file,'Synthetic staged recovery password',{jobId:id,sha256:prepared.backup_sha256});
    const done=await scalar(db,'SELECT rpc_execute_monthly_retention($1,$2,$3) AS value',[id,prepared.backup_sha256,retentionConfirmation(cutoff)]);
    assert.equal(done.verified,true);await db.exec('RESET ROLE');
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_backup_sessions')),0);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_backup_parts')),0);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders')),0);
    const sql=buildStagingRecoverySql(payload);target=await buildRetentionDatabase();
    await target.exec("SELECT set_config('app.retention_restore_target','ISOLATED_EMPTY_STAGING',false);SET session_replication_role=replica");
    const seeds=new Set(['profiles','companies','retention_control','inventory_control','dealer_support_control']);
    for(const name of Object.keys(payload.tables).filter(n=>!seeds.has(n)))await target.exec(`DELETE FROM public."${name}"`);
    await target.exec('SET session_replication_role=origin');await target.exec(sql);
    assert.equal(Number(await scalar(target,'SELECT count(*) AS value FROM orders')),1);
    assert.equal(Number(await scalar(target,"SELECT debt AS value FROM customers WHERE id='retention-customer'")),200);
  }finally{await db.close();if(target)await target.close();}
});

test('a lost response after a committed table resumes the same session without duplicate parts or jobs',async()=>{
  const db=await buildRetentionDatabase();
  try {
    await maintenance(db);const id=randomUUID();let lost=false;
    const rpc=caller(db,(name)=>{if(name==='rpc_stage_retention_backup_table'&&!lost){lost=true;throw new TypeError('Failed to fetch');}});
    await assert.rejects(prepareStagedRetentionBackup(rpc,id),/Failed to fetch/);
    await db.exec('RESET ROLE');assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);await asActor(db);
    const resumed=await prepareStagedRetentionBackup(rpc,id);const retry=await prepareStagedRetentionBackup(caller(db),id);
    assert.equal(resumed.backup_text,retry.backup_text);
    await db.exec('RESET ROLE');assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),1);
  }finally{await db.close();}
});

test('changed rows before staging or finalization fail closed without preparing a purge job',async()=>{
  const db=await buildRetentionDatabase();
  try {
    await maintenance(db);let id=randomUUID();await scalar(db,'SELECT rpc_start_retention_backup($1) AS value',[id]);
    await db.exec("RESET ROLE; UPDATE customers SET notes='Changed during snapshot' WHERE id='retention-customer'");await asActor(db);
    await assert.rejects(scalar(db,'SELECT rpc_stage_retention_backup_table($1,$2) AS value',[id,'customers']),/Dữ liệu đã thay đổi/);
    id=randomUUID();await stageAll(db,id);
    await db.exec("RESET ROLE; UPDATE customers SET notes='Changed before final check' WHERE id='retention-customer'");await asActor(db);
    await assert.rejects(scalar(db,'SELECT rpc_finish_retention_backup($1) AS value',[id]),/Dữ liệu đã thay đổi/);
    await db.exec('RESET ROLE');assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);
  }finally{await db.close();}
});

test('private transport data requires the owning Admin and application pages work in READ ONLY transactions',async()=>{
  const db=await buildRetentionDatabase();
  try {
    await maintenance(db);const id=randomUUID();await stageAll(db,id);await scalar(db,'SELECT rpc_finish_retention_backup($1) AS value',[id]);
    await db.exec('BEGIN READ ONLY');assert.ok((await scalar(db,'SELECT rpc_retention_backup_parts($1,$2,0) AS value',[id,'customers'])).length);await db.exec('ROLLBACK;RESET ROLE');
    await db.exec(`UPDATE profiles SET role='admin' WHERE auth_user_id='${accountingId}'`);await asActor(db,accountingId);
    await assert.rejects(scalar(db,'SELECT rpc_retention_backup_parts($1,$2,0) AS value',[id,'customers']),/tài khoản này/);
    await asActor(db,saleId);await assert.rejects(scalar(db,'SELECT rpc_start_retention_backup($1) AS value',[randomUUID()]),/Chỉ Admin/);
    await asActor(db);await assert.rejects(db.query('SELECT * FROM retention_backup_parts'),/permission denied/);
    await assert.rejects(scalar(db,'SELECT p121_download_plan($1) AS value',[id]),/permission denied/);
    await assert.rejects(scalar(db,'SELECT rpc_stage_retention_backup_table($1,$2) AS value',[id,'profiles; SELECT 1']),/Invalid snapshot table/);
    assert.equal(await scalar(db,'SELECT rpc_release_retention_backup($1) AS value',[id]),true);
    await db.exec('RESET ROLE');assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_backup_parts')),0);
    await db.exec('SET ROLE anon');await assert.rejects(scalar(db,'SELECT rpc_start_retention_backup($1) AS value',[randomUUID()]),/permission denied/);
  }finally{await db.close();}
});

test('missing, reordered, oversized or tampered chunks cannot produce a verified file',async()=>{
  const id=randomUUID(),body='[{"name":"Việt 😃"}]';
  const sha=text=>createHash('sha256').update(text).digest('hex');
  const plan=[{text:'{"tables":{"customers":'},{table:'customers',parts:1,bytes:Buffer.byteLength(body)},{text:'}}'}];
  const full=plan[0].text+body+plan[2].text;
  for(const broken of [[],[{part:1,text:body,sha256:sha(body)}],[{part:0,text:body,sha256:'0'.repeat(64)}],
    [{part:0,text:body+' ',sha256:sha(body+' ')}]]) {
    const rpc=async name=> name==='rpc_start_retention_backup'?{id,tables:['customers'],staged:{customers:{parts:1}}}:
      name==='rpc_finish_retention_backup'?{job_id:id,backup_sha256:sha(full),preview:{},plan}:broken;
    await assert.rejects(prepareStagedRetentionBackup(rpc,id),/không đầy đủ|không khớp/);
  }
});

test('parallel download stays bounded and rejoins pages in order',async()=>{
  const id=randomUUID(),parts=Array.from({length:21},(_,i)=>`row-${i};`),body=parts.join('');
  const sha=text=>createHash('sha256').update(text).digest('hex');
  let active=0,maxActive=0;
  const prepared=await prepareStagedRetentionBackup(async(name,args)=>{
    if(name==='rpc_start_retention_backup')return {id,tables:['customers'],staged:{customers:{parts:parts.length}}};
    if(name==='rpc_finish_retention_backup')return {job_id:id,backup_sha256:sha(body),preview:{},plan:[{table:'customers',parts:parts.length,bytes:Buffer.byteLength(body)}]};
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,args.p_offset===0?10:1));active--;
    return parts.slice(args.p_offset,args.p_offset+4).map((text,i)=>({part:args.p_offset+i,text,sha256:sha(text)}));
  },id);
  assert.equal(maxActive,4);assert.equal(prepared.backup_text,body);
});

test('0121 installation is additive, rolls back its rehearsal and rejects drifted purge definitions',async()=>{
  const {readFile}=await import('node:fs/promises');const db=await buildRetentionDatabase({maxVersion:120});
  try {
    const source=await readFile(new URL('../migrations/0121_retention_staged_recovery_download.sql',import.meta.url),'utf8');
    const fingerprint=await scalar(db,'SELECT p107_fingerprint(false) AS value');
    await db.exec(source.replace(/COMMIT;\s*$/,'ROLLBACK;').replace(/\r?\n/g,'\r\n'));
    assert.equal(await scalar(db,"SELECT to_regclass('public.retention_backup_sessions') AS value"),null);
    assert.equal(await scalar(db,'SELECT p107_fingerprint(false) AS value'),fingerprint);
    const definition=await scalar(db,"SELECT pg_get_functiondef('rpc_execute_monthly_retention(uuid,text,text)'::regprocedure) AS value");
    await db.exec(definition.replace('DECLARE actor','DECLARE /* drift fixture */ actor'));
    await assert.rejects(db.exec(source),/unexpected purge function/);await db.exec('ROLLBACK');
    await db.exec(definition);await db.exec(source);
    assert.equal(await scalar(db,'SELECT p107_fingerprint(false) AS value'),fingerprint);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_backup_sessions')),0);
  }finally{await db.close();}
});
