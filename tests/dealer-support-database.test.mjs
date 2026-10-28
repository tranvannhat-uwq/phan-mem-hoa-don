import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';
let db;
const owner=()=>db.exec('RESET ROLE');
const call=async(name,args=[])=>{
  const result=await scalar(db,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
  if(/^rpc_(confirm_order|record_sales_return_credit|cancel_sales_return|cancel_order)$/.test(name)) {
    await owner();await db.exec("UPDATE customer_debt_transactions SET created_at=clock_timestamp() WHERE created_at=now();SET ROLE authenticated");
  }
  return result;
};
async function reject(fn,pattern) {await db.exec('SAVEPOINT rejected');await assert.rejects(fn,pattern);await db.exec('ROLLBACK TO SAVEPOINT rejected;RELEASE SAVEPOINT rejected');}
async function dates(){const cutoff=(await call('rpc_retention_status')).next_cutoff;return{cutoff,old:new Date(Date.parse(cutoff)-86400000).toISOString(),previous:new Date(Date.parse(cutoff)+86400000).toISOString()};}
const select=async(selected=true)=>call('rpc_set_dealer_support_products',[JSON.stringify([{id:'retention-sku',selected}])]);
async function price(amount){await owner();await db.query("UPDATE price_list_items SET price=$1 WHERE id='retention-price'",[amount]);await asActor(db);}
const order=async(date,quantity=2,variantId='retention-sku')=>call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date,idempotencyKey:randomUUID(),items:[{variantId,quantity}]})]);
async function prepare(){await call('rpc_set_maintenance_mode',[true,'Synthetic support rehearsal']);return call('rpc_prepare_monthly_retention',[randomUUID(),false]);}
async function purge(p){return call('rpc_execute_monthly_retention',[p.job_id,p.backup_sha256,'XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(p.preview.cutoff))]);}
const history=()=>call('rpc_dealer_support_history',['retention-customer',0,25]);
before(async()=>{db=await buildRetentionDatabase();});after(async()=>{await db.close();});
beforeEach(async()=>{await owner();await db.exec("SELECT set_config('request.jwt.claim.sub','',false);BEGIN");await asActor(db);});
afterEach(async()=>{await db.exec('ROLLBACK;RESET ROLE');});

test('unconfirmed selection blocks preparation; only Admin can configure or modify selected SKUs',async()=>{
  await owner();await db.exec('UPDATE dealer_support_control SET selection_confirmed=false');await asActor(db);
  assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/SKU/);
  await reject(()=>prepare(),/Chưa thể dọn/);
  await call('rpc_set_maintenance_mode',[false,'Synthetic resume']);
  for(const actor of [accountingId,saleId]) {
    await asActor(db,actor);await reject(()=>select(),/Admin/);
    await reject(()=>call('rpc_dealer_support_products',['',0,25]),/Admin/);
  }
  await asActor(db,accountingId);await reject(()=>db.exec("UPDATE products SET retain_dealer_support_history=true WHERE id='retention-sku'"),/Admin|permission denied/);
  await asActor(db);await select();assert.deepEqual((await call('rpc_preview_monthly_retention',[false])).blockers,[]);
  await reject(()=>call('rpc_set_dealer_support_products',['[{"id":"retention-sku","selected":"false"}]']),/lựa chọn/);
  await reject(()=>call('rpc_set_dealer_support_products',['[{"id":"missing","selected":true}]']),/SKU/);
});

test('zero/nominal selected SKU history survives purge without keeping unselected products, prices or changing customer totals',async()=>{
  const date=await dates();await select();await price(0);await order(date.old,2);await price(5);await order(date.old,3);await order(new Date().toISOString(),1);
  await owner();await db.exec(`INSERT INTO brands(name,id,company_id) VALUES('OTHER','other-brand','ABS_NORTH');
    INSERT INTO products(id,code,variant_code,name,brand,brand_id,is_active,is_legacy) VALUES('other-sku','RET-SKU','RET-SKU','Synthetic same-name product','OTHER','other-brand',true,false);
    INSERT INTO price_list_items(id,price_list_id,product_id,variant_id,price) VALUES('other-price','retention-prices','other-sku','other-sku',0);`);
  await asActor(db);await order(date.old,7,'other-sku');
  const before=await history();assert.equal(before.total,3);assert.equal(Number(before.summary[0].issued),6);
  await owner();const customer=await scalar(db,"SELECT to_jsonb(c) AS value FROM customers c WHERE id='retention-customer'");await asActor(db);
  const p=await prepare();const payload=JSON.parse(p.backup_text);assert.ok(payload.tables.dealer_support_history);assert.ok(payload.tables.dealer_support_control);
  assert.ok(payload.columns.products.includes('retain_dealer_support_history'));assert.equal(p.preview.counts.support_history,2);
  await purge(p);await owner();assert.deepEqual(await scalar(db,"SELECT to_jsonb(c) AS value FROM customers c WHERE id='retention-customer'"),customer);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM dealer_support_history')),2);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM order_items')),1);
  await asActor(db,adminId,1);const after=await history();assert.equal(after.total,3);assert.equal(Number(after.summary[0].issued),6);
  assert.equal(after.rows.filter(r=>r.archived).length,2);assert.ok(after.rows.every(r=>!('unit_price' in r)&&!('order_id' in r)&&!('line_total' in r)));
  const again=await purge(p);assert.equal(again.already_completed,true);await owner();assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM dealer_support_history')),2);
});

