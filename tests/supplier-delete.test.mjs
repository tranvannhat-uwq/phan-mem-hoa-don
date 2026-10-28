import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {supplierNumber} from '../js/domain/supplier-directory.js';
const source=readFileSync(new URL('../js/components/suppliers.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('async function handleDeleteSupplier('),source.indexOf('// --- Excel Import & Template Helpers for Suppliers'));
function fixture(){
 const events=[],calls=[],state={suppliers:[{id:'keep',name:'Keep',debt:100},{id:'target',name:'Target',debt:0}]};
 const context=vm.createContext({state,toNumber:supplierNumber,deletingSuppliers:new Set(),
  confirm:()=>true,showToast:(...args)=>events.push(args),renderSuppliersTable:()=>events.push(['render']),populateSupplierDatalist:()=>events.push(['datalist']),
  dbDeleteSupplier:async id=>{calls.push(id);state.suppliers=state.suppliers.filter(s=>s.id!==id);return {success:true};}});
 vm.runInContext(handler,context);
 return{state,context,events,calls,run:(id,button={disabled:false})=>context.handleDeleteSupplier(id,button)};
}
test('deletion uses the clicked supplier identity after list reorder and waits for Cloud before changing the list',async()=>{
 const h=fixture();h.state.suppliers.reverse();const button={disabled:false};let complete;
 h.context.dbDeleteSupplier=id=>{h.calls.push(id);return new Promise(resolve=>complete=resolve);};
 const pending=h.run('target',button);assert.equal(button.disabled,true);assert.equal(h.state.suppliers.length,2);
 await h.run('target',button);assert.deepEqual(h.calls,['target']);
 complete(false);await pending;assert.equal(button.disabled,false);assert.equal(h.state.suppliers.length,2);assert.equal(h.events.length,0);
});
test('cancel and nonzero payable or advance balances never submit a deletion; success refreshes the directory',async()=>{
 const h=fixture();await h.run('keep');assert.equal(h.calls.length,0);assert.match(h.events[0][0],/tất toán/);
 h.state.suppliers[0].debt=-100;await h.run('keep');assert.equal(h.calls.length,0);
 h.context.confirm=()=>false;await h.run('target');assert.equal(h.calls.length,0);
 h.context.confirm=()=>true;await h.run('target');assert.deepEqual(h.calls,['target']);assert.equal(h.state.suppliers.length,1);
 assert.ok(h.events.some(e=>e[0]==='render'));assert.ok(h.events.some(e=>e[0]==='datalist'));
});
