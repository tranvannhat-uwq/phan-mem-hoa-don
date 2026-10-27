import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar} from './helpers/retention-db.mjs';

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
