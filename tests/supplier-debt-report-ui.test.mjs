import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {supplierReportFilterError,supplierReportExcelRows,SUPPLIER_DEBT_REPORT_COLUMNS,supplierReportDayLabel,supplierReportRange} from '../js/domain/supplier-debt-report.js';
const source=readFileSync(new URL('../js/components/supplier-debt-report.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
function fixture(){
 const nodes=new Map();const node=id=>{
  if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(){},querySelectorAll(){return [];}});
  return nodes.get(id);
 };
 Object.assign(node('from'),{value:'2026-09-01'});Object.assign(node('to'),{value:'2026-10-28'});Object.assign(node('status'),{value:'activity'});
 const ctx=vm.createContext({console,columns:SUPPLIER_DEBT_REPORT_COLUMNS,dayLabel:supplierReportDayLabel,supplierReportFilterError,supplierReportExcelRows,supplierReportRange,
  state:{currentUser:{role:'accounting'},suppliers:[]},document:{getElementById:id=>node(id.replace('supplier-period-',''))},showToast(){},openSupplierDebtHistory(){}});
 vm.runInContext(source,ctx);vm.runInContext('dialog={open:true};',ctx);
 return{ctx,node,run:code=>vm.runInContext(code,ctx)};
}
const data=(label='Vendor')=>({rows:[{id:'s1',code:'S-1',name:label,opening:-10,debit:100,credit:30,closing:60}],total:1,totals:{opening:-10,debit:100,credit:30,closing:60},from:'2026-09-01',to:'2026-10-28',generatedAt:'2026-10-28T06:00:00Z',fingerprint:'snapshot-1'});
test('late report responses cannot replace newer conditions or a closed report',async()=>{
 const h=fixture();let pending=[];h.ctx.dbSupplierDebtReport=()=>new Promise(resolve=>pending.push(resolve));
 const first=h.run('load()');h.run('invalidate()');h.node('query').value='New';const second=h.run('load()');
 pending[1](data('New vendor'));await second;assert.match(h.node('result').innerHTML,/New vendor/);
 pending[0](data('Old vendor'));await first;assert.doesNotMatch(h.node('result').innerHTML,/Old vendor/);
 h.run('invalidate()');assert.equal(h.node('excel').disabled,true);assert.equal(h.node('print').disabled,true);
 const last=h.run('load()');h.run('dialog.open=false;request++;');pending[2](data('Closed result'));await last;assert.doesNotMatch(h.node('result').innerHTML,/Closed result/);
});
test('export collection loads all pages, rejects changed snapshots and does not misrepresent partial downloads as complete',async()=>{
 const h=fixture(),rows=Array.from({length:205},(_,i)=>({...data().rows[0],id:'s'+i}));
 h.ctx.snapshot={...data(),total:205,rows:rows.slice(0,20)};h.run('report=snapshot;applied=filters();');
 const offsets=[];h.ctx.dbSupplierDebtReport=async(_filters,offset,limit)=>{offsets.push(offset);assert.equal(limit,100);return {...data(),total:205,rows:rows.slice(offset,offset+limit)};};
 const full=await h.run('collectRows(request)');assert.equal(full.length,205);assert.deepEqual(offsets,[0,100,200]);
 h.run('allRows=null;');h.ctx.dbSupplierDebtReport=async()=>({...data(),total:205,fingerprint:'changed'});
 await assert.rejects(h.run('collectRows(request)'),/Dữ liệu vừa thay đổi/);
 h.ctx.dbSupplierDebtReport=async()=>({...data(),total:205,rows:[]});await assert.rejects(h.run('collectRows(request)'),/Chưa tải đủ/);
});
test('report table escapes supplier content and renders full totals independently of visible page',async()=>{
 const h=fixture();h.ctx.dbSupplierDebtReport=async()=>({...data('<img src=x onerror=alert(1)>'),total:45,totals:{opening:900,debit:1000,credit:100,closing:1800}});
 await h.run('load()');const markup=h.node('result').innerHTML;
 assert.match(markup,/SL NCC: 45/);assert.match(markup,/1\.800/);assert.match(markup,/&lt;img/);assert.doesNotMatch(markup,/<img/);
 assert.match(h.node('pagination').innerHTML,/Trang 1 \/ 3/);assert.equal(h.node('excel').disabled,false);
 h.node('min').value='100';h.node('max').value='50';await h.run('load()');assert.match(h.node('error').textContent,/nhỏ hơn/);assert.equal(h.node('excel').disabled,true);
});
