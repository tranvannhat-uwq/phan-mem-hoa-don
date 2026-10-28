import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../js/components/dealer-support.js',import.meta.url),'utf8').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
function harness() {
  const nodes=new Map();const pending=[];let scope='project|admin';
  function element(){return{children:[],textContent:'',dataset:{},disabled:false,append(child){this.children.push(child);},replaceChildren(...children){this.children=children;},setAttribute(){},querySelectorAll(){return[];}};}
  const node=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const state={currentUser:{id:'admin',role:'admin'},retentionEpoch:0};
  const context=vm.createContext({state,document:{getElementById:node,createElement:element},getRetentionSessionScope:()=>scope,
    dbDealerSupportHistory:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),console});
  vm.runInContext(source,context);
  return{state,node,pending,run:code=>vm.runInContext(code,context),setScope:value=>{scope=value;}};
}
const result=name=>({total:1,selection_confirmed:true,summary:[],rows:[{business_date:'2026-08-15T00:00:00+07:00',product_code:name,
  product_name:name,brand_name:'Synthetic brand',company_name:'Synthetic company',quantity:2,returned_quantity:0,unit_name:'Cái',order_cancelled:false}]});
test('a delayed previous customer response cannot replace the current support history',async()=>{
  const h=harness();h.node('customer-detail-modal').dataset.customerId='first';const first=h.run("renderDealerSupportHistory('first')");
  h.node('customer-detail-modal').dataset.customerId='second';const second=h.run("renderDealerSupportHistory('second')");
  h.pending[1].resolve(result('CURRENT'));await second;
  h.pending[0].resolve(result('PREVIOUS'));await first;
  const cells=h.node('dealer-support-history-body').children.flatMap(row=>row.children.map(cell=>cell.textContent)).join(' ');
  assert.match(cells,/CURRENT/);assert.doesNotMatch(cells,/PREVIOUS/);
});
test('late support history cannot render after logout, epoch change or project change',async()=>{
  for(const change of ['logout','epoch','project']) {
    const h=harness();h.node('customer-detail-modal').dataset.customerId='first';const read=h.run("renderDealerSupportHistory('first')");
    if(change==='logout')h.state.currentUser=null;
    if(change==='epoch')h.state.retentionEpoch=1;
    if(change==='project')h.setScope('other-project|admin');
    h.pending[0].resolve(result('PRIVATE'));await read;
    assert.equal(h.node('dealer-support-history-body').children.length,0);
  }
});

test('support history shows exactly four columns, the exact order note and piece counts even when the source unit is kg',async()=>{
  const h=harness();h.node('customer-detail-modal').dataset.customerId='first';
  const read=h.run("renderDealerSupportHistory('first')");
  const payload=result('SAMPLE');
  payload.rows[0].unit_name='kg';payload.rows[0].quantity=5;
  payload.rows[0].order_notes='Giao cửa sau\n<img src=x onerror=alert(1)>';
  payload.summary=[{product_code:'SAMPLE',brand_name:'Brand',company_name:'Company',issued:5,returned:0,remaining:5,unit_name:'kg'}];
  h.pending[0].resolve(payload);await read;
  const cells=h.node('dealer-support-history-body').children[0].children;
  assert.equal(cells.length,4);
  assert.equal(cells[2].textContent,'5 cái');
  assert.equal(cells[3].textContent,payload.rows[0].order_notes);
  assert.match(h.node('dealer-support-summary').children[0].textContent,/5 cái\.$/);
  assert.doesNotMatch(h.node('dealer-support-summary').children[0].textContent,/kg/);
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const table=html.match(/<table class="table dealer-support-history-table">[\s\S]*?<\/table>/)[0];
  assert.equal((table.match(/<th>/g)||[]).length,4);
  assert.match(table,/<th>Ghi chú đơn hàng<\/th>/);
  assert.doesNotMatch(table,/<th>(?:Hãng \/ công ty|Đã trả|Trạng thái)<\/th>/);
});
