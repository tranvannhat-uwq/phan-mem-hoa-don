import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';
import {getCustomerTotalPayments} from '../js/domain/customer-debt.js';
let db;
const call=async(name,args=[])=>{
  const result=await scalar(db,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
  if(/^rpc_(confirm_order|record_customer_receipt|record_sales_return_credit|cancel_sales_return|record_independent_return)$/.test(name)) {
    // HTTP RPCs normally commit separately. This suite wraps scenarios in a
    // rollback transaction; give each posting its real call order rather than
    // the same transaction-wide now() timestamp and random UUID tie ordering.
    await db.exec("RESET ROLE; UPDATE customer_debt_transactions SET created_at=clock_timestamp() WHERE created_at=now(); SET ROLE authenticated");
  }
  return result;
};
const owner=()=>db.exec('RESET ROLE');
async function reject(fn,pattern) {
  await db.exec('SAVEPOINT expected_failure');
  await assert.rejects(fn,pattern);
  await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
}
async function dates() { const status=await call('rpc_retention_status'); return {cutoff:status.next_cutoff,old:new Date(Date.parse(status.next_cutoff)-86400000).toISOString()}; }
async function order(date,quantity=1) { return call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',pricelistId:'retention-prices',date,idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity}]})]); }
async function prepare(archive=false) { await call('rpc_set_maintenance_mode',[true,'Synthetic maintenance']); return call('rpc_prepare_monthly_retention',[randomUUID(),archive]); }
function confirmation(p) { return 'XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(p.preview.cutoff)); }
async function execute(p) { return call('rpc_execute_monthly_retention',[p.job_id,p.backup_sha256,confirmation(p)]); }
async function debt() { await owner(); return Number(await scalar(db,"SELECT debt AS value FROM customers WHERE id='retention-customer'")); }
before(async()=>{db=await buildRetentionDatabase();});
after(async()=>{await db.close();});
beforeEach(async()=>{await owner(); await db.exec("SELECT set_config('request.jwt.claim.sub','',false); BEGIN;"); await asActor(db);});
afterEach(async()=>{await db.exec('ROLLBACK; RESET ROLE');});

test('pending external inventory and unknown foreign keys block deletion before backup',async()=>{
  const date=await dates(); const sale=(await order(date.old)).order.id;
  await owner(); await db.query('INSERT INTO inventory_sync_outbox(order_id) VALUES($1)',[sale]); await asActor(db);
  assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/kho ngoài/);
  await owner(); await db.exec('DELETE FROM inventory_sync_outbox; CREATE TABLE unsupported_child(id text PRIMARY KEY,order_id text REFERENCES orders(id));');
  await asActor(db); assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/liên kết mới/);
  await reject(()=>prepare(),/Chưa thể dọn/);
  assert.equal(await debt(),100);
});

test('deferred failure rolls back old orders, checkpoints, archive cleanup and job state',async()=>{
  const date=await dates(); const sale=(await order(date.old)).order.id;
  await owner();
  await db.query("INSERT INTO activity_logs_archive_pre_20260804(id,operation_key,actor_id,actor_name,action,module,target_type,target_id,created_at) VALUES('synthetic-archive','synthetic',$2,'Synthetic','TEST','orders','order','synthetic',$1)",[date.old,adminId]);
  await db.exec(`CREATE FUNCTION test_retention_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic late constraint failure'; END $$;
    CREATE CONSTRAINT TRIGGER zz_test_late AFTER DELETE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_retention_fail();`);
  // The owner explicitly registers this synthetic failure hook for this one
  // rollback test. Normal unexpected trigger changes are blocked in preview.
  await db.exec('UPDATE retention_control SET expected_trigger_hash=p107_trigger_fingerprint()');
  await asActor(db); const p=await prepare(true);
  await reject(()=>execute(p),/Synthetic late constraint/);
  await owner();
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders WHERE id=$1',[sale])),1);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM activity_logs_archive_pre_20260804')),1);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_customer_balances')),0);
  assert.equal(await scalar(db,'SELECT state AS value FROM retention_jobs WHERE id=$1',[p.job_id]),'prepared');
  assert.equal(await debt(),100);
});

