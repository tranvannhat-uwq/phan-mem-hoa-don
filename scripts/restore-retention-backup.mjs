// Offline helper. Never connects to a database and never restores production.
// Run with Node 20+ and --experimental-default-type=module on this repository.
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {decryptRetentionBackup} from '../js/services/retention-backup.js';

const allowedTables=new Set(['companies','brands','product_groups','payroll_product_groups','products','profiles',
  'pricelists','price_list_items','customers','suppliers','orders','draft_orders','order_items','sales_returns','sales_return_items',
  'cashbook_transactions','payments','customer_debt_transactions','order_amendments','customer_debt_amendment_voids',
  'customer_debt_history_suppressions','purchases','purchase_items','purchase_payments','supplier_debt_transactions',
  'commission_transactions','payroll_periods','payroll_entries','payroll_adjustments','starting_balances','inventory_control',
  'inventory_balances','inventory_documents','inventory_movements','inventory_order_positions','inventory_pending_orders',
  'inventory_sync_outbox','bom_items','bom_item_balances','bom_item_documents','bom_versions','bom_lines','bom_runs','bom_item_movements',
  'audit_logs','activity_logs','retention_control','retention_customer_balances','retention_customer_company_balances','retention_supplier_balances',
  'retention_inventory_balances','retention_retired_requests','dealer_support_control','dealer_support_history','activity_logs_archive_pre_20260804']);
const seedTables=new Set(['profiles','companies','retention_control','inventory_control','dealer_support_control']);
const ident=value=>{if(!/^[a-z_][a-z0-9_]*$/.test(value))throw new Error('Unsupported SQL identifier');return '"'+value+'"';};
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";

