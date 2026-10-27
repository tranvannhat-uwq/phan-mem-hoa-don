import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root=new URL('../',import.meta.url);
export async function buildRetentionUpgrade({dryRun=true}={}) {
  const files=['0106_independent_customer_returns.sql','0107_monthly_data_retention.sql','0108_retention_reports_and_return_compatibility.sql','0109_retention_read_only_rpc_locks.sql','0110_retention_backup_and_lookup_bounds.sql','0111_private_sales_return_response.sql','0112_retention_legacy_report_patch_guards.sql','0113_retention_cross_period_commission_guard.sql'];
  const parts=[`-- ${dryRun?'COMPATIBILITY CHECK: all changes rolled back':'ADDITIVE INSTALLATION: no historical business deletion is executed'}.
-- Reviewable source: migrations/0106 through 0113. No purge RPC is called here.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM public.schema_migrations WHERE version IN('0106','0107','0108','0109','0110','0111','0112','0113')) THEN
  RAISE EXCEPTION 'Retention migration already present; review version state before continuing';
END IF; END $guard$;`];
  for(const file of files) {
    const source=(await readFile(new URL(`migrations/${file}`,root),'utf8')).replace(/^\uFEFF/,'').replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
    parts.push(`-- ${file}\n${source}`);
  }
  parts.push(`SELECT jsonb_build_object('mode','${dryRun?'ROLLBACK_COMPATIBILITY':'INSTALLED_NO_PURGE'}',
    'checked_at',now(),'preview',public.p107_preview(true),
    'versions',(SELECT jsonb_agg(version ORDER BY version) FROM schema_migrations WHERE version IN('0106','0107','0108','0109','0110','0111','0112','0113')),
    'customer_count',(SELECT count(*) FROM customers),'order_count',(SELECT count(*) FROM orders),
    'epoch',(SELECT epoch FROM retention_control WHERE id)) AS retention_result;
${dryRun?'ROLLBACK':'COMMIT'};`);
  return parts.join('\n\n');
}
async function main() {
  await mkdir(new URL('outputs/retention-review/',root),{recursive:true});
  for(const [name,dryRun] of [['production-compatibility-rollback.sql',true],['install-retention-0106-0113.sql',false]]) {
    const source=await buildRetentionUpgrade({dryRun});
    await writeFile(new URL(`outputs/retention-review/${name}`,root),source);
    console.log(`${name}: ${source.length} characters; ${dryRun?'rollback check':'installation only, no purge'}`);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
