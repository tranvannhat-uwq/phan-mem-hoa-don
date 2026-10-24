import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('rollback-only 0092 staging fixture passes against the complete billing schema',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, instance_id uuid, aud text, role text, email text,
        encrypted_password text, raw_app_meta_data jsonb DEFAULT '{}', raw_user_meta_data jsonb DEFAULT '{}',
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated,anon;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
    const dir=new URL('../migrations/',import.meta.url);
    const files=(await readdir(dir)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=84).sort();
    files.push('0088_integrated_inventory_free_budget.sql','0089_inventory_sync_toggle.sql',
      '0090_bounded_customer_product_lookup.sql','0091_inventory_page_limit.sql','0092_bom_two_stage.sql',
      '0093_bom_item_unit_edit.sql','0094_repair_bom_item_unit_edit.sql','0097_invoice_product_brand_search.sql',
      '0101_product_packaging_items.sql','0102_purchase_vat.sql','0103_sales_returns_credit_balance.sql','0105_purchase_existing_product_shells.sql');
    for(const file of files){
      let sql=(await readFile(new URL(file,dir),'utf8')).replace(/^\uFEFF/,'');
      if(file.startsWith('0001'))sql=sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
      try{await db.exec(sql);}catch(error){throw new Error(`${file}: ${error.message}\n${error.where||''}`);}
    }
    const results=await db.exec(await readFile(new URL('tests/0092_bom_two_stage_integration.sql',dir),'utf8'));
    assert.ok(results.some(result=>result.rows?.some(row=>String(row.result||'').includes('invariants passed'))));
    assert.equal((await db.query('SELECT count(*) AS n FROM public.bom_items')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*) AS n FROM public.bom_runs')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*) AS n FROM auth.users')).rows[0].n,0);
  }finally{await db.close();}
});
