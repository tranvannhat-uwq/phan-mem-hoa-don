import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSupplierDirectory as filter, supplierDirectoryTotals as totals, supplierFilterError, supplierDateRange, supplierDay } from '../js/domain/supplier-directory.js';

const rows = [
  { id:'a', name:'Công ty Ánh Dương', code:'NCC01', phone:'0900123456', address:'Hà Nội', debt:200, totalPurchase:1000, totalPaid:800, createdAt:'2026-09-30T17:00:00Z', lastPurchaseAt:'2026-10-27T17:00:00Z' },
  { id:'b', name:'Bình Minh', code:'NCC02', debt:-50, totalPurchase:400, totalPaid:450, notes:'Giao buổi sáng', createdAt:'2026-10-31T17:00:00Z', lastPaymentAt:'2026-10-01T10:00:00+07:00' },
  { id:'c', name:'Đại Việt', code:'NCC03', debt:0, totalPurchase:100, totalPaid:100, createdAt:'2026-10-31T16:59:59Z' },
  { id:'d', name:'Ngừng sử dụng', debt:9000, isActive:false },
  { id:'e', name:'Chưa có ngày', debt:10, totalPurchase:80, totalPaid:70 }
];
test('search ignores Vietnamese accents and combines words across supplier contact fields', () => {
  assert.deepEqual(filter(rows,{query:'anh duong ha noi'}).map(x=>x.id),['a']);
  assert.deepEqual(filter(rows,{query:'giao sang'}).map(x=>x.id),['b']);
});
test('debt status and signed amount ranges distinguish payable, settled and prepaid balances', () => {
  assert.deepEqual(filter(rows,{debt:'payable',min:'100'}).map(x=>x.id),['a']);
  assert.deepEqual(filter(rows,{debt:'advance',min:'-50',max:'0'}).map(x=>x.id),['b']);
  assert.deepEqual(filter(rows,{debt:'settled'}).map(x=>x.id),['c']);
});
test('date filters include complete local days, exclude unknown dates and use the selected date basis', () => {
  assert.equal(supplierDay(rows[0].createdAt),'2026-10-01');
  assert.deepEqual(filter(rows,{from:'2026-10-01',to:'2026-10-31'}).map(x=>x.id),['a','c']);
  assert.deepEqual(filter(rows,{dateField:'lastPurchaseAt',from:'2026-10-28',to:'2026-10-28'}).map(x=>x.id),['a']);
  assert.deepEqual(filter(rows,{dateField:'lastPaymentAt',to:'2026-10-01'}).map(x=>x.id),['b']);
});
test('invalid ranges produce a clear validation error rather than misleading totals', () => {
  for(const filters of [{from:'2026-13-01'},{from:'2026-02-30'},{from:'2026-10-31',to:'2026-10-01'},{min:'10',max:'-10'}]) {
    assert.ok(supplierFilterError(filters)); assert.deepEqual(filter(rows,filters),[]);
  }
});
test('sorting and totals cover the whole filtered list and preserve the canonical input', () => {
  const before=JSON.stringify(rows);
  assert.deepEqual(filter(rows,{sort:'debt-desc'}).map(x=>x.id),['a','e','c','b']);
  assert.deepEqual(totals(filter(rows,{debt:'payable'})),{count:2,debt:210,payable:210,payableCount:2,advance:0,purchase:1080,paid:870});
  assert.equal(totals(filter(rows)).advance,50);
  assert.equal(JSON.stringify(rows),before);
});
test('date shortcuts handle month boundaries, leap years and inclusive day counts', () => {
  const today=new Date('2026-10-28T00:00:00Z');
  assert.deepEqual(supplierDateRange('7',today),{from:'2026-10-22',to:'2026-10-28'});
  assert.deepEqual(supplierDateRange('month',today),{from:'2026-10-01',to:'2026-10-28'});
  assert.deepEqual(supplierDateRange('previous-month',new Date('2024-03-01T00:00:00Z')),{from:'2024-02-01',to:'2024-02-29'});
  assert.deepEqual(supplierDateRange('previous-month',new Date('2026-01-01T00:00:00Z')),{from:'2025-12-01',to:'2025-12-31'});
});