test('credit and imported customers with no ledger retain exact latest totals and future writes',async()=>{
  await owner();
  await db.exec(`INSERT INTO customers(id,code,name,debt,total_transaction,total_return,net_revenue,imported_debt_baseline)
    VALUES('imported-negative','NEG','Synthetic negative credit',-500,2000,250,1750,-500),('imported-only','ONLY','Synthetic no ledger',250,1000,50,950,250);`);
  await asActor(db); const p=await prepare(true); await execute(p);
  await owner(); await db.exec('SET CONSTRAINTS ALL DEFERRED');
  const actual=(await db.query("SELECT id,debt,total_transaction,total_return,net_revenue FROM customers WHERE id LIKE 'imported-%' ORDER BY id")).rows;
  assert.equal(Number(actual[0].debt),-500);assert.equal(Number(actual[1].debt),250);
  assert.equal(Number(await scalar(db,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('imported-negative')")),-500);
  await asActor(db,adminId,1);
  await call('rpc_record_customer_receipt',['imported-only',50,'Synthetic next receipt','cash',randomUUID(),'Thu tiền khách hàng',new Date().toISOString()]);
  await owner(); assert.equal(Number(await scalar(db,"SELECT debt AS value FROM customers WHERE id='imported-only'")),200);
  await reject(()=>call('rpc_record_customer_receipt',['imported-only',1,'Closed period','cash',randomUUID(),'Thu tiền khách hàng',new Date(Date.parse(p.preview.cutoff)-1000).toISOString()]),/đã đóng/);
});

test('unreviewed trigger changes block a purge instead of allowing external side effects',async()=>{
  await owner();await db.exec(`CREATE FUNCTION synthetic_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$;
    CREATE TRIGGER unreviewed_delete_hook BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION synthetic_trigger();`);
  await asActor(db);const p=await call('rpc_preview_monthly_retention',[false]);
  assert.match(p.blockers.join(' '),/Trigger/);
  await reject(()=>prepare(),/Chưa thể dọn/);
});

test('cash/bank/wallet opening and receipt totals remain continuous, with successful archive removal',async()=>{
  const date=await dates();
  for(const [index,method] of ['cash','bank','wallet'].entries()) {
    await call('rpc_record_customer_receipt',['retention-customer',10*(index+1),'Synthetic old receipt',method,randomUUID(),'Thu tiền khách hàng',date.old]);
  }
  const before=await call('rpc_get_cashbook_window',[date.cutoff,new Date(Date.now()+86400000).toISOString()]);
  await owner();
  const ledger=(await db.query('SELECT * FROM customer_debt_transactions')).rows;
  const totalBefore=getCustomerTotalPayments(ledger);
  await db.query("INSERT INTO activity_logs_archive_pre_20260804(id,operation_key,actor_id,actor_name,action,module,target_type,target_id,created_at) VALUES('synthetic-archive','synthetic',$2,'Synthetic','TEST','orders','order','synthetic',$1)",[date.old,adminId]);
  await asActor(db);const p=await prepare(true);await execute(p);
  await owner();await db.exec('SET CONSTRAINTS ALL DEFERRED');await asActor(db,adminId,1);
  const after=await call('rpc_get_cashbook_window',[date.cutoff,new Date(Date.now()+86400000).toISOString()]);
  assert.deepEqual(after.opening_net_by_method,before.opening_net_by_method);
  await owner(); const cp=await scalar(db,"SELECT to_jsonb(c) AS value FROM retention_customer_balances c WHERE customer_id='retention-customer'");
  assert.equal(Number(cp.payment_carry),totalBefore);assert.equal(totalBefore,60);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM activity_logs_archive_pre_20260804')),0);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM audit_logs WHERE record_id IN(SELECT id FROM orders)')),0);
  await asActor(db,adminId,1); await call('rpc_record_customer_receipt',['retention-customer',5,'Synthetic next receipt','cash',randomUUID(),'Thu tiền khách hàng',new Date().toISOString()]);
  assert.equal(await debt(),-65);
});

test('supplier opening carries survive the next canonical recomputation and payment',async()=>{
  const date=await dates(); await owner();
  await db.exec("INSERT INTO suppliers(id,name,opening_debt,debt) VALUES('retention-supplier','Synthetic supplier',50,50);");
  await asActor(db);
  await call('rpc_create_purchase',[JSON.stringify({supplierId:'retention-supplier',purchaseDate:date.old,idempotencyKey:randomUUID(),
    items:[{productId:'retention-sku',code:'RET-SKU',name:'Synthetic sealed product',quantity:10,unitPrice:100}],paidAmount:200,paymentMethod:'bank'})]);
  // Initial payment is posted now by the purchase RPC; it remains as a
  // current independent supplier payment after the older purchase is removed.
  const p=await prepare(); await execute(p); await owner(); await db.exec('SET CONSTRAINTS ALL DEFERRED');
  const before=await scalar(db,"SELECT to_jsonb(s) AS value FROM suppliers s WHERE id='retention-supplier'");
  assert.equal(Number(before.debt),850); assert.equal(Number(before.total_purchase),1000);
  await asActor(db,adminId,1);
  await call('rpc_record_supplier_payment',[JSON.stringify({supplierId:'retention-supplier',amount:100,paymentMethod:'cash',idempotencyKey:randomUUID()})]);
  await owner(); const after=await scalar(db,"SELECT to_jsonb(s) AS value FROM suppliers s WHERE id='retention-supplier'");
  assert.equal(Number(after.debt),750);assert.equal(Number(after.total_purchase),1000);assert.equal(Number(after.total_paid),300);
});

