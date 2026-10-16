import { state } from '../state.js';
import { showToast, safeCreateIcons, formatDateTime } from '../utils.js';
import { bomGateway } from '../services/bom.js?v=20261016-bom-v1';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>Number(value||0).toLocaleString('vi-VN',{maximumFractionDigits:4});
const names={raw:'Nguyên liệu',packaging:'Bao bì',semi:'Bán thành phẩm',sku:'SKU thành phẩm'};
const statuses={draft:'Nháp',released:'Đang áp dụng',superseded:'Đã thay thế'};
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
      <div class="inventory-actions"><button type="button" class="btn btn-secondary" data-bom-view="items">Vật tư & tồn</button>
      <button type="button" class="btn btn-secondary" data-bom-view="recipes">Công thức BOM</button>
      <button type="button" class="btn btn-secondary" data-bom-view="runs">Lệnh sản xuất</button></div>
      <form id="bom-search-form" class="inventory-actions"><input class="form-control" name="query" maxlength="80" placeholder="Tìm mã hoặc tên…" aria-label="Tìm BOM"><button class="btn btn-secondary">Tìm</button></form>
      <div class="inventory-actions" id="bom-create-actions"></div>
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
  host.querySelectorAll('[data-bom-view]').forEach(button=>button.classList.toggle('active',button.dataset.bomView===mode));
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
        ? `<tr><td><span class="bom-cell-main"><strong>${esc(row.code)}</strong><small>${esc(row.name)}${row.is_active?'':' · Ngừng sử dụng'}</small></span></td><td>${esc(names[row.kind])}</td><td>${esc(row.base_unit)}</td><td><strong>${number(row.quantity)}</strong></td><td>1 ${esc(row.purchase_unit)} = ${number(row.purchase_to_base)} ${esc(row.base_unit)}</td><td><div class="inventory-actions"><button class="btn btn-secondary btn-sm" data-bom="post-item" data-id="${esc(row.id)}">Phiếu vật tư</button>${admin()?`<button class="btn btn-secondary btn-sm" data-bom="edit-item" data-id="${esc(row.id)}">Sửa</button>`:''}</div></td></tr>`
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
function openModal(title,body,onSubmit){
  modal?.remove();modal=document.createElement('div');modal.className='bom-modal-host';
  modal.innerHTML=`<div class="modal-overlay active"><div class="modal-content bom-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h3>${esc(title)}</h3><button type="button" class="modal-close" aria-label="Đóng">&times;</button></div><form><div class="modal-body">${body}<p class="inventory-error bom-form-error" role="alert" hidden></p></div><div class="modal-footer"><button type="submit" class="btn btn-primary">Lưu</button></div></form></div></div>`;
  document.body.append(modal);
  const close=()=>{modal?.remove();modal=null;};
  modal.querySelector('.modal-close').onclick=close;
  modal.querySelector('.modal-overlay').onclick=event=>{if(event.target===event.currentTarget)close();};
  modal.onkeydown=event=>{if(event.key==='Escape')close();};
  if(!onSubmit){modal.querySelector('.modal-footer').remove();return modal;}
  modal.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,save=form.querySelector('[type="submit"]');
    if(save.disabled)return;save.disabled=true;
    const box=form.querySelector('.bom-form-error');box.hidden=true;
    try{await onSubmit(form);close();restart();}catch(error){box.textContent=error.message;box.hidden=false;}finally{if(save.isConnected)save.disabled=false;}
  };
  modal.querySelector('input,select,button')?.focus();
  return modal;
}
function itemEditor(row){
  if(!admin())return;
  const form=openModal(row?'Sửa vật tư':'Thêm vật tư',`
    <label>Mã vật tư<input class="form-control" name="code" maxlength="60" required value="${esc(row?.code)}"></label>
    <label>Tên vật tư<input class="form-control" name="name" maxlength="120" required value="${esc(row?.name)}"></label>
    <label>Loại<select class="form-control" name="kind">${['raw','packaging','semi'].map(kind=>`<option value="${kind}" ${row?.kind===kind?'selected':''}>${names[kind]}</option>`).join('')}</select></label>
    <div class="bom-grid"><label>Đơn vị gốc<input class="form-control" name="baseUnit" maxlength="24" placeholder="kg, lít, cái…" required value="${esc(row?.base_unit)}"></label>
    <label>Đơn vị mua<input class="form-control" name="purchaseUnit" maxlength="24" placeholder="bao, thùng…" required value="${esc(row?.purchase_unit)}"></label>
    <label>1 đơn vị mua = số đơn vị gốc<input class="form-control" name="purchaseToBase" type="number" min="0.0001" step="0.0001" required value="${esc(row?.purchase_to_base??1)}"></label></div>
    ${row?`<label><input type="checkbox" name="isActive" ${row.is_active?'checked':''}> Đang sử dụng</label>`:''}
    <small>Đơn vị gốc và hệ số quy đổi được khóa sau khi vật tư có tồn hoặc nằm trong BOM.</small>`,async element=>{
      const fields=new FormData(element);
      await bomGateway.saveItem({id:row?.id,code:String(fields.get('code')).trim(),name:String(fields.get('name')).trim(),
        kind:fields.get('kind'),baseUnit:String(fields.get('baseUnit')).trim(),purchaseUnit:String(fields.get('purchaseUnit')).trim(),
        purchaseToBase:Number(fields.get('purchaseToBase')),isActive:row?fields.has('isActive'):true});
      showToast('Đã lưu vật tư.','success');
    });
  return form;
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
const lookupRow=(kind,selected)=>`<div class="bom-lookup"><div class="inventory-actions"><input class="form-control" data-bom-search placeholder="Tìm mã hoặc tên…" maxlength="80"><button type="button" class="btn btn-secondary" data-bom-find="${kind}">Tìm</button></div>
  <select class="form-control" data-bom-choice required>${selected?`<option value="${esc(selected.id)}" selected>${esc(selected.label)}</option>`:'<option value="">Chọn từ kết quả tìm kiếm</option>'}</select></div>`;
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
function recipeLine(stage,selected){return `<div class="bom-line"><div>${stage==='sku'?`<select class="form-control" data-bom-component-kind aria-label="Loại thành phần"><option value="semi" ${selected?.kind==='semi'?'selected':''}>Bán thành phẩm</option><option value="packaging" ${selected?.kind==='packaging'?'selected':''}>Bao bì</option></select>`:''}${lookupRow(stage==='semi'?'raw':'component',selected&&{id:selected.itemId,label:`${selected.code} · ${selected.name}`})}</div>
  <input class="form-control" data-bom-quantity type="number" min="0.0001" max="100000000" step="0.0001" required placeholder="Định mức" value="${esc(selected?.quantity)}">
  <button type="button" class="btn btn-secondary" data-bom-remove aria-label="Bỏ thành phần">×</button></div>`;}
function recipeEditor(existing){
  if(!admin())return;
  const stage=existing?.outputKind||'semi';
  const outputPicker=existing
    ? `<div class="bom-output-lookup"><strong>${esc(existing.outputId)}</strong><input type="hidden" data-bom-choice value="${esc(existing.outputId)}"></div>`
    : `<div class="bom-output-lookup">${lookupRow(stage)}</div>`;
  const shell=openModal(existing?`BOM ${existing.status==='draft'?'nháp':'phiên bản mới'}`:'Tạo BOM',`
    <label>Công đoạn<select class="form-control" name="stage" ${existing?'disabled':''}><option value="semi" ${stage==='semi'?'selected':''}>Nguyên liệu → Bán thành phẩm</option><option value="sku" ${stage==='sku'?'selected':''}>Bán thành phẩm + Bao bì → SKU</option></select></label>
    <strong>Đầu ra</strong>${outputPicker}
    <label>Sản lượng chuẩn<input class="form-control" name="outputQuantity" type="number" min="0.0001" max="100000000" step="0.0001" required value="${esc(existing?.outputQuantity??1)}"></label>
    <strong>Thành phần cho sản lượng chuẩn</strong><div id="bom-lines">${(existing?.lines?.length?existing.lines:[null]).map(line=>recipeLine(stage,line)).join('')}</div>
    <button type="button" class="btn btn-secondary" data-bom-add>Thêm thành phần</button>
    <label>Ghi chú<input class="form-control" name="note" maxlength="240" value="${esc(existing?.note)}"></label>`,async form=>{
      const outputKind=existing?.outputKind||form.querySelector('[name="stage"]').value;
      const outputId=form.querySelector('.bom-output-lookup [data-bom-choice]').value;
      const lines=[...form.querySelectorAll('.bom-line')].map(line=>({itemId:line.querySelector('[data-bom-choice]').value,
        quantity:Number(line.querySelector('[data-bom-quantity]').value)}));
      if(!outputId||lines.some(line=>!line.itemId))throw new Error('Chọn đầu ra và tất cả thành phần từ kết quả tìm kiếm.');
      if(new Set(lines.map(line=>line.itemId)).size!==lines.length)throw new Error('Thành phần không được trùng.');
      await bomGateway.saveDraft({outputKind,outputId,outputQuantity:Number(form.querySelector('[name="outputQuantity"]').value),
        note:form.querySelector('[name="note"]').value.trim(),lines});
      showToast('Đã lưu bản nháp BOM. Áp dụng khi sẵn sàng sản xuất.','success');
    });
  shell.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.bomFind){button.disabled=true;try{await lookup(button);}catch(error){showToast(error.message,'danger');}finally{button.disabled=false;}}
    if(button.hasAttribute('data-bom-add')){
      const lines=shell.querySelector('#bom-lines');if(lines.children.length>=30)return;
      lines.insertAdjacentHTML('beforeend',recipeLine(shell.querySelector('[name="stage"]').value));
    }
    if(button.hasAttribute('data-bom-remove')&&shell.querySelectorAll('.bom-line').length>1)button.closest('.bom-line').remove();
  });
  shell.addEventListener('change',event=>{
    if(event.target.matches('[data-bom-component-kind]'))
      event.target.closest('.bom-line').querySelector('[data-bom-choice]').innerHTML='<option value="">Chọn từ kết quả tìm kiếm</option>';
  });
  if(!existing)shell.querySelector('[name="stage"]').onchange=event=>{
    shell.querySelector('.bom-output-lookup').innerHTML=lookupRow(event.target.value);
    shell.querySelector('#bom-lines').innerHTML=recipeLine(event.target.value);
  };
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
