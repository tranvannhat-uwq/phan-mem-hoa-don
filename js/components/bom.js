import { state } from '../state.js';
import { showToast, safeCreateIcons, formatDateTime } from '../utils.js';
import { bomGateway } from '../services/bom.js?v=20261030-supplier-cashbook-v1';
import { setupInputPicker } from './input-picker.js?v=20261030-supplier-cashbook-v1';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>Number(value||0).toLocaleString('vi-VN',{maximumFractionDigits:4});
const names={raw:'Nguyên liệu',packaging:'Bao bì',semi:'Bán thành phẩm',sku:'SKU thành phẩm'};
const statuses={draft:'Nháp',released:'Đang áp dụng',superseded:'Đã thay thế'};
const commonUnits=['mg','g','gam','kg','ml','l','lít','cái','chai','gói','hộp','bao','thùng','mét','cm','cuộn'];
const unitScales={mg:{dimension:'mass',scale:.001},g:{dimension:'mass',scale:1},gam:{dimension:'mass',scale:1},kg:{dimension:'mass',scale:1000},ml:{dimension:'volume',scale:1},l:{dimension:'volume',scale:1000},lít:{dimension:'volume',scale:1000}};
function convertedPurchaseFactor(fromUnit,toUnit,factor){
  if(fromUnit===toUnit)return Number(factor);
  const from=unitScales[fromUnit],to=unitScales[toUnit];
  if(!from||!to||from.dimension!==to.dimension)return null;
  const converted=Number(factor)*from.scale/to.scale;
  return Number.isFinite(converted)&&converted>=.0001?Math.round(converted*10000)/10000:null;
}
let host=null, modal=null, mode='items', query='', page=0, cursors=[null], data=null;
let loading=false, busy=false, requestId=0, actor='', errorText='';
const session=()=>state.currentUser?`${state.currentUser.authUserId||state.currentUser.id}:${state.currentUser.role}`:'';
const admin=()=>state.currentUser?.role==='admin';

