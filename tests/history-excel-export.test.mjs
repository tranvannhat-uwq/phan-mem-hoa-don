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

test('history Excel export matches the supplied one-sheet detailed invoice layout', () => {
  const customers = read('js/components/customers.js');

  assert.match(customers, /function sortOrdersForAccountingExport\(orders\)/);
  assert.match(customers, /function buildHistoryDetailExportRows\(orderContexts\)/);
  assert.match(customers, /return \[\.\.\.orderContexts\]\.reverse\(\)\.flatMap/);
  assert.match(customers, /function createHistoryDetailExportWorksheet\(rows\)/);
  assert.match(customers, /XLSX\.utils\.book_append_sheet\(workbook, detailWorksheet, 'DanhSachChiTietHoaDon'\)/);
  assert.match(customers, /DanhSachChiTietHoaDon_/);
  assert.doesNotMatch(customers, /'Tổng hợp theo mã SP'|'Chi tiết theo mã SP'/);
  assert.match(customers, /Đã xuất \$\{historyDetailRowCount\} dòng hàng hóa theo đúng mẫu chi tiết hóa đơn/);
});

test('detailed invoice export keeps the exact 61-column sample order', () => {
  const customers = read('js/components/customers.js');
  const columnsStart = customers.indexOf('const HISTORY_DETAIL_EXPORT_COLUMNS');
  const columnsEnd = customers.indexOf('const HISTORY_DETAIL_EXPORT_DATE_COLUMNS', columnsStart);
  const columnsSource = customers.slice(columnsStart, columnsEnd);
  const sandbox = {};
  vm.runInNewContext(`
    ${columnsSource}
    this.columns = HISTORY_DETAIL_EXPORT_COLUMNS;
  `, sandbox);

  const expectedColumns = [
    'Chi nhánh', 'Mã hóa đơn', 'Mã vận đơn', 'Địa chỉ lấy hàng', 'Mã đối soát',
    'Phí trả ĐTGH', 'Thời gian', 'Thời gian tạo', 'Ngày cập nhật', 'Mã đặt hàng',
    'Mã trả hàng', 'Mã khách hàng', 'Tên khách hàng', 'Email', 'Điện thoại',
    'Địa chỉ (Khách hàng)', 'Khu vực (Khách hàng)', 'Phường/Xã (Khách hàng)',
    'Ngày sinh', 'Bảng giá', 'Người bán', 'Kênh bán', 'Người tạo',
    'Đối tác giao hàng', 'Người nhận', 'Điện thoại (Người nhận)',
    'Địa chỉ (Người nhận)', 'Khu vực (Người nhận)', 'Phường/Xã (Người nhận)',
    'Dịch vụ', 'Trọng lượng (gram)', 'Dài', 'Rộng', 'Cao',
    'Ghi chú trạng thái giao hàng', 'Ghi chú giao hàng', 'Ghi chú',
    'Tổng tiền hàng', 'Giảm giá hóa đơn', 'Thu khác', 'Khách cần trả',
    'Khách đã trả', 'Tiền mặt', 'Thẻ', 'Ví', 'Chuyển khoản',
    'Còn cần thu (COD)', 'Thời gian giao hàng', 'Trạng thái',
    'Trạng thái giao hàng', 'Mã hàng', 'Tên hàng', 'Thương hiệu', 'ĐVT',
    'Ghi chú hàng hóa', 'Số lượng', 'Đơn giá', 'Giảm giá %', 'Giảm giá',
    'Giá bán', 'Thành tiền'
  ];
  assert.deepEqual(Array.from(sandbox.columns), expectedColumns);
  assert.equal(sandbox.columns.length, 61);
  assert.match(customers, /'Mã hàng': row\['Mã hàng'\]/);
  assert.match(customers, /'Tên hàng': row\['Tên hàng'\]/);
  assert.match(customers, /'Số lượng': row\['Số lượng'\]/);
  assert.match(customers, /'Thành tiền': row\['Thành tiền'\]/);
});

