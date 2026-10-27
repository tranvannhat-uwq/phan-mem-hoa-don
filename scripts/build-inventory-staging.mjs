import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(root,'outputs/inventory-staging-schema.sql');
const names=(await readdir(resolve(root,'migrations'))).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=84).sort();
names.push('0088_integrated_inventory_free_budget.sql');
names.push('0089_inventory_sync_toggle.sql');
names.push('0090_bounded_customer_product_lookup.sql');
names.push('0091_inventory_page_limit.sql');
names.push('0092_bom_two_stage.sql');
names.push('0093_bom_item_unit_edit.sql');
names.push('0094_repair_bom_item_unit_edit.sql');
names.push('0095_product_name_token_search.sql');
names.push('0096_invoice_product_packaging_fallback.sql');
names.push('0097_invoice_product_brand_search.sql');
names.push('0098_revert_latest_order_amendment.sql');
names.push('0099_customer_debt_order_event_snapshot.sql');
names.push('0100_customer_debt_history_correction.sql');
names.push('0101_product_packaging_items.sql');
names.push('0102_purchase_vat.sql');
names.push('0103_sales_returns_credit_balance.sql');
names.push('0105_purchase_existing_product_shells.sql');
names.push('0106_independent_customer_returns.sql');
names.push('0107_monthly_data_retention.sql');
names.push('0108_retention_reports_and_return_compatibility.sql');
names.push('0109_retention_read_only_rpc_locks.sql');
names.push('0110_retention_backup_and_lookup_bounds.sql');
names.push('0111_private_sales_return_response.sql');
names.push('0112_retention_legacy_report_patch_guards.sql');
names.push('0113_retention_cross_period_commission_guard.sql');
const parts=[`-- EMPTY SUPABASE STAGING PROJECT ONLY. Never paste into production.
-- This guard prevents bootstrap against an existing billing database.
DO $$ BEGIN
  IF to_regclass('public.orders') IS NOT NULL OR to_regclass('public.profiles') IS NOT NULL THEN
    RAISE EXCEPTION 'Bootstrap stopped: use an empty staging project. Existing databases need a reviewed upgrade.';
  END IF;
END $$;\n`];
for(const name of names) {
  let source=(await readFile(resolve(root,'migrations',name),'utf8')).replace(/^\uFEFF/,'');
  if(name.startsWith('0100')) source=source.slice(0,source.indexOf('-- This repair is deliberately'))+
    "INSERT INTO public.schema_migrations(version,description) VALUES('0100','History correction schema; production incident repair omitted on empty staging'); COMMIT;";
  parts.push(`-- Source: migrations/${name}\n${source}`);
}
await mkdir(resolve(root,'outputs'),{recursive:true});
await writeFile(output,parts.join('\n\n'));
console.log(`Staging bundle: ${output} (${names.length} migrations). Separate rollback-only test: migrations/tests/0088_inventory_financial_integration.sql`);
