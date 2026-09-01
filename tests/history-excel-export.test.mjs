import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('history Excel export preserves the visible order date range', () => {
  const customers = read('js/components/customers.js');
  const openStart = customers.indexOf('export function openHistoryOrderExportModal');
  const openEnd = customers.indexOf('function closeCustomerOrderExportModal', openStart);
  const open = customers.slice(openStart, openEnd);

  assert.match(open, /rangeMode\.value = 'current_filter'/);
  assert.match(open, /selectedOrderIds\.length > 0[\s\S]*?selectedOrderIds\.map\(String\)[\s\S]*?: null/);
  assert.match(open, /activeExportOrderIds = selectedIds/);
  assert.match(open, /datedOrders[\s\S]*?getVnDateInputValueFromDate/);
  assert.match(open, /customRange\.style\.display = 'none'/);
  assert.doesNotMatch(open, /rangeMode\.value = 'last_month'/);
  assert.match(customers, /if \(mode === 'current_filter'\)[\s\S]*?label: 'BoLocLichSuDon'/);
});

test('history Excel export keeps guest and legacy orders and reports failures', () => {
  const customers = read('js/components/customers.js');
  const exportStart = customers.indexOf('async function exportCustomerOrderHistoryExcel');
  const exportEnd = customers.indexOf('function getCustomerDebtSource', exportStart);
  const exporter = customers.slice(exportStart, exportEnd);

  assert.match(exporter, /const isHistoryExport = Array\.isArray\(activeExportOrders\)/);
  assert.match(exporter, /name: order\.customerName \|\| order\.customer_name \|\| 'Khách lẻ'/);
  assert.match(exporter, /if \(!globalThis\.XLSX\)/);
  assert.match(exporter, /catch \(error\)[\s\S]*?Không thể xuất Excel lịch sử đơn hàng/);
  assert.match(customers, /order\.items\.length > 0 \? order\.items : \[\{\}\]/);
});

test('history Excel export separates invoice totals from product lines for accounting', () => {
  const customers = read('js/components/customers.js');

  assert.match(customers, /function createCustomerOrderExportWorksheet\(columns, rows, totalColumns = new Set\(\)\)/);
  assert.match(customers, /function sortOrdersForAccountingExport\(orders\)/);
  assert.match(customers, /if \(isHistoryExport\)[\s\S]*?getHistoryOrderExportColumns\(selectedColumns\)/);
  assert.match(customers, /'Tổng hợp đơn hàng'/);
  assert.match(customers, /'Chi tiết hàng hóa'/);
  assert.match(customers, /HISTORY_ORDER_EXPORT_TOTAL_COLUMNS/);
  assert.match(customers, /HISTORY_ORDER_EXPORT_LINE_TOTAL_COLUMNS/);
  assert.doesNotMatch(customers, /\.map\(row => row\[column\] \?\? ''\)\s*\.join\('\\n'\)/);
  assert.match(customers, /Đã xuất \$\{orderContexts\.length\} đơn vào 2 trang/);
});

test('history Excel export resolves creator and manager UUIDs to employee names', () => {
  const customers = read('js/components/customers.js');
  const resolverStart = customers.indexOf('function getDisplayUserName');
  const resolverEnd = customers.indexOf('function getPricelistName', resolverStart);
  const resolver = customers.slice(resolverStart, resolverEnd);

  assert.match(resolver, /getUserDisplayName\(userReference, String\(userReference\), state\.users \|\| \[\]\)/);
  assert.match(customers, /'Kinh doanh quản lý': getDisplayUserName\(customer\.managedBy \|\| customer\.managed_by\)/);
  assert.match(customers, /'Người bán': getDisplayUserName\(order\.salespersonId \|\| order\.createdBy\)/);
  assert.match(customers, /'Người tạo': getDisplayUserName\(order\.createdBy\)/);
});