test('detailed invoice export applies section colors and shrinks columns without data', () => {
  const customers = read('js/components/customers.js');
  const sizingStart = customers.indexOf('const HISTORY_DETAIL_EXPORT_DATE_COLUMNS');
  const sizingEnd = customers.indexOf('function toExportDateValue', sizingStart);
  const sizingSource = customers.slice(sizingStart, sizingEnd);
  const sandbox = { Intl, Date };
  vm.runInNewContext(`
    ${sizingSource}
    this.getWidth = getHistoryDetailExportColumnWidth;
    this.headerColors = HISTORY_DETAIL_EXPORT_HEADER_GROUPS.map(group => group.color);
  `, sandbox);

  const rows = [
    { 'Mã vận đơn': '', 'Tên hàng': 'Sơn nội thất cao cấp', 'Số lượng': 12 },
    { 'Mã vận đơn': null, 'Tên hàng': 'Sơn lót', 'Số lượng': 2 }
  ];
  assert.equal(sandbox.getWidth('Mã vận đơn', rows), 5);
  assert.ok(sandbox.getWidth('Tên hàng', rows) >= 20);
  assert.ok(sandbox.getWidth('Số lượng', rows) >= 11);
  assert.deepEqual(Array.from(sandbox.headerColors), ['1F4E78', '0F6B78', '5B5EA6', '548235', 'C65911', '7030A0']);

  assert.match(customers, /patternType: 'solid'/);
  assert.match(customers, /HISTORY_DETAIL_EXPORT_STATUS_STYLES/);
  assert.match(customers, /XLSX\.writeFile\(workbook, fileName, \{ cellStyles: true \}\)/);
  assert.match(read('index.html'), /xlsx-js-style@1\.2\.0\/dist\/xlsx\.bundle\.js/);
});

test('detailed invoice export emits one repeated invoice row per product line', () => {
  const customers = read('js/components/customers.js');
  const helperStart = customers.indexOf('function toExportDateValue');
  const helperEnd = customers.indexOf('function createHistoryDetailExportWorksheet', helperStart);
  const helperSource = customers.slice(helperStart, helperEnd);
  const sandbox = {};
  vm.runInNewContext(`
    const state = {
      companies: [{ id: 'ABS_NORTH', name: 'Công ty ABS' }],
      salesReturns: []
    };
    function normalizeExportOrderStatus(status) { return status; }
    function getOrderStatusLabel(status) { return status; }
    function normalizeCompanyId() { return 'ABS_NORTH'; }
    function getProvinceNameByCode(value) { return value || ''; }
    function toExportNumber(value, fallback = 0) {
      if (value === null || value === undefined || value === '') return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    function getLineAmount(item) { return Number(item.subtotal || 0); }
    function getOrderFinancialBreakdown() {
      return {
        totalBeforeDiscount: 300000,
        totalDiscountAmount: 0,
        otherFeeAmount: 0,
        shippingFeeAmount: 0,
        totalPayment: 300000
      };
    }
    ${helperSource}
    this.buildRows = buildHistoryDetailExportRows;
  `, sandbox);

  const rows = sandbox.buildRows([{
    order: { id: 'HD001', companyId: 'ABS_NORTH', date: '2026-09-01T10:00:00+07:00', status: 'settled', items: [] },
    customer: { code: 'KH01', name: 'Khách A', province: 'Thái Nguyên' },
    rows: [
      { 'Mã hóa đơn': 'HD001', 'Mã khách hàng': 'KH01', 'Tên khách hàng': 'Khách A', 'Mã hàng': 'SP01', 'Tên hàng': 'Sơn A', 'Số lượng': 1, 'Đơn giá': 100000, 'Giảm giá %': 0, 'Giảm giá': 0, 'Giá bán': 100000, 'Thành tiền': 100000 },
      { 'Mã hóa đơn': 'HD001', 'Mã khách hàng': 'KH01', 'Tên khách hàng': 'Khách A', 'Mã hàng': 'SP02', 'Tên hàng': 'Sơn B', 'Số lượng': 2, 'Đơn giá': 100000, 'Giảm giá %': 0, 'Giảm giá': 0, 'Giá bán': 100000, 'Thành tiền': 200000 }
    ]
  }]);

  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => row['Mã hóa đơn']), ['HD001', 'HD001']);
  assert.deepEqual(Array.from(rows, row => row['Mã hàng']), ['SP01', 'SP02']);
  assert.deepEqual(Array.from(rows, row => row['Thành tiền']), [100000, 200000]);
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