test('cancelled orders remain marked cancelled and a retained return cancellation updates the preserved quantity',async()=>{
  const date=await dates();await select();await price(5);
  const sale=(await order(date.old,2)).order.id;
  const cancelled=(await order(date.old,3)).order.id;await call('rpc_cancel_order',[cancelled,'Synthetic cancelled allocation']);
  await owner();const item=await scalar(db,'SELECT id AS value FROM order_items WHERE order_id=$1',[sale]);await asActor(db);
  const ret=await call('rpc_record_sales_return_credit',[JSON.stringify({orderId:sale,idempotencyKey:randomUUID(),reason:'Synthetic support return',items:[{saleItemId:item,quantity:1}]})]);
  assert.equal(Number((await history()).summary[0].remaining),1);
  const p=await prepare();await purge(p);await owner();await db.exec('SET CONSTRAINTS ALL DEFERRED');await asActor(db,adminId,1);
  const after=await history();assert.equal(Number(after.summary[0].remaining),1);assert.equal(after.rows.filter(r=>r.order_cancelled).length,1);
  await call('rpc_cancel_sales_return',[ret.return_id,'Synthetic retained return cancellation']);
  assert.equal(Number((await history()).summary[0].returned),0);assert.equal(Number((await history()).summary[0].remaining),2);
  await owner();assert.equal(Number(await scalar(db,"SELECT debt AS value FROM customers WHERE id='retention-customer'")),10);
});

test('late failure rolls back support snapshots and return links together with all financial deletion',async()=>{
  const date=await dates();await select();await order(date.old);
  await owner();await db.exec(`CREATE FUNCTION test_support_late_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic support late failure';END $$;
    CREATE CONSTRAINT TRIGGER zz_support_failure AFTER DELETE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_support_late_fail();
    UPDATE retention_control SET expected_trigger_hash=p107_trigger_fingerprint();`);
  await asActor(db);const p=await prepare();await reject(()=>purge(p),/support late failure/);
  await owner();assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM dealer_support_history')),0);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders')),1);
  assert.equal(await scalar(db,'SELECT state AS value FROM retention_jobs WHERE id=$1',[p.job_id]),'prepared');
});

test('read-only scoped lookup, maintenance, private tables and bounds work for retained history',async()=>{
  await select();await order(new Date().toISOString());
  await asActor(db,saleId);await db.exec('SAVEPOINT reads');await db.exec('SET TRANSACTION READ ONLY');
  assert.equal((await history()).total,1);await db.exec('ROLLBACK TO SAVEPOINT reads');
  await reject(()=>db.exec('SELECT * FROM dealer_support_history'),/permission denied/);
  await reject(()=>call('rpc_dealer_support_history',['retention-customer',0,1000]),/Phân trang/);
  await owner();await db.query("UPDATE customers SET managed_by=$1 WHERE id='retention-customer'",[accountingId]);await asActor(db,saleId);
  await reject(()=>history(),/quyền/);
  await asActor(db);await call('rpc_set_maintenance_mode',[true,'Synthetic private history']);await asActor(db,accountingId);
  await reject(()=>history(),/maintenance/);
});