export function recoverySummary(payload) {
  return {format:payload.format,job_id:payload.job_id,created_at:payload.created_at,cutoff:payload.cutoff,
    epoch:payload.epoch,tables:Object.fromEntries(Object.entries(payload.tables).map(([name,rows])=>[name,rows.length])),
    warning:'Application data only. Requires matching schema and existing Auth identities. Restore to isolated staging only.'};
}
export function buildStagingRecoverySql(payload) {
  if(payload.format!=='soviet-retention-recovery-v1')throw new Error('Unsupported recovery format');
  const names=Object.keys(payload.tables);
  for(const name of names) {
    if(!allowedTables.has(name)||!Array.isArray(payload.tables[name])||!Array.isArray(payload.columns[name]))throw new Error(`Unsupported table: ${name}`);
    ident(name);payload.columns[name].forEach(ident);
  }
  const parts=[`-- DECRYPTED PERSONAL/FINANCIAL DATA: store securely and remove this temporary SQL after rehearsal.
-- ISOLATED, EMPTY STAGING ONLY. Install schema 0106-0114 and matching Auth identities first.
-- No connection is made by the exporter. This script refuses existing business/catalog data.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL standard_conforming_strings=on;
DO $guard$ BEGIN
  IF current_setting('app.retention_restore_target',true) IS DISTINCT FROM 'ISOLATED_EMPTY_STAGING' THEN
    RAISE EXCEPTION 'Set app.retention_restore_target=ISOLATED_EMPTY_STAGING on an isolated empty staging connection first';
  END IF;
  IF (SELECT count(*) FROM public.schema_migrations WHERE version IN('0106','0107','0108','0109','0110','0111','0112','0113','0114'))<>9 THEN
    RAISE EXCEPTION 'Matching retention schema is required';
  END IF;
END $guard$;`];
  for(const name of names) {
    if(!seedTables.has(name))parts.push(`DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM public.${ident(name)}) THEN RAISE EXCEPTION 'Restore refused: ${name} must be empty'; END IF; END $guard$;`);
    parts.push(`DO $guard$ BEGIN IF (SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name=${literal(name)}) IS DISTINCT FROM ${literal(JSON.stringify(payload.columns[name]))}::jsonb THEN RAISE EXCEPTION 'Schema columns differ: ${name}'; END IF; END $guard$;`);
  }
  const authIds=(payload.tables.profiles||[]).map(row=>row.auth_user_id).filter(Boolean);
  parts.push(`DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(${literal(JSON.stringify(authIds))}::jsonb) required(id) WHERE NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id::text=required.id)) THEN RAISE EXCEPTION 'Required Auth identities are missing'; END IF; END $guard$;`);
  // Owner-only replica mode resolves non-deferrable circular legacy FKs while
  // restoring an empty staging schema. Every FK is explicitly checked below.
  parts.push('SET LOCAL session_replication_role=replica;');
  for(const name of names.filter(name=>seedTables.has(name)).reverse())parts.push(`DELETE FROM public.${ident(name)};`);
  for(const name of names) {
    const columns=payload.columns[name].map(ident).join(',');
    if(payload.tables[name].length)parts.push(`INSERT INTO public.${ident(name)}(${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_recordset(NULL::public.${ident(name)},${literal(JSON.stringify(payload.tables[name]))}::jsonb);`);
  }
  parts.push(`SET LOCAL session_replication_role=origin;
DO $validate$
DECLARE fk record; pair record; joins text; nonnulls text; anynull text; anynonnull text; parent_key text; invalid boolean;
BEGIN
  FOR fk IN SELECT * FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace LOOP
    joins:='';nonnulls:='';anynull:='';anynonnull:='';parent_key:=NULL;
    FOR pair IN SELECT child.attname AS child_col,parent.attname AS parent_col
      FROM unnest(fk.conkey,fk.confkey) keys(child_num,parent_num)
      JOIN pg_attribute child ON child.attrelid=fk.conrelid AND child.attnum=keys.child_num
      JOIN pg_attribute parent ON parent.attrelid=fk.confrelid AND parent.attnum=keys.parent_num LOOP
      joins:=concat_ws(' AND ',NULLIF(joins,''),format('c.%I=p.%I',pair.child_col,pair.parent_col));
      nonnulls:=concat_ws(' AND ',NULLIF(nonnulls,''),format('c.%I IS NOT NULL',pair.child_col));
      anynull:=concat_ws(' OR ',NULLIF(anynull,''),format('c.%I IS NULL',pair.child_col));
      anynonnull:=concat_ws(' OR ',NULLIF(anynonnull,''),format('c.%I IS NOT NULL',pair.child_col));
      parent_key:=pair.parent_col;
    END LOOP;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s c LEFT JOIN %s p ON %s WHERE (%s) AND p.%I IS NULL)',fk.conrelid::regclass,fk.confrelid::regclass,joins,nonnulls,parent_key) INTO invalid;
    IF invalid THEN RAISE EXCEPTION 'Restored FK failed: %',fk.conname; END IF;
    IF fk.confmatchtype='f' THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s c WHERE (%s) AND (%s))',fk.conrelid::regclass,anynull,anynonnull) INTO invalid;
      IF invalid THEN RAISE EXCEPTION 'Restored MATCH FULL FK failed: %',fk.conname; END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM customers c CROSS JOIN LATERAL p74_customer_debt_ledger_balance(c.id) b
    WHERE b.calculated_balance IS NOT NULL AND round(c.debt) IS DISTINCT FROM b.calculated_balance) THEN
    RAISE EXCEPTION 'Restored customer debt invariant failed';
  END IF;
END $validate$;`);
  for(const [sequence,value] of Object.entries(payload.sequences||{})) {
    ident(sequence); if(!/^\d+$/.test(String(value.last_value)))throw new Error('Invalid sequence');
    parts.push(`SELECT setval(${literal('public.'+sequence)}::regclass,greatest((SELECT last_value FROM public.${ident(sequence)}),${String(value.last_value)}::bigint),true);`);
  }
  parts.push("COMMIT;\nSELECT 'Staging recovery committed. Review data and reapply the required retention cutoff before any production use.' AS result;");
  return parts.join('\n');
}

async function main() {
  const [mode,input,output]=process.argv.slice(2);
  if(!['--inspect','--emit-staging-sql'].includes(mode)||!input||(mode==='--emit-staging-sql'&&!output)) {
    throw new Error('Usage: node --experimental-default-type=module scripts/restore-retention-backup.mjs --inspect FILE | --emit-staging-sql FILE OUTPUT.sql. Supply RETENTION_BACKUP_PASSWORD through the environment.');
  }
  const password=process.env.RETENTION_BACKUP_PASSWORD;
  delete process.env.RETENTION_BACKUP_PASSWORD;
  if(!password)throw new Error('Missing RETENTION_BACKUP_PASSWORD');
  const {payload}=await decryptRetentionBackup(await readFile(input,'utf8'),password);
  if(mode==='--emit-staging-sql')await writeFile(output,buildStagingRecoverySql(payload),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(recoverySummary(payload),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
