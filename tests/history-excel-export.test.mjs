import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

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

test('history Excel export groups and sorts rows by product code instead of order code', () => {
  const customers = read('js/components/customers.js');

  assert.match(customers, /function createCustomerOrderExportWorksheet\(columns, rows, totalColumns = new Set\(\)\)/);
  assert.match(customers, /function sortOrdersForAccountingExport\(orders\)/);
  assert.match(customers, /function buildHistoryProductSummaryRows\(rows\)/);
  assert.match(customers, /const productCode = String\(row\['Mã sản phẩm'\]/);
  assert.match(customers, /function sortHistoryProductExportRows\(rows\)/);
  assert.match(customers, /if \(isHistoryExport\)[\s\S]*?getHistoryProductExportColumns\(selectedColumns\)/);
  assert.match(customers, /'Tổng hợp theo mã SP'/);
  assert.match(customers, /'Chi tiết theo mã SP'/);
  assert.match(customers, /HISTORY_PRODUCT_EXPORT_SUM_COLUMNS/);
  assert.match(customers, /HISTORY_PRODUCT_EXPORT_EXCLUDED_COLUMNS/);
  assert.match(customers, /'Mã hóa đơn', 'Mã trả hàng'/);
  assert.match(customers, /LichSuSanPham_/);
  assert.doesNotMatch(customers, /\.map\(row => row\[column\] \?\? ''\)\s*\.join\('\\n'\)/);
  assert.match(customers, /Đã xuất \$\{historyProductCount\} mã sản phẩm vào 2 trang/);
});

test('product history summary combines matching product codes across orders', () => {
  const customers = read('js/components/customers.js');
  const helperStart = customers.indexOf('function uniqueExportColumns');
  const helperEnd = customers.indexOf('function getExportColumnWidth', helperStart);
  const helperSource = customers.slice(helperStart, helperEnd);
  const sandbox = {};
  vm.runInNewContext(`
    function toExportNumber(value, fallback = 0) {
      if (value === null || value === undefined || value === '') return fallback;
      const normalized = typeof value === 'string' ? value.replace(/[^\\d.-]/g, '') : value;
      const num = Number(normalized);
      return Number.isFinite(num) ? num : fallback;
    }
    const HISTORY_PRODUCT_EXPORT_EXCLUDED_COLUMNS = new Set([
      'Mã hóa đơn', 'Mã trả hàng', 'Tổng tiền hàng', 'Tổng giảm giá',
      'Tổng sau giảm giá', 'Phí vận chuyển', 'Khách cọc', 'Còn phải thu'
    ]);
    ${helperSource}
    this.exportHelpers = { buildHistoryProductSummaryRows, getHistoryProductExportColumns };
  `, sandbox);

  const rows = [
    { 'Mã sản phẩm': 'SP02', 'Mã hóa đơn': 'D3', 'Số lượng': 1, 'Đơn giá': 50000, 'Giảm giá': 0, 'Thành tiền': 50000 },
    { 'Mã sản phẩm': 'SP01', 'Mã hóa đơn': 'D1', 'Số lượng': 2, 'Đơn giá': 100000, 'Giảm giá': 20000, 'Thành tiền': 180000 },
    { 'Mã sản phẩm': 'sp01', 'Mã hóa đơn': 'D2', 'Số lượng': 3, 'Đơn giá': 80000, 'Giảm giá': 24000, 'Thành tiền': 216000 }
  ];
  const summary = sandbox.exportHelpers.buildHistoryProductSummaryRows(rows);
  assert.equal(summary.length, 2);
  assert.equal(summary[0]['Mã sản phẩm'], 'SP01');
  assert.equal(summary[0]['Số đơn hàng'], 2);
  assert.equal(summary[0]['Số lượng'], 5);
  assert.equal(summary[0]['Đơn giá bình quân'], 88000);
  assert.equal(summary[0]['Giảm giá'], 44000);
  assert.equal(summary[0]['Thành tiền'], 396000);

  const columns = sandbox.exportHelpers.getHistoryProductExportColumns([
    'Mã hóa đơn', 'Mã hàng', 'Tên hàng', 'Số lượng', 'Thành tiền'
  ]);
  assert.equal(columns.detailColumns[0], 'Mã sản phẩm');
  assert.equal(columns.detailColumns.includes('Mã hóa đơn'), false);
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
