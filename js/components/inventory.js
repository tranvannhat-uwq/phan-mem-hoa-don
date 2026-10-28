import { state } from '../state.js';
import { safeCreateIcons, showToast, formatDateTime } from '../utils.js';
import { inventoryGateway } from '../services/inventory.js?v=20261028-inventory-product-sync-v1';
import { estimateInventoryUsage, validateInventoryDocument, INVENTORY_CACHE_MS, INVENTORY_PAGE_SIZE, INVENTORY_STOCK_PAGE_SIZE } from '../domain/inventory.js?v=20261028-inventory-product-sync-v1';
import { openBomPanel, resetBomPanel } from './bom.js?v=20261028-inventory-product-sync-v1';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const quantity = value => Number(value || 0).toLocaleString('vi-VN', { maximumFractionDigits: 4 });
const kinds = { receipt: 'Nhập kho', issue: 'Xuất kho', count: 'Kiểm kê', sale: 'Đơn bán / hoàn / hủy', production: 'Sản xuất BOM' };
let actorScope = '';
let filters = { mode: 'stock', query: '', lowOnly: false };
let cursors = [null];
let page = 0;
let loaded = null;
let loadedAt = 0;
let loading = false;
let errorText = '';
let requestGeneration = 0;
let draft = null;
let attemptedRequest = null;
let saving = false;
let switchingSync = false;

function sessionScope() {
  return state.currentUser ? `${state.currentUser.authUserId || state.currentUser.id}:${state.currentUser.role}` : '';
}
export function resetInventoryPanel() {
  actorScope = ''; filters = { mode: 'stock', query: '', lowOnly: false }; cursors = [null]; page = 0;
  loaded = null; loadedAt = 0; loading = false; errorText = ''; draft = null; attemptedRequest = null; saving = false; switchingSync = false;
  requestGeneration++; inventoryGateway.clear();
  resetBomPanel();
  document.getElementById('inventory-document-host')?.remove();
  const panel = document.getElementById('inventory-panel');
  if (panel) { panel.removeEventListener('click', onClick); panel.replaceChildren(); delete panel.dataset.inventoryReady; }
}
function ensureSession() {
  const next = sessionScope();
  if (actorScope !== next) { resetInventoryPanel(); actorScope = next; }
  return ['admin', 'accounting'].includes(state.currentUser?.role);
}

