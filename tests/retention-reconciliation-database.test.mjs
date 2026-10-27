import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';
import {buildStagingRecoverySql} from '../scripts/restore-retention-backup.mjs';
import {encryptRetentionBackup,decryptRetentionBackup} from '../js/services/retention-backup.js';
let db;
const owner=()=>db.exec('RESET ROLE');
const call=async(name,args=[])=>{
  const result=await scalar(db,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
  if(/^rpc_(confirm_order|record_customer_receipt|record_sales_return_credit)$/.test(name))
    await db.exec("RESET ROLE;UPDATE customer_debt_transactions SET created_at=clock_timestamp() WHERE created_at=now();SET ROLE authenticated");
  return result;
};
async function reject(fn,pattern){await db.exec('SAVEPOINT rejected');await assert.rejects(fn,pattern);await db.exec('ROLLBACK TO SAVEPOINT rejected;RELEASE SAVEPOINT rejected');}
async function dates(){const cutoff=(await call('rpc_retention_status')).next_cutoff;return{cutoff,old:new Date(Date.parse(cutoff)-86400000).toISOString()};}
const order=async(date,qty=2)=>call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date,idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:qty}]})]);
async function select(){await call('rpc_set_dealer_support_products',[JSON.stringify([{id:'retention-sku',selected:true}])]);}
async function prepare(){await call('rpc_set_maintenance_mode',[true,'Synthetic held documents rehearsal']);return call('rpc_prepare_monthly_retention',[randomUUID(),false]);}
const purge=p=>call('rpc_execute_monthly_retention',[p.job_id,p.backup_sha256,'XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(p.preview.cutoff))]);
async function missingCustomer(id){await owner();await db.query('UPDATE orders SET customer_id=NULL WHERE id=$1',[id]);await asActor(db);}
before(async()=>{db=await buildRetentionDatabase();});after(async()=>db.close());
beforeEach(async()=>{await owner();await db.exec("SELECT set_config('request.jwt.claim.sub','',false);BEGIN");await asActor(db);});
afterEach(async()=>{await db.exec('ROLLBACK;RESET ROLE');});

test('skip keeps the exact missing-customer order and items, while valid unrelated orders are deleted',async()=>{
  const date=await dates();await select();
  await owner();await db.exec('UPDATE price_list_items SET price=0');await asActor(db);
  const bad=(await order(date.old)).order.id,good=(await order(date.old)).order.id;
  await missingCustomer(bad);await owner();
  const original=await scalar(db,'SELECT to_jsonb(o) AS value FROM orders o WHERE id=$1',[bad]);
  const items=(await db.query('SELECT to_jsonb(i) AS value FROM order_items i WHERE order_id=$1 ORDER BY id',[bad])).rows;
  await asActor(db);assert.equal((await call('rpc_preview_monthly_retention',[false])).review_pending,1);
  await reject(()=>prepare(),/Chưa thể dọn/);
  const held=await call('rpc_hold_retention_warnings',[false]);assert.equal(held.added,1);assert.equal(held.preview.can_prepare,true);
  assert.equal((await call('rpc_hold_retention_warnings',[false])).added,0);
  const p=await prepare();assert.equal(JSON.parse(p.backup_text).tables.retention_review_orders.length,1);
  await purge(p);await owner();
  assert.deepEqual(await scalar(db,'SELECT to_jsonb(o) AS value FROM orders o WHERE id=$1',[bad]),original);
  assert.deepEqual((await db.query('SELECT to_jsonb(i) AS value FROM order_items i WHERE order_id=$1 ORDER BY id',[bad])).rows,items);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders WHERE id=$1',[good])),0);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM dealer_support_history')),1);
  await asActor(db,adminId,1);await call('rpc_set_maintenance_mode',[false,'Synthetic resume']);
  await asActor(db,accountingId,1);const review=await call('rpc_retention_review_orders',[0,25]);
  assert.equal(review.total,1);assert.equal(review.rows[0].current_order.id,bad);
  assert.ok(review.rows[0].reasons.includes('Chưa liên kết khách hàng'));assert.equal(review.rows[0].current_items.length,1);
});

