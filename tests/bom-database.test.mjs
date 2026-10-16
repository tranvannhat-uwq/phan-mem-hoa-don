import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db, rawId, semiId, packId, semiVersion, skuVersion;
const admin='92000000-0000-4000-8000-000000000001';
const accounting='92000000-0000-4000-8000-000000000002';
const sale='92000000-0000-4000-8000-000000000003';
const read=name=>readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
async function value(sql,args=[]){return (await db.query(sql,args)).rows[0]?.value;}
async function role(id,dbRole='authenticated'){
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);
  await db.exec(`SET ROLE ${dbRole}`);
}
async function rpc(name,input){return value(`SELECT public.${name}($1::jsonb) AS value`,[JSON.stringify(input)]);}
async function balance(table,column,id){await db.exec('RESET ROLE');return Number(await value(`SELECT quantity AS value FROM public.${table} WHERE ${column}=$1`,[id]));}

before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
  await db.exec((await read('0001_core_schema_and_migration_registry.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  const auth=await read('0002_auth_profiles_and_rls.sql');
  await db.exec(auth.match(/CREATE TABLE IF NOT EXISTS public\.profiles[\s\S]*?\n\);/)[0]);
  await db.exec(auth.match(/CREATE OR REPLACE FUNCTION public\.require_authenticated_profile\(\)[\s\S]*?\$\$;/)[0]);
  await db.exec(`INSERT INTO public.profiles(id,auth_user_id,username,display_name,role) VALUES
    ('admin','${admin}','admin','Admin','admin'),
    ('accounting','${accounting}','accounting','Accounting','accounting'),
    ('sale','${sale}','sale','Sale','sale');
    INSERT INTO public.products(id,code,brand,name,package_type) VALUES('sku-a','A-LON','TEST','Sơn A','Lon');`);
  for(const name of ['0088_integrated_inventory_free_budget.sql','0089_inventory_sync_toggle.sql','0091_inventory_page_limit.sql','0092_bom_two_stage.sql'])
    try{await db.exec(await read(name));}catch(error){throw new Error(`${name}: ${error.message}\n${error.where||''}`);}
});
after(async()=>{if(db)await db.close();});

test('BOM tables and RPCs enforce roles',async()=>{
  await role('', 'anon');
  await assert.rejects(value('SELECT public.rpc_bom_window() AS value'),/permission denied/);
  await role(sale);
  await assert.rejects(value('SELECT public.rpc_bom_window() AS value'),/Chỉ Admin/);
  await role(accounting);
  await assert.rejects(rpc('rpc_bom_save_item',{code:'X',name:'X',kind:'raw',baseUnit:'kg',purchaseUnit:'kg',purchaseToBase:1}),/Chỉ Admin/);
  await assert.rejects(db.query('SELECT * FROM public.bom_items'),/permission denied/);
});

test('configure two stages, receive units and publish immutable versions',async()=>{
  await role(admin);
  rawId=(await rpc('rpc_bom_save_item',{code:'RAW',name:'Nguyên liệu',kind:'raw',baseUnit:'kg',purchaseUnit:'bao',purchaseToBase:25})).id;
  semiId=(await rpc('rpc_bom_save_item',{code:'SEMI',name:'Bán thành phẩm',kind:'semi',baseUnit:'kg',purchaseUnit:'kg',purchaseToBase:1})).id;
  packId=(await rpc('rpc_bom_save_item',{code:'PACK',name:'Bao bì',kind:'packaging',baseUnit:'cái',purchaseUnit:'thùng',purchaseToBase:100})).id;
  const first=await rpc('rpc_bom_save_draft',{outputKind:'semi',outputId:semiId,outputQuantity:10,lines:[{itemId:rawId,quantity:12}]});
  semiVersion=first.id;
  await value('SELECT public.rpc_bom_publish($1::uuid) AS value',[semiVersion]);
  await assert.rejects(value('SELECT public.rpc_bom_publish($1::uuid) AS value',[semiVersion]),/phiên bản nháp/);
  const second=await rpc('rpc_bom_save_draft',{outputKind:'sku',outputId:'sku-a',outputQuantity:5,lines:[{itemId:semiId,quantity:5},{itemId:packId,quantity:5}]});
  skuVersion=second.id;
  await value('SELECT public.rpc_bom_publish($1::uuid) AS value',[skuVersion]);
  const detail=await value('SELECT public.rpc_bom_window($1::jsonb) AS value',[JSON.stringify({mode:'detail',id:skuVersion})]);
  assert.equal(detail.rows[0].lines.length,2);
  await role(accounting);
  await rpc('rpc_bom_post_item',{requestKey:randomUUID(),kind:'receipt',itemId:rawId,quantity:2,unit:'purchase'});
  await rpc('rpc_bom_post_item',{requestKey:randomUUID(),kind:'receipt',itemId:packId,quantity:1,unit:'purchase'});
  assert.equal(await balance('bom_item_balances','item_id',rawId),50);
  assert.equal(await balance('bom_item_balances','item_id',packId),100);
});

