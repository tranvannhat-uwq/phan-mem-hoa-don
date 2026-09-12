import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  calculateHistoryFinancialSummary,
  getSalesReturnRefundAmount,
  isSalesReturnActive
} from '../js/domain/order-financials.js';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('detailed invoice export includes return product rows with negative quantity and negative amount', () => {
  const customers = read('js/components/customers.js');
  const helperStart = customers.indexOf('function toExportDateValue');
  const helperEnd = customers.indexOf('function createHistoryDetailExportWorksheet', helperStart);
  const helperSource = customers.slice(helperStart, helperEnd);
  const sandbox = {};
  vm.runInNewContext(`
    const state = {
      companies: [{ id: 'ABS_NORTH', name: 'Công ty ABS' }],
      salesReturns: [{
        id: 'TH-001',
        saleId: 'HD001',
        status: 'completed',
        returnDate: '2026-09-02T10:00:00+07:00',
        totalRefund: 592900,
        items: [{
          variantCode: 'NT-Đ1-THUNG',
          productName: 'Sơn lót chống kiềm nội thất cao cấp',
          quantity: 1,
          refundPrice: 592900,
          subtotal: 592900
        }]
      }]
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
    function getOrderFinancialBreakdown(order, returns) {
      return {
        totalBeforeDiscount: 1602400,
        totalDiscountAmount: 0,
        otherFeeAmount: 0,
        shippingFeeAmount: 0,
        totalPayment: 1602400
      };
    }
    function isSalesReturnActive(ret) {
      return ret && ret.status !== 'cancelled' && ret.status !== 'draft';
    }
    function getSalesReturnRefundAmount(ret) {
      return Number(ret.totalRefund || 0);
    }
    function getPricelistName(id) { return 'Bảng giá chuẩn'; }
    function getDisplayUserName(name) { return name || ''; }
    ${helperSource}
    this.buildRows = buildHistoryDetailExportRows;
  `, sandbox);

  const orderRows = sandbox.buildRows([{
    order: {
      id: 'HD001',
      companyId: 'ABS_NORTH',
      date: '2026-09-01T10:00:00+07:00',
      status: 'partially_returned',
      items: []
    },
    customer: { code: 'KH01', name: 'Đại lý Minh Phát', province: 'Thái Nguyên' },
    rows: [
      {
        'Kinh doanh quản lý': 'Mr Vui',
        'Mã hóa đơn': 'HD001',
        'Mã trả hàng': '',
        'Mã khách hàng': 'KH01',
        'Tên khách hàng': 'Đại lý Minh Phát',
        'Mã hàng': 'NT-Đ1-THUNG',
        'Tên hàng': 'Sơn lót chống kiềm nội thất cao cấp',
        'Thương hiệu': 'NANO10 MB',
        'Quy cách': 'Thùng 22,5 kg',
        'Ghi chú hàng hóa': '',
        'Số lượng': 1,
        'Đơn giá': 592900,
        'Giảm giá %': 0,
        'Giảm giá': 0,
        'Giá bán': 592900,
        'Thành tiền': 592900
      },
      {
        'Kinh doanh quản lý': 'Mr Vui',
        'Mã hóa đơn': 'HD001',
        'Mã trả hàng': '',
        'Mã khách hàng': 'KH01',
        'Tên khách hàng': 'Đại lý Minh Phát',
        'Mã hàng': 'NT-Đ2-THUNG',
        'Tên hàng': 'Sơn lót chống kiềm ngoại thất cao cấp',
        'Thương hiệu': 'NANO10 MB',
        'Quy cách': 'Thùng 22 kg',
        'Ghi chú hàng hóa': '',
        'Số lượng': 2,
        'Đơn giá': 801200,
        'Giảm giá %': 0,
        'Giảm giá': 0,
        'Giá bán': 801200,
        'Thành tiền': 1602400
      }
    ]
  }]);

  // Total rows: 2 order item rows + 1 return product row = 3 rows!
  assert.equal(orderRows.length, 3);

  // Return row checks
  const returnRow = orderRows[2];
  assert.equal(returnRow['Mã hóa đơn'], 'HD001');
  assert.equal(returnRow['Mã trả hàng'], 'TH-001');
  assert.equal(returnRow['Mã hàng'], 'NT-Đ1-THUNG');
  assert.equal(returnRow['Tên hàng'], 'Sơn lót chống kiềm nội thất cao cấp');
  assert.equal(returnRow['Số lượng'], -1);
  assert.equal(returnRow['Thành tiền'], -592900);
  assert.equal(returnRow['Trạng thái'], 'Trả một phần');

  // Accounting reconciliation check:
  // Order original: 592.900 + 1.602.400 = 2.195.300
  // Return line: -592.900
  // SUM(Thành tiền): 1.602.400 (Net revenue after return)
  const excelNetSum = orderRows.reduce((sum, r) => sum + r['Thành tiền'], 0);
  assert.equal(excelNetSum, 1602400);
});

