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

test('detailed invoice export accurately breaks down return lines with original price, discount, and net refund amount', () => {
  const customers = read('js/components/customers.js');
  const helperStart = customers.indexOf('function toExportDateValue');
  const helperEnd = customers.indexOf('function createHistoryDetailExportWorksheet', helperStart);
  const helperSource = customers.slice(helperStart, helperEnd);
  const sandbox = {};
  vm.runInNewContext(`
    const state = {
      companies: [{ id: 'ABS_NORTH', name: 'Công ty ABS' }],
      salesReturns: [{
        id: 'RET3-001',
        saleId: 'HD-0388',
        status: 'completed',
        returnDate: '2026-09-12T09:04:00+07:00',
        totalRefund: 1704678,
        items: [{
          saleItemId: 'item-01',
          variantCode: 'H2-1-1-THUNG',
          productName: 'Sơn chống thấm trộn xi măng',
          quantity: 2,
          importPrice: 878700,
          refundPrice: 852339,
          subtotal: 1704678
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
        totalBeforeDiscount: 8391580,
        totalDiscountAmount: 251747,
        otherFeeAmount: 0,
        shippingFeeAmount: 0,
        totalPayment: 8139833
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
      id: 'HD-0388',
      companyId: 'ABS_NORTH',
      date: '2026-08-12T09:31:00+07:00',
      status: 'partially_returned',
      items: [{
        id: 'item-01',
        variantCode: 'H2-1-1-THUNG',
        productName: 'Sơn chống thấm trộn xi măng',
        quantity: 2,
        unitPrice: 878700
      }]
    },
    customer: { code: 'KH-CUONG', name: 'Nguyễn Văn Cường', province: 'Bắc Ninh' },
    rows: [
      {
        'Kinh doanh quản lý': 'Ms Dung',
        'Mã hóa đơn': 'HD-0388',
        'Mã trả hàng': '',
        'Mã khách hàng': 'KH-CUONG',
        'Tên khách hàng': 'Nguyễn Văn Cường',
        'Mã hàng': 'H2-1-1-THUNG',
        'Tên hàng': 'Sơn chống thấm trộn xi măng',
        'Thương hiệu': 'Nano10*',
        'Quy cách': 'Thùng 20,5 kg',
        'Ghi chú hàng hóa': '',
        'Số lượng': 2,
        'Đơn giá': 878700,
        'Giảm giá %': 0,
        'Giảm giá': 0,
        'Giá bán': 878700,
        'Thành tiền': 1757400
      }
    ]
  }]);

  assert.equal(orderRows.length, 2);
  const returnRow = orderRows[1];

  // Gross goods amount of the return: 2 * 878.700 = -1.757.400
  assert.equal(returnRow['Tổng tiền hàng'], -1757400);

  // Return discount (reversal): -(1.757.400 - 1.704.678) = -52.722
  assert.equal(returnRow['Giảm giá hóa đơn'], -52722);

  // Net amount payable / refund: -1.704.678
  assert.equal(returnRow['Khách cần trả'], -1704678);

  // Product line detail matches the gross product line so SUM(Thành tiền) matches Tổng tiền hàng
  assert.equal(returnRow['Số lượng'], -2);
  assert.equal(returnRow['Đơn giá'], 878700);
  assert.equal(returnRow['Giảm giá %'], 0);
  assert.equal(returnRow['Giảm giá'], 0);
  assert.equal(returnRow['Giá bán'], 878700);
  assert.equal(returnRow['Thành tiền'], -1757400);

  // Net goods amount in Excel is exactly 0 after returning 2 items:
  const excelNetSum = orderRows.reduce((sum, r) => sum + r['Thành tiền'], 0);
  assert.equal(excelNetSum, 0);
});

