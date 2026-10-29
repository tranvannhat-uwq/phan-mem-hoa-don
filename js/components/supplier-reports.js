import {state} from '../state.js';
import {formatCurrency,showToast} from '../utils.js';
import {dbImportSupplierDebtReport,dbSupplierDebtHistory} from '../services/supabase.js?v=20261029-purchase-discount-v1';
import {isSupplierDebtReport,parseSupplierDebtReport,SUPPLIER_REPORT_HEADERS} from '../domain/supplier-report-import.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let reportRows=null, reportFile='', originalPreview='', historyRequest=0;
export function resetSupplierReportPreview() {
  reportRows=null;reportFile='';
  const container=document.getElementById('supplier-excel-preview-container');
  if(container&&originalPreview)container.innerHTML=originalPreview;
  document.querySelector('#supplier-excel-modal .import-options')?.removeAttribute('hidden');
  const button=document.getElementById('btn-save-supplier-excel-submit');
  if(button)button.textContent='Lưu nhà cung cấp vào hệ thống';
}
function period() {
  const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Ho_Chi_Minh'});
  const [y,m]=today.split('-').map(Number), first=new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,10);
  return {from:first,to:today};
}
function payload() {
  return parseSupplierDebtReport(reportRows,{sourceFile:reportFile,suppliers:state.suppliers,
    from:document.getElementById('supplier-report-from').value,to:document.getElementById('supplier-report-to').value});
}
export function previewSupplierReport(rows,fileName) {
  if(!isSupplierDebtReport(rows))return false;
  reportRows=rows;reportFile=fileName;
  const container=document.getElementById('supplier-excel-preview-container');
  if(!originalPreview)originalPreview=container.innerHTML;
  const range=period();
  document.querySelector('#supplier-excel-modal .import-options')?.setAttribute('hidden','');
  container.style.display='block';
  container.innerHTML=`<h4>Báo cáo công nợ nhà cung cấp</h4><p class="supplier-report-hint">Nhập số dư đầu kỳ, phiếu mua, thanh toán và toàn bộ chi tiết trong file. Chọn đúng kỳ đã dùng khi xuất báo cáo.</p><div class="supplier-report-period"><label>Từ ngày<input type="date" class="form-control" id="supplier-report-from" value="${range.from}"></label><label>Đến ngày<input type="date" class="form-control" id="supplier-report-to" value="${range.to}"></label></div><p id="supplier-report-error" role="alert"></p><div class="table-responsive"><table class="table"><thead><tr><th>Nhà cung cấp</th><th>Đối chiếu</th><th>Nợ trên web</th><th>Đầu kỳ</th><th>Ghi nợ</th><th>Ghi có</th><th>Cuối kỳ theo file</th></tr></thead><tbody id="supplier-report-preview-body"></tbody></table></div><p id="supplier-report-summary" role="status"></p><p class="supplier-report-hint">Lịch sử chỉ rõ thanh toán theo NCC, chưa phân bổ từng phiếu và chưa rõ phương thức chi. Hệ thống giữ thông tin này, không tự ghi chi tiền mặt/ngân hàng. Hồ sơ có số dư hoặc lịch sử trùng kỳ sẽ bị chặn để đối chiếu.</p>`;
  const update=()=>{
    const button=document.getElementById('btn-save-supplier-excel-submit');button.textContent='Nhập toàn bộ báo cáo';button.disabled=true;
    document.getElementById('supplier-report-error').textContent='';
    document.getElementById('supplier-report-preview-body').innerHTML='';document.getElementById('supplier-report-summary').textContent='';
    try {
      const p=payload(), groups=p.suppliers, entries=groups.flatMap(g=>g.entries);
      document.getElementById('supplier-report-preview-body').innerHTML=groups.map(g=>`<tr><td>${esc(g.name)}<small class="supplier-address">${esc(g.code)}</small></td><td>${g.supplierId?'Khớp hồ sơ':'Tạo mới'}</td><td>${formatCurrency(state.suppliers.find(s=>s.id===g.supplierId)?.debt||0)}</td>${['opening','debit','credit','closing'].map(k=>`<td class="supplier-money">${formatCurrency(g[k])}</td>`).join('')}</tr>`).join('');
      document.getElementById('supplier-report-summary').textContent=`${groups.length} NCC · ${entries.filter(e=>e.type==='purchase').length} phiếu mua · ${entries.filter(e=>e.type==='payment').length} dòng thanh toán · Nợ cuối kỳ: ${formatCurrency(groups.reduce((s,g)=>s+g.closing,0))}. Các phiếu mới hơn lịch sử trong file vẫn được giữ và cộng riêng.`;
      button.disabled=false;
    }catch(error){document.getElementById('supplier-report-error').textContent=error.message;}
  };
  ['supplier-report-from','supplier-report-to'].forEach(id=>document.getElementById(id).addEventListener('change',update));
  update();return true;
}
export async function processSupplierReportImport(afterSave) {
  if(!reportRows)return false;
  const button=document.getElementById('btn-save-supplier-excel-submit');button.disabled=true;button.textContent='Đang nhập và đối chiếu…';
  try {
    const result=await dbImportSupplierDebtReport(payload());
    showToast(result.already_imported?'Báo cáo này đã được nhập, không cộng lại.':`Đã nhập ${result.suppliers} NCC, ${result.purchases} phiếu mua, ${result.payments} dòng thanh toán và ${result.items} dòng hàng.`,'success');
    await afterSave();
  }catch(error){showToast(error.message||'Không thể nhập báo cáo.','danger');document.getElementById('supplier-report-error').textContent=error.message;}
  finally{button.disabled=false;button.textContent='Nhập toàn bộ báo cáo';}
  return true;
}
export async function openSupplierDebtHistory(supplier,page=0) {
  let dialog=document.getElementById('supplier-history-dialog');
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='supplier-history-dialog';dialog.className='supplier-history-dialog';dialog.setAttribute('aria-labelledby','supplier-history-title');document.body.append(dialog);
    dialog.addEventListener('close',()=>{historyRequest++;});
    dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  }
  const request=++historyRequest;
  // Clear previous supplier immediately; late responses cannot overwrite it.
  dialog.innerHTML=`<div class="supplier-history-header"><div><h3 id="supplier-history-title">Lịch sử công nợ · ${esc(supplier.name)}</h3><p>${esc(supplier.code)} · Công nợ hiện tại: <strong>${formatCurrency(supplier.debt)}</strong></p></div><button type="button" class="btn btn-secondary btn-sm" id="supplier-history-close" aria-label="Đóng lịch sử">Đóng</button></div><div class="supplier-history-content" role="status">Đang tải lịch sử…</div>`;
  document.getElementById('supplier-history-close').onclick=()=>dialog.close();
  if(!dialog.open)dialog.showModal();
  try{
    const data=await dbSupplierDebtHistory(supplier.id,page*20);if(request!==historyRequest||!dialog.open)return;
    const label={opening_balance:'Số dư đầu kỳ',purchase:'Nhập hàng',supplier_payment:'Thanh toán',purchase_reversal:'Đảo phiếu mua',supplier_payment_reversal:'Đảo thanh toán'};
    dialog.querySelector('.supplier-history-content').innerHTML=`<p class="supplier-report-hint">Thanh toán nhập từ báo cáo được ghi theo NCC, chưa phân bổ từng phiếu. Có thể mở chi tiết để xem đầy đủ các cột nguồn.</p><div class="table-responsive"><table class="table"><thead><tr><th>Ngày</th><th>Mã / loại</th><th>Ghi nợ</th><th>Ghi có</th><th>Số dư sau giao dịch</th><th>Nguồn / chi tiết</th></tr></thead><tbody>${data.rows.map(t=>{
      const e=t.source_report?.entry,rows=e?.rows||[];
      return `<tr><td>${esc(new Date(t.transaction_date).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}))}</td><td>${esc(e?.code||t.notes||'')}<small class="supplier-address">${esc(label[t.transaction_type]||t.transaction_type)}</small></td><td class="supplier-money">${t.amount_change>0?formatCurrency(t.amount_change):'—'}</td><td class="supplier-money">${t.amount_change<0?formatCurrency(-t.amount_change):'—'}</td><td class="supplier-money">${formatCurrency(t.balance_after)}</td><td>${esc(t.source_report?.file||'Ghi nhận trên hệ thống')}</td></tr>${rows.length?`<tr><td colspan="6"><details><summary>Xem ${rows.length} dòng dữ liệu nguồn · ${esc(e.code)}</summary><div class="table-responsive"><table class="table supplier-source-table"><thead><tr>${SUPPLIER_REPORT_HEADERS.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((v,i)=>`<td>${esc(i===7 && typeof v==='number' ? new Date(e.date).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}) : v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></td></tr>`:''}`;
    }).join('')||'<tr><td colspan="6">Chưa có lịch sử công nợ.</td></tr>'}</tbody></table></div><div class="supplier-pagination"><button type="button" class="btn btn-secondary btn-sm" id="supplier-history-prev" ${page===0?'disabled':''}>Trước</button><span>${data.total?`${page*20+1}–${Math.min(page*20+20,data.total)}`:'0'} / ${data.total} giao dịch</span><button type="button" class="btn btn-secondary btn-sm" id="supplier-history-next" ${(page+1)*20>=data.total?'disabled':''}>Sau</button></div>`;
    document.getElementById('supplier-history-prev').onclick=()=>openSupplierDebtHistory(supplier,page-1);
    document.getElementById('supplier-history-next').onclick=()=>openSupplierDebtHistory(supplier,page+1);
  }catch(error){if(request===historyRequest&&dialog.open)dialog.querySelector('.supplier-history-content').textContent=error.message;}
}
