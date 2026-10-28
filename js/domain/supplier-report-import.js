// Supplier debt exports repeat voucher totals on every item row. A payment
// voucher may also contain several allocations with distinct timestamps.
const norm = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
const codeKey = v => norm(v).replace(/[\s-]+$/,'');
const plain = v => norm(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
export const SUPPLIER_REPORT_HEADERS = ['Mã nhà cung cấp','Tên nhà cung cấp','Nợ đầu kỳ','Ghi nợ','Ghi có','Nợ cuối kỳ','Mã giao dịch','Thời gian','Loại giao dịch','Giá trị','Dư nợ cuối','Mã hàng','Tên hàng','Thương hiệu','Nhóm hàng(3 Cấp)','Đơn vị tính','Đơn giá','SL sản phẩm','Thành tiền','Chiếu khấu','VAT nhập hàng','VAT hoàn lại','Chi phí nhập hàng','Chi phí nhập hoàn lại','Tổng cộng'];
export function isSupplierDebtReport(rows) {
  return ['ma nha cung cap','no dau ky','ghi no','ghi co','no cuoi ky','ma giao dich'].every(h => (rows[0] || []).some(v => plain(v) === h));
}
function number(value, row) {
  if (value === '' || value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error(`Dòng ${row}: số không hợp lệ.`);
  return n;
}
function date(value, row) {
  // SheetJS default reads Excel dates as serials; never apply the computer's TZ.
  let text = value;
  if (typeof value === 'number') text = new Date(Math.round((value - 25569) * 86400000)).toISOString().replace('Z','');
  if (value instanceof Date) text = value.toISOString().replace('Z','');
  const match = String(text ?? '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(?:\+07:00)?$/);
  if (!match) throw new Error(`Dòng ${row}: ngày giao dịch không hợp lệ.`);
  const result = `${match[1]}T${match[2].length === 5 ? match[2]+':00' : match[2]}${(match[3] || '').slice(0,4)}+07:00`;
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Dòng ${row}: ngày giao dịch không hợp lệ.`);
  return result;
}
export function parseSupplierDebtReport(rows, { from, to, sourceFile = '', suppliers = [] } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) throw new Error('Chọn đúng ngày đầu kỳ và cuối kỳ của báo cáo.');
  if (!isSupplierDebtReport(rows)) throw new Error('Không phải báo cáo công nợ nhà cung cấp.');
  const headers = rows[0].map(v => String(v ?? '').trim());
  const positions = SUPPLIER_REPORT_HEADERS.map(h => headers.findIndex(v => plain(v) === plain(h)));
  if (positions.some(i => i < 0)) throw new Error('Báo cáo thiếu cột chi tiết. Hãy xuất đầy đủ các cột.');
  const groups = new Map();
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i]; if (!raw?.some(v => v !== '' && v != null)) continue;
    const r = positions.map(p => raw[p] ?? null), code = String(r[0] ?? '').trim(), name = String(r[1] ?? '').trim();
    if (!code || !name) throw new Error(`Dòng ${i+1}: thiếu mã hoặc tên NCC.`);
    const amounts = r.slice(2,6).map(v => number(v,i+1));
    if (Math.abs(amounts[0]+amounts[1]-amounts[2]-amounts[3]) > 0.01) throw new Error(`Dòng ${i+1}: số dư không khớp.`);
    let g = groups.get(codeKey(code));
    if (!g) {
      const byCode = suppliers.filter(s => codeKey(s.code) === codeKey(code));
      const matches = byCode.length ? byCode : suppliers.filter(s => norm(s.name) === norm(name));
      if (matches.length > 1) throw new Error(`NCC ${code}: có nhiều hồ sơ trùng, cần đối chiếu.`);
      g = { supplierId: matches[0]?.id || null, code, name, opening:amounts[0],debit:amounts[1],credit:amounts[2],closing:amounts[3],rows:[],entries:[], _entries:new Map() };
      groups.set(codeKey(code),g);
    }
    if (norm(g.name) !== norm(name) || amounts.some((v,j) => v !== [g.opening,g.debit,g.credit,g.closing][j])) throw new Error(`Dòng ${i+1}: thông tin NCC không nhất quán.`);
    g.rows.push(r);
    if (!norm(r[6]) && !norm(r[7]) && !norm(r[8])) {
      if (r.slice(9).some(v => v != null && v !== '' && v !== 0)) throw new Error(`Dòng ${i+1}: có chi tiết nhưng thiếu giao dịch.`);
      continue;
    }
    const at = date(r[7],i+1), type = plain(r[8]) === 'nhap hang' ? 'purchase' : plain(r[8]) === 'thanh toan' ? 'payment' : '';
    if (!type || !String(r[6] ?? '').trim()) throw new Error(`Dòng ${i+1}: loại hoặc mã giao dịch không được hỗ trợ.`);
    if (at.slice(0,10) < from || at.slice(0,10) > to) throw new Error(`Dòng ${i+1}: giao dịch ngoài kỳ ${from} – ${to}.`);
    const amount = number(r[9],i+1), balance = number(r[10],i+1);
    if ((type === 'purchase' && amount <= 0) || (type === 'payment' && amount >= 0)) throw new Error(`Dòng ${i+1}: dấu số tiền không hợp lệ.`);
    const key = JSON.stringify([String(r[6]).trim(),at,type,amount,balance]);
    let e = g._entries.get(key);
    if (!e) { e = {code:String(r[6]).trim(),date:at,type,amount,balance,rows:[]}; g.entries.push(e); g._entries.set(key,e); }
    if (type === 'payment' && e.rows.length) throw new Error(`Dòng ${i+1}: trùng dòng thanh toán hoàn toàn.`);
    if (type === 'purchase') {
      if (!r[11] || !r[12] || number(r[17],i+1) <= 0 || number(r[16],i+1) < 0 || number(r[18],i+1) < 0) throw new Error(`Dòng ${i+1}: hàng hóa không hợp lệ.`);
    }
    e.rows.push(r);
  }
  const result = [...groups.values()];
  if (!result.length) throw new Error('Báo cáo không có dữ liệu.');
  for (const g of result) {
    const sum = type => g.entries.filter(e => e.type === type).reduce((s,e) => s + e.amount,0);
    if (Math.abs(sum('purchase')-g.debit) > 0.01 || Math.abs(-sum('payment')-g.credit) > 0.01) throw new Error(`NCC ${g.code}: lịch sử không khớp tổng ghi nợ/ghi có.`);
    const seen = new Set();
    for (const e of g.entries.filter(e => e.type === 'purchase')) {
      if (seen.has(norm(e.code))) throw new Error(`Phiếu ${e.code} có dữ liệu mâu thuẫn.`);
      seen.add(norm(e.code));
    }
    delete g._entries;
  }
  return {sourceFile,from,to,headers:SUPPLIER_REPORT_HEADERS,suppliers:result};
}