test('production is atomic, idempotent and conserves stock',async()=>{
  await role(accounting);
  const key=randomUUID();
  const first=await rpc('rpc_bom_run',{requestKey:key,versionId:semiVersion,quantity:10});
  assert.equal(first.replayed,false);
  const repeat=await rpc('rpc_bom_run',{requestKey:key,versionId:semiVersion,quantity:10});
  assert.equal(repeat.replayed,true);assert.equal(repeat.id,first.id);
  const runDetail=await value('SELECT public.rpc_bom_window($1::jsonb) AS value',
    [JSON.stringify({mode:'runDetail',id:first.id,limit:1})]);
  assert.equal(Number(runDetail.rows[0].snapshot.lines[0].quantity),12);
  assert.equal(await balance('bom_item_balances','item_id',rawId),38);
  assert.equal(await balance('bom_item_balances','item_id',semiId),10);
  await role(accounting);
  await assert.rejects(rpc('rpc_bom_run',{requestKey:randomUUID(),versionId:skuVersion,quantity:15}),/không đủ tồn/);
  assert.equal(await balance('bom_item_balances','item_id',semiId),10);
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.bom_runs')),1);
  await role(accounting);
  await rpc('rpc_bom_run',{requestKey:randomUUID(),versionId:skuVersion,quantity:5});
  assert.equal(await balance('bom_item_balances','item_id',semiId),5);
  assert.equal(await balance('bom_item_balances','item_id',packId),95);
  assert.equal(await balance('inventory_balances','product_id','sku-a'),5);
  assert.equal(Number(await value("SELECT count(*) AS value FROM public.inventory_movements WHERE kind='production' AND production_run_id IS NOT NULL")),1);
});

test('sale and return move only the finished SKU after production',async()=>{
  await role(admin);
  await rpc('rpc_inventory_post',{requestKey:randomUUID(),kind:'count',note:'Opening synthetic SKU',
    items:[{productId:'sku-a',quantity:5,expectedQuantity:5}]});
  await value('SELECT public.rpc_inventory_activate(true) AS value');
  await db.exec('RESET ROLE');
  await db.exec(`BEGIN;
    INSERT INTO public.orders(id,customer_name,status,confirmed_at) VALUES('bom-sale','Synthetic','settled',now());
    INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity)
      VALUES('bom-sale-line','bom-sale','sku-a','sku-a',2);
    COMMIT;`);
  assert.equal(await balance('inventory_balances','product_id','sku-a'),3);
  assert.equal(await balance('bom_item_balances','item_id',rawId),38);
  await db.exec("UPDATE public.order_items SET returned_quantity=1 WHERE id='bom-sale-line'");
  assert.equal(await balance('inventory_balances','product_id','sku-a'),4);
  await db.exec("UPDATE public.orders SET status='cancelled' WHERE id='bom-sale'");
  assert.equal(await balance('inventory_balances','product_id','sku-a'),5);
  assert.equal(await balance('bom_item_balances','item_id',semiId),5);
});

test('a new published recipe leaves prior production snapshots unchanged',async()=>{
  await role(admin);
  const next=await rpc('rpc_bom_save_draft',{outputKind:'semi',outputId:semiId,outputQuantity:10,lines:[{itemId:rawId,quantity:13}]});
  await value('SELECT public.rpc_bom_publish($1::uuid) AS value',[next.id]);
  await assert.rejects(rpc('rpc_bom_run',{requestKey:randomUUID(),versionId:semiVersion,quantity:10}),/thay thế/);
  await db.exec('RESET ROLE');
  const original=await value('SELECT snapshot AS value FROM public.bom_runs WHERE version_id=$1::uuid',[semiVersion]);
  assert.equal(Number(original.lines[0].quantity),12);
  assert.equal(Number(await value('SELECT quantity AS value FROM public.bom_lines WHERE version_id=$1::uuid',[semiVersion])),12);
});
