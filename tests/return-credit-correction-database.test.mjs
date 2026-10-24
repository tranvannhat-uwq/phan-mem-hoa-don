import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

let db;
const customerId='cust-1785809280224-455-820';
const returnId='RET3-20261024-00000025';
const voucherId='PC-RET-20261024-00001827';
const orderId='HD-20261017-00002796';
const admin='a1040000-0000-4000-8000-000000000001';
const directory=new URL('../migrations/',import.meta.url);
const read=async name=>(await readFile(new URL(name,directory),'utf8')).replace(/^\uFEFF/,'');
const value=async(sql,args=[])=> (await db.query(sql,args)).rows[0]?.value;

before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,instance_id uuid,aud text,role text,email text,
      encrypted_password text,raw_app_meta_data jsonb DEFAULT '{}',raw_user_meta_data jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
  for(const name of (await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=84).sort()){
    let sql=await read(name);
    if(name.startsWith('0001'))sql=sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
    await db.exec(sql);
  }
  await db.exec(await read('0103_sales_returns_credit_balance.sql'));
  await db.exec(`INSERT INTO auth.users(id,email) VALUES('${admin}','correction-test@test.invalid');
    UPDATE public.profiles SET role='admin' WHERE auth_user_id='${admin}';
    INSERT INTO public.customers(id,code,name,debt,total_transaction,total_return,net_revenue)
      VALUES('${customerId}','ĐINH XUÂN HIẾU - NANO10 - QUẢNG BÌNH - BG04M','Synthetic return customer',-23,1340400276,2166592,1338233684),
        ('unrelated-customer','UNRELATED','Synthetic unrelated customer',0,0,0,0);
    INSERT INTO public.customer_debt_transactions(id,customer_id,transaction_type,amount,debt_change,balance_before,balance_after,description)
      VALUES('opening-credit','${customerId}','adjust',23,-23,0,-23,'Synthetic opening balance');
    INSERT INTO public.orders(id,customer_id,customer_name,status,total_payable,returned_amount,net_revenue)
      VALUES('${orderId}','${customerId}','Synthetic return customer','draft',2166592,2166592,0);
    INSERT INTO public.sales_returns(id,sale_id,order_id,customer_id,total_refund,total_return_amount,debt_reduction_amount,
      refund_amount,status,refund_cashbook_transaction_id,request_fingerprint,idempotency_key,created_by)
      VALUES('${returnId}','${orderId}','${orderId}','${customerId}',2166592,2166592,0,2166592,'completed','${voucherId}',
        '48c8fb1603d652ee950b0ebe47dd8627','synthetic-credit-correction','${admin}');
    INSERT INTO public.cashbook_transactions(id,customer_id,order_id,sales_return_id,value,type,direction,transaction_type,status,
      method,payment_method,accounting)
      VALUES('${voucherId}','${customerId}','${orderId}','${returnId}',2166592,'chi','out','sales_return_refund','completed','cash','cash',false);`);
});
after(async()=>{await db?.close();});

test('the reviewed correction fails atomically if the current balance or voucher changed',async()=>{
  await db.exec('BEGIN');
  await db.exec(`UPDATE public.cashbook_transactions SET amendment_count=1 WHERE id='${voucherId}'`);
  await assert.rejects(db.exec(await read('0104_bg04m_return_credit_correction.sql')),/voucher was changed/);
  await db.exec('ROLLBACK');
  assert.equal(Number(await value('SELECT debt AS value FROM public.customers WHERE id=$1',[customerId])),-23);
  assert.equal(await value('SELECT status AS value FROM public.cashbook_transactions WHERE id=$1',[voucherId]),'completed');
  assert.equal(Number(await value("SELECT count(*) AS value FROM public.customer_debt_transactions WHERE sales_return_id=$1",[returnId])),0);
});

test('cash-only return converts once to full customer credit while preserving sales, items and other customers',async()=>{
  const oldOrder=(await db.query('SELECT * FROM public.orders WHERE id=$1',[orderId])).rows[0];
  const oldItems=(await db.query('SELECT * FROM public.sales_return_items WHERE return_id=$1',[returnId])).rows;
  await db.exec(await read('0104_bg04m_return_credit_correction.sql'));
  const customer=(await db.query('SELECT debt,total_return,net_revenue FROM public.customers WHERE id=$1',[customerId])).rows[0];
  assert.equal(Number(customer.debt),-2166615);
  assert.equal(Number(customer.total_return),2166592);
  assert.equal(Number(customer.net_revenue),1338233684);
  assert.equal(Number(await value('SELECT calculated_balance AS value FROM public.p74_customer_debt_ledger_balance($1)',[customerId])),-2166615);
  assert.equal(Number(await value("SELECT debt AS value FROM public.customers WHERE id='unrelated-customer'")),0);
  const returned=(await db.query('SELECT * FROM public.sales_returns WHERE id=$1',[returnId])).rows[0];
  assert.equal(returned.status,'completed');
  assert.equal(Number(returned.refund_amount),0);
  assert.equal(Number(returned.debt_reduction_amount),2166592);
  assert.equal(returned.refund_cashbook_transaction_id,null);
  assert.ok(returned.debt_ledger_id);
  assert.equal(await value('SELECT status AS value FROM public.cashbook_transactions WHERE id=$1',[voucherId]),'cancelled');
  assert.equal(Number(await value('SELECT value AS value FROM public.cashbook_transactions WHERE reversal_of_id=$1',[voucherId])),2166592);
  assert.equal(Number(await value("SELECT count(*) AS value FROM public.cashbook_transactions WHERE sales_return_id=$1 AND status='completed'",[returnId])),0);
  assert.deepEqual((await db.query('SELECT * FROM public.orders WHERE id=$1',[orderId])).rows[0],oldOrder);
  assert.deepEqual((await db.query('SELECT * FROM public.sales_return_items WHERE return_id=$1',[returnId])).rows,oldItems);
  const audit=(await db.query("SELECT old_data,new_data FROM public.audit_logs WHERE record_id=$1 AND action='CONVERT_AUTOMATIC_REFUND_TO_CREDIT'",[returnId])).rows[0];
  assert.equal(Number(audit.old_data.customer_debt),-23);
  assert.equal(Number(audit.old_data.refund_voucher_snapshot.value),2166592);
  assert.equal(Number(audit.new_data.customer_debt),-2166615);
  await db.exec(await read('0104_bg04m_return_credit_correction.sql'));
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.customer_debt_transactions WHERE sales_return_id=$1',[returnId])),1);
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.cashbook_transactions WHERE reversal_of_id=$1',[voucherId])),1);
});

test('the corrected return can still be cancelled using the normal atomic return RPC',async()=>{
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[admin]);
  await db.exec('SET ROLE authenticated');
  const result=await value('SELECT public.rpc_cancel_sales_return($1,$2) AS value',[returnId,'Synthetic cancellation after correction']);
  assert.equal(Number(result.new_debt),-23);
  assert.equal(Number(result.new_total_return),0);
  await db.exec('RESET ROLE');
  assert.equal(Number(await value('SELECT count(*) AS value FROM public.cashbook_transactions WHERE reversal_of_id=$1',[voucherId])),1);
});