test('selection changes invalidate prepared backup, and disabling a SKU keeps its archived history',async()=>{
  const date=await dates();await select();await order(date.old);
  const p=await prepare();await select(false);await reject(()=>purge(p),/đã thay đổi/);
  await select(true);const fresh=await prepare();await purge(fresh);await asActor(db,adminId,1);await select(false);
  assert.equal((await history()).total,1);assert.equal((await history()).rows[0].archived,true);
});

test('a second monthly purge adds new support rows without repeating earlier quantities',async()=>{
  const date=await dates();await select();await price(0);await order(date.old,2);await order(date.previous,3);await order(new Date().toISOString(),4);
  const first=await prepare();await purge(first);await owner();await db.exec('SET CONSTRAINTS ALL DEFERRED;DROP TABLE _retention_ids,_retention_preserved,_retention_openings,_retention_cash_rows');
  const next=new Date(date.cutoff);next.setUTCMonth(next.getUTCMonth()+1);
  await db.exec(`CREATE OR REPLACE FUNCTION p107_cutoff() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${next.toISOString()}'::timestamptz $$`);
  await asActor(db,adminId,1);const second=await prepare();await purge(second);await asActor(db,adminId,2);
  const result=await history();assert.equal(result.total,3);assert.equal(Number(result.summary[0].issued),9);assert.equal(result.rows.filter(r=>r.archived).length,2);
});

test('selected SKUs with identical names and codes remain separate across brands',async()=>{
  const date=await dates();await owner();
  await db.exec(`INSERT INTO brands(name,id,company_id) VALUES('OTHER','other-brand','ABS_NORTH');
    INSERT INTO products(id,code,variant_code,name,brand,brand_id,is_active,is_legacy)
      VALUES('other-sku','RET-SKU','RET-SKU','Synthetic sealed product','OTHER','other-brand',true,false);
    INSERT INTO price_list_items(id,price_list_id,product_id,variant_id,price) VALUES('other-price','retention-prices','other-sku','other-sku',0);`);
  await asActor(db);await call('rpc_set_dealer_support_products',[JSON.stringify([{id:'retention-sku',selected:true},{id:'other-sku',selected:true}])]);
  await price(0);await order(date.old,2);await order(date.old,3,'other-sku');
  const p=await prepare();await purge(p);await asActor(db,adminId,1);
  const h=await history();assert.equal(h.summary.length,2);assert.equal(new Set(h.summary.map(row=>row.product_id)).size,2);
  assert.deepEqual(h.summary.map(row=>Number(row.issued)).sort(),[2,3]);
});

test('invalid source quantity blocks a purge before creating its recovery job',async()=>{
  const date=await dates();await select();await order(date.old);
  await owner();await db.exec("UPDATE order_items SET quantity='NaN'::numeric");await asActor(db);
  assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/sai số lượng/);
  await reject(()=>prepare(),/Chưa thể dọn/);
  await owner();assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM dealer_support_history')),0);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);
});

test('each support line gets its exact order note and keeps it after source deletion',async()=>{
  const date=await dates();await select();await price(0);
  const first=(await order(date.old,2)).order.id;
  const second=(await order(date.old,3)).order.id;
  const current=(await order(new Date().toISOString(),4)).order.id;
  const expected=new Map([[2,"Giao cửa sau\nGọi trước 15 phút"],[3,"Đơn khác — không trộn ghi chú"],[4,"Đơn hiện tại"]]);
  await owner();
  for(const [id,quantity] of [[first,2],[second,3],[current,4]]) {
    await db.query('UPDATE public.orders SET notes=$1 WHERE id=$2',[expected.get(quantity),id]);
  }
  await asActor(db);
  const before=await history();
  for(const row of before.rows)assert.equal(row.order_notes,expected.get(Number(row.quantity)));
  const empty=await call('rpc_dealer_support_history',['retention-customer',50,25]);
  assert.equal(empty.total,3);assert.deepEqual(empty.rows,[]);
  const prepared=await prepare();await purge(prepared);await asActor(db,adminId,1);
  const after=await history();
  assert.equal(after.total,3);
  assert.equal(after.rows.filter(row=>row.archived).length,2);
  for(const row of after.rows)assert.equal(row.order_notes,expected.get(Number(row.quantity)));
  await owner();
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM public.orders WHERE id IN ($1,$2)',[first,second])),0);
  assert.equal(Number(await scalar(db,"SELECT count(*) AS value FROM public.dealer_support_history WHERE order_notes<>''")),2);
});
