import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {clearRetainedHistoryCaches,openingDebtRow} from '../js/domain/data-retention.js';
const source=readFileSync(new URL('../js/services/supabase.js',import.meta.url),'utf8')
  .replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
function harness({rpc=async()=>({data:{epoch:1,cutoff:'2026-09-01'},error:null}),storageFails=false,fetcher=async()=>new Response('{}')}={}) {
  const storage=new Map([['billing_system_customers__old','private'],['billing_system_orders','private'],['sb-auth-token','login']]);
  const state={currentUser:{id:'synthetic-user'},retentionEpoch:null,retentionAvailable:false,savedOrders:[{id:'old'}],customers:[{id:'old'}]};
  const events=[]; const requests=[];
  const context=vm.createContext({state,Headers,Response,clearRetainedHistoryCaches,openingDebtRow,
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
