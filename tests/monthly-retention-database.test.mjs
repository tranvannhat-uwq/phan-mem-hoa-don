import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';

let db; let oldOrder; let currentOrder; let keptReturn; let oldReceiptKey;
const call=async(name,args=[])=>scalar(db,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
const customer=async()=>{await db.exec('RESET ROLE');return (await db.query("SELECT to_jsonb(c) AS value FROM customers c WHERE id='retention-customer'")).rows[0].value;};
before(async()=>{db=await buildRetentionDatabase();});
after(async()=>{if(db)await db.close();});

test('real order/receipt/return RPCs build a backdated cross-period fixture',async()=>{
  await asActor(db);
  const cutoff=(await call('rpc_retention_status')).next_cutoff;
  const oldDate=new Date(new Date(cutoff).getTime()-86400000).toISOString();
  const retainedDate=new Date(new Date(cutoff).getTime()+86400000).toISOString();
  const order=async(date,quantity)=>call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',
    pricelistId:'retention-prices',date,idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity,discountType:'percent',discountValue:0}]})]);
  oldOrder=(await order(oldDate,10)).order.id;
  currentOrder=(await order(retainedDate,3)).order.id;
  oldReceiptKey=randomUUID();
  await call('rpc_record_customer_receipt',['retention-customer',200,'Synthetic old receipt','cash',oldReceiptKey,'Thu tiền khách hàng',oldDate]);
  await db.exec('RESET ROLE');
  const oldItem=await scalar(db,'SELECT id AS value FROM order_items WHERE order_id=$1',[oldOrder]);
  await asActor(db);
  keptReturn=(await call('rpc_record_sales_return_credit',[JSON.stringify({orderId:oldOrder,idempotencyKey:randomUUID(),
    reason:'Synthetic retained return for old sale',items:[{saleItemId:oldItem,quantity:1,deductionPercent:0}]})])).return_id;
  await db.exec('RESET ROLE');
  await db.query(`BEGIN;`);
  await db.query(`INSERT INTO customer_debt_transactions(id,customer_id,transaction_type,amount,debt_change,
    balance_before,balance_after,order_id,transaction_date,created_at)
    SELECT 'synthetic-backdated','retention-customer','order_amend',7,7,debt,debt+7,$1,$2,now() FROM customers WHERE id='retention-customer'`,[oldOrder,oldDate]);
  await db.exec("UPDATE customers SET debt=debt+7 WHERE id='retention-customer'; COMMIT;");
  assert.equal(Number((await customer()).debt),1007);
});

test('preview and backup require Admin, maintenance and produce a verifiable recovery bundle',async()=>{
  for(const id of [accountingId,saleId]) {
    await asActor(db,id);
    await assert.rejects(call('rpc_preview_monthly_retention',[false]),/Admin/);
    await assert.rejects(call('rpc_prepare_monthly_retention',[randomUUID(),false]),/Admin/);
  }
  await asActor(db);
  await assert.rejects(call('rpc_prepare_monthly_retention',[randomUUID(),false]),/bảo trì/);
  await call('rpc_set_maintenance_mode',[true,'Synthetic maintenance']);
  const preview=await call('rpc_preview_monthly_retention',[false]);
  assert.deepEqual(preview.blockers,[]);
  assert.equal(preview.counts.orders,1);
  const prepared=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
  assert.equal(createHash('sha256').update(prepared.backup_text).digest('hex'),prepared.backup_sha256);
  const backup=JSON.parse(prepared.backup_text);
  assert.equal(backup.format,'soviet-retention-recovery-v1');
  assert.equal(backup.tables.orders.length,2);
  assert.ok(!('users' in backup.tables));
});

test('stale backup, wrong confirmation and wrong backup digest never delete rows',async()=>{
  await asActor(db);
  const prepared=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
  await assert.rejects(call('rpc_execute_monthly_retention',[prepared.job_id,'0'.repeat(64),'XOA TRUOC 01/01/2000']),/Xác nhận/);
  await call('rpc_record_customer_receipt',['retention-customer',1,'Synthetic concurrent receipt','bank',randomUUID(),'Thu tiền khách hàng',new Date().toISOString()]);
  const confirmation='XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(prepared.preview.cutoff));
  await assert.rejects(call('rpc_execute_monthly_retention',[prepared.job_id,prepared.backup_sha256,confirmation]),/đã thay đổi/);
  await db.exec('RESET ROLE');
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders')),2);
});

