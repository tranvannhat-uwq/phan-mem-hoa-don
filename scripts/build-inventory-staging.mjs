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
names.push('0095_product_name_token_search.sql');
const parts=[`-- EMPTY SUPABASE STAGING PROJECT ONLY. Never paste into production.
-- This guard prevents bootstrap against an existing billing database.
DO $$ BEGIN
  IF to_regclass('public.orders') IS NOT NULL OR to_regclass('public.profiles') IS NOT NULL THEN
    RAISE EXCEPTION 'Bootstrap stopped: use an empty staging project. Existing databases need a reviewed upgrade.';
  END IF;
END $$;\n`];
for(const name of names)parts.push(`-- Source: migrations/${name}\n${(await readFile(resolve(root,'migrations',name),'utf8')).replace(/^\uFEFF/,'')}`);
await mkdir(resolve(root,'outputs'),{recursive:true});
await writeFile(output,parts.join('\n\n'));
console.log(`Staging bundle: ${output} (${names.length} migrations). Separate rollback-only test: migrations/tests/0088_inventory_financial_integration.sql`);