export function renderInventoryPanel() {
  const panel = document.getElementById('inventory-panel');
  if (!panel?.classList.contains('active') || !ensureSession()) return;
  if (!panel.dataset.inventoryReady) {
    panel.dataset.inventoryReady = 'true';
    panel.innerHTML = `
      <div class="inventory-header"><div class="inventory-heading-group"><div class="inventory-context"><i data-lucide="warehouse" aria-hidden="true"></i><span>Kho chính</span><span class="inventory-context-divider">·</span><span>Theo dõi theo SKU</span></div><p>Quản lý nhập, xuất, kiểm kê và định mức sản phẩm.</p></div>
        <div class="inventory-actions"><button class="btn btn-secondary" data-inventory-action="bom"><i data-lucide="boxes"></i> BOM & sản xuất</button><button class="btn btn-primary" data-inventory-action="receipt"><i data-lucide="package-plus"></i> Nhập kho</button><button class="btn btn-secondary" data-inventory-action="issue"><i data-lucide="package-minus"></i> Xuất kho</button></div></div>
      <div id="inventory-stock-view">
      <section id="inventory-status" class="inventory-status" aria-label="Trạng thái kho">
        <div class="inventory-status-summary"><span class="inventory-status-indicator" aria-hidden="true"></span><div class="inventory-status-copy"><strong id="inventory-status-title" role="status" aria-live="polite"></strong><small id="inventory-status-detail"></small></div></div>
        <div id="inventory-status-metrics" class="inventory-status-metrics">
          <div class="inventory-status-metric"><span>Database</span><strong id="inventory-database-size">—</strong></div>
          <div class="inventory-status-metric"><span>Dữ liệu kho</span><strong id="inventory-module-size">—</strong></div>
          <div class="inventory-status-metric inventory-budget-metric"><div><span>Ngân sách đọc kho</span><strong id="inventory-budget-label">—</strong></div><div class="inventory-budget-track" aria-hidden="true"><span id="inventory-budget-bar"></span></div><small id="inventory-budget-cycle"></small></div>
        </div>
      </section>
      <div id="inventory-sync-control" class="inventory-activation inventory-sync-control" hidden>
        <div class="inventory-header"><div><strong>Đồng bộ kho theo đơn hàng</strong><p id="inventory-sync-description"></p></div>
          <button type="button" class="btn btn-primary" data-inventory-action="toggle-sync" role="switch" aria-checked="false">Bật đồng bộ kho</button></div>
        <label id="inventory-opening-control"><input type="checkbox" id="inventory-opening-ack"> Tôi đã đối chiếu tồn đầu kỳ và các đơn đang xử lý.</label>
      </div>
      <div class="inventory-toolbar">
        <div class="inventory-toolbar-top"><div class="inventory-view-switch" role="group" aria-label="Nội dung kho"><button type="button" class="inventory-view-tab active" aria-pressed="true" data-inventory-view="stock"><i data-lucide="boxes"></i> Tồn kho</button><button type="button" class="inventory-view-tab" aria-pressed="false" data-inventory-view="movements"><i data-lucide="list-clock"></i> Lịch sử nhập / xuất</button></div>
          <button class="btn btn-secondary inventory-refresh" type="button" data-inventory-action="refresh"><i data-lucide="refresh-cw"></i> Tải lại</button></div>
        <div class="inventory-filter-row">
          <form id="inventory-search-form" class="inventory-search"><label class="sr-only" for="inventory-search-input">Tìm mã SKU, tên hoặc hãng</label><div class="inventory-search-field"><i data-lucide="search" aria-hidden="true"></i><input id="inventory-search-input" name="query" class="form-control" maxlength="80" placeholder="Tìm mã SKU, tên, hãng…" autocomplete="off"></div><button class="btn btn-primary"><i data-lucide="search"></i><span>Tìm kiếm</span></button></form>
          <label id="inventory-low-control" class="inventory-low-filter"><input type="checkbox" id="inventory-low-only"><span><strong>Dưới mức tối thiểu</strong><small>Chỉ hiện SKU cần bổ sung</small></span></label>
          <div id="inventory-date-controls" class="inventory-date-controls" hidden><label>Từ ngày<input class="form-control" type="date" id="inventory-start"></label><label>Đến ngày<input class="form-control" type="date" id="inventory-end"></label><button class="btn btn-secondary" data-inventory-action="dates">Áp dụng</button></div>
        </div>
      </div>
      <div id="inventory-error" class="inventory-error" role="alert" hidden></div>
      <div class="table-responsive inventory-table-wrap"><table class="table inventory-table" aria-label="Danh sách kho"><thead id="inventory-head"></thead><tbody id="inventory-body"></tbody></table></div>
      <div class="inventory-pagination"><span id="inventory-page-label"></span><div class="inventory-actions"><button class="btn btn-secondary" data-inventory-action="previous">Trang trước</button><button class="btn btn-secondary" data-inventory-action="next">Trang sau</button></div></div></div>`;
    panel.addEventListener('click', onClick);
    panel.querySelector('#inventory-search-form').addEventListener('submit', event => { event.preventDefault(); if (switchingSync) return; filters.query = new FormData(event.target).get('query').trim(); restart(); });
    panel.querySelector('#inventory-low-only').addEventListener('change', event => { if (switchingSync) return; filters.lowOnly = event.target.checked; restart(); });
  }
  draw();
  if ((!loaded || Date.now() - loadedAt >= INVENTORY_CACHE_MS) && !loading && !errorText) void load();
}

