import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const root=new URL('../',import.meta.url);
export const databaseAuditFixFiles=[
  '0115_customer_baseline_blank_field_safety.sql',
  '0116_cashbook_amendment_unicode_and_trigger_acl.sql',
  '0117_employee_report_pagination_retention_merge.sql'
];
// These values are compared inside the transaction and never returned as raw
// customer/supplier rows. The installation contains no business data writes.
const fingerprint=`SELECT jsonb_build_object(
  'customers',(SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,debt,total_transaction,total_return,net_revenue,last_order_at,created_at,imported_debt_baseline,imported_total_transaction_baseline,imported_total_return_baseline,imported_net_revenue_baseline) ORDER BY id),'[]')::text) FROM public.customers),
  'suppliers',(SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,debt,total_purchase,total_paid,opening_debt) ORDER BY id),'[]')::text) FROM public.suppliers),
  'orders',(SELECT count(*) FROM public.orders),
  'purchases',(SELECT count(*) FROM public.purchases),
  'returns',(SELECT count(*) FROM public.sales_returns),
  'cashbook',(SELECT jsonb_build_array(count(*),COALESCE(sum(value),0)) FROM public.cashbook_transactions),
  'customer_ledger',(SELECT jsonb_build_array(count(*),COALESCE(sum(debt_change),0)) FROM public.customer_debt_transactions),
  'supplier_ledger',(SELECT jsonb_build_array(count(*),COALESCE(sum(amount_change),0)) FROM public.supplier_debt_transactions),
  'retention',(SELECT to_jsonb(c) FROM public.retention_control c WHERE id),
  'retention_jobs',(SELECT count(*) FROM public.retention_jobs)
) AS value`;

export async function buildDatabaseAuditFixes({dryRun=true}={}){
  const parts=[`-- Database audit fixes 0115-0117: ${dryRun?'COMPATIBILITY REHEARSAL; every change is rolled back':'ATOMIC INSTALLATION; no business deletion or recalculation'}.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
-- Serialize against a monthly purge and another copy of this installation.
SELECT pg_advisory_xact_lock_shared(hashtextextended('billing-monthly-retention',0));
SELECT pg_advisory_xact_lock(hashtextextended('billing-audit-fixes-0115-0117',0));
CREATE TEMP TABLE audit_fix_before ON COMMIT DROP AS ${fingerprint};`];
  for(const name of databaseAuditFixFiles){
    const body=(await readFile(new URL('migrations/'+name,root),'utf8')).replace(/^\uFEFF/,'').replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
    parts.push(`-- ${name}\n${body}`);
  }
  parts.push(`CREATE TEMP TABLE audit_fix_after ON COMMIT DROP AS ${fingerprint};
DO $check$ BEGIN
  IF (SELECT value FROM audit_fix_before) IS DISTINCT FROM (SELECT value FROM audit_fix_after) THEN
    RAISE EXCEPTION 'Audit fix installation changed a financial snapshot; transaction rolled back';
  END IF;
END $check$;
SELECT jsonb_build_object('mode','${dryRun?'ROLLBACK_COMPATIBILITY':'INSTALLED'}','checked_at',now(),
  'financial_snapshot_unchanged',(SELECT b.value=a.value FROM audit_fix_before b CROSS JOIN audit_fix_after a),
  'versions',(SELECT jsonb_agg(version ORDER BY version) FROM public.schema_migrations WHERE version IN('0115','0116','0117')),
  'function_hashes',(SELECT jsonb_object_agg(p.oid::regprocedure::text,md5(replace(p.prosrc,chr(13),''))) FROM pg_proc p WHERE p.oid IN(
    'public.rpc_import_customer_financial_baselines(jsonb)'::regprocedure,
    'public.rpc_amend_cashbook_transaction(text,jsonb)'::regprocedure,
    'public.rpc_get_employee_business_report(jsonb)'::regprocedure)),
  'trigger_api_execute',has_function_privilege('authenticated','public.p84_guard_cancelled_order_debt()','EXECUTE')
) AS database_fix_result;
${dryRun?'ROLLBACK':'COMMIT'};`);
  return parts.join('\n\n');
}

async function main(){
  const output=new URL('outputs/retention-review/',root);await mkdir(output,{recursive:true});
  for(const [name,dryRun] of [['check-database-fixes-0115-0117-rollback.sql',true],['install-database-fixes-0115-0117.sql',false]]){
    const source=await buildDatabaseAuditFixes({dryRun});await writeFile(new URL(name,output),source);
    console.log(`${name}: ${source.length} characters`);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
