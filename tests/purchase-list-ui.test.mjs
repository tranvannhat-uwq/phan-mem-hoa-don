import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/purchases.js', import.meta.url), 'utf8');
const utils = readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8');
const identityUtils = (utils.slice(utils.indexOf('export function getUserById('), utils.indexOf('export function getPricelistById('))
  + utils.slice(utils.indexOf('export function isSameUser('), utils.indexOf('// Lấy tên hiển thị của người quản lý linh hoạt'))).replace(/^export /gm, '');
function harness(purchases, dataset = {}, role = 'accounting', users = [], currentUser = {}) {
  const body = { classList: { remove() {} } };
  const modal = { parentElement: body, remove() {} };
  const panel = { dataset, innerHTML: '', querySelector: () => null };
  const context = vm.createContext({
    state: { purchases, users, currentUser: { role, ...currentUser } },
    document: { body, getElementById: () => modal },
    financeRole: () => ['admin', 'accounting'].includes(role),
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    purchaseTotal: purchase => Number(purchase.totalAmount || 0),
    purchaseDate: purchase => purchase.purchaseDate,
    statusLabel: status => ({completed:'Hoàn thành',cancelled:'Đã hủy',draft:'Phiếu tạm'}[status]),
    formatCurrency: value => `${value} ₫`,
    purchaseDetail: () => '<tr class="purchase-detail-row"></tr>',
    syncPurchaseSupplierOptions() {}, attachEvents() {}, safeCreateIcons() {}
  });
  vm.runInContext(identityUtils, context);
  vm.runInContext(source.slice(source.indexOf('function filterPurchaseList(')).replace('export function ', 'function '), context);
  return { panel, context, render() { context.renderPurchasesPanel(panel); return panel.innerHTML; } };
}
const rows = [
  { id:'1', code:'PM-0001', invoiceNumber:'VAT-99', supplierName:'Đặng Minh',supplierCode:'NCC-Đ01', createdBy:'Kế toán',status:'completed',totalAmount:108000,paidAmount:8000,balanceDue:100000 },
  { id:'2', code:'PM-0002', supplierName:'Đặng Minh',status:'cancelled',totalAmount:200000 },
  { id:'3', code:'PM-0003', supplierName:'Bình An',status:'completed',totalAmount:300000 }
];

test('historical supplier imports do not present unallocated payments as unpaid invoices or invent original creators',()=>{
  const imported={...rows[0],sourceReport:{file:'synthetic.xlsx'}};
  const html=harness([imported]).render();
  assert.match(html,/Theo NCC/);assert.match(html,/Chưa phân bổ/);
  assert.match(html,/Excel · không có người tạo gốc/);
  assert.doesNotMatch(html,/purchase-outstanding/);
});

test('purchase list combines accent-insensitive search and status without changing source rows', () => {
  const h = harness(rows);
  assert.deepEqual(Array.from(h.context.filterPurchaseList(rows, 'dang minh', 'completed'), row => row.id), ['1']);
  assert.deepEqual(Array.from(h.context.filterPurchaseList(rows, 'VAT-99', ''), row => row.id), ['1']);
  assert.equal(h.context.filterPurchaseList(rows, 'NCC-d01 ke toan', '').length, 1);
  assert.equal(rows.length, 3);
});

