import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';

let db;
before(async()=>{
 db=await buildRetentionDatabase();
 await db.exec(`INSERT INTO products(id,code,name,brand,package_type) VALUES
   ('sku-a','A','Synthetic A','TEST','Cái'),('sku-b','B','Synthetic B','TEST','Thùng');`);
});
after(async()=>db?.close());
async function root(){await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");}
async function context(sku='sku-a'){await asActor(db,accountingId);return scalar(db,'SELECT rpc_inventory_count_context($1) AS value',[sku]);}
async function input(sku,qty){const c=await context(sku);return {kind:'count',requestKey:randomUUID(),note:'Synthetic count',countToken:c.token,activateProduct:true,items:[{productId:sku,quantity:qty,expectedQuantity:Number(c.quantity),minimumQuantity:0}]};}
async function save(payload){await asActor(db,accountingId);return scalar(db,'SELECT rpc_inventory_count_product($1::jsonb) AS value',[JSON.stringify(payload)]);}
async function quantity(sku='sku-a'){await root();return Number(await scalar(db,'SELECT COALESCE((SELECT quantity FROM inventory_balances WHERE product_id=$1),0) AS value',[sku]));}
async function tx(sql){await root();try{await db.exec(`BEGIN;${sql};COMMIT;`);}catch(e){await db.exec('ROLLBACK');throw e;}}
async function order(id,lines){await tx(`INSERT INTO orders(id,customer_name,status,confirmed_at) VALUES('${id}','Synthetic','settled',now());`+lines.map(([sku,q])=>`INSERT INTO order_items(id,order_id,product_id,variant_id,quantity) VALUES('${id}-${sku}','${id}','${sku}','${sku}',${q});`).join(''));}
async function financial(){await root();return scalar(db,`SELECT md5(jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM customers t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM suppliers t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM orders t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM cashbook_transactions t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM customer_debt_transactions t),
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM supplier_debt_transactions t)
 )::text) AS value`);}

test('accounting enables just one counted SKU, without backfilling stock or changing financial data',async()=>{
 await order('before-count',[['sku-a',5],['sku-b',9]]);
 const otherContext=await context('sku-b');
 const before=await financial();const payload=await input('sku-a',20);
 const first=await save(payload);assert.equal(first.syncActive,true);
 assert.equal(await financial(),before);
 assert.equal(await quantity(),20);assert.equal(await quantity('sku-b'),0);
 assert.equal((await context('sku-b')).token,otherContext.token,'enabling A must not invalidate an open count for B');
 await root();assert.equal(await scalar(db,'SELECT sync_mode AS value FROM inventory_control'),'selected');
 assert.equal(Number(await scalar(db,"SELECT quantity AS value FROM inventory_order_positions WHERE order_id='before-count' AND product_id='sku-a'")),5);
 const replay=await save(payload);assert.equal(replay.replayed,true);assert.equal(await quantity(),20);
 await assert.rejects(save({...payload,note:'changed'}),/phiếu khác/);
});
test('mixed orders deduct active SKU only; old-order amendments, returns and cancellations use net delta',async()=>{
 await order('after-count',[['sku-a',3],['sku-b',1000]]);
 assert.equal(await quantity(),17);assert.equal(await quantity('sku-b'),0);
 await tx("UPDATE order_items SET quantity=7 WHERE id='before-count-sku-a'; UPDATE orders SET notes='quantity amended' WHERE id='before-count'");assert.equal(await quantity(),15);
 await tx("UPDATE order_items SET returned_quantity=2 WHERE id='before-count-sku-a'");assert.equal(await quantity(),17);
 await tx("UPDATE orders SET status='cancelled' WHERE id='before-count'");assert.equal(await quantity(),22);
 await tx("UPDATE orders SET notes='repeat' WHERE id='before-count'");assert.equal(await quantity(),22);
});
test('a second SKU can start hours later without replaying prior mixed orders',async()=>{
 await save(await input('sku-b',50));assert.equal(await quantity('sku-b'),50);assert.equal(await quantity(),22);
 await tx("UPDATE order_items SET returned_quantity=4 WHERE id='after-count-sku-b'");assert.equal(await quantity('sku-b'),54);
 await order('both-active',[['sku-a',2],['sku-b',3]]);assert.equal(await quantity(),20);assert.equal(await quantity('sku-b'),51);
});
test('same-SKU movement rejects stale count atomically with PT409; unrelated SKU does not invalidate it',async()=>{
 const payload=await input('sku-a',100);
 await order('other-sku',[['sku-b',1]]);await save(payload);assert.equal(await quantity(),100);
 const stale=await input('sku-a',90);await order('during-count',[['sku-a',1]]);
 await assert.rejects(save(stale),e=>e.code==='PT409');assert.equal(await quantity(),99);
 await root();assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM inventory_documents WHERE request_key=$1',[stale.requestKey])),0);
});
test('inactive SKU movement and deletion during count are detected too',async()=>{
 const stale=await input('retention-sku',10);await order('inactive',[['retention-sku',1]]);
 await assert.rejects(save(stale),e=>e.code==='PT409');assert.equal(await quantity('retention-sku'),0);
 const removed=await input('retention-sku',10);await tx("DELETE FROM order_items WHERE id='inactive-retention-sku'");
 await assert.rejects(save(removed),e=>e.code==='PT409');
});
test('pause/resume preserves SKU selection and replays pending movement once',async()=>{
 await asActor(db,adminId);await scalar(db,'SELECT rpc_inventory_set_sync(false) AS value');
 await order('paused',[['sku-a',3],['retention-sku',99]]);assert.equal(await quantity(),99);
 await assert.rejects(save(await input('retention-sku',10)),/tạm dừng/);
 await asActor(db,adminId);await scalar(db,'SELECT rpc_inventory_set_sync(true) AS value');assert.equal(await quantity(),96);assert.equal(await quantity('retention-sku'),0);
});
test('sale and anonymous cannot count/activate or read private SKU state',async()=>{
 await asActor(db,saleId);await assert.rejects(scalar(db,"SELECT rpc_inventory_count_context('sku-a') AS value"),/Kế toán/);
 await assert.rejects(db.query('SELECT * FROM inventory_product_sync'),/permission denied/);
 await root();await db.exec('SET ROLE anon');await assert.rejects(scalar(db,"SELECT rpc_inventory_count_context('sku-a') AS value"),/permission denied/);
});
test('bounded pages show independent SKU states and retired count vouchers do not remove cutovers',async()=>{
 await asActor(db,accountingId);const page=await scalar(db,'SELECT rpc_inventory_window($1) AS value',[JSON.stringify({limit:3})]);
 assert.equal(page.rows.length,3);assert.equal(page.control.productSyncAvailable,true);
 assert.equal(page.rows.find(r=>r.product_id==='retention-sku').sync_active,false);
 assert.ok(page.rows.filter(r=>r.product_id!=='retention-sku').every(r=>r.sync_active));
 await root();assert.equal(await scalar(db,`SELECT confdeltype AS value FROM pg_constraint WHERE conrelid='inventory_product_sync'::regclass AND confrelid='inventory_documents'::regclass`),'n');
 assert.ok((await scalar(db,'SELECT p107_snapshot_tables(true) AS value')).includes('inventory_product_sync'));
});
test('real confirm and return RPCs keep stock and customer debt aligned after a SKU cutover',async()=>{
 await save(await input('retention-sku',100));
 await asActor(db,accountingId);
 const confirmed=await scalar(db,'SELECT rpc_confirm_order($1::jsonb) AS value',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date:new Date().toISOString(),idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:3,discountType:'percent',discountValue:0}]})]);
 assert.equal(await quantity('retention-sku'),97);
 await root();assert.equal(Number(await scalar(db,"SELECT debt AS value FROM customers WHERE id='retention-customer'")),300);
 const saleItemId=await scalar(db,'SELECT id AS value FROM order_items WHERE order_id=$1',[confirmed.order.id]);
 await asActor(db,accountingId);
 await scalar(db,'SELECT rpc_record_sales_return_credit($1::jsonb) AS value',[JSON.stringify({orderId:confirmed.order.id,idempotencyKey:randomUUID(),reason:'Synthetic return',items:[{saleItemId,quantity:1,deductionPercent:0}]})]);
 assert.equal(await quantity('retention-sku'),98);
 assert.equal(Number(await scalar(db,"SELECT debt AS value FROM customers WHERE id='retention-customer'")),200);
});
test('existing all-SKU warehouses keep their cutover and old-order behavior',async()=>{
 await root();await db.exec("UPDATE inventory_control SET sync_mode='all',activated_at=now(),sync_enabled=true; DELETE FROM inventory_order_positions; UPDATE inventory_balances SET quantity=100");
 await tx("UPDATE orders SET notes='old annotation' WHERE id='after-count'");assert.equal(await quantity(),100);
 await order('legacy-new',[['sku-a',3]]);assert.equal(await quantity(),97);
 const c=await context('retention-sku');assert.equal(c.syncActive,true);
});