test('atomic purge preserves every customer field, cash, retained documents and following transactions',async()=>{
  const before=await customer();
  await asActor(db);
  const prepared=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
  const confirmation='XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(prepared.preview.cutoff));
  const retainedPeriod=JSON.stringify({start:prepared.preview.cutoff,end:new Date(Date.now()+3600000).toISOString()});
  const retainedDashboard=await call('rpc_get_phase5_dashboard',[retainedPeriod]);
  const retainedEmployeeReport=await call('rpc_get_employee_business_report',[retainedPeriod]);
  const companyPeriod=JSON.stringify({...JSON.parse(retainedPeriod),company_id:'ABS_NORTH'});
  const companyDebtBefore=(await call('rpc_get_employee_business_report',[companyPeriod])).summary.debt_balance;
  const result=await call('rpc_execute_monthly_retention',[prepared.job_id,prepared.backup_sha256,confirmation]);
  assert.equal(result.verified,true);
  assert.deepEqual(await customer(),before);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders WHERE id=$1',[oldOrder])),0);
  assert.equal(Number(await scalar(db,'SELECT count(*) AS value FROM orders WHERE id=$1',[currentOrder])),1);
  const kept=(await db.query('SELECT source_kind,sale_id,order_id,total_refund FROM sales_returns WHERE id=$1',[keptReturn])).rows[0];
  assert.equal(kept.source_kind,'independent');assert.equal(kept.sale_id,null);assert.equal(kept.order_id,null);
  const balance=await scalar(db,"SELECT calculated_balance AS value FROM p74_customer_debt_ledger_balance('retention-customer')");
  assert.equal(Number(balance),Number(before.debt));
  await asActor(db,adminId,0);
  await assert.rejects(call('rpc_record_customer_receipt',['retention-customer',1,'Stale session receipt','cash',randomUUID(),'Thu tiền khách hàng',new Date().toISOString()]),/RETENTION_EPOCH_CHANGED/);
  await asActor(db,adminId,1);
  assert.equal((await call('rpc_get_phase5_dashboard',[retainedPeriod])).summary.net_sales,retainedDashboard.summary.net_sales);
  assert.equal((await call('rpc_get_employee_business_report',[retainedPeriod])).summary.net_sales,retainedEmployeeReport.summary.net_sales);
  assert.equal((await call('rpc_get_employee_business_report',[companyPeriod])).summary.debt_balance,companyDebtBefore);
  await assert.rejects(call('rpc_record_customer_receipt',['retention-customer',200,'Synthetic old receipt','cash',oldReceiptKey,'Thu tiền khách hàng',new Date().toISOString()]),/không được phát lại/);
  const filter=JSON.stringify({start:prepared.preview.cutoff,end:new Date(Date.now()+3600000).toISOString(),company_id:'all',brand_id:'all'});
  const dashBefore=await call('rpc_get_phase5_dashboard',[filter]);
  const employeeBefore=await call('rpc_get_employee_business_report',[filter]);
  const independent=await call('rpc_record_independent_return',[JSON.stringify({customerId:'retention-customer',companyId:'ABS_NORTH',
    sealConfirmed:true,reason:'Synthetic independent receiving',idempotencyKey:randomUUID(),items:[{productId:'retention-sku',quantity:2,unitPrice:100,deductionPercent:0}]})]);
  assert.equal(Number(independent.new_debt),Number(before.debt)-200);
  const dashAfter=await call('rpc_get_phase5_dashboard',[filter]);
  const employeeAfter=await call('rpc_get_employee_business_report',[filter]);
  assert.equal(Number(dashAfter.summary.returns)-Number(dashBefore.summary.returns),200);
  assert.equal(Number(dashBefore.summary.net_sales)-Number(dashAfter.summary.net_sales),200);
  assert.equal(Number(dashBefore.summary.sold_quantity)-Number(dashAfter.summary.sold_quantity),2);
  assert.equal(Number(employeeBefore.summary.sold_quantity)-Number(employeeAfter.summary.sold_quantity),2);
  assert.equal(Number(employeeBefore.summary.net_sales)-Number(employeeAfter.summary.net_sales),200);
  assert.equal(Number(employeeAfter.summary.debt_balance),Number(independent.new_debt));
  for(const mode of ['product','customer','employee']) {
    const report=await call('rpc_get_phase5_report',[JSON.stringify({type:'returns',mode})]);
    assert.ok(report.rows.length,`returns ${mode} includes independent documents`);
  }
  const listed=await call('rpc_list_independent_returns',['{}']);
  assert.equal(listed.total,2);
  await call('rpc_cancel_sales_return',[independent.return_id,'Synthetic independent cancellation']);
  assert.equal(Number((await customer()).debt),Number(before.debt));
  await asActor(db,adminId,1);
  await call('rpc_cancel_sales_return',[keptReturn,'Synthetic cancellation after old order purge']);
  assert.equal(Number((await customer()).debt),Number(before.debt)+100);
  await asActor(db,adminId,1);
  const retry=await call('rpc_execute_monthly_retention',[prepared.job_id,prepared.backup_sha256,confirmation]);
  assert.equal(retry.already_completed,true);
});
