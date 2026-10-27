import { state } from '../state.js';
import { dbDealerSupportProducts, dbSetDealerSupportProducts, dbDealerSupportHistory, getRetentionSessionScope } from '../services/supabase.js?v=20261027-retention-staged-v1';

const el = id => document.getElementById(`dealer-support-${id}`);
const admin = () => state.currentUser?.role === 'admin';
const number = value => Number(value || 0).toLocaleString('vi-VN', { maximumFractionDigits: 4 });
let configScope = ''; let configLoaded = false; let configBusy = false; let configOffset = 0;
let configRows = []; let configTotal = 0; let configSearch = ''; let setup = false;
const changes = new Map();
let historyCustomer = ''; let historyOffset = 0; let historyRequest = 0;
function textCell(row, value) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); return cell; }
function configurationControls() {
  if (!el('save')) return;
  for (const id of ['save', 'search', 'find']) el(id).disabled = configBusy;
  el('prev').disabled = configBusy || configOffset === 0;
  el('next').disabled = configBusy || configOffset + 25 >= configTotal;
  el('products').querySelectorAll('input').forEach(input => { input.disabled = configBusy; });
}
async function loadConfiguration() {
  if (!admin() || configBusy) return;
  const scope = getRetentionSessionScope(); const user = state.currentUser;
  configBusy = true; configurationControls(); el('config-status').textContent = 'Đang tải danh sách sản phẩm…';
  try {
    const result = await dbDealerSupportProducts(configSearch, configOffset);
    if (!admin() || user !== state.currentUser || scope !== getRetentionSessionScope()) return;
    configRows = result.rows || []; configTotal = result.total; configLoaded = true;
    el('products').replaceChildren();
    for (const product of configRows) {
      if (!result.selection_confirmed && product.suggested && !changes.has(product.id)) changes.set(product.id, true);
      const row = document.createElement('tr'); const check = document.createElement('input'); check.type = 'checkbox';
      check.checked = changes.has(product.id) ? changes.get(product.id) : product.selected;
      check.setAttribute('aria-label', `Giữ lịch sử ${product.code} — ${product.brand} — ${product.company_name}`);
      check.onchange = () => changes.set(product.id, check.checked);
      const cell = document.createElement('td'); cell.append(check); row.append(cell);
      textCell(row, product.code); textCell(row, product.name); textCell(row, product.brand); textCell(row, product.company_name);
      el('products').append(row);
    }
    el('config-status').textContent = `${result.selected_count} SKU đã lưu. ${result.selection_confirmed ? 'Danh sách đã được xác nhận.' : 'Đã đánh dấu gợi ý quạt màu/ấm chén; kiểm tra rồi bấm lưu để xác nhận trước lần dọn đầu.'} Đang xem ${configTotal ? configOffset + 1 : 0}–${Math.min(configOffset + 25, configTotal)} / ${configTotal}.`;
  } catch (error) { if (scope === getRetentionSessionScope() && user === state.currentUser) el('config-status').textContent = error.message || 'Chưa tải được danh sách.'; }
  finally {
    configBusy = false; configurationControls();
    if (admin() && (scope !== getRetentionSessionScope() || user !== state.currentUser)) renderDealerSupportSettings();
  }
}
export function renderDealerSupportSettings() {
  const section = el('settings'); if (!section) return;
  section.hidden = !admin();
  const scope = getRetentionSessionScope();
  if (scope !== configScope || !admin()) {
    configScope = scope; configLoaded = false; configOffset = 0; configSearch = ''; changes.clear();
    el('products').replaceChildren(); el('search').value = ''; el('config-status').textContent = '';
  }
  if (admin() && !configLoaded) void loadConfiguration();
}
export function setupDealerSupport() {
  if (setup || !el('save')) return; setup = true;
  el('find').onclick = () => { if (configBusy) return; configSearch = el('search').value.trim(); configOffset = 0; void loadConfiguration(); };
  el('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); el('find').click(); } });
  el('prev').onclick = () => { configOffset = Math.max(0, configOffset - 25); void loadConfiguration(); };
  el('next').onclick = () => { configOffset += 25; void loadConfiguration(); };
  el('save').onclick = async () => {
    if (!admin() || configBusy) return;
    const scope = getRetentionSessionScope(); const user = state.currentUser;
    configBusy = true; configurationControls();
    try {
      const result = await dbSetDealerSupportProducts([...changes].map(([id, selected]) => ({ id, selected })));
      if (!admin() || scope !== getRetentionSessionScope() || user !== state.currentUser) return;
      changes.clear(); el('config-status').textContent = `Đã lưu ${result.selected_count} SKU. Lịch sử đã lưu trước đây vẫn được giữ khi bỏ chọn SKU.`;
      configLoaded = false;
    } catch (error) { if (scope === getRetentionSessionScope() && user === state.currentUser) el('config-status').textContent = error.message || 'Chưa xác nhận được kết quả lưu. Có thể bấm lưu lại cùng lựa chọn.'; }
    finally { configBusy = false; configurationControls(); }
    if (!configLoaded && admin() && scope === getRetentionSessionScope()) void loadConfiguration();
  };
}

export async function renderDealerSupportHistory(customerId, offset = 0) {
  if (!el('history-body')) return;
  historyCustomer = customerId; historyOffset = offset;
  const request = ++historyRequest; const scope = getRetentionSessionScope();
  const user = state.currentUser; const role = user?.role; const epoch = state.retentionEpoch;
  const current = () => request === historyRequest && user === state.currentUser && role === state.currentUser?.role
    && scope === getRetentionSessionScope() && epoch === state.retentionEpoch
    && document.getElementById('customer-detail-modal')?.dataset.customerId === customerId;
  el('history-body').replaceChildren(); el('summary').replaceChildren();
  el('history-status').textContent = 'Đang tải lịch sử hàng cấp…';
  el('history-prev').disabled = true; el('history-next').disabled = true;
  el('history-prev').onclick = () => void renderDealerSupportHistory(historyCustomer, Math.max(0, historyOffset - 25));
  el('history-next').onclick = () => void renderDealerSupportHistory(historyCustomer, historyOffset + 25);
  try {
    const result = await dbDealerSupportHistory(customerId, offset);
    if (!current()) return;
    for (const item of result.rows || []) {
      const row = document.createElement('tr');
      textCell(row, new Date(item.business_date).toLocaleDateString('vi-VN', { timeZone: 'Asia/Bangkok' }));
      textCell(row, `${item.product_code} — ${item.product_name}`);
      textCell(row, `${item.brand_name} / ${item.company_name}`);
      textCell(row, `${number(item.quantity)} ${item.unit_name}`); textCell(row, number(item.returned_quantity));
      textCell(row, item.order_cancelled ? 'Đã hủy' : Number(item.returned_quantity) >= Number(item.quantity) ? 'Đã trả hết'
        : Number(item.returned_quantity) > 0 ? 'Đã trả một phần' : 'Đã ghi nhận');
      el('history-body').append(row);
    }
    for (const item of result.summary || []) {
      const line = document.createElement('li');
      line.textContent = `${item.product_code} · ${item.brand_name} · ${item.company_name}: ghi nhận ${number(item.issued)}, đã trả ${number(item.returned)}, sau trả/hủy ${number(item.remaining)} ${item.unit_name}.`;
      el('summary').append(line);
    }
    el('history-status').textContent = result.total ? `Dòng ${offset + 1}–${Math.min(offset + 25, result.total)} / ${result.total}.`
      : result.selection_confirmed ? 'Chưa có hàng thuộc danh mục theo dõi của khách này.' : 'Admin chưa xác nhận danh sách SKU cần giữ lịch sử.';
    el('history-prev').disabled = offset === 0; el('history-next').disabled = offset + 25 >= result.total;
  } catch (error) { if (current()) el('history-status').textContent = error.message || 'Chưa tải được lịch sử hàng cấp.'; }
}