test('calculateHistoryFinancialSummary correctly matches net revenue after returns', () => {
  const orders = [{
    id: 'HD001',
    status: 'settled',
    totalPayable: 2195300
  }];
  const returns = [{
    id: 'TH-001',
    saleId: 'HD001',
    status: 'completed',
    totalRefund: 592900
  }];

  const summary = calculateHistoryFinancialSummary(orders, returns);
  assert.equal(summary.totalReturnAmount, 592900);
  assert.equal(summary.totalPayable, 1602400);
});

test('detailed invoice export reconciles a deducted return with the history goods total', () => {
  const customers = read('js/components/customers.js');
  const helperStart = customers.indexOf('function toExportDateValue');
  const helperEnd = customers.indexOf('function createHistoryDetailExportWorksheet', helperStart);
  const helperSource = customers.slice(helperStart, helperEnd);
  const sandbox = {};
  vm.runInNewContext(`
    const state = {
      companies: [{ id: 'ABS_NORTH', name: 'Công ty ABS' }],
      salesReturns: [{
        id: 'RET-00699',
        saleId: 'HD-20260818-00000699',
        status: 'completed',
        returnDate: '2026-08-18T14:00:00+07:00',
        totalRefund: 608100,
        items: [{
          saleItemId: 'item-01',
          variantCode: 'NX-B1-THUNG',
          productName: 'Sơn siêu bóng nội thất đặc biệt',
          quantity: 1,
          importPrice: 1216200,
          refundPrice: 608100,
          subtotal: 608100,
          deductionPercent: 50
        }]
      }]
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
    function getOrderFinancialBreakdown(order, returns) {
      return {
        totalBeforeDiscount: 589293,
        totalDiscountAmount: 17679,
        otherFeeAmount: 0,
        shippingFeeAmount: 0,
        totalPayment: 571614
      };
    }
    function isSalesReturnActive(ret) {
      return ret && ret.status !== 'cancelled' && ret.status !== 'draft';
    }
    function getSalesReturnRefundAmount(ret) {
      return Number(ret.totalRefund || 0);
    }
    function getPricelistName(id) { return 'Bảng giá chuẩn'; }
    function getDisplayUserName(name) { return name || ''; }
    ${helperSource}
    this.buildRows = buildHistoryDetailExportRows;
  `, sandbox);

  const orderRows = sandbox.buildRows([{
    order: {
      id: 'HD-20260818-00000699',
      companyId: 'ABS_NORTH',
      date: '2026-08-18T13:49:00+07:00',
      status: 'partially_returned',
      items: [{
        id: 'item-01',
        variantCode: 'NX-B1-THUNG',
        productName: 'Sơn siêu bóng nội thất đặc biệt',
        quantity: 1,
        unitPrice: 1216200
      }]
    },
    customer: { code: 'KH-UNG-THE', name: 'Triệu Ứng Thế', province: 'Thái Nguyên' },
    rows: [
      {
        'Kinh doanh quản lý': 'Ms01 - Lê Dung',
        'Mã hóa đơn': 'HD-20260818-00000699',
        'Mã khách hàng': 'KH-UNG-THE',
        'Tên khách hàng': 'Triệu Ứng Thế',
        'Mã hàng': 'NX-B1-THUNG',
        'Tên hàng': 'Sơn siêu bóng nội thất đặc biệt',
        'Thương hiệu': 'NANO10 MB',
        'Quy cách': 'Thùng 19 kg',
        'Số lượng': 1,
        'Đơn giá': 1216200,
        'Giảm giá %': 0,
        'Giảm giá': 0,
        'Giá bán': 1216200,
        'Thành tiền': 1216200
      }
    ]
  }]);

  assert.equal(orderRows.length, 2);
  const returnRow = orderRows[1];

  assert.equal(returnRow['Tổng tiền hàng'], -626907);
  assert.equal(returnRow['Giảm giá hóa đơn'], -18807);
  assert.equal(returnRow['Khách cần trả'], -608100);
  assert.equal(
    returnRow['Tổng tiền hàng'] - returnRow['Giảm giá hóa đơn'],
    returnRow['Khách cần trả']
  );
  assert.equal(returnRow['Số lượng'], -1);
  assert.equal(returnRow['Đơn giá'], 1216200);
  assert.equal(returnRow['Giá bán'], 626907);
  assert.equal(returnRow['Thành tiền'], -626907);

  // 1.216.200 - 626.907 = 589.293, exactly the value shown in history.
  const excelNetSum = orderRows.reduce((sum, r) => sum + r['Thành tiền'], 0);
  assert.equal(excelNetSum, 589293);
});
