import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {buildRetentionDatabase,asActor,scalar,adminId} from './helpers/retention-db.mjs';
import {buildRetentionUpgrade} from '../scripts/build-retention-upgrade.mjs';

test('legacy CRLF employee report keeps company opening and cross-period return series after purge',async()=>{
  const db=await buildRetentionDatabase({maxVersion:105});
  const call=(name,args=[])=>scalar(db,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args);
  try {
    // Production retained the 0066 report, with CRLF inside its stored body.
    // 0108 used newline-sensitive anchors, which must never silently miss a patch.
    const legacy=await readFile(new URL('../migrations/0066_attribute_employee_report_to_customer_manager.sql',import.meta.url),'utf8');
    await db.exec(legacy.replace(/\r?\n/g,'\r\n'));
    // The SQL editor can also convert the upgrade script itself to CRLF.
    await db.exec((await buildRetentionUpgrade({dryRun:false})).replace(/\r?\n/g,'\r\n'));
    await asActor(db);
    const cutoff=(await call('rpc_retention_status')).next_cutoff;
    const old=new Date(Date.parse(cutoff)-86400000).toISOString();
    const order=async(date,quantity)=>(await call('rpc_confirm_order',[JSON.stringify({customerId:'retention-customer',
      pricelistId:'retention-prices',date,idempotencyKey:randomUUID(),items:[{variantId:'retention-sku',quantity}]})])).order.id;
    const oldOrder=await order(old,10);await order(new Date().toISOString(),3);
    await db.exec('RESET ROLE');const item=await scalar(db,'SELECT id AS value FROM order_items WHERE order_id=$1',[oldOrder]);
    await asActor(db);
    await call('rpc_record_sales_return_credit',[JSON.stringify({orderId:oldOrder,idempotencyKey:randomUUID(),
      reason:'Synthetic cross-period return',items:[{saleItemId:item,quantity:1}]})]);
    const filter=JSON.stringify({start:cutoff,end:new Date(Date.now()+86400000).toISOString(),company_id:'ABS_NORTH'});
    const before=await call('rpc_get_employee_business_report',[filter]);
    assert.equal(Number(before.summary.debt_balance),1200);
    await call('rpc_set_maintenance_mode',[true,'Synthetic legacy report rehearsal']);
    const p=await call('rpc_prepare_monthly_retention',[randomUUID(),false]);
    const confirm='XOA TRUOC '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok'}).format(new Date(cutoff));
    await call('rpc_execute_monthly_retention',[p.job_id,p.backup_sha256,confirm]);
    await asActor(db,adminId,1);
    const after=await call('rpc_get_employee_business_report',[filter]);
    assert.equal(Number(after.summary.debt_balance),Number(before.summary.debt_balance),'Company opening must be included after deleting its source orders');
    assert.equal(Number(after.summary.net_sales),200);
    assert.equal(after.series.reduce((sum,row)=>sum+Number(row.net_sales),0),200,'Timeline must subtract the independent cross-period return');
    assert.deepEqual(after.series,before.series);
  } finally {await db.close();}
});