export function resetBomPanel(){
  requestId++;loading=false;busy=false;actor='';errorText='';data=null;page=0;cursors=[null];query='';mode='items';
  modal?.remove();modal=null;host?.remove();host=null;bomGateway.clear();
  const panel=document.getElementById('inventory-panel');if(panel)delete panel.dataset.bomOpen;
  const stock=document.getElementById('inventory-stock-view');if(stock)stock.hidden=false;
}
export function openBomPanel(){
  const panel=document.getElementById('inventory-panel');
  if(!panel||!['admin','accounting'].includes(state.currentUser?.role))return;
  if(host){host.hidden=false;document.getElementById('inventory-stock-view').hidden=true;return;}
  actor=session();panel.dataset.bomOpen='true';document.getElementById('inventory-stock-view').hidden=true;
  host=document.createElement('section');host.id='bom-panel';host.className='bom-panel';
  host.innerHTML=`<div class="inventory-header"><div><h2>Cấu hình sản phẩm BOM</h2><p>Nguyên liệu → bán thành phẩm → đóng gói SKU. Định mức được lưu theo phiên bản.</p></div>
    <button type="button" class="btn btn-secondary" data-bom="close">Về tồn kho</button></div>
    <div class="inventory-toolbar bom-toolbar">
      <div class="inventory-view-switch bom-navigation" role="group" aria-label="Nội dung cấu hình BOM"><button type="button" class="inventory-view-tab" data-bom-view="items" aria-pressed="false">Vật tư & tồn</button>
      <button type="button" class="inventory-view-tab" data-bom-view="recipes" aria-pressed="false">Công thức BOM</button>
      <button type="button" class="inventory-view-tab" data-bom-view="runs" aria-pressed="false">Lệnh sản xuất</button></div>
      <form id="bom-search-form" class="inventory-actions bom-search"><input class="form-control" type="search" name="query" maxlength="80" placeholder="Tìm mã hoặc tên…" aria-label="Tìm BOM"><button type="submit" class="btn btn-secondary">Tìm</button></form>
      <div class="inventory-actions bom-create" id="bom-create-actions"></div>
    </div><p id="bom-error" class="inventory-error" role="alert" hidden></p>
    <div class="table-responsive"><table class="table bom-table"><thead id="bom-head"></thead><tbody id="bom-body"></tbody></table></div>
    <div class="inventory-pagination"><span id="bom-page-label"></span><div class="inventory-actions"><button type="button" class="btn btn-secondary" data-bom="previous">Trang trước</button><button type="button" class="btn btn-secondary" data-bom="next">Trang sau</button></div></div>`;
  panel.insertBefore(host,panel.querySelector('#inventory-stock-view'));
  host.addEventListener('click',onClick);
  host.querySelector('#bom-search-form').addEventListener('submit',event=>{event.preventDefault();query=new FormData(event.target).get('query').trim();restart();});
  draw();void load();
}
function draw(){
  if(!host)return;
  host.dataset.mode=mode;
  host.querySelector('#bom-error').hidden=!errorText;host.querySelector('#bom-error').textContent=errorText;
  host.querySelectorAll('[data-bom-view]').forEach(button=>{
    const active=button.dataset.bomView===mode;
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  host.querySelector('#bom-create-actions').innerHTML=mode==='items'
    ? admin()?'<button type="button" class="btn btn-primary" data-bom="new-item">Thêm vật tư</button>':''
    : mode==='recipes'&&admin()?'<button type="button" class="btn btn-primary" data-bom="new-recipe">Tạo BOM</button>':'';
  host.querySelector('#bom-head').innerHTML=mode==='items'
    ? '<tr><th>Mã / Tên</th><th>Loại</th><th>Đơn vị gốc</th><th>Tồn</th><th>Quy đổi mua</th><th></th></tr>'
    : mode==='recipes'?'<tr><th>Đầu ra</th><th>Phiên bản</th><th>Trạng thái</th><th>Sản lượng chuẩn</th><th></th></tr>'
      :'<tr><th>Ngày</th><th>Đầu ra</th><th>Phiên bản</th><th>Sản lượng</th><th></th></tr>';
  const rows=data?.rows||[];
  host.querySelector('#bom-body').innerHTML=loading?`<tr><td colspan="6" class="inventory-empty">Đang tải BOM…</td></tr>`
    :!rows.length?`<tr><td colspan="6" class="inventory-empty">Chưa có dữ liệu trong phạm vi đang xem.</td></tr>`
      :rows.map(row=>mode==='items'
        ? `<tr><td><span class="bom-cell-main"><strong>${esc(row.code)}</strong><small>${esc(row.name)}${row.is_active?'':' · Ngừng sử dụng'}</small></span></td><td>${esc(names[row.kind])}</td><td><span class="bom-unit-cell"><strong>${esc(row.base_unit)}</strong>${admin()?`<button type="button" class="btn btn-secondary btn-sm" data-bom="edit-unit" data-id="${esc(row.id)}" aria-label="Đổi đơn vị gốc ${esc(row.code)}">Đổi</button>`:''}</span></td><td><strong>${number(row.quantity)}</strong></td><td>1 ${esc(row.purchase_unit)} = ${number(row.purchase_to_base)} ${esc(row.base_unit)}</td><td><div class="inventory-actions"><button class="btn btn-secondary btn-sm" data-bom="post-item" data-id="${esc(row.id)}">Phiếu vật tư</button>${admin()?`<button class="btn btn-secondary btn-sm" data-bom="edit-item" data-id="${esc(row.id)}">Sửa</button>`:''}</div></td></tr>`
        :mode==='recipes'
          ? `<tr><td><span class="bom-cell-main"><strong>${esc(row.output_name||row.output_id)}</strong><small>${esc(names[row.output_kind])} · ${esc(row.output_id)}</small></span></td><td>v${number(row.version)}</td><td>${esc(statuses[row.status])}</td><td>${number(row.output_quantity)}</td><td><div class="inventory-actions"><button class="btn btn-secondary btn-sm" data-bom="detail" data-id="${esc(row.id)}">Xem</button>${admin()?`<button class="btn btn-secondary btn-sm" data-bom="edit-recipe" data-id="${esc(row.id)}">${row.status==='draft'?'Sửa nháp':'Tạo phiên bản'}</button>`:''}${admin()&&row.status==='draft'?`<button class="btn btn-primary btn-sm" data-bom="publish" data-id="${esc(row.id)}">Áp dụng</button>`:''}${row.status==='released'?`<button class="btn btn-primary btn-sm" data-bom="run" data-id="${esc(row.id)}">Sản xuất</button>`:''}</div></td></tr>`
          :`<tr><td>${esc(formatDateTime(row.created_at))}</td><td>${esc(names[row.output_kind])} · ${esc(row.output_id)}</td><td>v${number(row.version)}</td><td>${number(row.output_quantity)}</td><td><button class="btn btn-secondary btn-sm" data-bom="run-detail" data-id="${esc(row.id)}">Xem</button></td></tr>`).join('');
  host.querySelector('#bom-page-label').textContent=`Trang ${page+1} · tối đa 15 dòng/trang`;
  host.querySelector('[data-bom="previous"]').disabled=loading||busy||page===0;
  host.querySelector('[data-bom="next"]').disabled=loading||busy||!data?.hasMore;
  safeCreateIcons();
}
async function load(force=false){
  if(!host||loading)return;
  const id=++requestId,scope=session();loading=true;errorText='';draw();
  try{
    const value=await bomGateway.read({mode,query,cursor:cursors[page],limit:15},{force});
    if(id===requestId&&scope===session()){data=value;draw();}
  }catch(error){if(id===requestId&&scope===session()){data=null;errorText=error.message;}}
  finally{if(id===requestId&&scope===session()){loading=false;draw();}}
}
function restart(){requestId++;loading=false;errorText='';page=0;cursors=[null];data=null;void load();}
async function mutate(action){if(busy)return;busy=true;draw();try{await action();restart();}catch(error){showToast(error.message,'danger');}finally{busy=false;draw();}}
async function onClick(event){
  const button=event.target.closest('button');if(!button||button.disabled||busy)return;
  if(button.dataset.bomView){mode=button.dataset.bomView;query='';host.querySelector('[name="query"]').value='';restart();return;}
  const action=button.dataset.bom;
  if(action==='close'){
    resetBomPanel();
    document.querySelector('#inventory-panel [data-inventory-action="refresh"]')?.click();
    return;
  }
  if(action==='previous'){page--;data=null;void load();return;}
  if(action==='next'&&data?.hasMore){cursors[++page]=data.nextCursor;data=null;void load();return;}
  const row=data?.rows?.find(item=>item.id===button.dataset.id);
  if(action==='new-item')return itemEditor();
  if(action==='edit-unit'&&row)return unitEditor(row);
  if(action==='edit-item'&&row)return itemEditor(row);
  if(action==='post-item'&&row)return itemPostEditor(row);
  if(action==='new-recipe')return recipeEditor();
  if(action==='run-detail'&&row){
    try{
      const detail=(await bomGateway.read({mode:'runDetail',id:row.id,limit:1})).rows[0];
      if(!detail)throw new Error('Không tìm thấy lệnh sản xuất.');
      runDetail(detail);
    }catch(error){showToast(error.message,'danger');}
    return;
  }
  if(action==='publish'&&row){
    if(!confirm(`Áp dụng BOM v${row.version} cho ${row.output_name||row.output_id}? Các lệnh mới sẽ dùng phiên bản này.`))return;
    return mutate(async()=>{await bomGateway.publish(row.id);showToast('Đã áp dụng phiên bản BOM.','success');});
  }
  if(['detail','edit-recipe','run'].includes(action)&&row){
    try{
      const detail=(await bomGateway.read({mode:'detail',id:row.id,limit:1})).rows[0];
      if(!detail)throw new Error('Không tìm thấy BOM.');
      if(action==='detail')recipeDetail(detail);
      else if(action==='edit-recipe')recipeEditor(detail);
      else runEditor(detail);
    }catch(error){showToast(error.message,'danger');}
  }
}
function openModal(title,body,onSubmit,options={}){
  modal?.remove();modal=document.createElement('div');modal.className='bom-modal-host';
  const currentModal=modal;
  currentModal.innerHTML=`<div class="modal-overlay active"><div class="modal-content bom-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h3>${esc(title)}</h3><button type="button" class="modal-close" aria-label="Đóng">&times;</button></div><form><div class="modal-body">${body}<p class="inventory-error bom-form-error" role="alert" hidden></p></div><div class="modal-footer"><button type="submit" class="btn btn-primary">Lưu</button></div></form></div></div>`;
  document.body.append(currentModal);
  currentModal.querySelectorAll('[data-unit-picker]').forEach(input => setupInputPicker(input, {
    label: 'Danh sách đơn vị', getOptions: () => commonUnits.map(unit => ({ value: unit }))
  }));
  const close=()=>{currentModal.remove();if(modal===currentModal)modal=null;};
  currentModal.querySelector('.modal-close').onclick=close;
  currentModal.querySelector('.modal-overlay').onclick=event=>{if(event.target===event.currentTarget)close();};
  currentModal.onkeydown=event=>{if(event.key==='Escape')close();};
  if(!onSubmit){currentModal.querySelector('.modal-footer').remove();return currentModal;}
  currentModal.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,save=form.querySelector('[type="submit"]');
    if(save.disabled)return;save.disabled=true;
    const box=form.querySelector('.bom-form-error');box.hidden=true;
    try{const result=await onSubmit(form);close();if(options.onSuccess)await options.onSuccess(result);restart();}catch(error){
      if(currentModal.isConnected){box.textContent=error.message;box.hidden=false;}else showToast(error.message,'danger');
    }finally{if(save.isConnected)save.disabled=false;}
  };
  currentModal.querySelector('input,select,button')?.focus();
  return currentModal;
}
function itemEditor(row,options={}){
  if(!admin())return;
  const kindOptions=options.kindOnly?`<option value="${esc(options.kindOnly)}">${esc(names[options.kindOnly])}</option>`:['raw','packaging','semi'].map(kind=>`<option value="${kind}" ${row?.kind===kind?'selected':''}>${names[kind]}</option>`).join('');
  const form=openModal(options.kindOnly==='semi'?'Thêm bán thành phẩm':row?'Sửa vật tư':'Thêm vật tư',`
    ${options.kindOnly?'<p class="bom-quick-item-intro">Tạo mục đầu ra trong danh sách vật tư, rồi quay lại công thức đang nhập.</p>':''}
    <label>Mã vật tư<input class="form-control" name="code" maxlength="60" required value="${esc(row?.code)}"></label>
    <label>Tên vật tư<input class="form-control" name="name" maxlength="120" required value="${esc(row?.name)}"></label>
    <label>Loại<select class="form-control" name="kind" ${options.kindOnly?'disabled':''}>${kindOptions}</select>${options.kindOnly?`<input type="hidden" name="kind" value="${esc(options.kindOnly)}">`:''}</label>
    <div class="bom-grid"><label>Đơn vị gốc<input class="form-control" name="baseUnit" data-unit-picker maxlength="24" placeholder="gam, kg, lít, cái…" required value="${esc(row?.base_unit)}"></label>
    <label>Đơn vị mua<input class="form-control" name="purchaseUnit" maxlength="24" placeholder="bao, thùng…" required value="${esc(row?.purchase_unit)}"></label>
    <label>1 đơn vị mua = số đơn vị gốc<input class="form-control" name="purchaseToBase" type="number" min="0.0001" step="0.0001" required value="${esc(row?.purchase_to_base??1)}"></label></div>
    ${row?`<label><input type="checkbox" name="isActive" ${row.is_active?'checked':''}> Đang sử dụng</label>`:''}
    <small>Đổi đơn vị chỉ áp dụng khi vật tư chưa có phiếu và chưa được dùng trong BOM. Hệ số mua tự quy đổi giữa mg/g/kg hoặc ml/l; đơn vị khác cần nhập hệ số phù hợp.</small>`,async element=>{
      const fields=new FormData(element);
      const code=String(fields.get('code')).trim(),name=String(fields.get('name')).trim();
      const result=await bomGateway.saveItem({id:row?.id,code,name,
        kind:fields.get('kind'),baseUnit:String(fields.get('baseUnit')).trim(),purchaseUnit:String(fields.get('purchaseUnit')).trim(),
        purchaseToBase:Number(fields.get('purchaseToBase')),isActive:row?fields.has('isActive'):true});
      if(options.kindOnly==='semi'&&!result?.id)throw new Error('Đã lưu nhưng không nhận được mã vật tư để chọn vào BOM.');
      showToast(options.kindOnly==='semi'?'Đã tạo bán thành phẩm.':'Đã lưu vật tư.','success');
      return {id:result.id,code,name};
    },{onSuccess:options.onSuccess});
  const unitField=form.querySelector('[name="baseUnit"]'),factorField=form.querySelector('[name="purchaseToBase"]');
  const originalUnit=String(row?.base_unit??''),originalFactor=Number(row?.purchase_to_base??0);
  let priorUnit=unitField.value.trim();
  unitField.addEventListener('input',()=>{
    const nextUnit=unitField.value.trim();
    if(nextUnit===priorUnit)return;
    const converted=row?convertedPurchaseFactor(originalUnit,nextUnit,originalFactor):null;
    factorField.value=converted===null?'':converted;
    priorUnit=nextUnit;
  });
  return form;
}
function unitEditor(row){
  if(!admin())return;
  const form=openModal(`Đổi đơn vị gốc · ${row.code}`,`
    <p>Vật tư <strong>${esc(row.name)}</strong> · tồn hiện tại ${number(row.quantity)} ${esc(row.base_unit)}. Chỉ đổi trước khi ghi phiếu hoặc dùng vật tư trong BOM.</p>
    <label>Đơn vị gốc<input class="form-control" name="baseUnit" data-unit-picker maxlength="24" required value="${esc(row.base_unit)}" autocomplete="off"></label>
    <label>1 ${esc(row.purchase_unit)} = số đơn vị gốc<input class="form-control" name="purchaseToBase" type="number" min="0.0001" step="0.0001" required value="${esc(row.purchase_to_base)}"></label>
    <small>Nếu đổi giữa mg/g/kg hoặc ml/l, hệ số được quy đổi tự động. Khi đổi sang đơn vị khác, nhập hệ số mới để tránh sai số tồn khi nhập mua.</small>`,async element=>{
      const fields=new FormData(element),baseUnit=String(fields.get('baseUnit')).trim(),purchaseToBase=Number(fields.get('purchaseToBase'));
      await bomGateway.saveItem({id:row.id,code:row.code,name:row.name,kind:row.kind,baseUnit,
        purchaseUnit:row.purchase_unit,purchaseToBase,isActive:row.is_active});
      showToast('Đã cập nhật đơn vị gốc.','success');
    });
  const unitField=form.querySelector('[name="baseUnit"]'),factorField=form.querySelector('[name="purchaseToBase"]');
  unitField.addEventListener('input',()=>{
    const converted=convertedPurchaseFactor(row.base_unit,unitField.value.trim(),Number(row.purchase_to_base));
    factorField.value=converted===null?'':converted;
  });
}
function itemPostEditor(row){
  const key=crypto.randomUUID();
  const shell=openModal(`Phiếu vật tư · ${row.code}`,`
    <p>${esc(row.name)} · tồn hiện tại <strong>${number(row.quantity)} ${esc(row.base_unit)}</strong></p>
    <label>Loại phiếu<select class="form-control" name="kind"><option value="receipt">Nhập</option><option value="issue">Xuất</option><option value="count">Kiểm kê tồn thực tế</option></select></label>
    <label>Số lượng<input class="form-control" name="quantity" type="number" min="0" step="0.0001" max="100000000" required></label>
    <label>Đơn vị nhập<select class="form-control" name="unit"><option value="base">${esc(row.base_unit)} (đơn vị gốc)</option><option value="purchase">${esc(row.purchase_unit)} (× ${number(row.purchase_to_base)})</option></select></label>
    <small>Kiểm kê dùng đơn vị gốc và so với tồn đang hiển thị. Bán thành phẩm nhập qua lệnh sản xuất.</small>`,async form=>{
      const fields=new FormData(form),kind=fields.get('kind');
      if(row.kind==='semi'&&kind==='receipt')throw new Error('Bán thành phẩm chỉ nhập qua lệnh sản xuất.');
      await bomGateway.postItem({requestKey:key,itemId:row.id,kind,quantity:Number(fields.get('quantity')),
        expectedQuantity:kind==='count'?Number(row.quantity):undefined,unit:kind==='receipt'?fields.get('unit'):'base'});
      showToast('Đã ghi phiếu vật tư.','success');
    });
  if(row.kind==='semi')shell.querySelector('[name="kind"] option[value="receipt"]').remove();
  shell.querySelector('[name="kind"]').onchange=event=>{
    shell.querySelector('[name="unit"]').disabled=event.target.value!=='receipt';
    if(event.target.value!=='receipt')shell.querySelector('[name="unit"]').value='base';
  };
}
function recipeDetail(recipe){
  openModal(`BOM v${recipe.version} · ${statuses[recipe.status]}`,`
    <p>Đầu ra: <strong>${esc(names[recipe.outputKind])} · ${esc(recipe.outputId)}</strong><br>Sản lượng chuẩn: ${number(recipe.outputQuantity)}</p>
    <div class="table-responsive"><table class="table"><thead><tr><th>Thành phần</th><th>Định mức</th></tr></thead><tbody>${recipe.lines.map(line=>`<tr><td>${esc(line.code)} · ${esc(line.name)}</td><td>${number(line.quantity)} ${esc(line.unit)}</td></tr>`).join('')}</tbody></table></div>
    <p>${esc(recipe.note||'')}</p>`);
}
function runDetail(run){
  const snapshot=run.snapshot;
  openModal(`Lệnh sản xuất ${run.id}`,`
    <p>${esc(formatDateTime(run.createdAt))} · ${esc(names[snapshot.outputKind])} ${esc(snapshot.outputId)} · BOM v${number(snapshot.version)}</p>
    <p>Sản lượng thực tế: <strong>${number(run.quantity)}</strong> / chuẩn ${number(snapshot.batchQuantity)}</p>
    <div class="table-responsive"><table class="table"><thead><tr><th>Thành phần</th><th>Định mức chuẩn</th><th>Tiêu hao thực tế</th></tr></thead><tbody>
      ${snapshot.lines.map(line=>`<tr><td>${esc(line.code)} · ${esc(names[line.kind])}</td><td>${number(line.quantity)} ${esc(line.unit)}</td><td>${number(Number(line.quantity)*Number(run.quantity)/Number(snapshot.batchQuantity))} ${esc(line.unit)}</td></tr>`).join('')}
    </tbody></table></div>`);
}
const lookupRow=(kind,selected)=>`<div class="bom-lookup"><div class="bom-lookup-controls"><input class="form-control" type="search" data-bom-search aria-label="Tìm mã hoặc tên" placeholder="Tìm mã hoặc tên…" maxlength="80"><button type="button" class="btn btn-secondary" data-bom-find="${kind}">Tìm</button></div>
  <select class="form-control" data-bom-choice aria-label="Kết quả tìm kiếm" required>${selected?`<option value="${esc(selected.id)}" selected>${esc(selected.label)}</option>`:'<option value="">Chọn kết quả sau khi tìm</option>'}</select></div>`;
const createSemiButton=(hidden=false)=>`<div class="bom-quick-create" ${hidden?'hidden':''}><span>Chưa có bán thành phẩm?</span><button type="button" class="btn btn-secondary btn-sm" data-bom-create-semi>+ Tạo bán thành phẩm</button></div>`;
async function lookup(button){
  const holder=button.closest('.bom-lookup'),field=holder.querySelector('[data-bom-search]');
  const mode=button.dataset.bomFind==='sku'?'skus':'items';
  const kind=button.dataset.bomFind==='component'
    ? button.closest('.bom-line').querySelector('[data-bom-component-kind]').value
    : button.dataset.bomFind==='raw'||button.dataset.bomFind==='semi'?button.dataset.bomFind:undefined;
  const result=await bomGateway.read({mode,query:field.value.trim(),kind,limit:15});
  const select=holder.querySelector('[data-bom-choice]');
  select.innerHTML='<option value="">Chọn kết quả</option>'+result.rows.filter(row=>row.is_active!==false)
    .map(row=>`<option value="${esc(row.id)}">${esc(row.code)} · ${esc(row.name)}</option>`).join('');
  if(result.hasMore)showToast('Có thêm kết quả; nhập mã chính xác hơn để thu hẹp.','info');
}
function recipeLine(stage,selected){const picked=selected&&{id:selected.itemId,label:selected.label||`${selected.code} · ${selected.name}`};return `<article class="bom-line"><div class="bom-line-top"><span class="bom-line-index" aria-hidden="true"></span>
  ${stage==='sku'?`<label class="bom-component-kind"><span>Loại thành phần</span><select class="form-control" data-bom-component-kind aria-label="Loại thành phần"><option value="semi" ${selected?.kind==='semi'?'selected':''}>Bán thành phẩm</option><option value="packaging" ${selected?.kind==='packaging'?'selected':''}>Bao bì</option></select></label>`:'<span class="bom-kind-fixed">Nguyên liệu</span>'}
  <button type="button" class="bom-remove-line" data-bom-remove aria-label="Xóa thành phần">Xóa</button></div>
  <div class="bom-line-fields"><div class="bom-component-picker"><span class="bom-field-label">Chọn vật tư</span>${lookupRow(stage==='semi'?'raw':'component',picked)}${stage==='sku'?createSemiButton(selected?.kind==='packaging'):''}</div>
  <label class="bom-quantity-field"><span>Định mức cho mẻ chuẩn</span><input class="form-control" data-bom-quantity type="number" min="0.0001" max="100000000" step="0.0001" required placeholder="Ví dụ: 2,5" value="${esc(selected?.quantity)}"><small>Theo đơn vị gốc của vật tư</small></label></div></article>`;}
function recipeEditor(existing,prefill={}){
  if(!admin())return;
  const stage=existing?.outputKind||prefill.stage||'semi';
  const outputPicker=existing
    ? `<div class="bom-output-lookup bom-output-locked"><strong>${esc(existing.outputId)}</strong><small>Đầu ra được khóa theo phiên bản này</small><input type="hidden" data-bom-choice value="${esc(existing.outputId)}"></div>`
    : `<div class="bom-output-lookup">${lookupRow(stage,prefill.output)}${stage==='semi'?createSemiButton():''}</div>`;
  const shell=openModal(existing?`BOM ${existing.status==='draft'?'nháp':'phiên bản mới'}`:'Tạo BOM',`
    <div class="bom-recipe-intro"><span>${existing?'CHỈNH SỬA CÔNG THỨC':'THIẾT LẬP CÔNG THỨC'}</span><p>Lưu thành bản nháp để rà soát. BOM chỉ ảnh hưởng tồn kho sau khi được áp dụng và có lệnh sản xuất.</p></div>
    <section class="bom-recipe-section"><div class="bom-recipe-section-heading"><span class="bom-step-number">1</span><div><h4>Đầu ra và sản lượng chuẩn</h4><p>Chọn công đoạn, sản phẩm đầu ra và lượng tạo ra trong một mẻ.</p></div></div>
      <fieldset class="bom-stage-picker" aria-label="Chọn công đoạn">
        <label class="bom-stage-card"><input type="radio" name="stage" value="semi" ${stage==='semi'?'checked':''} ${existing?'disabled':''}><span class="bom-stage-kicker">CÔNG ĐOẠN 1</span><strong>Nguyên liệu → Bán thành phẩm</strong><small>Nấu hoặc pha chế bán thành phẩm</small></label>
        <label class="bom-stage-card"><input type="radio" name="stage" value="sku" ${stage==='sku'?'checked':''} ${existing?'disabled':''}><span class="bom-stage-kicker">CÔNG ĐOẠN 2</span><strong>Bán thành phẩm + Bao bì → SKU</strong><small>Đóng gói thành sản phẩm bán</small></label>
      </fieldset>
      <div class="bom-recipe-output-grid"><div class="bom-output-field"><span id="bom-output-label">${stage==='semi'?'Bán thành phẩm đầu ra':'SKU đầu ra'}</span>${outputPicker}</div>
        <label class="bom-output-quantity"><span>Sản lượng chuẩn / mẻ</span><input class="form-control" name="outputQuantity" type="number" min="0.0001" max="100000000" step="0.0001" required value="${esc(existing?.outputQuantity??prefill.outputQuantity??1)}"><small>Định mức thành phần bên dưới áp dụng cho lượng này.</small></label></div>
    </section>
    <section class="bom-recipe-section"><div class="bom-recipe-section-heading"><span class="bom-step-number">2</span><div><h4>Thành phần cho một mẻ</h4><p id="bom-stage-hint">${stage==='semi'?'Chọn nguyên liệu và lượng tiêu hao theo đơn vị gốc.':'Chọn bán thành phẩm hoặc bao bì cho từng dòng.'}</p></div><span class="bom-line-count" id="bom-line-count"></span></div>
      <div id="bom-lines" class="bom-lines">${(existing?.lines?.length?existing.lines:prefill.lines?.length?prefill.lines:[null]).map(line=>recipeLine(stage,line)).join('')}</div>
      <button type="button" class="btn btn-secondary bom-add-line" data-bom-add><span aria-hidden="true">+</span>Thêm thành phần</button>
    </section>
    <section class="bom-recipe-section bom-note-section"><label><span>Ghi chú <small>Tùy chọn</small></span><textarea class="form-control" name="note" maxlength="240" rows="2" placeholder="Ví dụ: thời gian ủ, lưu ý đóng gói…">${esc(existing?.note??prefill.note)}</textarea></label></section>`,async form=>{
      const outputKind=existing?.outputKind||form.querySelector('[name="stage"]:checked').value;
      const outputId=form.querySelector('.bom-output-lookup [data-bom-choice]').value;
      const lines=[...form.querySelectorAll('.bom-line')].map(line=>({itemId:line.querySelector('[data-bom-choice]').value,
        quantity:Number(line.querySelector('[data-bom-quantity]').value)}));
      if(!outputId||lines.some(line=>!line.itemId))throw new Error('Chọn đầu ra và tất cả thành phần từ kết quả tìm kiếm.');
      if(new Set(lines.map(line=>line.itemId)).size!==lines.length)throw new Error('Thành phần không được trùng.');
      await bomGateway.saveDraft({outputKind,outputId,outputQuantity:Number(form.querySelector('[name="outputQuantity"]').value),
        note:form.querySelector('[name="note"]').value.trim(),lines});
      showToast('Đã lưu bản nháp BOM. Áp dụng khi sẵn sàng sản xuất.','success');
    });
  shell.querySelector('.bom-modal').classList.add('bom-recipe-modal');
  shell.querySelector('.modal-footer').insertAdjacentHTML('afterbegin','<button type="button" class="btn btn-secondary" data-bom-cancel>Hủy</button>');
  shell.querySelector('[data-bom-cancel]').onclick=()=>shell.querySelector('.modal-close').click();
  shell.querySelector('form [type="submit"]').textContent='Lưu bản nháp';
  const updateLineCount=()=>{
    const count=shell.querySelectorAll('.bom-line').length;
    shell.querySelector('#bom-line-count').textContent=`${count}/30 thành phần`;
    shell.querySelector('[data-bom-add]').disabled=count>=30;
  };
  const captureDraft=()=>{
    const outputSelect=shell.querySelector('.bom-output-lookup [data-bom-choice]');
    return {stage:shell.querySelector('[name="stage"]:checked').value,
      output:outputSelect?.value?{id:outputSelect.value,label:outputSelect.selectedOptions[0]?.textContent||''}:undefined,
      outputQuantity:shell.querySelector('[name="outputQuantity"]').value,note:shell.querySelector('[name="note"]').value,
      lines:[...shell.querySelectorAll('.bom-line')].map(line=>{
        const select=line.querySelector('[data-bom-choice]');
        return {itemId:select.value||undefined,label:select.value?select.selectedOptions[0]?.textContent||'':undefined,
          kind:line.querySelector('[data-bom-component-kind]')?.value||'raw',quantity:line.querySelector('[data-bom-quantity]').value};
      })};
  };
  updateLineCount();
  shell.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.bomFind){button.disabled=true;try{await lookup(button);}catch(error){showToast(error.message,'danger');}finally{button.disabled=false;}}
    if(button.hasAttribute('data-bom-create-semi')){
      const draft=captureDraft(),line=button.closest('.bom-line');
      const lineIndex=line?[...shell.querySelectorAll('.bom-line')].indexOf(line):-1;
      if(lineIndex>=0)draft.lines[lineIndex].kind='semi';
      itemEditor(null,{kindOnly:'semi',onSuccess:item=>{
        if(!item?.id)throw new Error('Đã lưu nhưng không nhận được mã vật tư để chọn vào BOM.');
        const selected={itemId:item.id,label:`${item.code} · ${item.name}`,kind:'semi',quantity:lineIndex>=0?draft.lines[lineIndex]?.quantity:undefined};
        if(lineIndex>=0)draft.lines[lineIndex]=selected;
        else draft.output={id:item.id,label:`${item.code} · ${item.name}`};
        recipeEditor(null,draft);
      }});
      return;
    }
    if(button.hasAttribute('data-bom-add')){
      const lines=shell.querySelector('#bom-lines');if(lines.children.length>=30)return;
      lines.insertAdjacentHTML('beforeend',recipeLine(shell.querySelector('[name="stage"]:checked').value));updateLineCount();
    }
    if(button.hasAttribute('data-bom-remove')&&shell.querySelectorAll('.bom-line').length>1){button.closest('.bom-line').remove();updateLineCount();}
  });
  shell.addEventListener('change',event=>{
    if(event.target.matches('[data-bom-component-kind]'))
      {const line=event.target.closest('.bom-line');line.querySelector('[data-bom-choice]').innerHTML='<option value="">Chọn từ kết quả tìm kiếm</option>';
        const quickCreate=line.querySelector('[data-bom-create-semi]');if(quickCreate)quickCreate.hidden=event.target.value!=='semi';}
    if(event.target.matches('[name="stage"]')){
      const nextStage=event.target.value;
      shell.querySelector('.bom-output-lookup').innerHTML=lookupRow(nextStage);
      shell.querySelector('#bom-output-label').textContent=nextStage==='semi'?'Bán thành phẩm đầu ra':'SKU đầu ra';
      shell.querySelector('#bom-stage-hint').textContent=nextStage==='semi'
        ?'Chọn nguyên liệu và lượng tiêu hao theo đơn vị gốc.'
        :'Chọn bán thành phẩm hoặc bao bì cho từng dòng.';
      shell.querySelector('#bom-lines').innerHTML=recipeLine(nextStage);updateLineCount();
    }
  });
}
function runEditor(recipe){
  const key=crypto.randomUUID();
  const shell=openModal(`Sản xuất theo BOM v${recipe.version}`,`
    <p>Đầu ra: <strong>${esc(names[recipe.outputKind])} · ${esc(recipe.outputId)}</strong></p>
    <label>Sản lượng thực hiện<input class="form-control" name="quantity" type="number" min="0.0001" max="100000000" step="0.0001" value="${esc(recipe.outputQuantity)}" required></label>
    <div id="bom-preview" class="inventory-status"></div>
    <p>Lệnh sẽ trừ đủ tất cả thành phần và cộng đầu ra trong cùng giao dịch. Thiếu tồn sẽ hủy toàn bộ lệnh.</p>`,async form=>{
      const quantity=Number(form.querySelector('[name="quantity"]').value);
      await bomGateway.run({requestKey:key,versionId:recipe.id,quantity});
      showToast('Đã ghi lệnh sản xuất và cập nhật tồn.','success');
    });
  const preview=()=>{
    const ratio=Number(shell.querySelector('[name="quantity"]').value)/Number(recipe.outputQuantity);
    shell.querySelector('#bom-preview').innerHTML=Number.isFinite(ratio)&&ratio>0
      ? recipe.lines.map(line=>`${esc(line.code)}: <strong>${number(Number(line.quantity)*ratio)} ${esc(line.unit)}</strong>`).join(' · ')
      :'Nhập sản lượng để xem mức tiêu hao.';
  };
  shell.querySelector('[name="quantity"]').oninput=preview;preview();
}