test('independent return validation, authorization, negative credit and idempotency',async()=>{
  const input={customerId:'retention-customer',companyId:'ABS_NORTH',reason:'Synthetic approved return',sealConfirmed:true,
    idempotencyKey:randomUUID(),items:[{productId:'retention-sku',quantity:2,unitPrice:100,deductionPercent:0}]};
  await asActor(db,saleId);await reject(()=>call('rpc_record_independent_return',[JSON.stringify(input)]),/Admin|Kế toán/);
  await asActor(db,accountingId);
  await reject(()=>call('rpc_record_independent_return',[JSON.stringify({...input,sealConfirmed:false})]),/niêm phong/);
  await reject(()=>call('rpc_record_independent_return',[JSON.stringify({...input,items:[...input.items,...input.items]})]),/SKU/);
  const result=await call('rpc_record_independent_return',[JSON.stringify(input)]);
  const retry=await call('rpc_record_independent_return',[JSON.stringify(input)]);
  assert.equal(result.return_id,retry.return_id); assert.equal(retry.already_recorded,true);assert.equal(Number(retry.new_debt),-200);
  await reject(()=>call('rpc_record_independent_return',[JSON.stringify({...input,reason:'Changed contents'})]),/nội dung khác/);
  await call('rpc_cancel_sales_return',[result.return_id,'Synthetic cancellation']);
  assert.equal(await debt(),0);
  await asActor(db,accountingId);
  const linkedOrder=(await order(new Date().toISOString(),2)).order.id;
  await owner();const linkedItem=await scalar(db,'SELECT id AS value FROM order_items WHERE order_id=$1',[linkedOrder]);
  await asActor(db,accountingId);
  const linked=await call('rpc_record_sales_return_credit',[JSON.stringify({orderId:linkedOrder,idempotencyKey:randomUUID(),reason:'Synthetic existing linked return',items:[{saleItemId:linkedItem,quantity:1}]})]);
  await call('rpc_cancel_sales_return',[linked.return_id,'Synthetic existing route cancellation']);
  assert.equal(await debt(),200,'The original order-backed cancellation route remains intact');
});