test('a connected sale, receipt, return and financial ledger remain unchanged with current debt and cash preserved',async()=>{
  const date=await dates();await select();const bad=(await order(date.old,4)).order.id;
  const receipt=await call('rpc_record_customer_receipt',['retention-customer',50,'Synthetic linked payment','cash',randomUUID(),'Thu tiền khách hàng',date.old]);
  await owner();const item=await scalar(db,'SELECT id AS value FROM order_items WHERE order_id=$1',[bad]);await asActor(db);
  const ret=await call('rpc_record_sales_return_credit',[JSON.stringify({orderId:bad,idempotencyKey:randomUUID(),reason:'Synthetic linked return',items:[{saleItemId:item,quantity:1}]})]);
  await owner();await db.query('UPDATE cashbook_transactions SET order_id=$1 WHERE customer_id=$2',[bad,'retention-customer']);
  // Simulate the legacy support inconsistency; financial postings remain correct.
  await db.query('UPDATE order_items SET returned_quantity=0 WHERE id=$1',[item]);await asActor(db);
  assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/sai số lượng/);
  await call('rpc_hold_retention_warnings',[false]);
  await owner();const kept=(await db.query('SELECT * FROM p118_kept_rows() ORDER BY table_name,row_id')).rows;
  assert.ok(kept.some(row=>row.table_name==='sales_returns'&&row.row_id===ret.return_id));
  assert.ok(kept.some(row=>row.table_name==='cashbook_transactions'));
  const before={};for(const table of ['orders','order_items','sales_returns','sales_return_items','cashbook_transactions','customer_debt_transactions'])before[table]=(await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY id`)).rows;
  const cash=await scalar(db,'SELECT p107_cash_net(NULL) AS value');const debt=await scalar(db,"SELECT debt AS value FROM customers WHERE id='retention-customer'");await asActor(db);
  const p=await prepare();await purge(p);await owner();
  for(const [table,rows] of Object.entries(before))assert.deepEqual((await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY id`)).rows,rows,table);
  assert.deepEqual(await scalar(db,'SELECT p107_cash_net(NULL) AS value'),cash);
  assert.equal(await scalar(db,"SELECT debt AS value FROM customers WHERE id='retention-customer'"),debt);
});

test('skip cannot waive financial, unknown-schema or unconfirmed-SKU validation',async()=>{
  const date=await dates();await select();const bad=(await order(date.old)).order.id;await missingCustomer(bad);
  await call('rpc_hold_retention_warnings',[false]);await owner();await db.exec('UPDATE dealer_support_control SET selection_confirmed=false');await asActor(db);
  assert.equal((await call('rpc_preview_monthly_retention',[false])).can_prepare,false);
  await reject(()=>prepare(),/Chưa thể dọn/);
  await owner();await db.exec('UPDATE dealer_support_control SET selection_confirmed=true;CREATE TABLE unknown_reference(id text PRIMARY KEY,order_id text REFERENCES orders(id))');await asActor(db);
  assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/liên kết mới/);
  await reject(()=>prepare(),/Chưa thể dọn/);
});

test('only Admin can defer; accounting can read the private queue, sales and anonymous cannot',async()=>{
  const date=await dates();await select();const bad=(await order(date.old)).order.id;await missingCustomer(bad);
  for(const actor of [accountingId,saleId]){await asActor(db,actor);await reject(()=>call('rpc_hold_retention_warnings',[false]),/Admin/);}
  await asActor(db);await call('rpc_hold_retention_warnings',[false]);await asActor(db,accountingId);
  assert.equal((await call('rpc_retention_review_orders',[0,25])).total,1);
  await reject(()=>db.exec('SELECT * FROM retention_review_orders'),/permission denied/);
  await reject(()=>db.exec('SELECT * FROM p118_kept_rows()'),/permission denied/);
  await asActor(db,saleId);await reject(()=>call('rpc_retention_review_orders',[0,25]),/kế toán/);
  await owner();await db.exec('SET ROLE anon');await reject(()=>call('rpc_retention_review_orders',[0,25]),/permission denied/);
});

