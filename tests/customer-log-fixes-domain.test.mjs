import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNewCustomerPriceListId} from '../js/domain/customer-creation.js';
import {fetchCustomerOrderWindow} from '../js/domain/customer-order-window.js';

test('only the custom/unassigned placeholder becomes null; actual price-list IDs retain authorization',()=>{
 for(const value of [null,undefined,'',' custom ','custom'])assert.equal(normalizeNewCustomerPriceListId(value),null);
 for(const value of ['retail','private-list','inactive-list','missing-list'])assert.equal(normalizeNewCustomerPriceListId(value),value);
});
test('1,557 customer IDs travel in one bounded RPC body, never a query string or per-customer request',async()=>{
 const ids=Array.from({length:1557},(_,i)=>`synthetic-customer-${i}`),calls=[];
 const rows=await fetchCustomerOrderWindow(async(name,args)=>{calls.push({name,args});return{data:[{id:'match'}]};},
   {customerIds:[...ids,ids[0]],start:'2026-09-01T00:00:00Z',end:'2026-11-01T00:00:00Z',limit:500});
 assert.equal(calls.length,1);assert.equal(calls[0].name,'rpc_get_customer_order_window');
 assert.deepEqual(calls[0].args.p_customer_ids,ids);assert.equal(calls[0].args.p_date_field,'business');
 assert.equal(calls[0].args.p_start,'2026-09-01T00:00:00Z');assert.equal(calls[0].args.p_status,null);
 assert.deepEqual(rows,[{id:'match'}]);
});
test('report history still loads all pages in creation-date order with its status filter',async()=>{
 const calls=[];const first=Array.from({length:1000},(_,i)=>({id:i}));
 const rows=await fetchCustomerOrderWindow(async(name,args)=>{calls.push(args);return{data:args.p_offset===0?first:[{id:1000}]};},
   {customerIds:['c'],dateField:'created',status:'all',limit:1000,allPages:true});
 assert.equal(rows.length,1001);assert.deepEqual(calls.map(c=>c.p_offset),[0,1000]);
 assert.ok(calls.every(c=>c.p_date_field==='created'&&c.p_status==='all'));
});
test('empty filters avoid requests and Cloud failures cannot silently yield a partial result',async()=>{
 assert.deepEqual(await fetchCustomerOrderWindow(()=>{throw Error('unexpected')},{customerIds:[]}),[]);
 await assert.rejects(fetchCustomerOrderWindow(async()=>({error:new Error('network')}),{customerIds:['c']}),/network/);
 await assert.rejects(fetchCustomerOrderWindow(async()=>({data:{}}),{customerIds:['c']}),/không hợp lệ/);
});
