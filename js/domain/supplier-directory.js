export const supplierNumber = value => {
  const parsed = Number(typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value);
  return Number.isFinite(parsed) ? parsed : 0;
};
export function supplierSearchText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}
export function supplierDay(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(date);
}
export function supplierFilterError(filters) {
  const validDate = value => {
    if (!value) return true;
    const date = new Date(`${value}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validDate(filters.from) || !validDate(filters.to)) return 'Ngày lọc không hợp lệ.';
  if (filters.from && filters.to && filters.from > filters.to) return 'Từ ngày phải trước hoặc bằng đến ngày.';
  if (filters.min !== '' && filters.max !== '' && Number(filters.min) > Number(filters.max)) return 'Công nợ từ phải nhỏ hơn hoặc bằng công nợ đến.';
  return '';
}
export function supplierDateRange(preset, today = new Date()) {
  if (preset === 'all') return { from: '', to: '' };
  const end = new Date(supplierDay(today) + 'T00:00:00Z');
  const start = new Date(end);
  if (preset === 'month') start.setUTCDate(1);
  else if (preset === 'previous-month') {
    end.setUTCDate(0); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 1);
  } else start.setUTCDate(start.getUTCDate() - (preset === '7' ? 6 : 29));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
export function filterSupplierDirectory(suppliers, filters = {}) {
  if (supplierFilterError(filters)) return [];
  const terms = supplierSearchText(filters.query).split(/\s+/).filter(Boolean);
  const field = ['createdAt', 'updatedAt', 'lastPurchaseAt', 'lastPaymentAt'].includes(filters.dateField) ? filters.dateField : 'createdAt';
  const rows = (suppliers || []).filter(s => {
    if (!s || s.isActive === false) return false;
    const debt = supplierNumber(s.debt);
    const text = supplierSearchText([s.code, s.name, s.phone, s.address, s.notes].join(' '));
    if (!terms.every(term => text.includes(term))) return false;
    if (filters.debt === 'payable' && debt <= 0 || filters.debt === 'settled' && debt !== 0 || filters.debt === 'advance' && debt >= 0) return false;
    if (filters.min !== undefined && filters.min !== '' && debt < Number(filters.min)) return false;
    if (filters.max !== undefined && filters.max !== '' && debt > Number(filters.max)) return false;
    if (filters.from || filters.to) {
      const date = supplierDay(s[field]);
      if (!date || filters.from && date < filters.from || filters.to && date > filters.to) return false;
    }
    return true;
  });
  const nameOrder = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi')
    || String(a.id || a.code || '').localeCompare(String(b.id || b.code || ''));
  const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const sorts = {
    'debt-desc': (a, b) => supplierNumber(b.debt) - supplierNumber(a.debt),
    'debt-asc': (a, b) => supplierNumber(a.debt) - supplierNumber(b.debt),
    'purchase-desc': (a, b) => supplierNumber(b.totalPurchase) - supplierNumber(a.totalPurchase),
    'paid-desc': (a, b) => supplierNumber(b.totalPaid) - supplierNumber(a.totalPaid),
    'newest': (a, b) => time(b.createdAt) - time(a.createdAt),
    'last-purchase': (a, b) => time(b.lastPurchaseAt) - time(a.lastPurchaseAt)
  };
  return rows.sort((a, b) => (sorts[filters.sort || 'debt-desc']?.(a, b) || 0) || nameOrder(a, b));
}
export function supplierDirectoryTotals(rows) {
  return rows.reduce((total, row) => {
    const debt = supplierNumber(row.debt);
    total.count++; total.debt += debt;
    total.payable += Math.max(0, debt); total.advance += Math.max(0, -debt);
    total.purchase += supplierNumber(row.totalPurchase); total.paid += supplierNumber(row.totalPaid);
    if (debt > 0) total.payableCount++;
    return total;
  }, { count: 0, debt: 0, payable: 0, payableCount: 0, advance: 0, purchase: 0, paid: 0 });
}
