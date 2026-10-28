import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';
import {supplierReportRange,supplierReportFilterError,supplierReportExcelRows} from '../js/domain/supplier-debt-report.js';
test('report dates respect local complete days and the retained boundary; export contains every provided row and signed totals',()=>{
  const now=new Date('2026-10-28T12:00:00Z');
  assert.deepEqual(supplierReportRange('retained','2026-08-31T17:00:00Z',now),{from:'2026-09-01',to:'2026-10-28'});
  assert.deepEqual(supplierReportRange('week',null,now),{from:'2026-10-26',to:'2026-10-28'});
  assert.deepEqual(supplierReportRange('previous-month','2026-09-14T17:00:00Z',now),{from:'2026-09-15',to:'2026-09-30'});
  assert.ok(supplierReportFilterError({from:'2026-02-30',to:'2026-03-01',min:'',max:''}));
  assert.ok(supplierReportFilterError({from:'2026-09-01',to:'2026-10-28',min:'100',max:'50'}));
  assert.ok(supplierReportFilterError({from:'2026-09-01',to:'2026-10-28',min:'NaN',max:''}));
  const rows=Array.from({length:45},(_,i)=>({id:String(i),code:'00'+i,name:'Vendor '+i,opening:-10,debit:100,credit:30,closing:60}));
  const out=supplierReportExcelRows({from:'2026-09-01',to:'2026-09-30',generatedAt:now.toISOString(),total:45,totals:{opening:-450,debit:4500,credit:1350,closing:2700}},rows);
  assert.equal(out.length,50);assert.equal(out[4][2],-450);assert.equal(out[49][0],'0044');assert.equal(out[5][5],60);
});
test('period report reconciles advances, later changes and cancellations, returns full filtered totals, pages and enforces finance/retention boundaries',async()=>{
 const db=await buildRetentionDatabase({maxVersion:127});
 try {
  await db.exec(await readFile(new URL('../migrations/0128_supplier_debt_period_report.sql',import.meta.url),'utf8'));
  await db.exec(`INSERT INTO suppliers(id,code,name,debt) VALUES
   ('period-a','PER-A','Công ty Ánh Dương',110),('period-b','PER-B','Công ty hủy phiếu',0),('period-c','PER-C','Không phát sinh',0),
   ('period-d','PER-D','Trả trước',10),('period-e','PER-E','Tạo giữa kỳ',25);
   INSERT INTO supplier_debt_transactions(id,supplier_id,transaction_type,amount_change,balance_after,created_by,transaction_date) VALUES
   ('pa0','period-a','opening_balance',-10,-10,'${adminId}','2026-09-01T00:00:00+07:00'),
   ('pa1','period-a','purchase',100,90,'${adminId}','2026-09-05T12:00:00+07:00'),
   ('pa2','period-a','supplier_payment',-30,60,'${adminId}','2026-09-10T12:00:00+07:00'),
   ('pa3','period-a','purchase',50,110,'${adminId}','2026-10-28T23:59:59.999+07:00'),
   ('pb1','period-b','purchase',100,100,'${adminId}','2026-09-02T12:00:00+07:00'),
   ('pb2','period-b','supplier_payment',-100,0,'${adminId}','2026-09-10T12:00:00+07:00'),
   ('pb3','period-b','supplier_payment_reversal',100,100,'${adminId}','2026-10-03T12:00:00+07:00'),
   ('pb4','period-b','purchase_reversal',-100,0,'${adminId}','2026-10-03T12:00:00+07:00'),
   ('pd0','period-d','opening_balance',-50,-50,'${adminId}','2026-09-01T00:00:00+07:00'),
   ('pd1','period-d','purchase',60,10,'${adminId}','2026-10-01T00:00:00+07:00'),
   ('pe1','period-e','opening_balance',25,25,'${adminId}','2026-10-05T00:00:00+07:00');`);
  const call=(p={})=>scalar(db,'SELECT rpc_supplier_debt_report($1::jsonb) AS value',[JSON.stringify({from:'2026-09-01',to:'2026-09-30',...p})]);
  await asActor(db,accountingId);
  const september=await call();assert.equal(september.total,3);assert.equal(september.rows.length,3);
  const a=september.rows.find(r=>r.id==='period-a');assert.deepEqual([a.opening,a.debit,a.credit,a.closing],[-10,100,30,60]);
  const d=september.rows.find(r=>r.id==='period-d');assert.deepEqual([d.opening,d.debit,d.credit,d.closing],[-50,0,0,-50]);
  assert.deepEqual(september.totals,{opening:-60,debit:200,credit:130,closing:10});
  for(const r of september.rows)assert.equal(r.opening+r.debit-r.credit,r.closing);
  assert.equal((await call({query:'anh duong'})).rows[0].id,'period-a');
  assert.equal((await call({status:'advance'})).rows[0].id,'period-d');
  assert.equal((await call({min:10,max:100})).total,1);
  const all=await call({status:'all',limit:2});assert.equal(all.total,5);assert.equal(all.rows.length,2);assert.deepEqual(all.totals,september.totals);
  const next=await call({status:'all',offset:2,limit:2});assert.equal(next.fingerprint,all.fingerprint);assert.ok(next.rows.every(r=>!all.rows.some(x=>x.id===r.id)));
  const later=await call({from:'2026-10-01',to:'2026-10-28'});const la=later.rows.find(r=>r.id==='period-a');assert.deepEqual([la.opening,la.debit,la.credit,la.closing],[60,50,0,110]);
  const lb=later.rows.find(r=>r.id==='period-b');assert.deepEqual([lb.opening,lb.debit,lb.credit,lb.closing],[0,100,100,0]);
  assert.equal((await call({from:'2026-10-28',to:'2026-10-28',supplierId:'period-a'})).rows[0].debit,50);
  const empty=await call({query:'no-such-vendor'});assert.equal(empty.total,0);assert.deepEqual(empty.rows,[]);assert.equal(empty.totals.closing,0);
  await assert.rejects(call({from:'2026-10-30',to:'2026-10-01'}),/kỳ báo cáo/);await assert.rejects(call({min:'NaN'}),/Khoảng công nợ/);
  await db.exec('BEGIN READ ONLY');assert.equal((await call()).total,3);await db.exec('COMMIT');
  await asActor(db,saleId);await assert.rejects(call(),/quản trị/);
  await db.exec('RESET ROLE;SET ROLE anon');await assert.rejects(call(),/permission denied/);
  await db.exec("RESET ROLE;UPDATE retention_control SET cutoff='2026-09-01T00:00:00+07:00' WHERE id");
  await asActor(db,adminId);await assert.rejects(call({from:'2026-08-31'}),/đã đóng/);
  assert.equal((await call()).total,3);
  await db.exec('RESET ROLE');
  await db.exec("INSERT INTO suppliers(id,code,name) SELECT 'report-page-'||g,'PAGE-'||g,'Page vendor '||g FROM generate_series(1,205) g");
  await asActor(db,accountingId);
  const cap=await call({status:'all',limit:1000});assert.equal(cap.rows.length,100);assert.equal(cap.total,210);
  const middle=await call({status:'all',offset:100,limit:100}),last=await call({status:'all',offset:200,limit:100});
  assert.equal(middle.fingerprint,cap.fingerprint);assert.equal(last.fingerprint,cap.fingerprint);
  assert.equal(new Set([...cap.rows,...middle.rows,...last.rows].map(r=>r.id)).size,210);
  assert.deepEqual(cap.totals,september.totals);
 }finally{await db.close();}
});
