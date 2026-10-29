import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';
let db;const day=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Bangkok'});
const report=(actorId,sessionId,bytes,requests=1)=>scalar(db,'SELECT rpc_report_application_egress($1) AS value',[JSON.stringify({actorId,sessionId,day:day(),bytes,requests,truncated:0})]);
const status=()=>scalar(db,'SELECT rpc_admin_system_status() AS value');
before(async()=>{db=await buildRetentionDatabase();});after(async()=>db?.close());
test('only Admin can read totals or refresh; other roles cannot read private monitoring tables',async()=>{
 for(const id of [accountingId,saleId]){await asActor(db,id);await assert.rejects(status(),/Chỉ Admin/);await assert.rejects(db.query('SELECT * FROM private.app_egress_totals'),/permission denied/);}
 await db.exec('RESET ROLE; SET ROLE anon');await assert.rejects(status(),/permission denied/);await assert.rejects(report(adminId,randomUUID(),1),/permission denied/);
 await asActor(db);const data=await status();assert.equal(data.egressBytes,null);assert.equal(data.updateEveryHours,2);assert.ok(data.databaseBytes>0);
});
test('each role can report its own aggregates but cannot impersonate another account',async()=>{
 await asActor(db,saleId);await assert.rejects(report(adminId,randomUUID(),100),/tài khoản khác/);
 await report(saleId,randomUUID(),100);
 await asActor(db,accountingId);await report(accountingId,randomUUID(),200);
 await asActor(db);assert.equal((await status()).egressBytes,300);
});
test('retries, older snapshots and concurrent-session counters add only new measured bytes',async()=>{
 await asActor(db);const session=randomUUID();await report(adminId,session,100,1);await report(adminId,session,100,1);await report(adminId,session,80,1);await report(adminId,session,250,2);
 assert.equal((await status()).egressBytes,550);await report(adminId,randomUUID(),50);assert.equal((await status()).egressBytes,600);
});
test('invalid telemetry is atomic, holds no business data, and cached DB capture waits two hours',async()=>{
 await asActor(db);await assert.rejects(report(adminId,randomUUID(),-10),/không hợp lệ/);assert.equal((await status()).egressBytes,600);
 const a=await status();const b=await status();assert.equal(a.sampledAt,b.sampledAt);
 await db.exec('RESET ROLE');await db.exec("UPDATE private.app_system_status SET sampled_at=now()-interval '3 hours'");
 await asActor(db);const c=await status();assert.notEqual(c.sampledAt,a.sampledAt);
 await db.exec('RESET ROLE');assert.equal(await scalar(db,'SELECT expected_trigger_hash=p107_trigger_fingerprint() AS value FROM retention_control WHERE id'),true);
 const tables=await scalar(db,'SELECT p107_snapshot_tables(true) AS value');assert.ok(tables.every(t=>!t.startsWith('app_egress')&&!t.startsWith('app_system')));
});