test('a new hold invalidates a prepared backup, and READ ONLY queue queries enforce pagination',async()=>{
  const date=await dates();await select();const bad=(await order(date.old)).order.id;
  const p=await prepare();await missingCustomer(bad);await call('rpc_hold_retention_warnings',[false]);
  await reject(()=>purge(p),/đã thay đổi/);
  await db.exec('SAVEPOINT read_only;SET TRANSACTION READ ONLY');assert.equal((await call('rpc_retention_review_orders',[0,25])).total,1);
  await db.exec('ROLLBACK TO SAVEPOINT read_only');await reject(()=>call('rpc_retention_review_orders',[0,1000]),/Phân trang/);
});

test('multiple SKU inventory positions and movements stay exact while an unrelated old order is purged',async()=>{
  const date=await dates();await select();await owner();
  await db.exec(`INSERT INTO products(id,code,variant_code,name,brand,brand_id,is_active,is_legacy,packaging_name)
    VALUES('other-sku','OTHER','OTHER','Other product','RETENTION','retention-brand',true,false,'Thùng');
    INSERT INTO price_list_items(id,price_list_id,product_id,variant_id,price) VALUES('other-price','retention-prices','other-sku','other-sku',50);`);
  await asActor(db);
  await call('rpc_inventory_post',[JSON.stringify({requestKey:randomUUID(),kind:'count',note:'Synthetic opening',items:[
    {productId:'retention-sku',quantity:20,expectedQuantity:0},{productId:'other-sku',quantity:20,expectedQuantity:0}]})]);
  await call('rpc_inventory_activate',[true]);
  await owner();await db.exec("UPDATE inventory_control SET activated_at=now()-interval '1 year'");await asActor(db);
  const bad=(await call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date:date.old,
    idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:2},{variantId:'other-sku',quantity:3}]})])).order.id;
  const good=(await order(date.old)).order.id;
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED');
  await missingCustomer(bad);await call('rpc_hold_retention_warnings',[false]);await owner();
  const positions=(await db.query('SELECT to_jsonb(p) AS value FROM inventory_order_positions p WHERE order_id=$1 ORDER BY product_id',[bad])).rows;
  assert.equal(positions.length,2);
  const stock=(await db.query('SELECT to_jsonb(s) AS value FROM inventory_balances s ORDER BY product_id')).rows;
  const moves=(await db.query('SELECT to_jsonb(m) AS value FROM inventory_movements m WHERE order_id=$1 ORDER BY id',[bad])).rows;
  await asActor(db);const p=await prepare();await purge(p);await owner();
  assert.deepEqual((await db.query('SELECT to_jsonb(p) AS value FROM inventory_order_positions p WHERE order_id=$1 ORDER BY product_id',[bad])).rows,positions);
  assert.deepEqual((await db.query('SELECT to_jsonb(m) AS value FROM inventory_movements m WHERE order_id=$1 ORDER BY id',[bad])).rows,moves);
  assert.deepEqual((await db.query('SELECT to_jsonb(s) AS value FROM inventory_balances s ORDER BY product_id')).rows,stock);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders WHERE id=$1',[good])),0);
});

