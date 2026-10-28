import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildRetentionDatabase, asActor, scalar } from './helpers/retention-db.mjs';

test('retention conflicts return non-retryable PT409 without changing guards, grants or business rows', async () => {
  const db = await buildRetentionDatabase({ maxVersion: 124 });
  const signatures = ['p107_assert_epoch()', 'rpc_execute_monthly_retention(uuid,text,text)',
    'rpc_stage_retention_backup_table(uuid,text)', 'rpc_finish_retention_backup(uuid)'];
  const definitions = async () => (await db.query(`SELECT oid::regprocedure::text AS signature,prosrc,proacl
    FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid`, [signatures.map(s => 'public.' + s)])).rows;
  try {
    const before = await definitions();
    const install = await readFile(new URL('../migrations/0125_non_retryable_retention_conflicts.sql', import.meta.url), 'utf8');
    await db.exec(install);
    const after = await definitions();
    assert.deepEqual(after, before.map(row => ({ ...row, prosrc: row.prosrc.replaceAll("'40001'", "'PT409'") })));
    await db.exec('UPDATE retention_control SET epoch=1 WHERE id');
    await asActor(db, undefined, 0);
    await assert.rejects(scalar(db, "SELECT rpc_get_phase5_dashboard('{}') AS value"),
      error => error.code === 'PT409' && /RETENTION_EPOCH_CHANGED/.test(error.message));
    await asActor(db, undefined, 1);
    await db.exec('BEGIN READ ONLY');
    assert.ok(await scalar(db, "SELECT rpc_get_phase5_dashboard('{}') AS value"));
    await db.exec('ROLLBACK; RESET ROLE');
    assert.equal(Number(await scalar(db, 'SELECT count(*) AS value FROM customers')), 1);
    await db.exec(install);
    assert.deepEqual(await definitions(), after);
  } finally { await db.close(); }
});