test('monthly retention retires old count voucher and orders while preserving SKU activation and physical stock',async()=>{
 const fresh=await buildRetentionDatabase();
 const call=(name,args=[])=>scalar(fresh,`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
 try{
   await asActor(fresh);
   const cutoff=(await call('rpc_retention_status')).next_cutoff;
   const old=new Date(Date.parse(cutoff)-86400000).toISOString();
   await call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date:old,idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:5}]})]);
   const c=await call('rpc_inventory_count_context',['retention-sku']);
   const count=await call('rpc_inventory_count_product',[JSON.stringify({kind:'count',requestKey:randomUUID(),countToken:c.token,activateProduct:true,items:[{productId:'retention-sku',quantity:20,expectedQuantity:0}]})]);
   await fresh.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
   await fresh.query('UPDATE inventory_documents SET created_at=$1 WHERE id=$2',[old,count.id]);
   await fresh.query('UPDATE inventory_movements SET created_at=$1 WHERE document_id=$2',[old,count.id]);
   await asActor(fresh);await call('rpc_set_maintenance_mode',[true,'Synthetic inventory retention']);
   const prepared=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
   assert.ok(JSON.parse(prepared.backup_text).tables.inventory_product_sync.some(row=>row.product_id==='retention-sku'));
   await call('rpc_execute_monthly_retention',[prepared.job_id,prepared.backup_sha256,'XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(cutoff))]);
   await fresh.exec('RESET ROLE');
   assert.equal(Number(await scalar(fresh,"SELECT quantity AS value FROM inventory_balances WHERE product_id='retention-sku'")),20);
   const row=(await fresh.query("SELECT enabled_at,count_document_id FROM inventory_product_sync WHERE product_id='retention-sku'")).rows[0];
   assert.ok(row.enabled_at);assert.equal(row.count_document_id,null);
 }finally{await fresh.close();}
});