function draw() {
  const panel = document.getElementById('inventory-panel');
  if (!panel?.dataset.inventoryReady) return;
  const history = filters.mode === 'movements';
  panel.dataset.inventoryMode = filters.mode;
  panel.querySelector('#inventory-head').innerHTML = history
    ? '<tr><th>Thời gian</th><th>SKU / Sản phẩm</th><th>Nghiệp vụ</th><th>Thay đổi</th><th>Tồn sau</th><th>Tham chiếu / Ghi chú</th></tr>'
    : '<tr><th>SKU / Sản phẩm</th><th>Hãng</th><th>Đơn vị</th><th>Tồn hiện tại</th><th>Tối thiểu</th><th>Đồng bộ / Thao tác</th></tr>';
  panel.querySelector('#inventory-body').innerHTML = loading ? '<tr><td colspan="6" class="inventory-empty">Đang tải dữ liệu kho…</td></tr>' : !loaded?.rows.length
    ? '<tr><td colspan="6" class="inventory-empty">Chưa có dữ liệu trong phạm vi đang xem.</td></tr>'
    : loaded.rows.map(row => history
      ? `<tr><td data-label="Thời gian">${escape(formatDateTime(row.created_at))}</td><td data-label="SKU / Sản phẩm"><strong>${escape(row.sku)}</strong><small>${escape(row.name)}</small></td><td data-label="Nghiệp vụ">${escape(kinds[row.kind])}</td><td data-label="Thay đổi" class="${Number(row.delta) < 0 ? 'inventory-negative' : 'inventory-positive'}">${Number(row.delta) > 0 ? '+' : ''}${quantity(row.delta)}</td><td data-label="Tồn sau">${quantity(row.balance_after)}</td><td data-label="Tham chiếu / Ghi chú">${escape(row.order_id || row.document_id || '')}<small>${escape(row.note)}</small></td></tr>`
      : `<tr><td data-label="SKU / Sản phẩm"><strong>${escape(row.sku)}</strong><small>${escape(row.name)}${row.is_active ? '' : ' · Ngừng sử dụng'}</small></td><td data-label="Hãng">${escape(row.brand)}</td><td data-label="Đơn vị">${escape(row.unit)}</td><td data-label="Tồn hiện tại" class="${Number(row.quantity) <= Number(row.minimum_quantity) ? 'inventory-negative' : ''}"><strong>${quantity(row.quantity)}</strong></td><td data-label="Mức tối thiểu">${quantity(row.minimum_quantity)}</td><td data-label="Đồng bộ / Thao tác"><small class="${row.sync_active ? 'inventory-positive' : ''}">${row.sync_active ? (loaded.control.syncEnabled ? 'Đang đồng bộ' : 'Tạm dừng') : 'Chưa đồng bộ'}</small><button class="btn ${row.sync_active ? 'btn-secondary' : 'btn-primary'}" data-inventory-count="${escape(row.product_id)}">${row.sync_active ? 'Kiểm kê' : 'Kiểm kê & đồng bộ'}</button></td></tr>`).join('');
  panel.querySelector('#inventory-error').hidden = !errorText;
  panel.querySelector('#inventory-error').textContent = errorText;
  panel.querySelector('#inventory-low-control').hidden = history;
  panel.querySelector('#inventory-date-controls').hidden = !history;
  panel.querySelector('#inventory-page-label').textContent = `Trang ${page + 1} · tối đa ${history ? INVENTORY_PAGE_SIZE : INVENTORY_STOCK_PAGE_SIZE} dòng mỗi trang`;
  panel.querySelectorAll('[data-inventory-view]').forEach(button => {
    const active = button.dataset.inventoryView === filters.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  panel.querySelectorAll('.inventory-toolbar button, .inventory-toolbar input, [data-inventory-count], .inventory-header > .inventory-actions button').forEach(element => { element.disabled = switchingSync; });
  panel.querySelector('[data-inventory-action="previous"]').disabled = switchingSync || loading || page === 0;
  panel.querySelector('[data-inventory-action="next"]').disabled = switchingSync || loading || !loaded?.hasMore;
  const usage = loaded?.usage;
  const control = loaded?.control;
  const syncEnabled = control?.syncEnabled ?? Boolean(control?.activatedAt);
  const pendingOrders = Number(control?.pendingOrders || 0);
  const status = !control ? loading ? 'Đang cập nhật trạng thái kho' : 'Trạng thái kho chưa khả dụng'
    : !control.activatedAt ? 'Chưa bật đồng bộ'
      : syncEnabled ? 'Đồng bộ kho đang bật' : `Đang tạm dừng${pendingOrders ? ` · ${pendingOrders} đơn chờ` : ''}`;
  const detail = !control ? 'Thông tin đồng bộ sẽ xuất hiện sau khi tải xong dữ liệu.'
    : !control.activatedAt ? 'Đếm xong SKU nào, bấm Kiểm kê & đồng bộ ngay dòng đó. Các SKU chưa đếm chưa tự động trừ tồn.'
    : syncEnabled ? control.syncMode === 'selected' ? 'Chỉ SKU đã kiểm kê và bật đồng bộ mới tự động cập nhật theo đơn bán, hoàn và hủy.' : 'Tồn kho được cập nhật tự động theo đơn hàng, hoàn và hủy.'
      : pendingOrders ? 'Các đơn mới đang chờ xử lý đồng bộ.' : 'Đơn phát sinh được lưu vào hàng đợi để xử lý khi bật lại.';
  const statusCard = panel.querySelector('#inventory-status');
  statusCard.dataset.syncState = !control ? 'unknown' : !control.activatedAt ? 'setup' : syncEnabled ? 'enabled' : 'paused';
  statusCard.dataset.hasUsage = String(Boolean(usage));
  panel.querySelector('#inventory-status-title').textContent = status;
  panel.querySelector('#inventory-status-detail').textContent = control
    ? detail : `${detail} Dữ liệu chỉ được tải khi bạn mở trang kho hoặc thực hiện tìm kiếm.`;
  panel.querySelector('#inventory-status-metrics').hidden = !usage;
  if (usage) {
    const megabytes = bytes => `${(Number(bytes || 0) / 1e6).toFixed(1)} MB`;
    const used = Number(usage.budgetUsed || 0); const limit = Number(usage.budgetLimit || 0);
    const percent = limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0;
    panel.querySelector('#inventory-database-size').textContent = megabytes(usage.databaseBytes);
    panel.querySelector('#inventory-module-size').textContent = megabytes(usage.moduleBytes);
    panel.querySelector('#inventory-budget-label').textContent = `${megabytes(used)} / ${megabytes(limit)}`;
    panel.querySelector('#inventory-budget-bar').style.width = `${percent}%`;
    panel.querySelector('#inventory-budget-cycle').textContent = `Chu kỳ từ ${usage.cycleStart}`;
  }
  panel.querySelector('#inventory-sync-control').hidden = !control || (Boolean(control.activatedAt) && state.currentUser?.role !== 'admin');
  panel.querySelector('#inventory-opening-control').hidden = Boolean(control?.productSyncAvailable) || Boolean(control?.activatedAt);
  const toggle = panel.querySelector('[data-inventory-action="toggle-sync"]');
  toggle.setAttribute('aria-checked', String(syncEnabled));
  toggle.textContent = switchingSync ? 'Đang xử lý…' : syncEnabled ? 'Tắt đồng bộ kho'
    : pendingOrders ? `Bật và xử lý ${pendingOrders} đơn chờ` : 'Bật đồng bộ kho';
  toggle.className = `btn ${syncEnabled ? 'btn-secondary' : 'btn-primary'}`;
  toggle.disabled = loading || saving || Boolean(draft) || switchingSync || !control?.syncAvailable;
  toggle.hidden = Boolean(control?.productSyncAvailable) && !control?.activatedAt;
  panel.querySelector('#inventory-sync-description').textContent = !control?.syncAvailable
    ? 'Cần cập nhật Cloud phiên bản 0089 để sử dụng nút bật/tắt đồng bộ.'
    : !control.activatedAt ? 'Kiểm kê từng sản phẩm rồi lưu và bật đồng bộ ngay trong phiếu. Không cần chờ kiểm kê hết kho. Đơn cũ được giữ làm mốc, không trừ lại số hàng đã xuất.'
      : syncEnabled ? 'Đơn bán, sửa, hoàn và hủy đang tự động cập nhật tồn. Bạn có thể tạm dừng khi cần.'
        : pendingOrders ? `Khi bật lại, mỗi lượt xử lý tối đa 50 đơn chờ. Chỉ bật tự động sau khi xử lý hết. Không xuất tay để bù các đơn này; xử lý hàng đợi trước khi kiểm kê.`
          : 'Đang tạm dừng cập nhật tồn từ đơn hàng. Đơn phát sinh sẽ vào hàng đợi và được xử lý khi bật lại.';
  safeCreateIcons();
}

async function load(force = false) {
  if (!ensureSession() || loading) return;
  const generation = ++requestGeneration; const actor = sessionScope();
  loading = true; errorText = ''; draw();
  try {
    const limit = filters.mode === 'stock' ? INVENTORY_STOCK_PAGE_SIZE : INVENTORY_PAGE_SIZE;
    const data = await inventoryGateway.read({ ...filters, cursor: cursors[page], limit }, { force });
    if (generation === requestGeneration && actor === sessionScope()) { loaded = data; loadedAt = Date.now(); }
  } catch (error) { if (generation === requestGeneration && actor === sessionScope()) errorText = error.message; }
  finally { if (generation === requestGeneration && actor === sessionScope()) { loading = false; draw(); } }
}
function restart() { requestGeneration++; loading = false; page = 0; cursors = [null]; loaded = null; void load(); }

function onClick(event) {
  const panel = document.getElementById('inventory-panel');
  const button = event.target.closest('button');
  if (!button || button.disabled || switchingSync || !ensureSession()) return;
  if (button.dataset.inventoryView) {
    filters.mode = button.dataset.inventoryView;
    if (filters.mode === 'movements') {
      const end = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const start = new Date(`${end}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 6);
      filters.start = start.toISOString().slice(0, 10); filters.end = end;
      panel.querySelector('#inventory-start').value = filters.start; panel.querySelector('#inventory-end').value = end;
    }
    restart(); return;
  }
  if (button.dataset.inventoryCount) {
    const row = loaded?.rows.find(item => item.product_id === button.dataset.inventoryCount);
    if (row) openDocument('count', row); return;
  }
  const action = button.dataset.inventoryAction;
  if (action === 'bom') { openBomPanel(); return; }
  if (['receipt', 'issue'].includes(action)) { openDocument(action); return; }
  if (action === 'refresh') { if (!loading) { loaded = null; void load(true); } }
  if (action === 'previous') { page--; loaded = null; void load(); }
  if (action === 'next' && loaded?.hasMore) { cursors[++page] = loaded.nextCursor; loaded = null; void load(); }
  if (action === 'dates') {
    const start = panel.querySelector('#inventory-start').value; const end = panel.querySelector('#inventory-end').value;
    const span = (Date.parse(end) - Date.parse(start)) / 86400000;
    if (!Number.isFinite(span) || span < 0 || span > 30) { showToast('Chọn khoảng ngày hợp lệ, tối đa 31 ngày.', 'warning'); return; }
    filters.start = start; filters.end = end; restart();
  }
  if (action === 'toggle-sync') void toggleSync();
}

function availableProducts() { return state.products.filter(product => product.isActive !== false && product.isLegacy !== true && (product.packagingName || product.packageType)); }
function closeDocument() {
  document.getElementById('inventory-document-host')?.remove();
  draft = null;
  draw();
}
function openDocument(kind, row = null) {
  if (saving || draft) return;
  draft = { requestKey: crypto.randomUUID(), kind, row }; attemptedRequest = null;
  // The panel's entrance animation creates a containing block for fixed children.
  // Keep the dialog at the document root so it stays in the visible viewport.
  const host = document.createElement('div');
  host.id = 'inventory-document-host';
  document.body.append(host);
  const products = availableProducts();
  host.innerHTML = `<div class="modal-overlay active"><div class="modal-content inventory-document" role="dialog" aria-modal="true" aria-label="${kinds[kind]}"><div class="modal-header"><h3>${kinds[kind]}</h3><button type="button" class="modal-close" aria-label="Đóng phiếu kho">&times;</button></div>
    <form id="inventory-document-form"><div class="modal-body"><p>${kind === 'count' ? 'Mở phiếu trước khi bắt đầu đếm SKU này. Nếu có biến động trong lúc đếm, hệ thống sẽ yêu cầu kiểm tra lại riêng SKU này trước khi lưu.' : 'Phiếu kho ghi số lượng hàng. Các khoản thanh toán được ghi riêng tại Phiếu mua hàng hoặc Sổ quỹ.'}</p>
    ${kind === 'count' ? `<strong>${escape(row.sku)} · ${escape(row.name)}</strong><p id="inventory-count-baseline" role="status">Đang lấy mốc kiểm kê…</p><p id="inventory-product-sync-note"></p><label>Tồn thực tế<input class="form-control" name="countQuantity" type="number" min="0" max="100000000" step="0.0001" value="${Number(row.quantity)}" required></label><label>Mức tồn tối thiểu<input class="form-control" name="minimumQuantity" type="number" min="0" max="100000000" step="0.0001" value="${Number(row.minimum_quantity)}" required></label>`
      : `<div id="inventory-document-lines"></div><button type="button" class="btn btn-secondary" id="inventory-add-line">Thêm SKU</button><datalist id="inventory-product-options">${products.map(product => `<option value="${escape(product.code)} · ${escape(product.brand)}" label="${escape(product.name)}"></option>`).join('')}</datalist>`}
    <label>Ghi chú<textarea class="form-control" name="note" maxlength="240" rows="2" placeholder="Lý do nhập, xuất hoặc kiểm kê"></textarea></label><p id="inventory-document-error" class="inventory-error" role="alert" hidden></p></div>
    <div class="modal-footer"><button type="submit" class="btn btn-primary" id="inventory-save-document">Lưu phiếu</button></div></form></div></div>`;
  const close = () => { if (!saving) closeDocument(); };
  host.querySelector('.modal-close').addEventListener('click', close);
  host.querySelector('.modal-overlay').addEventListener('click', event => { if (event.target === event.currentTarget) close(); });
  host.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  host.querySelector('#inventory-document-form').addEventListener('submit', saveDocument);
  const add = host.querySelector('#inventory-add-line');
  if (add) { add.addEventListener('click', addLine); addLine(); }
  if (kind === 'count') void prepareCount(draft, host);
  draw();
  host.querySelector(kind === 'count' ? '[name="countQuantity"]' : '[data-inventory-product]')?.focus();
}
async function prepareCount(currentDraft, host) {
  const actor = sessionScope(); const button = host.querySelector('#inventory-save-document');
  button.disabled = true;
  host.querySelector('[name="countQuantity"]').disabled = true;
  try {
    const context = await inventoryGateway.countContext(currentDraft.row.product_id);
    if (draft !== currentDraft || actor !== sessionScope()) return;
    currentDraft.context = context;
    currentDraft.row = { ...currentDraft.row, quantity: context.quantity, minimum_quantity: context.minimumQuantity };
    host.querySelector('#inventory-count-baseline').textContent = 'Tồn hệ thống tại lúc bắt đầu: ' + quantity(context.quantity);
    host.querySelector('[name="countQuantity"]').value = '';
    host.querySelector('[name="countQuantity"]').disabled = false;
    host.querySelector('[name="minimumQuantity"]').value = context.minimumQuantity;
    host.querySelector('#inventory-product-sync-note').textContent = context.syncActive
      ? 'SKU này đã được bật đồng bộ. Lưu để điều chỉnh theo số đếm mới.'
      : 'Lưu phiếu sẽ bật đồng bộ riêng SKU này ngay. Các SKU khác giữ nguyên.';
    button.textContent = context.syncActive ? 'Lưu kiểm kê' : 'Lưu & bật đồng bộ SKU';
    button.disabled = false;
    host.querySelector('[name="countQuantity"]').focus();
  } catch (error) {
    if (draft !== currentDraft || actor !== sessionScope()) return;
    const box = host.querySelector('#inventory-document-error'); box.textContent = error.message; box.hidden = false;
  }
}
function addLine() {
  const lines = document.getElementById('inventory-document-lines');
  if (!lines || lines.children.length >= 50) return;
  const line = document.createElement('div'); line.className = 'inventory-document-line';
  line.innerHTML = '<input class="form-control" list="inventory-product-options" data-inventory-product placeholder="Mã SKU · Hãng" aria-label="SKU" required><input class="form-control" data-inventory-quantity type="number" min="0.0001" max="100000000" step="0.0001" placeholder="Số lượng" aria-label="Số lượng" required><button type="button" class="btn btn-secondary" aria-label="Bỏ dòng">×</button>';
  line.querySelector('button').addEventListener('click', () => { if (lines.children.length > 1 && !saving) line.remove(); });
  lines.appendChild(line);
}
async function saveDocument(event) {
  event.preventDefault(); if (saving || !draft || !ensureSession()) return;
  const form = event.currentTarget; const actor = sessionScope();
  const errorBox = form.querySelector('#inventory-document-error'); errorBox.hidden = true;
  try {
    const data = new FormData(form);
    const products = availableProducts();
    const items = draft.kind === 'count'
      ? [{ productId: draft.row.product_id, quantity: Number(data.get('countQuantity')), expectedQuantity: Number(draft.row.quantity), minimumQuantity: Number(data.get('minimumQuantity')) }]
      : [...form.querySelectorAll('.inventory-document-line')].map(line => {
        const code = line.querySelector('[data-inventory-product]').value;
        const product = products.find(item => `${item.code} · ${item.brand}` === code);
        if (!product) throw new Error('Chọn SKU hợp lệ từ danh mục.');
        return { productId: product.id, quantity: Number(line.querySelector('[data-inventory-quantity]').value) };
      });
    if (draft.kind === 'count' && !draft.context) throw new Error('Chờ tải mốc kiểm kê trước khi lưu.');
    const input = { requestKey: draft.requestKey, kind: draft.kind, note: String(data.get('note') || '').trim(), items };
    if (draft.kind === 'count') Object.assign(input, { countToken: draft.context.token, activateProduct: true });
    validateInventoryDocument(input);
    // An uncertain response must retry the same payload/key. A changed form
    // cannot accidentally create a second voucher after a network timeout.
    if (attemptedRequest && attemptedRequest !== JSON.stringify(input)) throw new Error('Phiếu đã được gửi. Giữ nguyên nội dung để thử lại; kiểm tra lịch sử trước khi tạo phiếu khác.');
    attemptedRequest = JSON.stringify(input);
    saving = true; form.querySelector('#inventory-save-document').disabled = true;
    if (draft.kind === 'count') await inventoryGateway.countProduct(input);
    else await inventoryGateway.post(input);
    if (actor !== sessionScope()) return;
    closeDocument();
    showToast(input.kind === 'count' ? 'Đã lưu kiểm kê và đồng bộ SKU.' : 'Đã ghi nhận phiếu kho.'); loaded = null; await load(true);
  } catch (error) {
    if (actor === sessionScope()) {
      if (error.definitive) attemptedRequest = null;
      errorBox.textContent = error.message; errorBox.hidden = false;
    }
  } finally {
    if (actor === sessionScope()) { saving = false; const button = form.querySelector('#inventory-save-document'); if (button) button.disabled = false; draw(); }
  }
}
async function toggleSync() {
  if (loading || saving || draft || switchingSync || !loaded?.control?.syncAvailable || state.currentUser?.role !== 'admin') return;
  const control = loaded.control;
  const enabled = !control.syncEnabled;
  const acknowledgeOpening = document.getElementById('inventory-opening-ack').checked;
  if (enabled && !control.activatedAt && !acknowledgeOpening) { showToast('Cần xác nhận đã đối chiếu tồn đầu kỳ.', 'warning'); return; }
  switchingSync = true; draw();
  const actor = sessionScope();
  try {
    const result = await inventoryGateway.setSync(enabled, { acknowledgeOpening });
    if (actor !== sessionScope()) return;
    loaded.control = { ...loaded.control, activatedAt: result.activatedAt, syncEnabled: result.enabled,
      pendingOrders: result.pendingOrders, syncUpdatedAt: result.updatedAt };
    showToast(result.enabled ? 'Đã bật đồng bộ kho.' : enabled
      ? `Đã xử lý ${result.processed} đơn. Còn ${result.pendingOrders} đơn chờ; bấm tiếp để hoàn tất.`
      : 'Đã tắt đồng bộ kho. Đơn mới sẽ được lưu vào hàng đợi.');
    await load(true);
  }
  catch (error) { if (actor === sessionScope()) showToast(escape(error.message), 'danger'); }
  finally { if (actor === sessionScope()) { switchingSync = false; draw(); } }
}

// Exposed for the local capacity report without loading any cloud history.
export const inventoryCapacityEstimate = estimateInventoryUsage();