test('a following monthly purge adds only the newly removed movements to prior openings',async()=>{
  const date=await dates();
  const retained=new Date(Date.parse(date.cutoff)+86400000).toISOString();
  await order(date.old,10);await order(retained,2);await order(new Date().toISOString(),3);
  await call('rpc_record_customer_receipt',['retention-customer',100,'Synthetic first receipt','cash',randomUUID(),'Thu tiền khách hàng',date.old]);
  await call('rpc_record_customer_receipt',['retention-customer',50,'Synthetic second receipt','cash',randomUUID(),'Thu tiền khách hàng',retained]);
  const expected=await debt();await asActor(db);
  const first=await prepare();await execute(first);await owner();await db.exec('SET CONSTRAINTS ALL DEFERRED');
  await db.exec('DROP TABLE _retention_ids,_retention_preserved,_retention_openings,_retention_cash_rows'); // ON COMMIT DROP in real HTTP calls
  const nextBoundary=new Date(date.cutoff);nextBoundary.setUTCMonth(nextBoundary.getUTCMonth()+1);
  await db.exec(`CREATE OR REPLACE FUNCTION public.p107_cutoff() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${nextBoundary.toISOString()}'::timestamptz $$;`);
  await asActor(db,adminId,1);const second=await prepare();await execute(second);await owner();
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders')),1);
  assert.equal(await debt(),expected);
  assert.equal(Number(await scalar(db,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('retention-customer')")),expected);
  assert.equal(Number(await scalar(db,"SELECT payment_carry AS value FROM retention_customer_balances WHERE customer_id='retention-customer'")),150);
  assert.equal(Number(await scalar(db,'SELECT epoch AS value FROM retention_control')),2);
});

test('a detached historical cash-refund return cancels its original split without changing customer credit',async()=>{
  const date=await dates(); const sale=(await order(date.old)).order.id;
  await call('rpc_record_customer_receipt',['retention-customer',100,'Synthetic paid old sale','cash',randomUUID(),'Thu tiền khách hàng',date.old]);
  await owner();const item=await scalar(db,'SELECT id AS value FROM order_items WHERE order_id=$1',[sale]);await asActor(db);
  const ret=await call('rpc_record_sales_return_credit',[JSON.stringify({orderId:sale,idempotencyKey:randomUUID(),reason:'Synthetic historic cash-refund fixture',items:[{saleItemId:item,quantity:1}]})]);
  // Reproduce the pre-0103 data shape using a documented, synthetic cash split.
  await owner();await db.query('DELETE FROM customer_debt_transactions WHERE sales_return_id=$1',[ret.return_id]);
  await db.exec("UPDATE customers SET debt=0 WHERE id='retention-customer'");
  await db.query("INSERT INTO cashbook_transactions(id,date,transaction_date,type,direction,value,method,payment_method,status,order_id,sales_return_id,customer_id) VALUES('synthetic-refund',now(),now(),'chi','out',100,'cash','cash','completed',$1,$2,'retention-customer')",[sale,ret.return_id]);
  await db.query("UPDATE sales_returns SET debt_reduction_amount=0,refund_amount=100,refund_cashbook_transaction_id='synthetic-refund',debt_ledger_id=NULL WHERE id=$1",[ret.return_id]);
  await asActor(db);const p=await prepare();await execute(p);await owner();await db.exec('SET CONSTRAINTS ALL DEFERRED');
  await asActor(db,adminId,1);await call('rpc_cancel_sales_return',[ret.return_id,'Synthetic post-purge cancellation']);
  assert.equal(await debt(),0);
  assert.equal(await scalar(db,"SELECT status AS value FROM cashbook_transactions WHERE id='synthetic-refund'"),'cancelled');
  assert.equal(Number(await scalar(db,"SELECT total_return AS value FROM customers WHERE id='retention-customer'")),0);
});

test('recent audit copies cannot keep old statement arrays or nested purged document snapshots',async()=>{
  const date=await dates();const sale=(await order(date.old)).order.id;
  await owner();
  await db.query("INSERT INTO audit_logs(id,table_name,record_id,action,old_data,new_data) VALUES('synthetic-copy','customers','retention-customer','UPDATE',$1,$2)",
    [JSON.stringify({id:'retention-customer',debt_history:[{date:date.old,note:'synthetic-private-history'}]}),JSON.stringify({id:'retention-customer',debt_history:[]})]);
  await db.query("INSERT INTO activity_logs(id,operation_key,actor_id,actor_name,action,module,target_type,target_id,changes) VALUES('synthetic-nested-copy','synthetic-nested',$1,'Synthetic','UPDATE','customers','customer','retention-customer',$2)",
    [adminId,JSON.stringify({order_id:{old:{id:sale,items:[{price:100}]},new:null}})]);
  await asActor(db);const p=await prepare();await execute(p);await owner();
  const log=await scalar(db,"SELECT old_data AS value FROM audit_logs WHERE id='synthetic-copy'");
  assert.ok(!JSON.stringify(log).includes('synthetic-private-history'));
  assert.ok(!JSON.stringify(log).includes('debt_history'));
  assert.equal(Number(await scalar(db,"SELECT count(*) AS value FROM activity_logs WHERE id='synthetic-nested-copy'")),0);
});

test('inventory receiving and return cancellation are atomic even when stock is already consumed',async()=>{
  await call('rpc_inventory_post',[JSON.stringify({requestKey:randomUUID(),kind:'count',note:'Synthetic opening',items:[{productId:'retention-sku',quantity:10,expectedQuantity:0}]})]);
  await call('rpc_inventory_activate',[true]);
  const result=await call('rpc_record_independent_return',[JSON.stringify({customerId:'retention-customer',companyId:'ABS_NORTH',reason:'Synthetic sealed return',sealConfirmed:true,idempotencyKey:randomUUID(),items:[{productId:'retention-sku',quantity:2,unitPrice:100}]})]);
  await owner(); assert.equal(Number(await scalar(db,"SELECT quantity AS value FROM inventory_balances WHERE product_id='retention-sku'")),12);
  await asActor(db);await call('rpc_inventory_post',[JSON.stringify({requestKey:randomUUID(),kind:'issue',note:'Synthetic usage',items:[{productId:'retention-sku',quantity:11}]})]);
  await reject(()=>call('rpc_cancel_sales_return',[result.return_id,'Synthetic underflow cancellation']),/không đủ tồn/);
  assert.equal(await debt(),-200);
  await owner();assert.equal(await scalar(db,'SELECT status AS value FROM sales_returns WHERE id=$1',[result.return_id]),'completed');
});

test('retained receipt amendment and cancellation do not consume historical payment carries',async()=>{
  const date=await dates();
  await order(date.old,10);
  await call('rpc_record_customer_receipt',['retention-customer',100,'Synthetic old receipt','cash',randomUUID(),'Thu tiền khách hàng',date.old]);
  await call('rpc_record_customer_receipt',['retention-customer',50,'Synthetic retained receipt','bank',randomUUID(),'Thu tiền khách hàng',new Date().toISOString()]);
  await owner();
  const receipt=await scalar(db,"SELECT id AS value FROM cashbook_transactions WHERE customer_id='retention-customer' AND value=50");
  await asActor(db);const p=await prepare();await execute(p);
  await owner();await db.exec('SET CONSTRAINTS ALL DEFERRED');await asActor(db,adminId,1);
  await call('rpc_amend_cashbook_transaction',[receipt,JSON.stringify({value:80,reason:'Synthetic retained amount correction'})]);
  assert.equal(await debt(),820);
  await asActor(db,adminId,1);await call('rpc_cancel_cashbook_entry',[receipt,'Synthetic cancellation after purge']);
  assert.equal(await debt(),900);
  assert.equal(Number(await scalar(db,"SELECT payment_carry AS value FROM retention_customer_balances WHERE customer_id='retention-customer'")),100);
  assert.equal(Number(await scalar(db,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('retention-customer')")),900);
});

test('retained order cancellation and a new sale preserve deleted lifetime turnover',async()=>{
  const date=await dates();await order(date.old,10);
  const current=(await order(new Date().toISOString(),3)).order.id;
  const p=await prepare();await execute(p);await owner();await db.exec('SET CONSTRAINTS ALL DEFERRED');
  await asActor(db,adminId,1);await call('rpc_cancel_order',[current,'Synthetic retained cancellation']);
  assert.equal(await debt(),1000);
  assert.equal(Number(await scalar(db,"SELECT total_transaction AS value FROM customers WHERE id='retention-customer'")),1000);
  await asActor(db,adminId,1);await order(new Date().toISOString(),2);
  assert.equal(await debt(),1200);
  assert.equal(Number(await scalar(db,"SELECT total_transaction AS value FROM customers WHERE id='retention-customer'")),1200);
  assert.equal(Number(await scalar(db,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('retention-customer')")),1200);
});

test('return response helper cannot bypass customer scope or maintenance through direct API calls',async()=>{
  const result=await call('rpc_record_independent_return',[JSON.stringify({customerId:'retention-customer',companyId:'ABS_NORTH',
    reason:'Synthetic private return',sealConfirmed:true,idempotencyKey:randomUUID(),
    items:[{productId:'retention-sku',quantity:1,unitPrice:100}]})]);
  await owner();await db.query("UPDATE customers SET managed_by=$1 WHERE id='retention-customer'",[accountingId]);
  await asActor(db,saleId);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM sales_returns WHERE id=$1',[result.return_id])),0);
  await reject(()=>call('p3_sales_return_response',[result.return_id]),/permission denied/);
  await asActor(db);await call('rpc_set_maintenance_mode',[true,'Synthetic helper privacy check']);
  await asActor(db,accountingId);await reject(()=>call('p3_sales_return_response',[result.return_id]),/permission denied/);
  await asActor(db);assert.ok((await call('rpc_list_independent_returns',['{}'])).rows.length);
});

test('retained or undated commissions linked to old cash vouchers block deletion',async()=>{
  const date=await dates();
  await call('rpc_record_customer_receipt',['retention-customer',100,'Synthetic old commission receipt','cash',randomUUID(),'Thu tiền khách hàng',date.old]);
  await owner();
  await db.exec(`INSERT INTO commission_transactions(id,employee_id,salary_period,cashbook_transaction_id,transaction_type,commission_amount)
    SELECT 'synthetic-cash-commission','synthetic-employee',to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM'),id,'receipt_commission',10
    FROM cashbook_transactions WHERE customer_id='retention-customer' LIMIT 1;`);
  await asActor(db);
  assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/Hoa hồng/);
  await reject(()=>prepare(),/Chưa thể dọn/);
  await owner();await db.exec("UPDATE commission_transactions SET salary_period=NULL WHERE id='synthetic-cash-commission'");await asActor(db);
  assert.match((await call('rpc_preview_monthly_retention',[false])).blockers.join(' '),/Hoa hồng/);
  await reject(()=>prepare(),/Chưa thể dọn/);
  await owner();
  assert.equal(Number(await scalar(db,"SELECT count(*) AS value FROM commission_transactions WHERE id='synthetic-cash-commission'")),1);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM retention_jobs')),0);
});
