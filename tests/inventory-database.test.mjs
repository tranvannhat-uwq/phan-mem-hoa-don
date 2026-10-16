import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db;
const admin = '00000000-0000-0000-0000-000000000001';
const accounting = '00000000-0000-0000-0000-000000000002';
const sale = '00000000-0000-0000-0000-000000000003';
const read = name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0].value; }
async function actor(id, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec(`SET ROLE ${role}`);
}
async function post(kind, items, requestKey = randomUUID(), note = '') {
  return scalar('SELECT public.rpc_inventory_post($1::jsonb) AS value', [JSON.stringify({kind, items, requestKey, note})]);
}
async function balance(product = 'sku-a') {
  await db.exec('RESET ROLE');
  return Number(await scalar('SELECT quantity AS value FROM public.inventory_balances WHERE product_id = $1', [product]));
}
async function transaction(sql) {
  try { await db.exec(`BEGIN; ${sql}; COMMIT;`); }
  catch (error) { await db.exec('ROLLBACK'); throw error; }
}
async function setSync(enabled, acknowledgeOpening = false) {
  await actor(admin);
  return scalar('SELECT public.rpc_inventory_set_sync($1,$2) AS value',[enabled,acknowledgeOpening]);
}
async function newOrder(id, quantity = 1) {
  await db.exec('RESET ROLE');
  await transaction(`INSERT INTO public.orders(id,customer_name,status,confirmed_at) VALUES ('${id}','Synthetic','settled',now()); INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity) VALUES ('line-${id}','${id}','sku-a','sku-a',${quantity})`);
}

