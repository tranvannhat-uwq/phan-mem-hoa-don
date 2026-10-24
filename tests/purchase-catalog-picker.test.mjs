import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../js/components/purchases.js',import.meta.url),'utf8');
function harness(rows,price='0'){
  const requests=[],pending=[];
  const search={value:'vỏ thùng nt',setAttribute(){},removeAttribute(){},setCustomValidity(){},focus(){}};
  const results={id:'catalog-results',innerHTML:'',hidden:true};
  const fields={'.purchase-entry-material-search':search,'.purchase-entry-material-results':results,
    '.purchase-entry-code':{value:''},'.purchase-entry-unit':{value:''},
    '.purchase-entry-price':{value:price},'.purchase-entry-item-source span':{textContent:''}};
  const row={isConnected:true,dataset:{mode:'material'},querySelector:key=>fields[key],closest:()=>({})};
  const context=vm.createContext({setTimeout:fn=>{pending.push(fn());return 1;},clearTimeout(){},
    bomGateway:{searchPurchaseItems:async filters=>{requests.push(filters);return {rows,hasMore:false};}},
    escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    formatCurrency:value=>`${Math.round(value)} ₫`,setPurchaseMaterialActiveOption(){},closePurchaseMaterialResults(){},updateTotals(){}});
  const start=source.indexOf('function searchPurchaseMaterials(');
  const end=source.indexOf('function switchPurchaseItemMode(',start);
  vm.runInContext(source.slice(start,end),context);
  return {context,row,search,fields,results,requests,async searchItems(){context.searchPurchaseMaterials(row,true);await Promise.all(pending);}};
}
const product={id:'product:shell-b1',source:'product',code:'VỎ THÙNG NT-B1',name:'Sơn siêu bóng nội thất cao cấp',
  brand:'NANO10 MB',purchase_unit:'Bộ',unit_price:51250,is_active:true};

test('purchase suggestions show product names and the exact existing shell SKU',async()=>{
  const h=harness([product]);await h.searchItems();
  assert.equal(h.requests[0].query,'vỏ thùng nt');
  assert.match(h.results.innerHTML,/<strong>Sơn siêu bóng nội thất cao cấp<\/strong>/);
  assert.match(h.results.innerHTML,/VỎ THÙNG NT-B1/);
  assert.match(h.results.innerHTML,/NANO10 MB/);
  assert.match(h.results.innerHTML,/ĐVT mua: Bộ/);
  assert.doesNotMatch(h.results.innerHTML,/BB-THUNG|VO-.*HASH/);
});

test('choosing the shell keeps its real code and unit, and records a clear shell description',async()=>{
  const h=harness([product]);await h.searchItems();
  h.context.choosePurchaseMaterial(h.row,product.id);
  assert.equal(h.fields['.purchase-entry-code'].value,'VỎ THÙNG NT-B1');
  assert.equal(h.fields['.purchase-entry-unit'].value,'Bộ');
  assert.equal(h.search.value,'VỎ THÙNG NT-B1 · Sơn siêu bóng nội thất cao cấp · NANO10 MB');
  assert.equal(h.fields['.purchase-entry-price'].value,51250);
  assert.equal(h.row.dataset.catalogId,product.id);
});

test('selecting a product shell preserves a price already entered by accounting and escapes names',async()=>{
  const h=harness([{...product,name:'Sơn <script>bad</script>'}],'49000');await h.searchItems();
  assert.doesNotMatch(h.results.innerHTML,/<script>/);
  assert.match(h.results.innerHTML,/&lt;script&gt;/);
  h.context.choosePurchaseMaterial(h.row,product.id);
  assert.equal(h.fields['.purchase-entry-price'].value,'49000');
});
