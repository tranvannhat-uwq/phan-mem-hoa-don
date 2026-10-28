import {supplierDay,supplierDateRange,supplierFilterError} from './supplier-directory.js';
export const SUPPLIER_DEBT_REPORT_COLUMNS=['Mã nhà cung cấp','Tên nhà cung cấp','Nợ đầu kỳ','Ghi nợ','Ghi có','Nợ cuối kỳ'];
export function supplierReportRange(preset,cutoff,today=new Date()) {
  const to=supplierDay(today), start=cutoff?supplierDay(cutoff):'';
  let range;
  if(preset==='retained') range={from:start||to.slice(0,8)+'01',to};
  else if(preset==='week') {
    const end=new Date(to+'T00:00:00Z');
    end.setUTCDate(end.getUTCDate()-(end.getUTCDay()+6)%7);
    range={from:end.toISOString().slice(0,10),to};
  } else range=supplierDateRange(preset,today);
  if(start&&range.from<start)range.from=start;
  return range;
}
export function supplierReportFilterError(filters) {
  if(!filters.from||!filters.to)return 'Chọn đủ ngày bắt đầu và kết thúc báo cáo.';
  const error=supplierFilterError(filters);if(error)return error;
  for(const key of ['min','max'])if(filters[key]!==''&&(!Number.isFinite(Number(filters[key]))||Math.abs(Number(filters[key]))>Number.MAX_SAFE_INTEGER))return 'Khoảng công nợ không hợp lệ.';
  return '';
}
export const supplierReportDayLabel=value=>String(value||'').split('-').reverse().join('/');
export function supplierReportExcelRows(report,rows) {
  const {totals}=report;
  return [
    ['BÁO CÁO CÔNG NỢ THEO NHÀ CUNG CẤP'],
    [`Từ ngày ${supplierReportDayLabel(report.from)} đến ngày ${supplierReportDayLabel(report.to)}`],
    ['Ngày lập',new Date(report.generatedAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})],
    SUPPLIER_DEBT_REPORT_COLUMNS,
    [`SL NCC: ${report.total}`,'TỔNG CỘNG',totals.opening,totals.debit,totals.credit,totals.closing],
    ...rows.map(r=>[r.code,r.name,Number(r.opening),Number(r.debit),Number(r.credit),Number(r.closing)])
  ];
}