test('pagination shows 20 records, clamps after filtering, and keeps the active detail', () => {
  const many = Array.from({length:45}, (_, index) => ({...rows[0],id:String(index+1),code:`PM-${index+1}`}));
  const h = harness(many, {purchasePage:'2',activePurchaseId:'25'});
  let html = h.render();
  assert.equal((html.match(/class="purchase-row /g) || []).length, 20);
  assert.match(html, /21–40 \/ 45/);
  assert.match(html, /purchase-detail-row/);
  h.panel.dataset.purchaseQuery = 'PM-45';
  html = h.render();
  assert.equal(h.panel.dataset.purchasePage, '1');
  assert.match(html, /1–1 \/ 1 phiếu mua/);
  assert.doesNotMatch(html, /purchase-detail-row/);
});

test('empty data and unmatched filters have distinct guidance', () => {
  const empty = harness([]).render();
  assert.match(empty, /Chưa có phiếu mua hàng/);
  assert.doesNotMatch(empty, /id="btn-clear-purchase-filters"/);
  const unmatched = harness(rows,{purchaseQuery:'khong ton tai'}).render();
  assert.match(unmatched, /Không tìm thấy phiếu phù hợp/);
  assert.match(unmatched, /id="btn-clear-purchase-filters"/);
});

test('list escapes filter text and supplier content and uses shared UI components', () => {
  const html = harness([{...rows[0], supplierName:'<script>bad</script>'}], {purchaseQuery:'"<script>bad</script>'}).render();
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;&lt;script&gt;/);
  const normal = harness(rows).render();
  assert.match(normal, /class="glass-panel purchase-main"/);
  assert.match(normal, /class="table purchase-table"/);
  assert.match(normal, /class="btn btn-primary btn-sm" id="btn-open-purchase-modal"/);
  assert.match(normal, /Tổng gồm VAT/);
});

test('sale role cannot see purchase records or creation controls', () => {
  const html = harness(rows, {}, 'sale').render();
  assert.match(html, /không có quyền/);
  assert.doesNotMatch(html, /PM-0001|btn-open-purchase-modal/);
});

test('creator UUID resolves to the actual profile name and can be searched without changing audit identity', () => {
  const creatorId = '91000000-0000-4000-8000-000000000001';
  const users = [{ id: 'creator-profile', authUserId: creatorId, username: 'creator@test.invalid', displayName: 'Trần Thị Hương', isActive: false }];
  const purchase = { ...rows[0], createdBy: creatorId };
  const h = harness([purchase], {}, 'accounting', users, { id: 'viewer', authUserId: 'different-user', displayName: 'Người đang xem' });
  assert.match(h.render(), /data-label="Người tạo">Trần Thị Hương<\/td>/);
  assert.doesNotMatch(h.render(), /91000000|Người đang xem/);
  assert.equal(h.context.filterPurchaseList([purchase], 'tran thi huong', '').length, 1);
  vm.runInContext(source.slice(source.indexOf('function purchaseDetail('), source.indexOf('function updateTotals(')), h.context);
  assert.match(h.context.purchaseDetail(purchase), /Người tạo:<\/span><strong>Trần Thị Hương/);
  assert.equal(purchase.createdBy, creatorId);
});

test('creator resolver supports profile ID, auth_user_id, username and a matching current profile', () => {
  for (const creator of ['profile-1', '91000000-0000-4000-8000-000000000001', 'owner@test.invalid']) {
    const h = harness([{ ...rows[0], createdBy: creator }], {}, 'admin', [{ id:'profile-1', auth_user_id:'91000000-0000-4000-8000-000000000001', username:'owner@test.invalid', displayName:'Người lập phiếu' }]);
    assert.match(h.render(), /data-label="Người tạo">Người lập phiếu<\/td>/);
  }
  const h = harness([{ ...rows[0], createdBy: '91000000-0000-4000-8000-000000000001' }], {}, 'admin', [],
    { authUserId:'91000000-0000-4000-8000-000000000001', displayName:'Người lập hiện tại' });
  assert.match(h.render(), /data-label="Người tạo">Người lập hiện tại<\/td>/);
});

test('missing creator mappings never substitute the viewer and creator names remain escaped', () => {
  const unknown = harness([{ ...rows[0], createdBy:'91000000-0000-4000-8000-000000000001' }], {}, 'admin', [], { displayName:'Viewer' }).render();
  assert.match(unknown, /data-label="Người tạo">Chưa xác định<\/td>/);
  assert.doesNotMatch(unknown, /91000000|Viewer/);
  const named = harness([{ ...rows[0], createdBy:'owner' }], {}, 'admin', [{ username:'owner', displayName:'<img src=x onerror=alert(1)>' }]).render();
  assert.match(named, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(named, /<img src=x/);
});
