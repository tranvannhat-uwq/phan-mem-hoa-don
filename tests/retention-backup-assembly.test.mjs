import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar} from './helpers/retention-db.mjs';
import {retentionConfirmation} from '../js/domain/data-retention.js';

test('one-pass assembly keeps every recovery row and checksum with large legacy logs',async()=>{
  const db=await buildRetentionDatabase({maxVersion:119});
  try {
    await db.exec(`SET session_replication_role=replica;
      INSERT INTO activity_logs_archive_pre_20260804(id,operation_key,actor_id,actor_name,action,module,target_type,target_id,old_value,new_value,created_at)
      SELECT 'backup-large-'||n,'backup-large-'||n,'10700000-0000-4000-8000-000000000001','Synthetic','UPDATE','orders','order','source-'||n,
        jsonb_build_object('payload',repeat(md5(n::text),256)),jsonb_build_object('payload',repeat(md5((n+1)::text),256)),p107_cutoff()-interval '1 day' FROM generate_series(1,500) n;
      SET session_replication_role=origin;`);
    await asActor(db);await scalar(db,"SELECT rpc_set_maintenance_mode(true,'Synthetic backup assembly') AS value");
    const key=randomUUID();await db.exec('BEGIN');
    const before=await scalar(db,'SELECT rpc_prepare_monthly_retention($1,true) AS value',[key]);await db.exec('ROLLBACK;RESET ROLE');
    const migration=await readFile(new URL('../migrations/0120_retention_backup_assembly_performance.sql',import.meta.url),'utf8');
    await db.exec(migration.replace(/\r?\n/g,'\r\n'));await asActor(db);await db.exec('BEGIN');
    const after=await scalar(db,'SELECT rpc_prepare_monthly_retention($1,true) AS value',[key]);
    const oldPayload=JSON.parse(before.backup_text),newPayload=JSON.parse(after.backup_text);
    assert.deepEqual(newPayload.tables,oldPayload.tables);
    assert.deepEqual(newPayload.columns,oldPayload.columns);
    assert.deepEqual(newPayload.sequences,oldPayload.sequences);
    assert.equal(newPayload.fingerprint,oldPayload.fingerprint);
    assert.equal(newPayload.tables.activity_logs_archive_pre_20260804.length,500);
    assert.equal(createHash('sha256').update(after.backup_text).digest('hex'),after.backup_sha256);
    const again=await scalar(db,'SELECT rpc_prepare_monthly_retention($1,true) AS value',[key]);
    assert.equal(again.backup_text,after.backup_text);assert.equal(again.backup_sha256,after.backup_sha256);
    await db.exec('RESET ROLE');
    assert.equal(await scalar(db,"SELECT to_regclass('pg_temp._retention_backup_parts') AS value"),null,'Large temporary parts are removed before returning');
    await db.exec('ROLLBACK;RESET ROLE');
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);
  }finally{await db.close();}
});

test('excluding the legacy archive omits it from recovery and leaves it intact during monthly cleanup',async()=>{
  const db=await buildRetentionDatabase();
  try {
    await db.exec(`SET session_replication_role=replica;
      INSERT INTO activity_logs_archive_pre_20260804(id,operation_key,actor_id,actor_name,action,module,target_type,target_id,old_value,new_value,created_at)
      VALUES ('archive-excluded','archive-excluded','10700000-0000-4000-8000-000000000001','Synthetic','UPDATE','orders','order','synthetic-old-order',
        '{"note":"Original archived log"}','{"note":"Keep the archive unchanged"}',p107_cutoff()-interval '1 day');
      SET session_replication_role=origin;`);
    const original=await scalar(db,"SELECT to_jsonb(t) AS value FROM activity_logs_archive_pre_20260804 t WHERE id='archive-excluded'");
    await asActor(db);await scalar(db,"SELECT rpc_set_maintenance_mode(true,'Synthetic archive exclusion') AS value");
    const preview=await scalar(db,'SELECT rpc_preview_monthly_retention(false) AS value');
    assert.equal(preview.include_archive,false);assert.equal(preview.can_prepare,true);
    const prepared=await scalar(db,'SELECT rpc_prepare_monthly_retention($1,false) AS value',[randomUUID()]);
    const payload=JSON.parse(prepared.backup_text);
    assert.equal(Object.hasOwn(payload.tables,'activity_logs_archive_pre_20260804'),false);
    assert.equal(Object.hasOwn(payload.columns,'activity_logs_archive_pre_20260804'),false);
    assert.ok(Array.isArray(payload.tables.audit_logs),'Current application audit data remains recoverable');
    assert.equal(createHash('sha256').update(prepared.backup_text).digest('hex'),prepared.backup_sha256);
    const completed=await scalar(db,'SELECT rpc_execute_monthly_retention($1,$2,$3) AS value',
      [prepared.job_id,prepared.backup_sha256,retentionConfirmation(prepared.preview.cutoff)]);
    assert.equal(completed.verified,true);
    await db.exec('RESET ROLE');
    assert.deepEqual(await scalar(db,"SELECT to_jsonb(t) AS value FROM activity_logs_archive_pre_20260804 t WHERE id='archive-excluded'"),original);
    assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM activity_logs_archive_pre_20260804')),1);
  } finally {await db.close();}
});
