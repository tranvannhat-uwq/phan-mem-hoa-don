import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db; let orderId;
const admin = '88000000-0000-4000-8000-000000000001';
const sale = '88000000-0000-4000-8000-000000000002';
async function value(sql, args=[]) { return (await db.query(sql,args)).rows[0].value; }
async function role(id) { await db.exec('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec('SET ROLE authenticated'); }
async function snapshot() {
  await db.exec('RESET ROLE');
  return (await db.query(`SELECT
    (SELECT quantity FROM public.inventory_balances WHERE product_id='fin-sku') AS stock,
    (SELECT debt FROM public.customers WHERE id='fin-customer') AS debt,
    (SELECT count(*) FROM public.orders) AS orders,
    (SELECT count(*) FROM public.customer_debt_transactions) AS debt_entries,
    (SELECT count(*) FROM public.inventory_movements) AS movements`)).rows[0];
}
before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, instance_id uuid, aud text, role text, email text,
      encrypted_password text, raw_app_meta_data jsonb DEFAULT '{}', raw_user_meta_data jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
  const directory=new URL('../migrations/',import.meta.url);
  const files=(await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=84).sort();
  for(const file of files){
    let source=(await readFile(new URL(file,directory),'utf8')).replace(/^\uFEFF/,'');
    if(file.startsWith('0001'))source=source.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
    try{await db.exec(source);}catch(error){throw new Error(`${file}: ${error.message}`);}
  }
  await db.exec(await readFile(new URL('0088_integrated_inventory_free_budget.sql',directory),'utf8'));
  await db.exec(await readFile(new URL('0089_inventory_sync_toggle.sql',directory),'utf8'));
  // Execute the exact cloud staging artifact before other synthetic fixtures.
  // It must succeed and leave no test accounts, products or stock behind.
  let stagingResults;
  try { stagingResults=await db.exec(await readFile(new URL('tests/0088_inventory_financial_integration.sql',directory),'utf8')); }
  catch (error) { throw new Error(`Staging fixture: ${error.message}\n${error.where || ''}`); }
  assert.ok(stagingResults.some(result=>result.rows?.some(row=>String(row.result||'').includes('invariants passed'))));
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.inventory_balances')),0);
  assert.equal(Number(await value('SELECT count(*) AS value FROM auth.users')),0);
  await db.exec(`INSERT INTO auth.users(id,email) VALUES ('${admin}','inventory-admin@test.invalid'),('${sale}','inventory-sale@test.invalid');
    UPDATE public.profiles SET role='admin' WHERE auth_user_id='${admin}';
    INSERT INTO public.companies(id,code,name) VALUES ('ABS_NORTH','ABS_NORTH','Synthetic company') ON CONFLICT DO NOTHING;
    INSERT INTO public.brands(name,id,company_id) VALUES ('FIN','fin-brand','ABS_NORTH');
    INSERT INTO public.products(id,code,variant_code,name,brand,brand_id,packaging_name,package_type,weight_or_volume,unit_name)
      VALUES ('fin-sku','FIN-LON','FIN-LON','Synthetic paint','FIN','fin-brand','Lon','Lon',1,'kg');
    INSERT INTO public.customers(id,code,name,managed_by,status) VALUES ('fin-customer','FIN-C','Synthetic customer','inventory-sale@test.invalid','active');
    INSERT INTO public.pricelists(id,name,type,price_list_type,is_active,is_available_for_sales)
      VALUES ('fin-prices','Synthetic prices','general','general',true,true);
    INSERT INTO public.price_list_items(id,price_list_id,product_id,variant_id,price)
      VALUES ('fin-price','fin-prices','fin-sku','fin-sku',100000);`);
  await role(admin);
  await value('SELECT public.rpc_inventory_post($1::jsonb) AS value',[JSON.stringify({requestKey:randomUUID(),kind:'count',note:'Opening synthetic stock',items:[{productId:'fin-sku',quantity:100,expectedQuantity:0}]})]);
  await value('SELECT public.rpc_inventory_activate(true) AS value');
});
after(async()=>{if(db)await db.close();});