before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;`);
  // Apply the real core schema; PGlite's built-in gen_random_uuid replaces the
  // optional pgcrypto extension. All data below is synthetic, never production.
  await db.exec((await read('0001_core_schema_and_migration_registry.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  const authMigration = await read('0002_auth_profiles_and_rls.sql');
  await db.exec(authMigration.match(/CREATE TABLE IF NOT EXISTS public\.profiles[\s\S]*?\n\);/)[0]);
  await db.exec(authMigration.match(/CREATE OR REPLACE FUNCTION public\.require_authenticated_profile\(\)[\s\S]*?\$\$;/)[0]);
  await db.exec(`INSERT INTO public.profiles(id,auth_user_id,username,display_name,role) VALUES
    ('admin','${admin}','admin','Admin','admin'),('accounting','${accounting}','accounting','Accounting','accounting'),('sale','${sale}','sale','Sale','sale');
    INSERT INTO public.products(id,code,brand,name,package_type) VALUES ('sku-a','A-LON','TEST','Sơn A','Lon'),('sku-b','B-THUNG','TEST','Sơn B','Thùng');
    INSERT INTO public.orders(id,customer_name,status,created_at,confirmed_at) VALUES ('old-order','Synthetic','settled',now()-interval '1 day',now()-interval '1 day');
    INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity) VALUES ('old-line','old-order','sku-a','sku-a',5);`);
  await db.exec(await read('0088_integrated_inventory_free_budget.sql'));
  await db.exec(await read('0089_inventory_sync_toggle.sql'));
  await db.exec(await read('0091_inventory_page_limit.sql'));
});
after(async () => { if (db) await db.close(); });

test('anonymous, Sale and direct authenticated table access are denied', async () => {
  await actor('', 'anon');
  await assert.rejects(scalar('SELECT public.rpc_inventory_window() AS value'), /permission denied/);
  await actor(sale);
  await assert.rejects(scalar('SELECT public.rpc_inventory_window() AS value'), /Chỉ Admin/);
  await assert.rejects(post('receipt', [{productId:'sku-a', quantity:1}]), /Chỉ Admin/);
  await actor(admin);
  await assert.rejects(db.query('SELECT * FROM public.inventory_balances'), /permission denied/);
});
test('multi-SKU voucher is atomic and underflow rolls back every line', async () => {
  await actor(admin);
  await post('count', [{productId:'sku-a', quantity:10, expectedQuantity:0},{productId:'sku-b', quantity:2, expectedQuantity:0}]);
  await assert.rejects(post('issue', [{productId:'sku-a',quantity:3},{productId:'sku-b',quantity:5}]), /không đủ tồn/);
  assert.equal(await balance(),10); assert.equal(await balance('sku-b'),2);
});
test('idempotent retries do not move stock twice and changed payload is rejected', async () => {
  await actor(accounting); const key = randomUUID(); const lines = [{productId:'sku-a',quantity:2}];
  const first = await post('receipt', lines, key); const second = await post('receipt', lines, key);
  assert.equal(first.id, second.id); assert.equal(second.replayed,true);
  await assert.rejects(post('receipt',[{productId:'sku-a',quantity:3}],key), /phiếu khác/);
  assert.equal(await balance(),12);
});
test('stale count snapshot and duplicate SKU are rejected', async () => {
  await actor(admin);
  await assert.rejects(post('count',[{productId:'sku-a',quantity:1,expectedQuantity:0}]), /đã thay đổi/);
  await assert.rejects(post('receipt',[{productId:'sku-a',quantity:1},{productId:'sku-a',quantity:1}]), /khác nhau/);
});
test('activation is Admin-only and never backfills old orders', async () => {
  await actor(accounting);
  await assert.rejects(scalar('SELECT public.rpc_inventory_activate(true) AS value'), /Admin/);
  await actor(admin);
  await scalar('SELECT public.rpc_inventory_activate(true) AS value');
  await db.exec('RESET ROLE');
  await transaction("UPDATE public.orders SET notes='annotation' WHERE id='old-order'");
  assert.equal(await balance(),12);
  assert.equal(Number(await scalar('SELECT count(*) AS value FROM public.inventory_order_positions')),0);
});
test('deferred confirm, amend, return and cancellation produce exact net stock', async () => {
  await db.exec('RESET ROLE');
  await transaction("INSERT INTO public.orders(id,customer_name,status,confirmed_at) VALUES ('new-order','Synthetic','settled',now()); INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity) VALUES ('new-line','new-order','sku-a','sku-a',3)");
  assert.equal(await balance(),9);
  await transaction("DELETE FROM public.order_items WHERE order_id='new-order'; UPDATE public.orders SET items='[{\"quantity\":5}]' WHERE id='new-order'; INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity) VALUES ('amended-line','new-order','sku-a','sku-a',5)");
  assert.equal(await balance(),7);
  // Free/zero-value returns still fire from returned_quantity.
  await transaction("UPDATE public.order_items SET returned_quantity=2 WHERE order_id='new-order'");
  assert.equal(await balance(),9);
  await transaction("UPDATE public.order_items SET returned_quantity=0 WHERE order_id='new-order'");
  assert.equal(await balance(),7);
  await transaction("UPDATE public.orders SET status='cancelled' WHERE id='new-order'");
  assert.equal(await balance(),12);
  await transaction("UPDATE public.orders SET notes='repeat' WHERE id='new-order'");
  assert.equal(await balance(),12);
});
test('insufficient stock aborts the whole order commit', async () => {
  await db.exec('RESET ROLE');
  await assert.rejects(transaction("INSERT INTO public.orders(id,customer_name,status,confirmed_at) VALUES ('overflow-order','Synthetic','settled',now()); INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity) VALUES ('overflow-line','overflow-order','sku-b','sku-b',30)"), /không đủ tồn/);
  assert.equal(Number(await scalar("SELECT count(*) AS value FROM public.orders WHERE id='overflow-order'")),0);
  assert.equal(await balance('sku-b'),2);
});
test('sub-unit precision cannot silently disappear from inventory', async () => {
  await db.exec('RESET ROLE');
  await assert.rejects(transaction("INSERT INTO public.orders(id,customer_name,status,confirmed_at) VALUES ('precision-order','Synthetic','settled',now()); INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity) VALUES ('precision-line','precision-order','sku-a','sku-a',0.00001)"), /4 chữ số/);
  assert.equal(await balance(),12);
});

test('only Admin can toggle; queue, core implementation and old window stay private', async () => {
  for (const user of [accounting,sale]) {
    await actor(user);
    await assert.rejects(scalar('SELECT public.rpc_inventory_set_sync(false) AS value'), /Admin/);
  }
  await actor('','anon');
  await assert.rejects(scalar('SELECT public.rpc_inventory_set_sync(false) AS value'), /permission denied/);
  await actor(admin);
  await assert.rejects(db.query('SELECT * FROM public.inventory_pending_orders'), /permission denied/);
  await assert.rejects(scalar("SELECT private.inventory_apply_order_core('new-order') AS value"), /permission denied/);
  await assert.rejects(scalar('SELECT private.inventory_window_v88() AS value'), /permission denied/);
  await assert.rejects(scalar('SELECT public.rpc_inventory_set_sync(NULL) AS value'), /Cần chọn/);
});

test('pause queues each order once; resume applies its latest state once and keeps the opening cutoff', async () => {
  const paused=await setSync(false); assert.equal(paused.enabled,false);
  const cutoff=paused.activatedAt;
  await newOrder('paused-order',3);
  await transaction("UPDATE public.order_items SET quantity=5 WHERE order_id='paused-order'; UPDATE public.orders SET notes='changed' WHERE id='paused-order'; UPDATE public.order_items SET returned_quantity=2 WHERE order_id='paused-order'");
  assert.equal(await balance(),12);
  assert.equal(Number(await scalar('SELECT count(*) AS value FROM public.inventory_pending_orders')),1);
  await actor(admin);
  const window=await scalar('SELECT public.rpc_inventory_window() AS value');
  assert.equal(window.control.syncEnabled,false);assert.equal(window.control.pendingOrders,1);
  await assert.rejects(post('count',[{productId:'sku-a',quantity:9,expectedQuantity:12}]),/hàng đợi/);
  const resumed=await setSync(true);
  assert.equal(resumed.enabled,true);assert.equal(resumed.processed,1);assert.equal(resumed.pendingOrders,0);
  assert.equal(resumed.activatedAt,cutoff);
  assert.equal(await balance(),9);
  await setSync(true);assert.equal(await balance(),9);
  await transaction("UPDATE public.orders SET status='cancelled' WHERE id='paused-order'");
  assert.equal(await balance(),12);
});

test('a paused return restores a previously applied sale; a new cancelled order never deducts stock', async () => {
  await newOrder('paused-return',4);assert.equal(await balance(),8);
  await setSync(false);await db.exec('RESET ROLE');
  await transaction("UPDATE public.order_items SET returned_quantity=1 WHERE order_id='paused-return'");
  await newOrder('paused-cancel',2);
  await transaction("UPDATE public.orders SET status='cancelled' WHERE id='paused-cancel'; UPDATE public.orders SET notes='legacy annotation' WHERE id='old-order'");
  assert.equal(await balance(),8);
  assert.equal(Number(await scalar('SELECT count(*) AS value FROM public.inventory_pending_orders')),2);
  await setSync(true);assert.equal(await balance(),9);
  assert.equal(Number(await scalar("SELECT count(*) AS value FROM public.inventory_movements WHERE order_id='paused-cancel'")),0);
  await transaction("UPDATE public.orders SET status='cancelled' WHERE id='paused-return'");
  assert.equal(await balance(),12);
});

test('resume underflow rolls back the batch and keeps it paused until stock is replenished', async () => {
  await setSync(false);await newOrder('paused-overflow',20);
  await assert.rejects(setSync(true),/không đủ tồn/);
  assert.equal(await balance(),12);
  assert.equal(await scalar('SELECT sync_enabled AS value FROM public.inventory_control'),false);
  assert.equal(Number(await scalar('SELECT count(*) AS value FROM public.inventory_pending_orders')),1);
  await actor(accounting);await post('receipt',[{productId:'sku-a',quantity:8}]);
  await setSync(true);assert.equal(await balance(),0);
  await transaction("UPDATE public.orders SET status='cancelled' WHERE id='paused-overflow'");
  await actor(admin);await post('issue',[{productId:'sku-a',quantity:8}]);
  assert.equal(await balance(),12);
});

test('saving and deleting an unposted draft while paused never queues or changes stock', async () => {
  await setSync(false);await db.exec('RESET ROLE');
  await transaction("INSERT INTO public.orders(id,customer_name,status) VALUES ('paused-draft','Synthetic','draft'); INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity) VALUES ('paused-draft-line','paused-draft','sku-a','sku-a',3)");
  await transaction("UPDATE public.orders SET notes='draft edit' WHERE id='paused-draft'");
  assert.equal(Number(await scalar('SELECT count(*) AS value FROM public.inventory_pending_orders')),0);
  await transaction("DELETE FROM public.orders WHERE id='paused-draft'");
  assert.equal(await balance(),12);
  await setSync(true);
});

test('catch-up processes at most 50 orders per call and enables only after the queue is empty', async () => {
  await setSync(false);await db.exec('RESET ROLE');
  await transaction(`INSERT INTO public.orders(id,customer_name,status,confirmed_at)
    SELECT 'batch-'||i,'Synthetic','settled',now() FROM generate_series(1,52) i;
    INSERT INTO public.order_items(id,order_id,product_id,variant_id,quantity)
    SELECT 'batch-line-'||i,'batch-'||i,'sku-a','sku-a',0.1 FROM generate_series(1,52) i`);
  assert.equal(await balance(),12);
  let result=await setSync(true);
  assert.equal(result.processed,50);assert.equal(result.pendingOrders,2);assert.equal(result.enabled,false);
  assert.equal(await balance(),7);
  result=await setSync(true);
  assert.equal(result.processed,2);assert.equal(result.pendingOrders,0);assert.equal(result.enabled,true);
  assert.equal(await balance(),6.8);
  await setSync(true);assert.equal(await balance(),6.8);
  await transaction("UPDATE public.orders SET status='cancelled' WHERE id LIKE 'batch-%'");
  assert.equal(await balance(),12);
});
test('keyset pages include every SKU, cap UTF-8 output and require a bounded history window', async () => {
  await db.exec('RESET ROLE');
  await db.exec("INSERT INTO public.products(id,code,brand,name,package_type) SELECT 'page-'||lpad(i::text,4,'0'),'PAGE-'||i,'TEST',repeat('Sơn ',50),'Lon' FROM generate_series(1,150) i");
  await actor(admin);
  const first = await scalar('SELECT public.rpc_inventory_window($1::jsonb) AS value', [JSON.stringify({mode:'stock',limit:15})]);
  assert.equal(first.rows.length,15);
  assert.equal(first.hasMore,true);
  assert.equal(first.nextCursor,first.rows.at(-1).product_id);
  const next = await scalar('SELECT public.rpc_inventory_window($1::jsonb) AS value', [JSON.stringify({mode:'stock',limit:15,cursor:first.nextCursor})]);
  assert.equal(next.rows.length,15);
  assert.ok(next.rows.every(row => row.product_id > first.nextCursor));
  const distantMatch = await scalar('SELECT public.rpc_inventory_window($1::jsonb) AS value', [JSON.stringify({mode:'stock',limit:15,query:'PAGE-150'})]);
  assert.deepEqual(distantMatch.rows.map(row => row.product_id),['page-0150']);
  await assert.rejects(scalar('SELECT public.rpc_inventory_window($1::jsonb) AS value', [JSON.stringify({mode:'stock',limit:51})]), /1–50 dòng/);
  const ids = new Set(); let cursor = null; let pages = 0;
  do {
    const result = await scalar('SELECT public.rpc_inventory_window($1::jsonb) AS value',[JSON.stringify({mode:'stock',cursor})]);
    assert.ok(result.rows.length <= 50); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
    result.rows.forEach(row => { assert.ok(!ids.has(row.product_id)); ids.add(row.product_id); });
    cursor = result.nextCursor; pages++;
  } while (cursor);
  assert.equal(ids.size,152); assert.ok(pages>=4);
  await assert.rejects(scalar('SELECT public.rpc_inventory_window($1::jsonb) AS value',[JSON.stringify({mode:'movements',start:'2026-01-01',end:'2026-12-31'})]), /31 ngày/);
  const moves = await scalar("SELECT public.rpc_inventory_window('{\"mode\":\"movements\"}') AS value");
  assert.ok(moves.rows.length>0); assert.ok(moves.rows.every(row => Number.isFinite(Number(row.balance_after))));
});
test('shared read budget rejects further pages without returning unbounded data', async () => {
  await db.exec('RESET ROLE');
  await db.exec('UPDATE public.inventory_control SET read_budget_limit=read_budget_used+1');
  await actor(admin);
  await assert.rejects(scalar('SELECT public.rpc_inventory_window() AS value'), /ngân sách đọc/);
  const paused=await setSync(false);
  assert.equal(paused.enabled,false);
  await assert.rejects(setSync(true), /ngân sách đọc/);
  await db.exec('RESET ROLE');
  assert.equal(await scalar('SELECT sync_enabled AS value FROM public.inventory_control'),false);
});
