import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';
let db;const payload=price=>({id:randomUUID(),code:randomUUID(),name:'Synthetic customer',managedBy:'retention-sale@test.invalid',pricelistId:price,debt:999999});
const create=async data=>scalar(db,'SELECT rpc_create_quick_customer($1::jsonb) AS value',[JSON.stringify(data)]);
const window=async(ids,options={})=>scalar(db,'SELECT rpc_get_customer_order_window($1,$2,$3,$4,$5,$6,$7) AS value',[
 ids,options.start??null,options.end??null,options.status??null,options.dateField??'business',options.limit??500,options.offset??0]);
before(async()=>{
 db=await buildRetentionDatabase({maxVersion:130});
 await asActor(db,saleId);await assert.rejects(create(payload('custom')),/price list is not available/);
 await db.exec('RESET ROLE');await db.exec(await readFile(new URL('../migrations/0131_quick_customer_and_order_filter_fix.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
test('custom quick-create now succeeds for each existing role with zero balances and the correct owner',async()=>{
 for(const actor of [saleId,accountingId,adminId]){
   await asActor(db,actor);const result=await create(payload('custom'));
   assert.equal(result.success,true);assert.equal(result.customer.pricelistId,null);
   assert.equal(result.customer.managedBy,'retention-sale@test.invalid');assert.equal(Number(result.customer.debt),0);
   assert.equal(Number(result.customer.totalTransaction),0);
 }
});
test('real private, inactive and nonexistent lists remain rejected for Sale',async()=>{
 await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
 await db.exec(`INSERT INTO pricelists(id,name,type,price_list_type,is_active,is_available_for_sales) VALUES
  ('denied-private','Synthetic private','dealer_private','dealer_private',true,false),
  ('denied-inactive','Synthetic inactive','general','general',false,true)`);
 await asActor(db,saleId);
 for(const price of ['denied-private','denied-inactive','missing'])await assert.rejects(create(payload(price)),/price list is not available/);
 assert.equal((await create(payload('retention-prices'))).customer.pricelistId,'retention-prices');
 assert.equal((await create(payload('retail'))).customer.pricelistId,'retail');
});
test('new order RPC matches direct SELECT under Admin, Accounting and Sale RLS for >1,500 IDs',async()=>{
 await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
 await db.exec(`INSERT INTO customers(id,code,name,managed_by) VALUES('foreign-customer','FOREIGN','Synthetic foreign customer','another-salesperson');
 INSERT INTO orders(id,customer_id,customer_name,status,order_date,created_at) VALUES
 ('visible-old','retention-customer','Snapshot old','settled','2026-09-02','2026-10-02'),
 ('visible-new','retention-customer','Snapshot new','returned','2026-10-02','2026-10-03'),
 ('visible-cancelled','retention-customer','Snapshot cancelled','cancelled','2026-10-03','2026-10-04'),
 ('visible-legacy','retention-customer','Legacy without business date','settled',NULL,'2026-10-05'),
 ('hidden','foreign-customer','Synthetic hidden snapshot','settled','2026-10-01','2026-10-01');`);
 const ids=['retention-customer','foreign-customer',...Array.from({length:1557},(_,i)=>`no-match-${i}`)];
 for(const actor of [adminId,accountingId,saleId]){
   await asActor(db,actor);
   const direct=(await db.query('SELECT id FROM orders WHERE customer_id=ANY($1) ORDER BY order_date DESC,created_at DESC,id LIMIT 500',[ids])).rows.map(r=>r.id);
   assert.deepEqual((await window(ids)).map(r=>r.id),direct);
   if(actor===saleId)assert.ok(!direct.includes('hidden'));
 }
});
test('business-date fallback, creation-date reports, statuses and pagination retain their existing meanings',async()=>{
 await asActor(db,accountingId);
 assert.deepEqual((await window(['retention-customer'],{start:'2026-10-01',end:'2026-10-06'})).map(r=>r.id),['visible-legacy','visible-cancelled','visible-new']);
 assert.deepEqual((await window(['retention-customer'],{start:'2026-10-01',end:'2026-10-06',dateField:'created',status:'all'})).map(r=>r.id),['visible-old','visible-new','visible-legacy']);
 assert.deepEqual((await window(['retention-customer'],{status:'settled'})).map(r=>r.id),['visible-legacy','visible-old']);
 assert.deepEqual((await window(['retention-customer'],{status:'cancelled'})).map(r=>r.id),['visible-cancelled']);
 const all=await window(['retention-customer']);
 assert.deepEqual([...await window(['retention-customer'],{limit:2}),...await window(['retention-customer'],{limit:2,offset:2})],all);
});
test('anonymous, inactive users, invalid filters and oversized requests stay blocked',async()=>{
 await db.exec('RESET ROLE; SET ROLE anon');await assert.rejects(window(['retention-customer']),/permission denied/);
 await asActor(db,accountingId);
 for(const options of [{limit:1001},{offset:-1},{dateField:'unsafe'},{start:'2026-11-01',end:'2026-10-01'}])await assert.rejects(window(['retention-customer'],options),/không hợp lệ/);
 await assert.rejects(window(Array.from({length:10001},()=> 'x')),/không hợp lệ/);
 await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");await db.query('UPDATE profiles SET is_active=false WHERE auth_user_id=$1',[saleId]);
 await asActor(db,saleId);await assert.rejects(window(['retention-customer']),/active profile|authentication|inactive|401|403/);
});
