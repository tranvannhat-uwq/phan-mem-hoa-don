import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildRetentionDatabase, asActor, scalar, adminId, accountingId, saleId } from './helpers/retention-db.mjs';

test('supplier directory pages complete authoritative totals/dates and preserves finance-only access',async()=>{
  const db=await buildRetentionDatabase({maxVersion:125});
  try {
    const beforeAcl=await scalar(db,"SELECT proacl::text AS value FROM pg_proc WHERE oid='public.p4_supplier_response(text)'::regprocedure");
    await db.exec(await readFile(new URL('../migrations/0126_supplier_directory_dates.sql',import.meta.url),'utf8'));
    assert.equal(await scalar(db,"SELECT proacl::text AS value FROM pg_proc WHERE oid='public.p4_supplier_response(text)'::regprocedure"),beforeAcl);
    await db.exec(`SET session_replication_role=replica;
      INSERT INTO suppliers(id,code,name,debt,total_purchase,total_paid,opening_debt)
      SELECT 'directory-'||lpad(g::text,3,'0'),'NCC-'||g,'Supplier '||g,50,100,50,0 FROM generate_series(1,405) g;
      INSERT INTO suppliers(id,code,name,is_active) VALUES ('inactive-directory','OFF','Inactive',false);
      INSERT INTO purchases(id,code,supplier_id,purchase_date,subtotal_amount,total_amount,paid_amount,balance_due,status,created_by) VALUES
      ('dir-p1','DIR-P1','directory-001','2026-09-01T00:00:00Z',100,100,0,100,'completed','${adminId}'),
      ('dir-p2','DIR-P2','directory-001','2026-10-01T00:00:00Z',100,100,0,100,'completed','${adminId}'),
      ('dir-p3','DIR-P3','directory-001','2026-10-28T00:00:00Z',100,100,0,100,'cancelled','${adminId}');
      INSERT INTO purchase_payments(id,supplier_id,amount,status,created_by,created_at) VALUES
      ('dir-pay1','directory-001',50,'completed','${adminId}','2026-10-05T00:00:00Z'),
      ('dir-pay2','directory-001',50,'cancelled','${adminId}','2026-10-28T00:00:00Z');
      SET session_replication_role=origin;`);
    const call=(offset=0,limit=200)=>scalar(db,'SELECT rpc_supplier_directory($1,$2) AS value',[offset,limit]);
    await asActor(db,accountingId);
    await db.exec('BEGIN READ ONLY');
    const first=await call(0,9999); assert.equal(first.rows.length,200); assert.equal(first.total,405);
    const second=await call(200);const third=await call(400);
    assert.equal(new Set([...first.rows,...second.rows,...third.rows].map(x=>x.id)).size,405);
    const supplier=first.rows.find(x=>x.id==='directory-001');
    assert.equal(supplier.debt,50);assert.equal(supplier.total_purchase,100);assert.equal(supplier.total_paid,50);
    assert.equal(Date.parse(supplier.last_purchase_at),Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(Date.parse(supplier.last_payment_at),Date.parse('2026-10-05T00:00:00Z'));
    assert.ok(supplier.created_at&&supplier.updated_at);
    await db.exec('ROLLBACK');
    await assert.rejects(call(-1),/Invalid supplier offset/);
    await asActor(db,saleId);await assert.rejects(call(),/Không có quyền/);
    await db.exec('RESET ROLE;SET ROLE anon');await assert.rejects(call(),/permission denied/);
    await asActor(db,adminId);await assert.rejects(scalar(db,"SELECT p4_supplier_response('directory-001') AS value"),/permission denied/);
    await db.exec('RESET ROLE');
    const response=await scalar(db,"SELECT p4_supplier_response('directory-001') AS value");
    assert.equal(Date.parse(response.supplier.lastPurchaseAt),Date.parse(supplier.last_purchase_at));
    assert.equal(Date.parse(response.supplier.lastPaymentAt),Date.parse(supplier.last_payment_at));
    await db.exec("SET session_replication_role=replica;UPDATE purchases SET status='cancelled';UPDATE purchase_payments SET status='cancelled';SET session_replication_role=origin;");
    const cancelled=await scalar(db,"SELECT p4_supplier_response('directory-001') AS value");
    assert.equal(cancelled.supplier.lastPurchaseAt,null);assert.equal(cancelled.supplier.lastPaymentAt,null);
  }finally{await db.close();}
});
