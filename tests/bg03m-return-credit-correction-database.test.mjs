import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {buildRetentionDatabase, asActor} from './helpers/retention-db.mjs';

let db;
const customerId='cust-1785809280204-263-435';
const returnId='RET3-20261022-00000022';
const voucherId='PC-RET-20261022-00001766';
const orderId='HD-20261013-00002625';
const admin='a1040000-0000-4000-8000-000000000001';
const directory=new URL('../migrations/',import.meta.url);
const read=async name=>(await readFile(new URL(name,directory),'utf8')).replace(/^\uFEFF/,'');
const value=async(sql,args=[])=> (await db.query(sql,args)).rows[0]?.value;

before(async()=>{
  db=await buildRetentionDatabase({maxVersion:138});
  await db.exec(`INSERT INTO auth.users(id,email) VALUES('${admin}','correction-test@test.invalid');
    UPDATE public.profiles SET role='admin' WHERE auth_user_id='${admin}';
    INSERT INTO public.customers(id,code,name,debt,total_transaction,total_return,net_revenue)
      VALUES('${customerId}','ĐÀO TIÊN SINH - NANO10 - HẢI PHÒNG - BG03M','Synthetic return customer',-422,5024578,528750,4495828),
        ('unrelated-customer','UNRELATED','Synthetic unrelated customer',0,0,0,0);
    INSERT INTO public.customer_debt_transactions(id,customer_id,transaction_type,amount,debt_change,balance_before,balance_after,description)
      VALUES('opening-credit','${customerId}','adjust',422,-422,0,-422,'Synthetic opening balance');
    INSERT INTO public.orders(id,customer_id,customer_name,status,total_payable,returned_amount,net_revenue)
      VALUES('${orderId}','${customerId}','Synthetic return customer','draft',528750,528750,0);
    INSERT INTO public.order_items(id,order_id,product_id,quantity,unit_price,line_total,returned_quantity,returned_amount)
      VALUES('bg03m-sale-item','${orderId}','retention-sku',1,1125000,1125000,1,528750);
    INSERT INTO public.sales_returns(id,sale_id,order_id,customer_id,total_refund,total_return_amount,debt_reduction_amount,
      refund_amount,status,refund_cashbook_transaction_id,request_fingerprint,idempotency_key,created_by)
      VALUES('${returnId}','${orderId}','${orderId}','${customerId}',528750,528750,0,528750,'completed','${voucherId}',
        '9e3824b0aab1c9e3b1b0180dae542510','synthetic-credit-correction','${admin}');
    INSERT INTO public.sales_return_items(id,return_id,sale_item_id,product_id,quantity,refund_price,subtotal)
      VALUES('bg03m-return-item','${returnId}','bg03m-sale-item','retention-sku',1,528750,528750);
    INSERT INTO public.cashbook_transactions(id,customer_id,order_id,sales_return_id,value,type,direction,transaction_type,status,
      method,payment_method,accounting)
      VALUES('${voucherId}','${customerId}','${orderId}','${returnId}',528750,'chi','out','sales_return_refund','completed','cash','cash',false);`);
});
after(async()=>{await db?.close();});

test('a new posting after preflight stops the correction without overwriting the new balance',async()=>{
  await db.exec(`BEGIN;
    INSERT INTO public.customer_debt_transactions(id,customer_id,transaction_type,amount,debt_change,balance_before,balance_after)
      VALUES('concurrent-posting','${customerId}','adjust',1,1,-422,-421);
    UPDATE public.customers SET debt=-421 WHERE id='${customerId}';`);
  try {
    await assert.rejects(db.exec(await read('0139_bg03m_return_credit_correction.sql')),/totals changed/);
  } finally { await db.exec('ROLLBACK'); }
  assert.equal(Number(await value('SELECT debt AS value FROM public.customers WHERE id=$1',[customerId])),-422);
});

