import {state} from '../state.js';
import {showToast} from '../utils.js';
import {dbSupplierDebtReport} from '../services/supabase.js?v=20261028-supplier-delete-v1';
import {openSupplierDebtHistory} from './supplier-reports.js?v=20261028-supplier-delete-v1';
import {SUPPLIER_DEBT_REPORT_COLUMNS as columns,supplierReportRange,supplierReportFilterError,supplierReportDayLabel as dayLabel,supplierReportExcelRows} from '../domain/supplier-debt-report.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number(v||0).toLocaleString('vi-VN');
const byId=id=>document.getElementById('supplier-period-'+id);
let dialog, report=null, applied=null, request=0, busy=false, mode='report', allRows=null, page=0;

function filters() {
  const value=id=>byId(id).value;
  return {from:value('from'),to:value('to'),query:value('query').trim(),min:value('min'),max:value('max'),status:value('status')};
}
function exportEnabled(enabled) {
  ['excel','print'].forEach(id=>{byId(id).disabled=!enabled;});
}
function invalidate() {
  request++; report=null;applied=null;allRows=null;page=0;
  exportEnabled(false);byId('result').innerHTML='<div class="supplier-period-empty">Điều kiện đã thay đổi. Bấm <strong>Tạo báo cáo</strong> để xem kết quả.</div>';
  byId('pagination').innerHTML='';byId('error').textContent='';
}
function heading(data) {
  return `<div class="supplier-period-document-head"><p>Ngày lập: ${esc(new Date(data.generatedAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}))}</p><h2>Báo cáo công nợ theo nhà cung cấp</h2><p>Từ ngày ${dayLabel(data.from)} đến ngày ${dayLabel(data.to)}</p><small>Đơn vị: đồng · Sắp xếp công nợ cao đến thấp</small></div>`;
}
function table(data,rows,interactive=true) {
  return `<table class="supplier-period-table"><thead><tr>${columns.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody><tr class="supplier-period-total"><th scope="row" colspan="2">SL NCC: ${data.total}</th>${['opening','debit','credit','closing'].map(k=>`<td>${money(data.totals[k])}</td>`).join('')}</tr>${rows.map(r=>`<tr><td>${interactive?`<button type="button" class="supplier-period-code" data-supplier-id="${esc(r.id)}">${esc(r.code)}</button>`:`<strong>${esc(r.code)}</strong>`}</td><td>${esc(r.name)}</td>${['opening','debit','credit','closing'].map(k=>`<td class="${Number(r[k])<0?'supplier-period-negative':''}">${money(r[k])}</td>`).join('')}</tr>`).join('')||'<tr><td colspan="6" class="supplier-period-empty">Không có nhà cung cấp phù hợp điều kiện đã chọn.</td></tr>'}</tbody></table>`;
}
function render() {
  if(!report)return;
  const rows=mode==='chart'?(allRows||report.rows):report.rows;
  let content=table(report,rows);
  if(mode==='chart') {
    const top=rows.slice(0,10),max=Math.max(1,...top.map(r=>Math.abs(Number(r.closing))));
    content=`<div class="supplier-period-chart"><h3>Công nợ cuối kỳ · ${top.length} nhà cung cấp đầu danh sách</h3>${top.map(r=>`<div class="supplier-period-chart-row"><span title="${esc(r.name)}">${esc(r.name)}</span><div class="supplier-period-chart-track"><span class="${Number(r.closing)<0?'is-advance':''}" style="width:${Math.max(1,Math.abs(Number(r.closing))/max*100)}%"></span></div><strong>${money(r.closing)}</strong></div>`).join('')||'<p>Không có dữ liệu phù hợp.</p>'}</div>`;
  }
  byId('result').innerHTML=`<article class="supplier-period-paper">${heading(report)}${content}<p class="supplier-period-footnote">Nợ đầu kỳ + Ghi nợ − Ghi có = Nợ cuối kỳ. Ghi nợ/ghi có gồm cả giao dịch điều chỉnh, hủy và đảo công nợ trong kỳ. Số dư âm là khoản trả trước.</p></article>`;
  byId('result').querySelectorAll('[data-supplier-id]').forEach(button=>button.addEventListener('click',()=>{
    const r=report.rows.find(r=>r.id===button.dataset.supplierId);
    const current=state.suppliers.find(s=>s.id===r.id);
    openSupplierDebtHistory(current||{...r,debt:r.closing});
  }));
  const pages=Math.max(1,Math.ceil(report.total/20));
  byId('pagination').innerHTML=mode==='chart'?`<span>Biểu đồ theo công nợ cuối kỳ · ${report.total} NCC phù hợp</span>`:`<span>${report.total?page*20+1:0}–${Math.min(page*20+20,report.total)} / ${report.total} nhà cung cấp</span><div><button type="button" class="btn btn-secondary btn-sm" id="supplier-period-prev" ${page===0?'disabled':''}>Trước</button><span>Trang ${page+1} / ${pages}</span><button type="button" class="btn btn-secondary btn-sm" id="supplier-period-next" ${page+1>=pages?'disabled':''}>Sau</button></div>`;
  byId('prev')?.addEventListener('click',()=>load(page-1));byId('next')?.addEventListener('click',()=>load(page+1));
  exportEnabled(report.total>0&&!busy);
}
async function load(nextPage=0) {
  const chosen=nextPage===0?filters():applied;
  const error=supplierReportFilterError(chosen||{});
  if(error){invalidate();byId('error').textContent=error;return;}
  const ticket=++request;
  report=null;allRows=null;exportEnabled(false);byId('error').textContent='';byId('pagination').innerHTML='';
  byId('result').innerHTML='<div class="supplier-period-empty" role="status">Đang tổng hợp công nợ trong kỳ…</div>';
  try {
    const data=await dbSupplierDebtReport(chosen,nextPage*20,20);
    if(ticket!==request||!dialog.open)return;
    if(nextPage>0&&nextPage*20>=data.total){await load(0);return;}
    report=data;applied={...chosen};page=nextPage;
    if(mode==='chart')allRows=await collectRows(ticket);
    if(ticket!==request||!dialog.open)return;
    render();
  }catch(error){if(ticket!==request)return;report=null;byId('error').textContent=error.message||'Không tải được báo cáo.';byId('result').innerHTML='<div class="supplier-period-empty">Chưa lập được báo cáo. Hãy thử lại.</div>';}
}
async function collectRows(ticket) {
  if(allRows)return allRows;
  const snapshot=report,selection={...applied},rows=[];
  for(let offset=0;offset<snapshot.total;offset+=100) {
    const data=await dbSupplierDebtReport(selection,offset,100);
    if(ticket!==request||!dialog.open)throw new Error('Điều kiện báo cáo đã thay đổi.');
    if(data.fingerprint!==snapshot.fingerprint||data.total!==snapshot.total)throw new Error('Dữ liệu vừa thay đổi. Hãy tạo lại báo cáo trước khi xuất.');
    if(data.rows.length!==Math.min(100,snapshot.total-offset))throw new Error('Chưa tải đủ dữ liệu báo cáo. Hãy thử lại.');
    rows.push(...data.rows);
  }
  if(new Set(rows.map(r=>r.id)).size!==snapshot.total)throw new Error('Dữ liệu báo cáo bị trùng trang. Hãy tạo lại báo cáo.');
  allRows=rows;return rows;
}
async function setMode(nextMode) {
  mode=nextMode;
  ['report','chart'].forEach(value=>byId(value).setAttribute('aria-pressed',String(value===mode)));
  if(!report)return;
  if(mode==='chart'){
    const ticket=request;busy=true;exportEnabled(false);
    try{allRows=await collectRows(ticket);if(ticket===request)render();}
    catch(error){if(ticket===request&&dialog.open)byId('error').textContent=error.message;}
    finally{busy=false;if(report)exportEnabled(report.total>0);}
  }else render();
}
async function exportReport(kind) {
  if(!report||busy)return;
  // Open synchronously from the user's click, before awaiting report pages.
  const popup=kind==='print'?window.open('','_blank','width=1200,height=850'):null;
  if(kind==='print'&&!popup){showToast('Trình duyệt đang chặn cửa sổ in. Hãy cho phép và thử lại.','warning');return;}
  const ticket=request,snapshot=report;busy=true;exportEnabled(false);
  try {
    const rows=await collectRows(ticket);
    if(kind==='excel') {
      if(!globalThis.XLSX)throw new Error('Chưa tải được thư viện Excel. Hãy tải lại trang.');
      const ws=XLSX.utils.aoa_to_sheet(supplierReportExcelRows(snapshot,rows));
      ws['!cols']=[30,48,22,22,22,22].map(wch=>({wch}));
      ws['!merges']=[0,1].map(r=>({s:{r,c:0},e:{r,c:5}}));
      for(let r=4;r<rows.length+5;r++)for(let c=0;c<6;c++){
        const cell=ws[XLSX.utils.encode_cell({r,c})];if(!cell)continue;
        if(c>=2)cell.z='#,##0;[Red]-#,##0';else{cell.t='s';cell.z='@';}
      }
      const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'CongNoNhaCungCap');
      XLSX.writeFile(wb,`BaoCaoCongNoNCC_${snapshot.from}_${snapshot.to}.xlsx`);
      showToast(`Đã xuất ${rows.length} nhà cung cấp theo kỳ báo cáo.`,'success');
    } else {
      popup.document.write(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Báo cáo công nợ NCC</title><style>@page{size:A4 landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#222;margin:24px}.supplier-period-document-head{text-align:center;margin-bottom:24px}.supplier-period-document-head>p:first-child{text-align:left;font-size:12px}h2{font-size:24px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border-bottom:1px solid #ccc;padding:10px 8px;text-align:left}th:nth-child(n+3),td:nth-child(n+3),.supplier-period-total td{text-align:right;white-space:nowrap}thead{display:table-header-group;background:#b6e9f7}.supplier-period-total{background:#f2eed6;font-weight:bold}.supplier-period-negative{color:#b45309}.supplier-period-footnote{font-size:11px;margin-top:20px}tr{break-inside:avoid}strong{color:#1666a8}</style></head><body>${heading(snapshot)}${table(snapshot,rows,false)}<p class="supplier-period-footnote">Nợ đầu kỳ + Ghi nợ − Ghi có = Nợ cuối kỳ. Ghi nợ/ghi có gồm giao dịch điều chỉnh và hủy/đảo trong kỳ. Đơn vị: đồng.</p></body></html>`);
      popup.document.close();popup.focus();popup.print();
    }
  }catch(error){popup?.close();showToast(error.message||'Không xuất được báo cáo.','danger');}
  finally{busy=false;if(report)exportEnabled(report.total>0);}
}
export function openSupplierPeriodReport() {
  if(!['admin','accounting'].includes(state.currentUser?.role))return;
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='supplier-period-dialog';dialog.className='supplier-period-dialog';dialog.setAttribute('aria-labelledby','supplier-period-title');document.body.append(dialog);
    dialog.innerHTML=`<header class="supplier-period-header"><div><span>BÁO CÁO NHÀ CUNG CẤP</span><h2 id="supplier-period-title">Báo cáo công nợ</h2></div><button type="button" class="btn btn-secondary btn-sm" id="supplier-period-close">Đóng</button></header><div class="supplier-period-layout"><aside class="supplier-period-sidebar"><div class="supplier-period-exports"><button type="button" class="btn btn-success btn-sm" id="supplier-period-excel" disabled>Xuất Excel tất cả</button><button type="button" class="btn btn-secondary btn-sm" id="supplier-period-print" disabled>In / Lưu PDF</button></div><form id="supplier-period-form"><label>Kỳ báo cáo<select class="form-control" id="supplier-period-preset"><option value="retained">Toàn bộ kỳ còn lưu</option><option value="week">Tuần này</option><option value="month">Tháng này</option><option value="previous-month">Tháng trước</option><option value="7">7 ngày gần đây</option><option value="30">30 ngày gần đây</option><option value="custom">Tùy chọn ngày</option></select></label><div class="supplier-period-dates"><label>Từ ngày<input type="date" class="form-control" id="supplier-period-from" required></label><label>Đến ngày<input type="date" class="form-control" id="supplier-period-to" required></label></div><label>Nhà cung cấp<input type="search" class="form-control" id="supplier-period-query" placeholder="Mã, tên, số điện thoại"></label><label>Công nợ cuối kỳ<select class="form-control" id="supplier-period-status"><option value="activity">Có số dư hoặc phát sinh</option><option value="all">Tất cả nhà cung cấp</option><option value="payable">Còn phải trả</option><option value="advance">Đã trả trước</option><option value="settled">Đã tất toán</option></select></label><label>Công nợ từ (đ)<input type="number" class="form-control" id="supplier-period-min" step="any" placeholder="Không giới hạn"></label><label>Công nợ đến (đ)<input type="number" class="form-control" id="supplier-period-max" step="any" placeholder="Không giới hạn"></label><button type="submit" class="btn btn-primary" id="supplier-period-generate">Tạo báo cáo</button><p class="supplier-period-sidebar-note">Lọc theo công nợ cuối kỳ. Tổng báo cáo gồm tất cả các trang phù hợp.</p></form></aside><main class="supplier-period-main"><div class="supplier-period-toolbar"><div class="supplier-period-mode" aria-label="Kiểu hiển thị"><button type="button" id="supplier-period-report" aria-pressed="true">Báo cáo</button><button type="button" id="supplier-period-chart" aria-pressed="false">Biểu đồ</button></div><span id="supplier-period-status-text">Theo giao dịch trong kỳ</span></div><p id="supplier-period-error" role="alert"></p><div id="supplier-period-result" class="supplier-period-result" aria-live="polite"></div><footer id="supplier-period-pagination" class="supplier-period-pagination"></footer></main></div>`;
    byId('close').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{request++;report=null;allRows=null;});
    byId('form').addEventListener('submit',e=>{e.preventDefault();void load();});
    byId('form').addEventListener('input',e=>{
      if(['supplier-period-from','supplier-period-to'].includes(e.target.id))byId('preset').value='custom';
      invalidate();
    });
    byId('preset').addEventListener('change',()=>{
      if(byId('preset').value==='custom')return;
      const range=supplierReportRange(byId('preset').value,state.retentionCutoff);
      byId('from').value=range.from;byId('to').value=range.to;invalidate();
    });
    byId('report').onclick=()=>void setMode('report');byId('chart').onclick=()=>void setMode('chart');
    byId('excel').onclick=()=>void exportReport('excel');byId('print').onclick=()=>void exportReport('print');
  }
  if(dialog.open)return;
  byId('form').reset();mode='report';busy=false;applied=null;
  ['report','chart'].forEach(value=>byId(value).setAttribute('aria-pressed',String(value===mode)));
  const range=supplierReportRange('retained',state.retentionCutoff);
  byId('from').value=range.from;byId('to').value=range.to;
  if(state.retentionCutoff)byId('from').min=new Date(state.retentionCutoff).toLocaleDateString('sv-SE',{timeZone:'Asia/Ho_Chi_Minh'});
  dialog.showModal();void load();
}
