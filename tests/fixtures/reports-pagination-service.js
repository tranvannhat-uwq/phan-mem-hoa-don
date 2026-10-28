// Synthetic, read-only data for the browser harness. No database connections.
const customers = Array.from({ length: 237 }, (_, index) => ({
  code: `KH-${String(index + 1).padStart(3, '0')}`, name: `Đại lý kiểm thử ${index + 1}`,
  phone: '0900000000', debt: 1000000 + index * 10000, managed_by: 'test-admin',
  amount: 500000 + index * 1000, quantity: index + 1, count: index + 1, key: `employee-${index}`
}));
export async function dbFetchPhase5Report({ type, search = '', limit = 20, offset = 0 }) {
  const rows = customers.filter(row => `${row.code} ${row.name}`.toLowerCase().includes(search.toLowerCase()));
  return { total: rows.length, rows: rows.slice(offset, offset + limit),
    summary: { total_debt: rows.reduce((sum, row) => sum + row.debt, 0), overdue_debt: 12000000 } };
}
export async function dbFetchEmployeeBusinessReport(input) {
  const rows = Array.from({ length: 65 }, (_, index) => ({ employee_id: `employee-${index}`,
    employee_name: `Nhân viên kiểm thử ${index + 1}`, employee_code: `NV-${index + 1}`,
    order_count: 10, sold_quantity: 25, net_sales: 50000000, collected: 30000000, debt_balance: 20000000 }));
  const details = Array.from({ length: 123 }, (_, index) => ({ document_date: '2026-10-28T08:00:00+07:00',
    document_type: 'Đơn hàng', document_id: `HD-${index + 1}`, description: 'Chứng từ giả lập', amount: 1000000 }));
  return { total: rows.length, rows: rows.slice(input.offset, input.offset + input.limit), summary: {}, series: [],
    details: input.detail_limit ? details.slice(input.detail_offset, input.detail_offset + input.detail_limit) : [],
    metadata: { detail_total: details.length } };
}
