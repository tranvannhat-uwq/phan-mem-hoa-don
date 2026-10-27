import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {clearRetainedHistoryCaches,openingDebtRow} from '../js/domain/data-retention.js';
import {prepareStagedRetentionBackup} from '../js/services/retention-download.js';
const source=readFileSync(new URL('../js/services/supabase.js',import.meta.url),'utf8')
  .replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
function harness({rpc=async()=>({data:{epoch:1,cutoff:'2026-09-01'},error:null}),storageFails=false,fetcher=async()=>new Response('{}')}={}) {
  const storage=new Map([['billing_system_customers__old','private'],['billing_system_orders','private'],['sb-auth-token','login']]);
  const state={currentUser:{id:'synthetic-user'},retentionEpoch:null,retentionAvailable:false,savedOrders:[{id:'old'}],customers:[{id:'old'}]};
  const events=[]; const requests=[];
  const context=vm.createContext({state,Headers,Response,clearRetainedHistoryCaches,openingDebtRow,prepareStagedRetentionBackup,
    createEgressMeter:()=>({fetch:async(...args)=>{requests.push(args);return fetcher(...args);}}),
    localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>{if(storageFails)throw Error('Unavailable');return storage.get(k)||null;},
      setItem:(k,v)=>{if(storageFails)throw Error('Unavailable');storage.set(k,v);},removeItem:k=>storage.delete(k)},
    window:{dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    testClient:{rpc},console,setTimeout,clearTimeout});
  vm.runInContext(source,context);
  vm.runInContext("supabaseClient=testClient;retentionProjectUrl='https://synthetic.invalid';isCloudActive=true",context);
  return {state,storage,events,requests,run:code=>vm.runInContext(code,context)};
}
test('new epoch clears all scoped financial caches and notifies the active screen',async()=>{
  const h=harness();await h.run('syncRetentionState()');
  assert.equal(h.state.retentionEpoch,1);assert.equal(h.state.customers.length,0);assert.equal(h.state.savedOrders.length,0);
  assert.ok(!h.storage.has('billing_system_customers__old'));assert.ok(h.storage.has('sb-auth-token'));
  assert.equal(h.events[0].type,'billing-retention-changed');
  assert.equal((await h.run('syncRetentionState()')).changed,false);
});

test('changing login between staged metadata and download never sends chunk requests under the new user',async()=>{
  const names=[],key='synthetic-request',sha=createHash('sha256').update('[]').digest('hex');
  const h=harness({rpc:async(name)=>{
    names.push(name);
    if(name==='rpc_start_retention_backup')return {data:{id:key,tables:['customers'],staged:{customers:{parts:1}}},error:null};
    if(name==='rpc_finish_retention_backup')return {data:{job_id:key,backup_sha256:sha,preview:{},plan:[{table:'customers',parts:1,bytes:2}]},error:null};
    throw new Error('A chunk must not be requested under another login');
  }});
  h.run("testProgress=text=>{if(text.includes('Đang tải'))state.currentUser={id:'another-login'}}");
  await assert.rejects(h.run("dbPrepareMonthlyRetention('synthetic-request',false,testProgress)"),/đăng nhập đã thay đổi/);
  assert.deepEqual(names,['rpc_start_retention_backup','rpc_finish_retention_backup']);
});
test('missing feature is tolerated before installation, but a known purge epoch fails closed',async()=>{
  const h=harness({rpc:async()=>({data:null,error:{code:'PGRST202'}})});
  assert.equal((await h.run('syncRetentionState()')).available,false);
  h.storage.set('billing_retention_epoch:https://synthetic.invalid','1');
  await assert.rejects(h.run('syncRetentionState()'),/Không thể xác minh/);
});
test('blocked local storage does not cause endless epoch reload notifications',async()=>{
  const h=harness({storageFails:true});assert.equal((await h.run('syncRetentionState()')).changed,true);
  assert.equal((await h.run('syncRetentionState()')).changed,false);assert.equal(h.events.length,1);
});
test('late status from a previous login cannot replace the current session',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});const h=harness({rpc:()=>pending});
  const reading=h.run('syncRetentionState()');h.state.currentUser={id:'another-login'};
  resolve({data:{epoch:4,cutoff:'2026-09-01'},error:null});
  await assert.rejects(reading,/đã thay đổi/);assert.equal(h.state.retentionEpoch,null);
});
test('REST carries the verified epoch and ignores in-flight data after a new epoch',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});const h=harness({fetcher:()=>pending});
  h.state.retentionEpoch=1;
  const reading=h.run("retentionAwareFetch('https://synthetic.invalid/rest/v1/orders',{headers:{apikey:'synthetic-public-key'}})");
  assert.equal(h.requests[0][1].headers.get('x-retention-epoch'),'1');assert.equal(h.requests[0][1].cache,'no-store');
  h.state.retentionEpoch=2;resolve(new Response('{}'));
  await assert.rejects(reading,/RETENTION_EPOCH_CHANGED/);
});

function committedDeleteHarness({jobState='completed',statusEpoch=1,writeError=null}={}) {
  const calls=[],jobId='synthetic-job',hash='1'.repeat(64),cutoff='2026-09-01T00:00:00+07:00';
  const result={verified:true,success:true,job_id:jobId,epoch:1,cutoff};
  const h=harness({rpc:async name=>{
    calls.push(name);
    if(name==='rpc_execute_monthly_retention')return {data:writeError?null:result,error:writeError};
    if(name==='rpc_retention_job')return {data:{job_id:jobId,state:jobState,backup_sha256:hash,cutoff,
      completed_at:jobState==='completed'?'2026-10-27T14:00:00Z':null,result:jobState==='completed'?result:null},error:null};
    if(name==='rpc_retention_status')return {data:{epoch:statusEpoch,cutoff:statusEpoch?cutoff:null},error:null};
    throw new Error(`Unexpected ${name}`);
  }});
  return {h,calls,execute:()=>h.run(`dbExecuteMonthlyRetention('${jobId}','${hash}','XOA TRUOC 01/09/2026')`)};
}

test('a positive execute response cannot report success while the persisted job remains prepared',async()=>{
  const {execute,calls}=committedDeleteHarness({jobState:'prepared'});
  await assert.rejects(execute(),/Database chưa ghi nhận xóa hoàn tất/);
  assert.deepEqual(calls,['rpc_execute_monthly_retention','rpc_retention_job']);
});

test('completed deletion also requires the persisted retention epoch and cutoff',async()=>{
  const {execute}=committedDeleteHarness({statusEpoch:0});
  await assert.rejects(execute(),/Chưa đối chiếu được mốc dữ liệu/);
});

test('a committed, verified job and matching control state allow success and clear old caches',async()=>{
  const {execute,h,calls}=committedDeleteHarness();const result=await execute();
  assert.equal(result.verified,true);assert.equal(h.state.retentionEpoch,1);
  assert.deepEqual(calls,['rpc_execute_monthly_retention','rpc_retention_job','rpc_retention_status']);
  assert.ok(!h.storage.has('billing_system_orders'));
});

test('a database delete error cannot fall through to a success readback',async()=>{
  const {execute,calls}=committedDeleteHarness({writeError:{message:'DELETE requires a WHERE clause',code:'21000'}});
  await assert.rejects(execute(),error=>error.message==='DELETE requires a WHERE clause');
  assert.deepEqual(calls,['rpc_execute_monthly_retention']);
});