test('the reviewed correction fails atomically if the current balance or voucher changed',async()=>{
  await db.exec('BEGIN');
  await db.exec(`UPDATE public.cashbook_transactions SET amendment_count=1 WHERE id='${voucherId}'`);
  await assert.rejects(db.exec(await read('0139_bg03m_return_credit_correction.sql')),/voucher was changed/);
  await db.exec('ROLLBACK');
  assert.equal(Number(await value('SELECT debt AS value FROM public.customers WHERE id=$1',[customerId])),-422);
  assert.equal(await value('SELECT status AS value FROM public.cashbook_transactions WHERE id=$1',[voucherId]),'completed');
  assert.equal(Number(await value("SELECT count(*) AS value FROM public.customer_debt_transactions WHERE sales_return_id=$1",[returnId])),0);
});

test('cash-only return converts once to full customer credit while preserving sales, items and other customers',async()=>{
  const oldOrder=(await db.query('SELECT * FROM public.orders WHERE id=$1',[orderId])).rows[0];
  const oldItems=(await db.query('SELECT * FROM public.sales_return_items WHERE return_id=$1',[returnId])).rows;
  const oldSaleItems=(await db.query('SELECT * FROM public.order_items WHERE order_id=$1',[orderId])).rows;
  assert.equal(oldItems.length,1);
  await db.exec(await read('0139_bg03m_return_credit_correction.sql'));
  const customer=(await db.query('SELECT debt,total_return,net_revenue FROM public.customers WHERE id=$1',[customerId])).rows[0];
  assert.equal(Number(customer.debt),-529172);
  assert.equal(Number(customer.total_return),528750);
  assert.equal(Number(customer.net_revenue),4495828);
  assert.equal(Number(await value('SELECT calculated_balance AS value FROM public.p74_customer_debt_ledger_balance($1)',[customerId])),-529172);
  assert.equal(Number(await value("SELECT debt AS value FROM public.customers WHERE id='unrelated-customer'")),0);
  const returned=(await db.query('SELECT * FROM public.sales_returns WHERE id=$1',[returnId])).rows[0];
  assert.equal(returned.status,'completed');
  assert.equal(Number(returned.refund_amount),0);
  assert.equal(Number(returned.debt_reduction_amount),528750);
  assert.equal(returned.refund_cashbook_transaction_id,null);
  assert.ok(returned.debt_ledger_id);
  assert.equal(await value('SELECT status AS value FROM public.cashbook_transactions WHERE id=$1',[voucherId]),'cancelled');
  assert.equal(Number(await value('SELECT value AS value FROM public.cashbook_transactions WHERE reversal_of_id=$1',[voucherId])),528750);
  assert.equal(Number(await value("SELECT count(*) AS value FROM public.cashbook_transactions WHERE sales_return_id=$1 AND status='completed'",[returnId])),0);
  assert.deepEqual((await db.query('SELECT * FROM public.orders WHERE id=$1',[orderId])).rows[0],oldOrder);
  assert.deepEqual((await db.query('SELECT * FROM public.sales_return_items WHERE return_id=$1',[returnId])).rows,oldItems);
  assert.deepEqual((await db.query('SELECT * FROM public.order_items WHERE order_id=$1',[orderId])).rows,oldSaleItems);
  const audit=(await db.query("SELECT old_data,new_data FROM public.audit_logs WHERE record_id=$1 AND action='CONVERT_AUTOMATIC_REFUND_TO_CREDIT'",[returnId])).rows[0];
  assert.equal(Number(audit.old_data.customer_debt),-422);
  assert.equal(Number(audit.old_data.refund_voucher_snapshot.value),528750);
  assert.equal(Number(audit.new_data.customer_debt),-529172);
  await db.exec(await read('0139_bg03m_return_credit_correction.sql'));
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.customer_debt_transactions WHERE sales_return_id=$1',[returnId])),1);
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.cashbook_transactions WHERE reversal_of_id=$1',[voucherId])),1);
});

test('the corrected return can still be cancelled using the normal atomic return RPC',async()=>{
  await asActor(db,admin);
  const result=await value('SELECT public.rpc_cancel_sales_return($1,$2) AS value',[returnId,'Synthetic cancellation after correction']);
  assert.equal(Number(result.new_debt),-422);
  assert.equal(Number(result.new_total_return),0);
  await db.exec('RESET ROLE');
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.cashbook_transactions WHERE reversal_of_id=$1',[voucherId])),1);
});
