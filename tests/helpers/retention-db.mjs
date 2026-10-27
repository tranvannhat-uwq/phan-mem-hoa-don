import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

export const adminId='10700000-0000-4000-8000-000000000001';
export const accountingId='10700000-0000-4000-8000-000000000002';
export const saleId='10700000-0000-4000-8000-000000000003';
export async function buildRetentionDatabase({maxVersion=Infinity}={}) {
  const db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,instance_id uuid,aud text,role text,email text,
      encrypted_password text,raw_app_meta_data jsonb DEFAULT '{}',raw_user_meta_data jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
  const dir=new URL('../../migrations/',import.meta.url);
  for(const name of (await readdir(dir)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort()) {
    const version=Number(name.slice(0,4));
    if(version>maxVersion)continue;
    if([85,86,87,104].includes(version))continue; // separate HTTP integration and incident-only repair
    let source=(await readFile(new URL(name,dir),'utf8')).replace(/^\uFEFF/,'');
    if(version===1)source=source.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
    if(version===100)source=source.slice(0,source.indexOf('-- This repair is deliberately'))+
      "INSERT INTO public.schema_migrations(version,description) VALUES ('0100','Synthetic schema only'); COMMIT;";
    try { await db.exec(source); } catch(error) { await db.close(); throw new Error(`${name}: ${error.message}\n${error.where||''}`); }
  }
  await db.exec(`CREATE TABLE public.inventory_sync_outbox(order_id text PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
    version bigint NOT NULL DEFAULT 1,pending boolean NOT NULL DEFAULT true,attempts integer DEFAULT 0,
    last_attempt_at timestamptz,last_error text,queued_at timestamptz DEFAULT now(),synced_at timestamptz);
    CREATE TABLE public.activity_logs_archive_pre_20260804 (LIKE public.activity_logs INCLUDING ALL);
    ALTER TABLE public.activity_logs_archive_pre_20260804 ENABLE ROW LEVEL SECURITY;
    INSERT INTO auth.users(id,email) VALUES
      ('${adminId}','retention-admin@test.invalid'),('${accountingId}','retention-accounting@test.invalid'),('${saleId}','retention-sale@test.invalid');
    UPDATE public.profiles SET role='admin' WHERE auth_user_id='${adminId}';
    UPDATE public.profiles SET role='accounting' WHERE auth_user_id='${accountingId}';
    INSERT INTO public.companies(id,code,name) VALUES ('ABS_NORTH','ABS_NORTH','Synthetic company') ON CONFLICT DO NOTHING;
    INSERT INTO public.brands(name,id,company_id) VALUES ('RETENTION','retention-brand','ABS_NORTH');
    INSERT INTO public.products(id,code,variant_code,name,brand,brand_id,packaging_name,package_type,is_active,is_legacy)
      VALUES ('retention-sku','RET-SKU','RET-SKU','Synthetic sealed product','RETENTION','retention-brand','Thùng','Thùng',true,false);
    INSERT INTO public.customers(id,code,name,managed_by,status,phone,notes)
      VALUES ('retention-customer','RET-C','Synthetic customer','retention-sale@test.invalid','active','0000000000','Preserve this profile exactly');
    INSERT INTO public.pricelists(id,name,type,price_list_type,is_active,is_available_for_sales)
      VALUES ('retention-prices','Synthetic prices','general','general',true,true);
    INSERT INTO public.price_list_items(id,price_list_id,product_id,variant_id,price)
      VALUES ('retention-price','retention-prices','retention-sku','retention-sku',100);`);
  return db;
}
export async function asActor(db,id=adminId,epoch=0) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",
    [id,JSON.stringify({'x-retention-epoch':String(epoch)})]);
  await db.exec('SET ROLE authenticated');
}
export async function scalar(db,sql,args=[]) {return (await db.query(sql,args)).rows[0].value;}