test('actual Sale checkout updates the debt ledger and inventory in one commit',async()=>{
  await role(sale);
  const response=await value('SELECT public.rpc_confirm_order($1::jsonb) AS value',[JSON.stringify({
    idempotencyKey:randomUUID(),customerId:'fin-customer',pricelistId:'fin-prices',paidAmount:0,
    items:[{variantId:'fin-sku',quantity:3,discountType:'percent',discountValue:0}]
  })]);
  orderId=response.order.id;
  const current=await snapshot();
  assert.equal(Number(current.stock),97); assert.equal(Number(current.debt),300000);
  assert.equal(Number(current.orders),1);
});
test('actual checkout underflow rolls back financial ledgers and inventory together',async()=>{
  const prior=await snapshot(); await role(sale);
  await assert.rejects(value('SELECT public.rpc_confirm_order($1::jsonb) AS value',[JSON.stringify({
    idempotencyKey:randomUUID(),customerId:'fin-customer',pricelistId:'fin-prices',paidAmount:0,
    items:[{variantId:'fin-sku',quantity:1000,discountType:'percent',discountValue:0}]
  })]),/không đủ tồn/);
  assert.deepEqual(await snapshot(),prior);
});
test('actual amendment replaces canonical lines and applies only the stock/debt delta',async()=>{
  await role(admin);
  await value('SELECT public.rpc_amend_order($1,$2::jsonb,$3) AS value',[orderId,JSON.stringify({
    idempotencyKey:randomUUID(),customerId:'fin-customer',customerName:'Synthetic customer',pricelistId:'fin-prices',
    items:[{variantId:'fin-sku',quantity:5,discountType:'percent',discountValue:0}]
  }),'Synthetic amendment']);
  const current=await snapshot(); assert.equal(Number(current.stock),95);assert.equal(Number(current.debt),500000);
});
test('actual return and return cancellation preserve inventory and financial invariants',async()=>{
  await db.exec('RESET ROLE');
  const itemId=await value('SELECT id AS value FROM public.order_items WHERE order_id=$1',[orderId]);
  await role(admin);
  const response=await value('SELECT public.rpc_record_sales_return($1::jsonb) AS value',[JSON.stringify({
    orderId,idempotencyKey:randomUUID(),reason:'Synthetic return',paymentMethod:'cash',items:[{saleItemId:itemId,quantity:2,deductionPercent:0}]
  })]);
  let current=await snapshot();assert.equal(Number(current.stock),97);assert.equal(Number(current.debt),300000);
  await db.exec('RESET ROLE');
  const returnId=await value('SELECT id AS value FROM public.sales_returns WHERE order_id=$1',[orderId]);
  await role(admin);
  await value('SELECT public.rpc_cancel_sales_return($1,$2) AS value',[returnId,'Synthetic reversal']);
  current=await snapshot();assert.equal(Number(current.stock),95);assert.equal(Number(current.debt),500000);
});
test('actual cancellation restores stock and reverses debt once',async()=>{
  await role(admin);
  await value('SELECT public.rpc_cancel_order($1,$2) AS value',[orderId,'Synthetic inventory test']);
  const current=await snapshot();
  assert.equal(Number(current.stock),100);assert.equal(Number(current.debt),0);
});

test('paused Sale checkout commits debt, queues stock, and resume reconciles without changing debt',async()=>{
  await role(admin);await value('SELECT public.rpc_inventory_set_sync(false) AS value');
  await role(sale);
  const response=await value('SELECT public.rpc_confirm_order($1::jsonb) AS value',[JSON.stringify({
    idempotencyKey:randomUUID(),customerId:'fin-customer',pricelistId:'fin-prices',paidAmount:0,
    items:[{variantId:'fin-sku',quantity:3,discountType:'percent',discountValue:0}]
  })]);
  let current=await snapshot();assert.equal(Number(current.stock),100);assert.equal(Number(current.debt),300000);
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.inventory_pending_orders')),1);
  await role(admin);await value('SELECT public.rpc_inventory_set_sync(true) AS value');
  current=await snapshot();assert.equal(Number(current.stock),97);assert.equal(Number(current.debt),300000);
  await role(admin);await value('SELECT public.rpc_inventory_set_sync(false) AS value');
  await value('SELECT public.rpc_cancel_order($1,$2) AS value',[response.order.id,'Synthetic paused cancellation']);
  current=await snapshot();assert.equal(Number(current.stock),97);assert.equal(Number(current.debt),0);
  await role(admin);await value('SELECT public.rpc_inventory_set_sync(true) AS value');
  current=await snapshot();assert.equal(Number(current.stock),100);assert.equal(Number(current.debt),0);
});
