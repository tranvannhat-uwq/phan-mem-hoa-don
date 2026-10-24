import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../js/services/supabase.js',import.meta.url),'utf8');

test('new return clients require the credit-policy RPC and never fall back to automatic cash refund',async()=>{
  const calls=[],messages=[];
  const start=source.indexOf('export async function dbRecordSalesReturn(');
  const end=source.indexOf('export async function dbCancelSalesReturn(',start);
  const context=vm.createContext({ isCloudActive:true,
    supabaseClient:{rpc:async(...args)=>{calls.push(args);return {error:{code:'PGRST202'}};}},
    showToast:message=>messages.push(message),console:{warn(){}} });
  vm.runInContext(source.slice(start,end).replace('export async function','async function'),context);
  assert.equal(await context.dbRecordSalesReturn({saleId:'HD-01',idempotencyKey:'stable-key'},[{saleItemId:'i1',quantity:1}]),false);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'rpc_record_sales_return_credit');
  assert.match(messages[0],/0103/);
});

test('customer history loads return summaries only for the selected customer with bounded pages',async()=>{
  const calls=[];
  const rows=[{id:'RET-1',customer_id:'c1',sale_id:'HD-1',total_refund:0,total_return_amount:2166592,
    debt_reduction_amount:2166592,refund_amount:0,status:'completed'}];
  const chain={ select(value){calls.push(['select',value]);return this;},
    eq(...args){calls.push(['eq',...args]);return this;},order(){return this;},
    range(...args){calls.push(['range',...args]);return Promise.resolve({data:rows,error:null});} };
  const context=vm.createContext({isCloudActive:true,supabaseClient:{from:()=>chain},tableSalesReturnsName:'sales_returns'});
  const start=source.indexOf('export async function dbFetchCustomerReturnDocuments(');
  const end=source.indexOf('export async function dbRefreshCustomerFinancialState(',start);
  vm.runInContext(source.slice(start,end).replace('export async function','async function'),context);
  const [result]=await context.dbFetchCustomerReturnDocuments('c1');
  assert.deepEqual(calls.find(call=>call[0]==='eq'),['eq','customer_id','c1']);
  assert.deepEqual(calls.find(call=>call[0]==='range'),['range',0,99]);
  assert.ok(!calls.find(call=>call[0]==='select')[1].includes('*'));
  assert.equal(result.totalRefund,2166592);
  assert.equal(result.debtReductionAmount,2166592);
  assert.equal(result.refundAmount,0);
});