test('shared financial links retain related purchases and supplier ledgers without corrupting supplier carry',async()=>{
  const date=await dates();await select();const bad=(await order(date.old)).order.id;await missingCustomer(bad);
  await owner();await db.exec("INSERT INTO suppliers(id,name,opening_debt,debt) VALUES('held-supplier','Synthetic supplier',50,50)");await asActor(db);
  await call('rpc_create_purchase',[JSON.stringify({supplierId:'held-supplier',purchaseDate:date.old,idempotencyKey:randomUUID(),
    items:[{productId:'retention-sku',code:'RET-SKU',name:'Synthetic product',quantity:10,unitPrice:100}],paidAmount:200,paymentMethod:'bank'})]);
  await owner();await db.query("UPDATE cashbook_transactions SET order_id=$1 WHERE supplier_id='held-supplier'",[bad]);
  const before={};for(const table of ['purchases','purchase_items','purchase_payments','supplier_debt_transactions'])
    before[table]=(await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY id`)).rows;
  const supplier=await scalar(db,"SELECT to_jsonb(s) AS value FROM suppliers s WHERE id='held-supplier'");await asActor(db);
  const held=await call('rpc_hold_retention_warnings',[false]);assert.equal(held.preview.can_prepare,true);
  const p=await prepare();await purge(p);await owner();
  for(const [table,rows] of Object.entries(before))assert.deepEqual((await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY id`)).rows,rows,table);
  assert.deepEqual(await scalar(db,"SELECT to_jsonb(s) AS value FROM suppliers s WHERE id='held-supplier'"),supplier);
});

test('a forgotten mutation of a held row aborts and rolls back the whole purge',async()=>{
  const date=await dates();await select();const bad=(await order(date.old)).order.id;await missingCustomer(bad);
  await call('rpc_hold_retention_warnings',[false]);const p=await prepare();await owner();
  const originalNotes=await scalar(db,'SELECT notes AS value FROM orders WHERE id=$1',[bad]);
  // Emulate a future cleanup accidentally writing a kept source after its snapshot.
  await db.exec(`ALTER FUNCTION p118_assert_kept() RENAME TO p118_real_assert_kept;
    CREATE FUNCTION p118_assert_kept() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    BEGIN UPDATE orders SET notes='Synthetic accidental mutation' WHERE id IN(SELECT order_id FROM retention_review_orders);
    PERFORM p118_real_assert_kept(); END $$;`);
  await asActor(db);await reject(()=>purge(p),/chứng từ giữ/);await owner();
  assert.equal(await scalar(db,'SELECT notes AS value FROM orders WHERE id=$1',[bad]),originalNotes);
  assert.equal(Number(await scalar(db,'SELECT epoch AS value FROM retention_control')),0);
  assert.equal(await scalar(db,'SELECT state AS value FROM retention_jobs WHERE id=$1',[p.job_id]),'prepared');
});

test('holds survive a later month and an encrypted recovery into empty staging',async()=>{
  const date=await dates();await select();const bad=(await order(date.old)).order.id;await missingCustomer(bad);
  await call('rpc_hold_retention_warnings',[false]);const first=await prepare();await purge(first);await owner();
  await db.exec('SET CONSTRAINTS ALL DEFERRED;DROP TABLE _retention_ids,_retention_preserved,_retention_openings,_retention_cash_rows');
  const next=new Date(date.cutoff);next.setUTCMonth(next.getUTCMonth()+1);
  await db.exec(`CREATE OR REPLACE FUNCTION p107_cutoff() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${next.toISOString()}'::timestamptz $$`);
  await asActor(db,adminId,1);const second=await prepare();
  const encrypted=await encryptRetentionBackup(second,'Synthetic hold recovery password');
  const {payload}=await decryptRetentionBackup(encrypted,'Synthetic hold recovery password');
  const target=await buildRetentionDatabase();
  try {
    const seed=new Set(['profiles','companies','retention_control','inventory_control','dealer_support_control']);
    await target.exec("SELECT set_config('app.retention_restore_target','ISOLATED_EMPTY_STAGING',false);SET session_replication_role=replica");
    for(const table of Object.keys(payload.tables).filter(t=>!seed.has(t)))await target.exec(`DELETE FROM public."${table}"`);
    await target.exec('SET session_replication_role=origin');await target.exec(buildStagingRecoverySql(payload));
    await asActor(target,accountingId,1);
    const review=await scalar(target,'SELECT rpc_retention_review_orders(0,25) AS value');
    assert.equal(review.rows[0].current_order.id,bad);assert.equal(review.rows[0].current_items.length,1);
    assert.deepEqual(review.rows[0].reasons,payload.tables.retention_review_orders[0].reasons);
  } finally {await target.close();}
  await purge(second);await owner();assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders WHERE id=$1',[bad])),1);
});
