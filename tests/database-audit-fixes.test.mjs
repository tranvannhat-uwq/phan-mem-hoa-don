import assert from 'node:assert/strict';
import test, {before,after,beforeEach,afterEach} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId,saleId} from './helpers/retention-db.mjs';

const filenames=['0115_customer_baseline_blank_field_safety.sql','0116_cashbook_amendment_unicode_and_trigger_acl.sql','0117_employee_report_pagination_retention_merge.sql'];
const migrations=await Promise.all(filenames.map(name=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8')));
let db;
const call=(name,args=[])=>scalar(db,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
const customer=()=>db.query("SELECT debt,total_transaction,total_return,net_revenue,last_order_at,created_at,imported_debt_baseline,imported_total_transaction_baseline,imported_total_return_baseline,imported_net_revenue_baseline,imported_last_order_at_baseline,imported_created_at_baseline FROM customers WHERE id='retention-customer'").then(r=>r.rows[0]);
async function importRows(rows){return call('rpc_import_customer_financial_baselines',[JSON.stringify(rows)]);}
async function seedBaseline(){
  await asActor(db);
  await importRows([{id:'retention-customer',debt:100,totalTransaction:1000,totalReturn:100,netRevenue:900,
    lastOrderAt:'2026-01-02T00:00:00Z',createdAt:'2025-01-01T00:00:00Z'}]);
}
before(async()=>{
  db=await buildRetentionDatabase({maxVersion:114});
  // This suite groups several RPCs into one rollback-only transaction. Anchor
  // its opening before that transaction so identical now() timestamps cannot
  // reorder its synthetic ledger rows by random UUID instead of posting time.
  await db.exec("INSERT INTO customer_debt_transactions(id,customer_id,transaction_type,amount,debt_change,balance_before,balance_after,created_at,transaction_date) VALUES ('fixture-opening','retention-customer','adjust',0,0,0,0,now()-interval '1 day',now()-interval '1 day')");
  const tables=(await db.query('SELECT unnest(public.p107_snapshot_tables(false)) AS name')).rows.map(r=>r.name);
  const digest=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,await scalar(db,
    `SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) AS value FROM public."${name}" t`)])));
  const before=await digest();
  for(const source of migrations)await db.exec(source);
  assert.deepEqual(await digest(),before,'Installing fixes must not rewrite business tables');
});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('BEGIN');});
afterEach(async()=>{await db.exec('ROLLBACK; RESET ROLE');});

test('reimport with omitted, null or blank money fields preserves balances and dates',async()=>{
  await seedBaseline();
  // Current summary may include an order whose detail has already been purged.
  await db.exec('RESET ROLE');
  await db.exec("UPDATE customers SET last_order_at='2026-02-03T00:00:00Z' WHERE id='retention-customer'");
  const before=await customer();
  const ledgerCount=await scalar(db,'SELECT count(*) AS value FROM customer_debt_transactions');
  await asActor(db);
  for(const extra of [{},{debt:null,totalTransaction:null,totalReturn:null,netRevenue:null},
    {debt:'',totalTransaction:'',totalReturn:'',netRevenue:'',lastOrderAt:'',createdAt:''}]){
    await importRows([{id:'retention-customer',...extra}]);
    await db.exec('RESET ROLE');
    assert.deepEqual(await customer(),before);
    assert.equal(await scalar(db,'SELECT count(*) AS value FROM customer_debt_transactions'),ledgerCount);
    await asActor(db);
  }
});

