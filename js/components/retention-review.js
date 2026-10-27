import { state } from '../state.js';
import { dbRetentionReviewOrders, getRetentionSessionScope } from '../services/supabase.js?v=20261027-retention-holds-v1';
import { getOrderDisplayCode } from '../domain/order-display.js';

const el = id => document.getElementById(`retention-review-${id}`);
const allowed = () => ['admin', 'accounting'].includes(state.currentUser?.role);
const number = value => Number(value || 0).toLocaleString('vi-VN', { maximumFractionDigits: 4 });
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('vi-VN') : 'Chưa có ngày';
let scope = ''; let offset = 0; let total = 0; let request = 0; let loaded = false; let busy = false; let setup = false;

function element(tag, text, parent) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (parent) parent.append(node);
  return node;
}
function controls() {
  el('prev').disabled = busy || offset === 0;
  el('next').disabled = busy || offset + 25 >= total;
  el('refresh').disabled = busy;
}
function showRows(rows) {
  el('list').replaceChildren();
  for (const entry of rows) {
    const order = entry.current_order || entry.source_snapshot?.order || {};
    const items = entry.current_items || entry.source_snapshot?.items || [];
    const card = element('details', undefined, el('list'));
    card.className = 'retention-review-order';
    element('summary', `${getOrderDisplayCode(order)} · ${order.customer_name || 'Chưa rõ khách'} · ${number(order.total_payable)} ₫`, card);
    element('p', `Ngày đơn: ${date(order.order_date || order.created_at)} · Giữ để đối soát từ: ${date(entry.kept_at)}`, card);
    element('p', order.customer_id ? `Mã khách: ${order.customer_id}` : 'Đơn chưa liên kết hồ sơ khách hàng.', card);
    const reasons = element('ul', undefined, card);
    reasons.className = 'retention-review-reasons';
    for (const reason of entry.reasons || []) element('li', reason, reasons);
    if (order.notes) element('p', `Ghi chú: ${order.notes}`, card);
    const wrapper = element('div', undefined, card); wrapper.className = 'table-container';
    const table = element('table', undefined, wrapper); table.className = 'table';
    const head = element('tr', undefined, element('thead', undefined, table));
    for (const label of ['Sản phẩm', 'Đơn vị', 'Số lượng', 'Đã trả', 'Đơn giá', 'Thành tiền']) element('th', label, head);
    const body = element('tbody', undefined, table);
    for (const item of items) {
      const row = element('tr', undefined, body);
      for (const value of [item.product_name_snapshot || item.product_name || item.product_id || '', item.unit_snapshot || '',
        number(item.quantity), number(item.returned_quantity), number(item.final_unit_price ?? item.unit_price), number(item.line_total)]) element('td', value, row);
    }
  }
}
async function load() {
  if (!allowed()) return;
  const currentScope = `${getRetentionSessionScope()}|${state.retentionEpoch}`;
  const currentRequest = ++request;
  const current = () => allowed() && currentRequest === request && currentScope === `${getRetentionSessionScope()}|${state.retentionEpoch}`;
  busy = true; controls(); el('status').textContent = 'Đang tải chứng từ giữ để đối soát…';
  try {
    const result = await dbRetentionReviewOrders(offset);
    if (!current()) return;
    total = Number(result.total) || 0; loaded = true; showRows(result.rows || []);
    el('status').textContent = total ? `Đang xem ${offset + 1}–${Math.min(offset + 25, total)} / ${total} chứng từ giữ lại.` : 'Chưa có chứng từ được giữ riêng để đối soát.';
  } catch (error) {
    if (current()) { loaded = true; el('list').replaceChildren(); el('status').textContent = error.message || 'Chưa tải được danh sách đối soát.'; }
  } finally { if (current()) { busy = false; controls(); } }
}
export function renderRetentionReview() {
  const section = el('section'); if (!section) return;
  section.hidden = !allowed();
  if (!allowed()) { ++request; scope = ''; loaded = false; busy = false; el('list').replaceChildren(); return; }
  if (!setup) {
    setup = true;
    el('prev').addEventListener('click', () => { offset = Math.max(0, offset - 25); load(); });
    el('next').addEventListener('click', () => { if (offset + 25 < total) { offset += 25; load(); } });
    el('refresh').addEventListener('click', () => { offset = 0; loaded = false; load(); });
  }
  const nextScope = `${getRetentionSessionScope()}|${state.retentionEpoch}`;
  if (scope !== nextScope) { scope = nextScope; offset = 0; loaded = false; busy = false; ++request; el('list').replaceChildren(); }
  if (!loaded && !busy) load();
}
