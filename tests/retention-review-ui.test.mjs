import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../js/components/retention-review.js',import.meta.url),'utf8')
  .replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
function harness(fetch=async()=>({rows:[],total:0})) {
  const nodes=new Map();let scope='project|admin',calls=0;
  function element(){return {children:[],textContent:'',handlers:{},append(child){this.children.push(child);},replaceChildren(){this.children=[];},addEventListener(type,fn){this.handlers[type]=fn;}};}
  const node=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const state={currentUser:{role:'admin'},retentionEpoch:0};
  const context=vm.createContext({state,document:{getElementById:node,createElement:element},getOrderDisplayCode:o=>o.id,
    getRetentionSessionScope:()=>scope,dbRetentionReviewOrders:async offset=>{calls++;return fetch(offset);}});
  vm.runInContext(source,context);
  return {state,node:id=>node('retention-review-'+id),get calls(){return calls;},scope:value=>{scope=value;},
    render:()=>vm.runInContext('renderRetentionReview()',context),tick:()=>new Promise(setImmediate)};
}
const text=node=>[node.textContent,...node.children.map(text)].join(' ');
test('accounting can inspect the original reason and items using text nodes, including hostile customer content',async()=>{
  const h=harness(async()=>({total:1,rows:[{order_id:'BAD-1',reasons:['Chưa liên kết khách hàng'],kept_at:'2026-10-27',
    current_order:{id:'BAD-1',customer_name:'<img src=x onerror=alert(1)>',total_payable:0},
    current_items:[{product_name_snapshot:'Quạt màu bé',quantity:1,returned_quantity:0,unit_price:0,line_total:0}]}]}));
  h.state.currentUser.role='accounting';h.render();await h.tick();
  assert.equal(h.calls,1);assert.equal(h.node('section').hidden,false);
  assert.match(text(h.node('list')),/Chưa liên kết khách hàng/);assert.match(text(h.node('list')),/Quạt màu bé/);
  assert.match(text(h.node('list')),/<img src=x onerror=alert\(1\)>/);
  assert.equal(h.node('list').children[0].children[0].innerHTML,undefined);
  h.render();await h.tick();assert.equal(h.calls,1,'Routine renders reuse the current page');
});
test('sales cannot query the private queue and late results cannot cross a changed login',async()=>{
  let resolve;const h=harness(()=>new Promise(done=>{resolve=done;}));h.render();
  h.state.currentUser.role='sale';h.scope('project|sale');h.render();
  resolve({total:1,rows:[{current_order:{id:'PRIVATE-OLD',customer_name:'private'}}]});await h.tick();
  assert.equal(h.node('section').hidden,true);assert.equal(h.node('list').children.length,0);assert.equal(h.calls,1);
});
test('paging is bounded and errors remain retryable through the refresh button',async()=>{
  const offsets=[];let fail=false;const h=harness(async offset=>{offsets.push(offset);if(fail)throw new Error('Synthetic unavailable');return{total:26,rows:[]};});
  h.render();await h.tick();h.node('next').handlers.click();await h.tick();assert.deepEqual(offsets,[0,25]);
  assert.equal(h.node('next').disabled,true);fail=true;h.node('refresh').handlers.click();await h.tick();
  assert.match(h.node('status').textContent,/unavailable/);h.render();await h.tick();assert.equal(offsets.length,3);
  fail=false;h.node('refresh').handlers.click();await h.tick();assert.equal(offsets.length,4);
});
