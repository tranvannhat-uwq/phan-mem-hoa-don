import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseSupplierDebtReport,SUPPLIER_REPORT_HEADERS as headers} from '../js/domain/supplier-report-import.js';
import {buildRetentionDatabase,asActor,scalar,adminId,saleId} from './helpers/retention-db.mjs';
const item=(code,date,type,amount,balance,qty=1)=>['NCC-REPORT','Report supplier',-10,100,30,60,code,date,type,amount,balance,type==='Nhập hàng'?'ITEM':null,type==='Nhập hàng'?'Test item':null,null,null,'cái',100,qty,100,0,0,0,0,0,100];
function fixture() {return parseSupplierDebtReport([headers,item('PN-REPORT','2026-09-04T16:00:00','Nhập hàng',100,90),item('PC-REPORT','2026-09-05T16:00:00.001','Thanh toán',-20,70),item('PC-REPORT','2026-09-05T16:00:00.002','Thanh toán',-10,60)],{from:'2026-09-01',to:'2026-10-28',sourceFile:'synthetic.xlsx',suppliers:[{id:'report-supplier',code:'NCC-REPORT'}]});}
test('report parser groups repeated purchase rows, preserves separate payment allocations, signed opening and raw fields',()=>{
 const p=fixture();assert.equal(p.suppliers.length,1);assert.equal(p.suppliers[0].entries.length,3);assert.equal(p.suppliers[0].opening,-10);
 const r=item('PN-REPORT','2026-09-04T16:00:00','Nhập hàng',100,90);r[16]=50;r[18]=50;
 const x=parseSupplierDebtReport([headers,r,[...r],item('PC','2026-09-06T16:00:00','Thanh toán',-30,60)],{from:'2026-09-01',to:'2026-10-28'});
 assert.equal(x.suppliers[0].entries.length,2);assert.equal(x.suppliers[0].entries[0].rows.length,2);
 assert.throws(()=>parseSupplierDebtReport([headers,item('PN','2026-08-31T16:00:00','Nhập hàng',100,90)],{from:'2026-09-01',to:'2026-10-28'}),/ngoài kỳ/);
 assert.throws(()=>parseSupplierDebtReport([headers,...[item('PN','2026-09-04T16:00:00','Nhập hàng',99,90)]],{from:'2026-09-01',to:'2026-10-28'}),/không khớp/);
});
test('report import is atomic, reconciled, idempotent, finance-only and preserves subsequent native purchases without touching cash',async()=>{
 const db=await buildRetentionDatabase({maxVersion:126});
 try {
  await db.exec(await readFile(new URL('../migrations/0127_supplier_debt_report_import.sql',import.meta.url),'utf8'));
  await db.exec(`INSERT INTO suppliers(id,code,name) VALUES('report-supplier','NCC-REPORT','Report supplier');
   INSERT INTO purchases(id,code,supplier_id,purchase_date,status,subtotal_amount,total_amount,paid_amount,balance_due,created_by)
   VALUES('native-later','NATIVE-LATER','report-supplier','2026-10-28T00:00:00Z','completed',20,20,0,20,'${adminId}');
   SELECT p4_recompute_supplier('report-supplier');`);
  const call=p=>scalar(db,'SELECT rpc_import_supplier_debt_report($1::jsonb) AS value',[JSON.stringify(p)]);
  await asActor(db,saleId);await assert.rejects(call(fixture()),/quản trị/);
  await db.exec('RESET ROLE;SET ROLE anon');await assert.rejects(call(fixture()),/permission denied/);
  await asActor(db,adminId);
  const bad=fixture();bad.suppliers[0].entries[2].balance=61;
  await assert.rejects(call(bad),/không khớp/);
  assert.equal(await scalar(db,'SELECT count(*) AS value FROM supplier_report_imports'),0);
  assert.equal(await scalar(db,"SELECT opening_debt AS value FROM suppliers WHERE id='report-supplier'"),'0');
  const cashBefore=await scalar(db,'SELECT count(*) AS value FROM cashbook_transactions');
  const result=await call(fixture());assert.equal(result.purchases,1);assert.equal(result.payments,2);assert.equal(result.items,1);
  assert.equal(await scalar(db,"SELECT debt AS value FROM suppliers WHERE id='report-supplier'"),'80');
  assert.equal(await scalar(db,"SELECT opening_debt AS value FROM suppliers WHERE id='report-supplier'"),'-10');
  assert.equal(await scalar(db,'SELECT count(*) AS value FROM cashbook_transactions'),cashBefore);
  assert.equal((await call({...fixture(),sourceFile:'renamed.xlsx'})).already_imported,true);
  const different=fixture();different.suppliers[0].name='Different';await assert.rejects(call(different),/đã nhập/);
  const history=await scalar(db,"SELECT rpc_supplier_debt_history('report-supplier',0,2) AS value");assert.equal(history.total,4);assert.equal(history.rows.length,2);
  const purchase=await scalar(db,"SELECT id AS value FROM purchases WHERE code='PN-REPORT'");
  const response=await scalar(db,'SELECT rpc_supplier_debt_history($1,0,20) AS value',['report-supplier']);
  assert.ok(response.rows.some(t=>t.source_report?.entry?.rows?.[0]?.[12]==='Test item'));
  await assert.rejects(scalar(db,'SELECT rpc_cancel_purchase($1,$2) AS value',[purchase,'Test']),/Phiếu lịch sử/);
  const payment=await scalar(db,'SELECT payment_id AS value FROM supplier_debt_transactions WHERE payment_id IS NOT NULL LIMIT 1');
  await assert.rejects(scalar(db,'SELECT rpc_cancel_supplier_payment($1,$2) AS value',[payment,'Test']),/Phiếu lịch sử/);
  await assert.rejects(scalar(db,'SELECT rpc_record_supplier_payment($1::jsonb) AS value',[JSON.stringify({supplierId:'report-supplier',purchaseId:purchase,amount:1,paymentMethod:'cash',idempotencyKey:'reject-history'})]),/Phiếu lịch sử/);
  await db.exec('RESET ROLE');await db.exec("SELECT p4_recompute_supplier('report-supplier')");
  assert.equal(await scalar(db,"SELECT debt AS value FROM suppliers WHERE id='report-supplier'"),'80');
  const changed=fixture();changed.suppliers[0].supplierId=null;await asActor(db);await assert.rejects(call(changed),/đã tồn tại/);
  await db.exec('RESET ROLE');
  await db.exec("INSERT INTO suppliers(id,code,name,opening_debt,debt) VALUES('conflict-supplier','CONFLICT','Conflict',5,5)");
  const overlap=fixture();Object.assign(overlap.suppliers[0],{supplierId:'conflict-supplier',code:'CONFLICT',name:'Conflict'});
  await asActor(db);await assert.rejects(call(overlap),/trùng kỳ/);
  assert.equal(await scalar(db,'SELECT count(*) AS value FROM supplier_report_imports'),1);
  await db.exec('RESET ROLE');await db.exec("UPDATE retention_control SET cutoff='2026-10-01T00:00:00+07:00',epoch=2 WHERE id");
  await asActor(db,adminId,2);await assert.rejects(call(fixture()),/Kỳ báo cáo đã đóng/);
 } finally {await db.close();}
});