test('explicit zero replaces only the imported contribution and repeated import is idempotent',async()=>{
  await seedBaseline();
  await call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',
    idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:3}]})]);
  const payload=[{id:'retention-customer',debt:0,totalTransaction:0,totalReturn:0,netRevenue:0}];
  await importRows(payload);
  await db.exec('RESET ROLE');
  const first=await customer();
  assert.equal(Number(first.debt),300);
  assert.equal(Number(first.total_transaction),300);
  assert.equal(Number(first.total_return),0);
  assert.equal(Number(first.net_revenue),300);
  const count=await scalar(db,'SELECT count(*) AS value FROM customer_debt_transactions');
  await asActor(db);await importRows(payload);await db.exec('RESET ROLE');
  assert.deepEqual(await customer(),first);
  assert.equal(await scalar(db,'SELECT count(*) AS value FROM customer_debt_transactions'),count);
  assert.equal(Number(await scalar(db,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('retention-customer')")),300);
});

test('signed imports stay signed and a partial update preserves the other baselines',async()=>{
  await seedBaseline();
  await importRows([{id:'retention-customer',debt:-50,totalTransaction:-100,totalReturn:-20,netRevenue:-80}]);
  await importRows([{id:'retention-customer',debt:-60}]);
  await db.exec('RESET ROLE');
  const current=await customer();
  assert.equal(Number(current.debt),-60);
  assert.equal(Number(current.total_transaction),-100);
  assert.equal(Number(current.total_return),-20);
  assert.equal(Number(current.net_revenue),-80);
});

test('invalid rows roll back the whole import and sales users cannot import balances',async()=>{
  await seedBaseline();
  await db.exec('SAVEPOINT invalid_import');
  await assert.rejects(importRows([{id:'retention-customer',debt:200},{id:'retention-customer',debt:'bad'}]),/Invalid financial baseline/);
  await db.exec('ROLLBACK TO SAVEPOINT invalid_import; RESET ROLE');
  assert.equal(Number((await customer()).debt),100);
  await asActor(db,saleId);
  await assert.rejects(importRows([{id:'retention-customer',debt:0}]),/accounting role required/);
});

test('amendment rejects Unicode, old encoded, padded and English cancelled statuses',async()=>{
  await asActor(db);
  const receipt=await call('rpc_create_cashbook_transaction',[JSON.stringify({idempotencyKey:randomUUID(),type:'thu',value:50,method:'cash',category:'Test',partner:'Test'})]);
  await db.exec('RESET ROLE');
  const id=receipt.id||receipt.cashbook?.id||receipt.transaction?.id;
  assert.ok(id,JSON.stringify(receipt));
  for(const status of ['cancelled','canceled','đã hủy','ĐÃ HỦY',' da huy ','Ä‘Ã£ há»§y','Ã„â€˜ÃƒÂ£ hÃ¡Â»Â§y']){
    await db.query('UPDATE cashbook_transactions SET status=$1,cancelled_at=NULL WHERE id=$2',[status,id]);
    await asActor(db);await db.exec('SAVEPOINT rejected_amendment');
    await assert.rejects(call('rpc_amend_cashbook_transaction',[id,JSON.stringify({value:40})]),/Cancelled cashbook/);
    await db.exec('ROLLBACK TO SAVEPOINT rejected_amendment; RESET ROLE');
    assert.equal(Number(await scalar(db,'SELECT value AS value FROM cashbook_transactions WHERE id=$1',[id])),50);
  }
});

test('active receipt edits preserve debt lineage, correct default labels and no-op amounts',async()=>{
  await seedBaseline();
  const receipt=await call('rpc_record_customer_receipt',['retention-customer',20,'Test','cash',randomUUID(),'Thu tiền khách hàng',new Date().toISOString()]);
  const id=receipt.cashbook_id||receipt.id||receipt.cashbook?.id;
  assert.ok(id,JSON.stringify(receipt));
  await call('rpc_amend_cashbook_transaction',[id,JSON.stringify({value:30})]);
  await db.exec('RESET ROLE');
  assert.equal(Number((await customer()).debt),70);
  assert.equal(await scalar(db,"SELECT description AS value FROM customer_debt_transactions WHERE cashbook_transaction_id=$1 AND transaction_type='payment_amend' ORDER BY created_at DESC LIMIT 1",[id]),'Sửa phiếu thu/chi');
  assert.equal(Number(await scalar(db,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('retention-customer')")),70);
  const count=await scalar(db,'SELECT count(*) AS value FROM customer_debt_transactions');
  await asActor(db);await call('rpc_amend_cashbook_transaction',[id,JSON.stringify({value:30})]);await db.exec('RESET ROLE');
  assert.equal(await scalar(db,'SELECT count(*) AS value FROM customer_debt_transactions'),count);
});

test('report detail pagination has a stable total, no duplicate pages and optional overview',async()=>{
  await seedBaseline();
  for(let i=0;i<5;i++)await call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity:1}]})]);
  const filter={start:new Date(Date.now()-86400000).toISOString(),end:new Date(Date.now()+86400000).toISOString(),employee_id:(await scalar(db,"SELECT id AS value FROM profiles WHERE auth_user_id=$1",[saleId])),detail_limit:3};
  const full=await call('rpc_get_employee_business_report',[JSON.stringify({...filter,detail_limit:100})]);
  const first=await call('rpc_get_employee_business_report',[JSON.stringify({...filter,include_summary:false,include_series:false})]);
  const second=await call('rpc_get_employee_business_report',[JSON.stringify({...filter,detail_offset:3})]);
  assert.ok(full.details.length>3);
  assert.equal(first.metadata.detail_total,full.details.length);
  assert.deepEqual(first.summary,{});assert.deepEqual(first.series,[]);
  assert.deepEqual(first.details,full.details.slice(0,3));
  assert.deepEqual(second.details,full.details.slice(3,6));
  assert.equal(second.summary.net_sales,full.summary.net_sales);
});

test('RPC privileges stay scoped and trigger-only function has no API execute permission',async()=>{
  for(const signature of ['rpc_import_customer_financial_baselines(jsonb)','rpc_amend_cashbook_transaction(text,jsonb)','rpc_get_employee_business_report(jsonb)']){
    assert.equal(await scalar(db,"SELECT has_function_privilege('anon',$1,'EXECUTE') AS value",[signature]),false);
    assert.equal(await scalar(db,"SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS value",[signature]),true);
  }
  assert.equal(await scalar(db,"SELECT has_function_privilege('authenticated','p84_guard_cancelled_order_debt()','EXECUTE') AS value"),false);
});

test('unknown report edits block installation instead of overwriting an unreviewed function',async()=>{
  const current=(await db.query("SELECT pg_get_functiondef('rpc_get_employee_business_report(jsonb)'::regprocedure) AS value")).rows[0].value;
  await db.exec(current.replace('DECLARE','-- unknown customization\nDECLARE'));
  await assert.rejects(db.exec(migrations[2]),/unexpected function definition/);
});
