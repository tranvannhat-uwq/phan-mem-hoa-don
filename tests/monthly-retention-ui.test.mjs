import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('an uncertain independent return cannot be replayed under a different login or project',async()=>{
  const source=readFileSync(new URL('../js/components/independent-returns.js',import.meta.url),'utf8')
    .replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
  let scope='project-one|actor-one';const sent=[];
  const context=vm.createContext({state:{currentUser:{id:'actor-one',role:'admin'}},
    getRetentionSessionScope:()=>scope,
    dbRecordIndependentReturn:async input=>{sent.push(input);throw new Error('Synthetic transport uncertainty');},
    document:{getElementById:()=>null},console});
  vm.runInContext(source,context);
  vm.runInContext(`request='synthetic-stable-key';requestScope='project-one|actor-one';
    lastPayload=JSON.stringify({customerId:'synthetic-customer',items:[]});`,context);
  for(const different of ['project-one|actor-two','project-two|actor-one','']) {
    scope=different;
    await assert.rejects(vm.runInContext('recordPending()',context),/tài khoản hoặc kết nối khác/);
  }
  assert.equal(sent.length,0,'Changing scope must never send a new financial request');
  scope='project-one|actor-one';
  for(let retry=0;retry<2;retry++)await assert.rejects(vm.runInContext('recordPending()',context),/transport uncertainty/);
  assert.equal(sent.length,2);
  assert.ok(sent.every(input=>input.idempotencyKey==='synthetic-stable-key'));
  assert.equal(vm.runInContext('request',context),'synthetic-stable-key');
});

test('a SQL error on reconciliation cannot discard the key of an earlier uncertain attempt',async()=>{
  const source=readFileSync(new URL('../js/components/independent-returns.js',import.meta.url),'utf8')
    .replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,hidden:false,onclick:null,
      eventCounts:{},addEventListener(type){this.eventCounts[type]=(this.eventCounts[type]||0)+1;},append(){},querySelectorAll:()=>[],
      closest:()=>({querySelector:()=>node('lookup-results'),addEventListener(){}})});
    return nodes.get(id);
  };
  const context=vm.createContext({state:{currentUser:{id:'actor-one',role:'admin'}},
    getRetentionSessionScope:()=> 'project-one|actor-one',
    dbRecordIndependentReturn:async()=>{throw {code:'42501',message:'Synthetic maintenance after the original uncertain request'};},
    document:{getElementById:node},window:{addEventListener(){}},console});
  vm.runInContext(source,context);
  vm.runInContext(`setupIndependentReturns();setupIndependentReturns();request='original-uncertain-key';requestScope='project-one|actor-one';
    lastPayload=JSON.stringify({customerId:'synthetic-customer',items:[]});`,context);
  await node('independent-return-reconcile').onclick();
  assert.equal(node('independent-return-form').eventCounts.submit,1,'Repeated page setup must not bind duplicate financial submissions');
  assert.equal(vm.runInContext('request',context),'original-uncertain-key');
  assert.equal(vm.runInContext('requestScope',context),'project-one|actor-one');
  assert.ok(node('independent-return-form').querySelectorAll);
  assert.match(node('independent-return-status').textContent,/chưa được đối soát/);
  assert.match(node('independent-return-form-status').textContent,/chưa được đối soát/);
});
