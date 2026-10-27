import { state } from '../state.js';
import { formatCurrency, formatDateTime, safeCreateIcons, showToast } from '../utils.js';
import {
  dbCancelPurchase,
  dbCancelSupplierPayment,
  dbCreatePurchase,
  dbRecordSupplierPayment
} from '../services/supabase.js?v=20261027-retention-safe-delete-v1';
import { bomGateway } from '../services/bom.js?v=20261027-retention-safe-delete-v1';

let pendingPurchaseKey = '';
let purchaseItemRowSequence = 0;
const pendingSupplierPaymentKeys = new Map();

function financeRole() {
  return state.currentUser?.role === 'admin' || state.currentUser?.role === 'accounting';
}

function newKey(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${value}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function purchaseTotal(purchase) {
  return Number(purchase.totalAmount ?? purchase.totalPayable ?? 0);
}

function purchaseDate(purchase) {
  const value = purchase.purchaseDate || purchase.date;
  return value ? formatDateTime(value) : '-';
}

function statusLabel(status) {
  if (status === 'cancelled') return 'Đã hủy';
  if (status === 'draft') return 'Phiếu tạm';
  return 'Hoàn thành';
}

function itemRow(item = {}) {
  const manual = item.mode === 'manual';
  const resultsId = `purchase-material-results-${++purchaseItemRowSequence}`;
  return `
    <tr class="purchase-entry-item-row" data-mode="${manual ? 'manual' : 'material'}" data-catalog-id="${escapeHtml(item.catalogId || '')}">
      <td><input type="text" class="purchase-entry-code" value="${escapeHtml(item.code || '')}" required placeholder="Mã hàng" ${manual ? '' : 'readonly'}></td>
      <td>
        <div class="purchase-entry-material-picker">
          <input type="${manual ? 'text' : 'search'}" class="purchase-entry-name ${manual ? '' : 'purchase-entry-material-search'}" value="${escapeHtml(item.name || '')}" required placeholder="${manual ? 'Tên hàng hóa/dịch vụ' : 'Tìm mã hoặc tên vật tư...'}" autocomplete="off" ${manual ? '' : `role="combobox" aria-autocomplete="list" aria-controls="${resultsId}" aria-expanded="false"`}>
          <div class="purchase-entry-material-results" id="${resultsId}" role="listbox" aria-label="Kết quả vật tư" hidden></div>
        </div>
        <div class="purchase-entry-item-source"><span>${manual ? 'Nhập tay' : 'Từ danh mục'}</span><button type="button" class="purchase-entry-switch-source">${manual ? 'Chọn danh mục' : 'Nhập tay'}</button></div>
      </td>
      <td><input type="text" class="purchase-entry-unit" value="${escapeHtml(item.unit || '')}" placeholder="ĐVT" ${manual ? '' : 'readonly'}></td>
      <td><input type="number" class="purchase-entry-qty" min="0.0001" step="any" value="${item.quantity || 1}" required></td>
      <td><input type="number" class="purchase-entry-price" min="0" step="1" value="${item.unitPrice || 0}" required></td>
      <td class="purchase-entry-line-total" style="text-align:right">0 ₫</td>
      <td><button type="button" class="purchase-entry-remove-row" title="Xóa dòng">×</button></td>
    </tr>`;
}

function purchaseModal() {
  return `
    <div class="modal-overlay purchase-entry-overlay" id="purchase-entry-modal">
      <div class="modal-content purchase-entry-modal-content" role="dialog" aria-modal="true" aria-labelledby="purchase-entry-title">
        <div class="modal-header purchase-entry-header">
          <div class="purchase-entry-title-group">
            <span class="purchase-entry-title-icon"><i data-lucide="file-plus-2"></i></span>
            <div><h3 class="modal-title" id="purchase-entry-title">Tạo phiếu mua hàng</h3><p>Nhập thông tin nhà cung cấp và hàng hóa cần ghi nhận.</p></div>
          </div>
          <button type="button" class="modal-close" id="btn-close-purchase-entry" aria-label="Đóng"><i data-lucide="x"></i></button>
        </div>
        <form id="purchase-entry-form">
          <div class="modal-body purchase-entry-modal-body">
            <section class="purchase-entry-card purchase-entry-info-card">
              <div class="purchase-entry-section-heading">
                <span class="purchase-entry-step">01</span>
                <div><h4>Thông tin phiếu</h4><p>Nhà cung cấp, hóa đơn và thanh toán</p></div>
              </div>
              <div class="purchase-entry-info-grid">
                <div class="form-group">
                  <label class="form-label" for="purchase-supplier-search">Nhà cung cấp <span>*</span></label>
                  <div class="purchase-supplier-combobox">
                    <input class="form-control purchase-entry-supplier-search" id="purchase-supplier-search" type="search" placeholder="Tìm tên hoặc mã nhà cung cấp..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="purchase-supplier-results" aria-expanded="false" required>
                    <input type="hidden" id="purchase-supplier-select" name="supplierId">
                    <div class="purchase-supplier-results" id="purchase-supplier-results" role="listbox" aria-label="Kết quả nhà cung cấp" hidden></div>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label" for="purchase-invoice-number">Số hóa đơn đầu vào</label>
                  <input class="form-control" id="purchase-invoice-number" maxlength="100" placeholder="Nhập số hóa đơn nếu có">
                </div>
                <div class="form-group">
                  <label class="form-label" for="purchase-date-input">Ngày mua <span>*</span></label>
                  <input type="datetime-local" class="form-control" id="purchase-date-input" required>
                </div>
                <div class="purchase-entry-payment-fields">
                  <div class="form-group">
                    <label class="form-label" for="purchase-paid-input">Thanh toán ngay</label>
                    <input type="number" class="form-control" id="purchase-paid-input" min="0" step="1" value="0" placeholder="0">
                  </div>
                  <div class="form-group">
                    <label class="form-label" for="purchase-payment-method">Phương thức chi</label>
                    <select class="form-control" id="purchase-payment-method">
                      <option value="cash">Tiền mặt</option><option value="bank">Ngân hàng</option><option value="wallet">Ví điện tử</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>
            <section class="purchase-entry-card purchase-entry-items-card">
              <div class="purchase-entry-section-heading purchase-entry-items-heading">
                <span class="purchase-entry-step">02</span>
                <div><h4>Hàng hóa / dịch vụ</h4><p>Chọn mã vỏ từ Danh sách sản phẩm, vật tư hoặc nhập tay, rồi điền số lượng và đơn giá.</p></div>
                <div class="purchase-entry-item-actions">
                  <button type="button" class="btn btn-secondary purchase-entry-add-row" id="btn-add-purchase-item-row"><i data-lucide="plus"></i><span>Thêm dòng</span></button>
                </div>
              </div>
              <div class="purchase-entry-items-wrap">
                <table class="purchase-entry-items-table">
                  <thead><tr><th>Mã hàng</th><th>Tên hàng / dịch vụ</th><th>ĐVT</th><th>Số lượng</th><th>Đơn giá</th><th>Thành tiền</th><th></th></tr></thead>
                  <tbody id="purchase-entry-items-body">${itemRow()}</tbody>
                </table>
              </div>
              <div class="purchase-entry-tax-settings">
                <span>Đơn giá chưa gồm VAT. Thuế tính trên tổng tiền hàng.</span>
                <label for="purchase-vat-rate">VAT (%)</label>
                <input type="number" class="form-control" id="purchase-vat-rate" min="0" max="100" step="0.01" value="0" required inputmode="decimal">
              </div>
              <div class="purchase-entry-summary">
                <div class="purchase-entry-summary-card"><span>Tiền hàng</span><strong id="purchase-entry-subtotal">0 ₫</strong></div>
                <div class="purchase-entry-summary-card"><span>Tiền VAT</span><strong id="purchase-entry-vat-total">0 ₫</strong></div>
                <div class="purchase-entry-summary-card"><span>Tổng gồm VAT</span><strong id="purchase-entry-total">0 ₫</strong></div>
                <div class="purchase-entry-summary-card is-due"><span>Còn phải trả</span><strong id="purchase-entry-debt-total">0 ₫</strong></div>
              </div>
              <p class="purchase-entry-helper"><i data-lucide="info"></i><span>Database sẽ tự tính lại toàn bộ thành tiền và công nợ khi hoàn thành phiếu.</span></p>
            </section>
            <section class="purchase-entry-card purchase-entry-note-card">
              <div class="purchase-entry-section-heading">
                <span class="purchase-entry-step is-muted"><i data-lucide="notebook-pen"></i></span>
                <div><h4>Ghi chú</h4><p>Thông tin bổ sung cho phiếu mua (nếu có).</p></div>
              </div>
              <textarea class="form-control" id="purchase-note-input" rows="2" placeholder="Nhập ghi chú..."></textarea>
            </section>
          </div>
          <div class="modal-footer purchase-entry-footer">
            <span class="purchase-entry-footer-hint"><i data-lucide="shield-check"></i> Kiểm tra thông tin trước khi hoàn thành.</span>
            <div class="purchase-entry-footer-actions"><button type="button" class="btn btn-secondary" id="btn-cancel-purchase-entry">Hủy</button><button type="submit" class="btn btn-primary"><i data-lucide="check"></i> Hoàn thành phiếu mua</button></div>
          </div>
        </form>
      </div>
    </div>`;
}

function purchaseDetail(purchase) {
  const activePayments = (purchase.payments || []).filter(payment => payment.status === 'completed');
  return `
    <tr class="purchase-detail-row"><td colspan="10">
      <div class="purchase-detail">
        <div class="purchase-detail-head"><strong>${escapeHtml(purchase.code)}</strong><span class="purchase-status ${escapeHtml(purchase.status)}">${statusLabel(purchase.status)}</span></div>
        <div class="purchase-detail-meta">
          <div><span>Hóa đơn đầu vào:</span><strong>${escapeHtml(purchase.invoiceNumber || '-')}</strong></div>
          <div><span>Ngày mua:</span><strong>${escapeHtml(purchaseDate(purchase))}</strong></div>
          <div><span>Người thực hiện:</span><strong>${escapeHtml(purchase.createdBy || '-')}</strong></div>
        </div>
        <div class="purchase-detail-items-wrap"><table class="purchase-items-table"><thead><tr><th>Mã</th><th>Tên</th><th>ĐVT</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead><tbody>
          ${(purchase.items || []).map(item => `<tr><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.unit)}</td><td>${Number(item.quantity).toLocaleString('vi-VN')}</td><td>${formatCurrency(item.unitPrice)}</td><td>${formatCurrency(item.lineTotal)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="purchase-summary">
          <div><span>Tiền hàng</span><strong>${formatCurrency(purchase.subtotalAmount ?? purchaseTotal(purchase))}</strong></div>
          <div><span>VAT (${Number(purchase.vatRate || 0).toLocaleString('vi-VN')}%)</span><strong>${formatCurrency(purchase.vatAmount || 0)}</strong></div>
          <div><span>Tổng mua</span><strong>${formatCurrency(purchaseTotal(purchase))}</strong></div>
          <div><span>Đã thanh toán</span><strong>${formatCurrency(purchase.paidAmount)}</strong></div>
          <div><span>Còn phải trả</span><strong>${formatCurrency(purchase.balanceDue)}</strong></div>
        </div>
        ${purchase.status === 'completed' && Number(purchase.balanceDue || 0) > 0 ? `<div class="purchase-payment-box"><input type="number" class="purchase-pay-amount" aria-label="Số tiền thanh toán" min="1" max="${Number(purchase.balanceDue)}" value="${Number(purchase.balanceDue)}"><select class="purchase-pay-method" aria-label="Phương thức thanh toán"><option value="cash">Tiền mặt</option><option value="bank">Ngân hàng</option><option value="wallet">Ví điện tử</option></select><button class="btn btn-primary btn-sm purchase-pay-btn" data-id="${escapeHtml(purchase.id)}">Tạo phiếu chi</button></div>` : ''}
        ${activePayments.length ? `<div class="purchase-payment-history"><strong>Phiếu chi:</strong>${activePayments.map(payment => `<span>${formatCurrency(payment.amount)} · ${escapeHtml(payment.paymentMethod)} <button class="btn btn-danger btn-sm purchase-cancel-payment-btn" data-id="${escapeHtml(payment.id)}">Hủy phiếu chi</button></span>`).join('')}</div>` : ''}
        <div class="purchase-detail-actions">
          <button class="btn btn-secondary btn-sm purchase-print-btn" data-id="${escapeHtml(purchase.id)}">In phiếu mua</button>
          ${purchase.status === 'completed' ? `<button class="btn btn-danger btn-sm purchase-cancel-btn" data-id="${escapeHtml(purchase.id)}">Hủy phiếu mua</button>` : ''}
        </div>
      </div>
    </td></tr>`;
}

function updateTotals(modal) {
  let subtotal = 0;
  modal.querySelectorAll('.purchase-entry-item-row').forEach(row => {
    const quantity = Number(row.querySelector('.purchase-entry-qty')?.value || 0);
    const price = Number(row.querySelector('.purchase-entry-price')?.value || 0);
    const lineTotal = Math.max(0, Math.round(quantity * Math.round(price)));
    subtotal += lineTotal;
    const cell = row.querySelector('.purchase-entry-line-total');
    if (cell) cell.textContent = formatCurrency(lineTotal);
  });
  const paid = Math.max(0, Number(modal.querySelector('#purchase-paid-input')?.value || 0));
  const vatRate = Math.min(100, Math.max(0, Number(modal.querySelector('#purchase-vat-rate').value || 0)));
  const vatAmount = Math.round(subtotal * Math.round(vatRate * 100) / 10000);
  const total = subtotal + vatAmount;
  modal.querySelector('#purchase-entry-subtotal').textContent = formatCurrency(subtotal);
  modal.querySelector('#purchase-entry-vat-total').textContent = formatCurrency(vatAmount);
  modal.querySelector('#purchase-paid-input').max = String(total);
  modal.querySelector('#purchase-entry-total').textContent = formatCurrency(total);
  modal.querySelector('#purchase-entry-debt-total').textContent = formatCurrency(Math.max(0, total - paid));
}

function closePurchaseMaterialResults(row) {
  const search = row?.querySelector('.purchase-entry-material-search');
  const results = row?.querySelector('.purchase-entry-material-results');
  if (!search || !results) return;
  clearTimeout(row.materialSearchTimer);
  row.materialSearchSequence = (row.materialSearchSequence || 0) + 1;
  results.hidden = true;
  search.setAttribute('aria-expanded', 'false');
  search.removeAttribute('aria-activedescendant');
  row.dataset.materialActiveIndex = '-1';
}

function setPurchaseMaterialActiveOption(row, index, scroll = false) {
  const search = row.querySelector('.purchase-entry-material-search');
  const options = Array.from(row.querySelectorAll('.purchase-entry-material-option'));
  const activeIndex = options.length ? (index + options.length) % options.length : -1;
  options.forEach((option, optionIndex) => option.classList.toggle('is-active', optionIndex === activeIndex));
  if (activeIndex < 0) search.removeAttribute('aria-activedescendant');
  else {
    search.setAttribute('aria-activedescendant', options[activeIndex].id);
    if (scroll) options[activeIndex].scrollIntoView({ block: 'nearest' });
  }
  row.dataset.materialActiveIndex = String(activeIndex);
}

function searchPurchaseMaterials(row, immediate = false) {
  if (row.dataset.mode !== 'material') return;
  clearTimeout(row.materialSearchTimer);
  const sequence = (row.materialSearchSequence || 0) + 1;
  row.materialSearchSequence = sequence;
  const search = row.querySelector('.purchase-entry-material-search');
  const results = row.querySelector('.purchase-entry-material-results');
  const query = search.value.trim().slice(0, 80);
  results.hidden = false;
  results.innerHTML = '<p class="purchase-entry-material-message">Đang tìm vật tư…</p>';
  search.setAttribute('aria-expanded', 'true');
  search.removeAttribute('aria-activedescendant');
  row.materialSearchTimer = setTimeout(async () => {
    try {
      const data = await bomGateway.searchPurchaseItems({ query, limit: 30 });
      if (!row.isConnected || row.materialSearchSequence !== sequence || row.dataset.mode !== 'material') return;
      const materials = (data.rows || []).filter(item => item.is_active !== false);
      row.purchaseMaterialMatches = materials;
      results.innerHTML = materials.length
        ? `${materials.map((item, index) => `<button type="button" class="purchase-entry-material-option" role="option" id="${results.id}-option-${index}" data-item-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.code)}${item.brand ? ` · ${escapeHtml(item.brand)}` : ''} · ĐVT mua: ${escapeHtml(item.purchase_unit || item.base_unit || '')}${Number(item.unit_price) > 0 ? ` · Giá nhập: ${formatCurrency(item.unit_price)}` : ''}</small></button>`).join('')}${data.hasMore ? '<p class="purchase-entry-material-message">Nhập thêm mã hoặc tên để thu hẹp kết quả.</p>' : ''}`
        : '<p class="purchase-entry-material-message">Không thấy vật tư phù hợp. Có thể chọn Nhập tay.</p>';
      setPurchaseMaterialActiveOption(row, 0);
    } catch (error) {
      if (!row.isConnected || row.materialSearchSequence !== sequence) return;
      row.purchaseMaterialMatches = [];
      results.innerHTML = `<p class="purchase-entry-material-message">${escapeHtml(error.message || 'Không tải được danh mục mua hàng.')}</p>`;
      setPurchaseMaterialActiveOption(row, -1);
    }
  }, immediate ? 0 : 250);
}

function choosePurchaseMaterial(row, id) {
  const item = (row.purchaseMaterialMatches || []).find(material => String(material.id) === String(id));
  if (!item || item.is_active === false) return;
  row.dataset.catalogId = String(item.id);
  row.querySelector('.purchase-entry-code').value = item.code || '';
  row.querySelector('.purchase-entry-unit').value = item.purchase_unit || item.base_unit || '';
  const search = row.querySelector('.purchase-entry-material-search');
  search.value = item.source === 'product' ? `${item.code} · ${item.name}${item.brand ? ` · ${item.brand}` : ''}` : item.name || '';
  row.querySelector('.purchase-entry-item-source span').textContent = item.source === 'product' ? 'Từ danh sách sản phẩm' : 'Từ vật tư';
  const price = row.querySelector('.purchase-entry-price');
  if (item.source === 'product' && Number(item.unit_price) > 0 && !Number(price.value)) price.value = Math.round(Number(item.unit_price));
  updateTotals(row.closest('#purchase-entry-modal'));
  search.setCustomValidity('');
  search.focus();
  closePurchaseMaterialResults(row);
}

function switchPurchaseItemMode(row) {
  clearTimeout(row.materialSearchTimer);
  row.materialSearchSequence = (row.materialSearchSequence || 0) + 1;
  const mode = row.dataset.mode === 'material' ? 'manual' : 'material';
  const quantity = Number(row.querySelector('.purchase-entry-qty').value || 1);
  const unitPrice = Number(row.querySelector('.purchase-entry-price').value || 0);
  row.insertAdjacentHTML('afterend', itemRow({ mode, quantity, unitPrice }));
  const nextRow = row.nextElementSibling;
  row.remove();
  nextRow.querySelector('.purchase-entry-name').focus();
  updateTotals(nextRow.closest('#purchase-entry-modal'));
}

function normalizeSupplierSearch(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}

function purchaseSupplierLabel(supplier) {
  const name = String(supplier.name || '').trim();
  const code = String(supplier.code || '').trim();
  return code ? `${name} (${code})` : name;
}

function setPurchaseSupplierActiveOption(modal, index, scroll = false) {
  const input = modal.querySelector('#purchase-supplier-search');
  const options = Array.from(modal.querySelectorAll('.purchase-supplier-option'));
  const activeIndex = options.length ? (index + options.length) % options.length : -1;
  options.forEach((option, optionIndex) => option.classList.toggle('is-active', optionIndex === activeIndex));
  if (activeIndex < 0) input.removeAttribute('aria-activedescendant');
  else {
    input.setAttribute('aria-activedescendant', options[activeIndex].id);
    if (scroll) options[activeIndex].scrollIntoView({ block: 'nearest' });
  }
  modal.dataset.supplierActiveIndex = String(activeIndex);
}

function renderPurchaseSupplierResults(modal, open) {
  const input = modal.querySelector('#purchase-supplier-search');
  const results = modal.querySelector('#purchase-supplier-results');
  if (!input || !results) return;
  results.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  if (!open) {
    input.removeAttribute('aria-activedescendant');
    modal.dataset.supplierActiveIndex = '-1';
    return;
  }
  const suppliers = state.suppliers || [];
  const query = normalizeSupplierSearch(input.value);
  const filteredSuppliers = query
    ? suppliers.filter(supplier => normalizeSupplierSearch(`${supplier.name || ''} ${supplier.code || ''}`).includes(query))
    : suppliers;
  const visibleSuppliers = filteredSuppliers.slice(0, 25);
  results.innerHTML = visibleSuppliers.length
    ? `${visibleSuppliers.map((supplier, index) => `<button type="button" class="purchase-supplier-option" role="option" id="purchase-supplier-option-${index}" data-supplier-id="${escapeHtml(supplier.id)}"><span>${escapeHtml(supplier.name)}</span><small>${escapeHtml(supplier.code || '')}</small></button>`).join('')}${filteredSuppliers.length > visibleSuppliers.length ? `<p class="purchase-supplier-more">Còn ${filteredSuppliers.length - visibleSuppliers.length} nhà cung cấp. Nhập thêm để thu hẹp kết quả.</p>` : ''}`
    : '<p class="purchase-supplier-empty">Không tìm thấy nhà cung cấp phù hợp.</p>';
  setPurchaseSupplierActiveOption(modal, 0);
}

function choosePurchaseSupplier(modal, id) {
  const supplier = (state.suppliers || []).find(item => String(item.id) === String(id));
  if (!supplier) return;
  modal.querySelector('#purchase-supplier-select').value = String(supplier.id);
  const input = modal.querySelector('#purchase-supplier-search');
  input.value = purchaseSupplierLabel(supplier);
  input.setCustomValidity('');
  input.focus();
  renderPurchaseSupplierResults(modal, false);
}

function syncPurchaseSupplierOptions(modal) {
  const selected = modal?.querySelector('#purchase-supplier-select');
  if (!selected) return;
  if (selected.value && !(state.suppliers || []).some(supplier => String(supplier.id) === selected.value)) {
    selected.value = '';
    modal.querySelector('#purchase-supplier-search').value = '';
  }
  if (!modal.querySelector('#purchase-supplier-results').hidden) renderPurchaseSupplierResults(modal, true);
}

function printPurchase(purchase) {
  const popup = window.open('', '_blank', 'width=900,height=700');
  if (!popup) return showToast('Trình duyệt đang chặn cửa sổ in.', 'warning');
  popup.document.write(`<!doctype html><html><head><title>${escapeHtml(purchase.code)}</title><style>body{font-family:Arial;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #222;padding:7px;text-align:left}.right{text-align:right}</style></head><body><h2>PHIẾU MUA HÀNG</h2><p>Mã: <b>${escapeHtml(purchase.code)}</b></p><p>Nhà cung cấp: <b>${escapeHtml(purchase.supplierName)}</b></p><p>Ngày mua: ${escapeHtml(purchaseDate(purchase))}</p><table><thead><tr><th>Mã</th><th>Tên</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead><tbody>${(purchase.items || []).map(item => `<tr><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.name)}</td><td class="right">${Number(item.quantity).toLocaleString('vi-VN')}</td><td class="right">${formatCurrency(item.unitPrice)}</td><td class="right">${formatCurrency(item.lineTotal)}</td></tr>`).join('')}</tbody></table><p class="right">Tiền hàng: ${formatCurrency(purchase.subtotalAmount ?? purchaseTotal(purchase))}</p><p class="right">VAT (${Number(purchase.vatRate || 0).toLocaleString('vi-VN')}%): ${formatCurrency(purchase.vatAmount || 0)}</p><h3 class="right">Tổng gồm VAT: ${formatCurrency(purchaseTotal(purchase))}</h3><p class="right">Đã trả: ${formatCurrency(purchase.paidAmount)} · Còn phải trả: ${formatCurrency(purchase.balanceDue)}</p></body></html>`);
  popup.document.close();
  popup.focus();
  popup.print();
}

function attachEvents(panel, modal) {
  panel.querySelector('#purchase-list-search')?.addEventListener('input', event => {
    if (event.isComposing) return;
    panel.dataset.purchaseQuery = event.target.value;
    panel.dataset.purchasePage = '1';
    const cursor = event.target.selectionStart;
    renderPurchasesPanel(panel);
    const search = panel.querySelector('#purchase-list-search');
    search.focus();
    if (cursor !== null) search.setSelectionRange(cursor, cursor);
  });
  panel.querySelector('#purchase-list-status')?.addEventListener('change', event => {
    panel.dataset.purchaseStatus = event.target.value;
    panel.dataset.purchasePage = '1';
    renderPurchasesPanel(panel);
  });
  panel.querySelectorAll('[data-purchase-page]').forEach(button => button.addEventListener('click', () => {
    panel.dataset.purchasePage = button.dataset.purchasePage;
    renderPurchasesPanel(panel);
  }));
  panel.querySelector('#btn-clear-purchase-filters')?.addEventListener('click', () => {
    panel.dataset.purchaseQuery = '';
    panel.dataset.purchaseStatus = '';
    panel.dataset.purchasePage = '1';
    renderPurchasesPanel(panel);
    panel.querySelector('#purchase-list-search')?.focus();
  });
  panel.querySelectorAll('.purchase-row').forEach(row => row.addEventListener('click', event => {
    if (event.target.closest('input,select')) return;
    if (event.target.closest('button') && !event.target.closest('.purchase-row-toggle')) return;
    panel.dataset.activePurchaseId = panel.dataset.activePurchaseId === row.dataset.id ? '' : row.dataset.id;
    renderPurchasesPanel(panel);
  }));
  const close = () => {
    if (modal) renderPurchaseSupplierResults(modal, false);
    modal?.querySelectorAll('.purchase-entry-item-row').forEach(row => {
      clearTimeout(row.materialSearchTimer);
      row.materialSearchSequence = (row.materialSearchSequence || 0) + 1;
      closePurchaseMaterialResults(row);
    });
    modal?.classList.remove('active');
    document.body.classList.remove('purchase-entry-modal-open');
  };
  panel.querySelector('#btn-open-purchase-modal')?.addEventListener('click', () => {
    const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    modal.querySelector('#purchase-date-input').value = date.toISOString().slice(0, 16);
    pendingPurchaseKey ||= newKey('purchase');
    updateTotals(modal);
    modal?.classList.add('active');
    document.body.classList.add('purchase-entry-modal-open');
  });
  if (modal && modal.dataset.eventsBound !== 'true') {
    modal.dataset.eventsBound = 'true';
    const supplierSearch = modal.querySelector('#purchase-supplier-search');
    modal.querySelector('#purchase-supplier-search')?.addEventListener('input', () => {
      modal.querySelector('#purchase-supplier-select').value = '';
      supplierSearch.setCustomValidity('Chọn nhà cung cấp trong danh sách gợi ý.');
      renderPurchaseSupplierResults(modal, true);
    });
    supplierSearch?.addEventListener('focus', () => renderPurchaseSupplierResults(modal, true));
    supplierSearch?.addEventListener('keydown', event => {
      const results = modal.querySelector('#purchase-supplier-results');
      if (event.key === 'Escape') {
        renderPurchaseSupplierResults(modal, false);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (results.hidden) renderPurchaseSupplierResults(modal, true);
        else setPurchaseSupplierActiveOption(modal, Number(modal.dataset.supplierActiveIndex || 0) + (event.key === 'ArrowDown' ? 1 : -1), true);
      }
      if (event.key === 'Enter' && !results.hidden) {
        const active = results.querySelector('.purchase-supplier-option.is-active');
        if (active) {
          event.preventDefault();
          choosePurchaseSupplier(modal, active.dataset.supplierId);
        }
      }
    });
    modal.querySelector('#purchase-supplier-results')?.addEventListener('click', event => {
      const option = event.target.closest('.purchase-supplier-option');
      if (option) choosePurchaseSupplier(modal, option.dataset.supplierId);
    });
    modal.addEventListener('pointerdown', event => {
      if (!event.target.closest('.purchase-supplier-combobox')) renderPurchaseSupplierResults(modal, false);
      modal.querySelectorAll('.purchase-entry-item-row').forEach(row => {
        if (!row.querySelector('.purchase-entry-material-picker')?.contains(event.target)) closePurchaseMaterialResults(row);
      });
    });
    modal.querySelector('#btn-close-purchase-entry')?.addEventListener('click', close);
    modal.querySelector('#btn-cancel-purchase-entry')?.addEventListener('click', close);
    modal.querySelector('#btn-add-purchase-item-row')?.addEventListener('click', () => {
      const body = modal.querySelector('#purchase-entry-items-body');
      body.insertAdjacentHTML('beforeend', itemRow());
      updateTotals(modal);
      body.lastElementChild.querySelector('.purchase-entry-material-search').focus();
    });
    const itemBody = modal.querySelector('#purchase-entry-items-body');
    itemBody?.addEventListener('focusin', event => {
      if (event.target.matches('.purchase-entry-material-search')) searchPurchaseMaterials(event.target.closest('.purchase-entry-item-row'), true);
    });
    itemBody?.addEventListener('input', event => {
      const search = event.target.closest('.purchase-entry-material-search');
      if (search) {
        const row = search.closest('.purchase-entry-item-row');
        row.dataset.catalogId = '';
        row.querySelector('.purchase-entry-code').value = '';
        row.querySelector('.purchase-entry-unit').value = '';
        search.setCustomValidity('Chọn vật tư trong danh sách gợi ý hoặc chuyển sang Nhập tay.');
        searchPurchaseMaterials(row);
      }
      updateTotals(modal);
    });
    itemBody?.addEventListener('keydown', event => {
      const search = event.target.closest('.purchase-entry-material-search');
      if (!search) return;
      const row = search.closest('.purchase-entry-item-row');
      const results = row.querySelector('.purchase-entry-material-results');
      if (event.key === 'Escape') {
        closePurchaseMaterialResults(row);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (results.hidden) searchPurchaseMaterials(row, true);
        else setPurchaseMaterialActiveOption(row, Number(row.dataset.materialActiveIndex ?? -1) + (event.key === 'ArrowDown' ? 1 : -1), true);
      }
      if (event.key === 'Enter' && !results.hidden) {
        const active = results.querySelector('.purchase-entry-material-option.is-active');
        if (active) {
          event.preventDefault();
          choosePurchaseMaterial(row, active.dataset.itemId);
        }
      }
    });
    modal.querySelector('#purchase-paid-input')?.addEventListener('input', () => updateTotals(modal));
    modal.querySelector('#purchase-vat-rate')?.addEventListener('input', () => updateTotals(modal));
    itemBody?.addEventListener('click', event => {
      const row = event.target.closest('.purchase-entry-item-row');
      const material = event.target.closest('.purchase-entry-material-option');
      if (material) return choosePurchaseMaterial(row, material.dataset.itemId);
      if (event.target.closest('.purchase-entry-switch-source')) return switchPurchaseItemMode(row);
      const button = event.target.closest('.purchase-entry-remove-row'); if (!button) return;
      if (modal.querySelectorAll('.purchase-entry-item-row').length <= 1) return showToast('Phiếu mua phải có ít nhất một dòng.', 'warning');
      clearTimeout(row.materialSearchTimer);
      row.materialSearchSequence = (row.materialSearchSequence || 0) + 1;
      row.remove(); updateTotals(modal);
    });
    modal.querySelector('#purchase-entry-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const supplierId = modal.querySelector('#purchase-supplier-select').value;
      if (!supplierId) {
        supplierSearch.setCustomValidity('Chọn nhà cung cấp trong danh sách gợi ý.');
        supplierSearch.reportValidity();
        supplierSearch.focus();
        return;
      }
      const unselectedMaterial = Array.from(modal.querySelectorAll('.purchase-entry-item-row'))
        .find(row => row.dataset.mode === 'material' && !row.dataset.catalogId);
      if (unselectedMaterial) {
        const search = unselectedMaterial.querySelector('.purchase-entry-material-search');
        search.setCustomValidity('Chọn vật tư trong danh sách gợi ý hoặc chuyển sang Nhập tay.');
        search.reportValidity();
        search.focus();
        return;
      }
      const items = Array.from(modal.querySelectorAll('.purchase-entry-item-row')).map(row => ({
        code: row.querySelector('.purchase-entry-code').value.trim(),
        name: row.querySelector('.purchase-entry-name').value.trim(),
        unit: row.querySelector('.purchase-entry-unit').value.trim(),
        quantity: Number(row.querySelector('.purchase-entry-qty').value),
        unitPrice: Number(row.querySelector('.purchase-entry-price').value)
      }));
      const submit = event.submitter; if (submit) submit.disabled = true;
      const result = await dbCreatePurchase({
        supplierId,
        invoiceNumber: modal.querySelector('#purchase-invoice-number').value.trim(),
        purchaseDate: new Date(modal.querySelector('#purchase-date-input').value).toISOString(),
        paidAmount: Number(modal.querySelector('#purchase-paid-input').value || 0),
        vatRate: Number(modal.querySelector('#purchase-vat-rate').value || 0),
        paymentMethod: modal.querySelector('#purchase-payment-method').value,
        notes: modal.querySelector('#purchase-note-input').value.trim(),
        idempotencyKey: pendingPurchaseKey || newKey('purchase'), items
      });
      if (submit) submit.disabled = false;
      if (!result) return;
      pendingPurchaseKey = '';
      panel.dataset.activePurchaseId = result.purchase?.id || '';
      panel.dataset.purchaseQuery = '';
      panel.dataset.purchaseStatus = '';
      panel.dataset.purchasePage = '1';
      showToast(result.already_recorded ? 'Phiếu mua đã được ghi nhận trước đó.' : 'Đã tạo phiếu mua và cập nhật công nợ.', 'success');
      close();
      renderPurchasesPanel(panel);
    });
  }
  panel.querySelectorAll('.purchase-pay-btn').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    const purchase = state.purchases.find(item => String(item.id) === String(button.dataset.id));
    const box = button.closest('.purchase-payment-box');
    const amount = Number(box.querySelector('.purchase-pay-amount').value || 0);
    const method = box.querySelector('.purchase-pay-method').value;
    const paymentKey = pendingSupplierPaymentKeys.get(purchase.id) || newKey(`supplier-payment:${purchase.id}`);
    pendingSupplierPaymentKeys.set(purchase.id, paymentKey);
    button.disabled = true;
    const result = await dbRecordSupplierPayment({ supplierId: purchase.supplierId, purchaseId: purchase.id, amount, paymentMethod: method, notes: `Thanh toán ${purchase.code}`, idempotencyKey: paymentKey });
    button.disabled = false;
    if (result) {
      pendingSupplierPaymentKeys.delete(purchase.id);
      showToast('Đã tạo phiếu chi và giảm công nợ nhà cung cấp.', 'success');
      renderPurchasesPanel(panel);
    }
  }));
  panel.querySelectorAll('.purchase-cancel-payment-btn').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation(); const reason = prompt('Nhập lý do hủy phiếu chi:'); if (!reason?.trim()) return;
    const result = await dbCancelSupplierPayment(button.dataset.id, reason.trim());
    if (result) { showToast('Đã hủy phiếu chi và ghi giao dịch đảo.', 'success'); renderPurchasesPanel(panel); }
  }));
  panel.querySelectorAll('.purchase-cancel-btn').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation(); const reason = prompt('Nhập lý do hủy phiếu mua:'); if (!reason?.trim()) return;
    const result = await dbCancelPurchase(button.dataset.id, reason.trim());
    if (result) { showToast('Đã hủy phiếu mua và đảo công nợ/phiếu chi.', 'success'); renderPurchasesPanel(panel); }
  }));
  panel.querySelectorAll('.purchase-print-btn').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation(); const purchase = state.purchases.find(item => String(item.id) === String(button.dataset.id)); if (purchase) printPurchase(purchase);
  }));
}

function filterPurchaseList(purchases, query, status) {
  const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return purchases.filter(purchase => {
    if (status && purchase.status !== status) return false;
    const text = normalize([purchase.code, purchase.invoiceNumber, purchase.supplierName, purchase.supplierCode, purchase.createdBy].join(' '));
    return terms.every(term => text.includes(term));
  });
}

export function renderPurchasesPanel(panel) {
  if (!panel) return;
  if (!financeRole()) {
    document.getElementById('purchase-entry-modal')?.remove();
    document.body.classList.remove('purchase-entry-modal-open');
    panel.innerHTML = '<div class="empty-state">Bạn không có quyền truy cập phân hệ mua hàng.</div>';
    return;
  }
  let modal = document.getElementById('purchase-entry-modal');
  const existingPage = panel.querySelector('.purchase-page');
  const activeId = panel.dataset.activePurchaseId || '';
  const purchases = state.purchases || [];
  const query = panel.dataset.purchaseQuery || '';
  const status = panel.dataset.purchaseStatus || '';
  const filtered = filterPurchaseList(purchases, query, status);
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number(panel.dataset.purchasePage) || 1));
  panel.dataset.purchasePage = String(page);
  const start = (page - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  const pageMarkup = `
    <div class="purchase-page"><div class="glass-panel purchase-main">
      <div class="panel-header purchase-toolbar"><div class="purchase-heading"><h2 class="panel-title"><i data-lucide="clipboard-list"></i> Quản lý phiếu mua hàng</h2><p>Ghi nhận mua hàng, thanh toán và công nợ nhà cung cấp.</p></div><div class="purchase-actions"><button type="button" class="btn btn-primary btn-sm" id="btn-open-purchase-modal"><i data-lucide="plus"></i> Tạo phiếu mua</button></div></div>
      <div class="controls-row purchase-list-controls">
        <div class="search-wrapper"><i data-lucide="search" class="search-icon" aria-hidden="true"></i><label class="sr-only" for="purchase-list-search">Tìm phiếu mua hàng</label><input type="text" class="form-control-search" id="purchase-list-search" placeholder="Tìm mã phiếu, hóa đơn, nhà cung cấp…" value="${escapeHtml(query)}" autocomplete="off"></div>
        <div class="purchase-status-filter"><label for="purchase-list-status">Trạng thái</label><select class="form-control" id="purchase-list-status"><option value="" ${!status ? 'selected' : ''}>Tất cả trạng thái</option>${['completed', 'draft', 'cancelled'].map(value => `<option value="${value}" ${status === value ? 'selected' : ''}>${statusLabel(value)}</option>`).join('')}</select></div>
      </div>
      <div class="table-responsive purchase-table-wrap"><table class="table purchase-table" aria-label="Danh sách phiếu mua hàng"><thead><tr><th>Mã phiếu</th><th>Ngày mua</th><th>Số hóa đơn</th><th>Nhà cung cấp</th><th class="purchase-money">Tổng gồm VAT</th><th class="purchase-money">Đã thanh toán</th><th class="purchase-money">Còn phải trả</th><th>Trạng thái</th><th>Người tạo</th><th>Thao tác</th></tr></thead><tbody>
        ${visible.length ? visible.map(purchase => `<tr class="purchase-row ${String(activeId) === String(purchase.id) ? 'active' : ''}" data-id="${escapeHtml(purchase.id)}"><td data-label="Mã phiếu"><strong class="purchase-code">${escapeHtml(purchase.code)}</strong></td><td data-label="Ngày mua">${escapeHtml(purchaseDate(purchase))}</td><td data-label="Số hóa đơn">${escapeHtml(purchase.invoiceNumber || '-')}</td><td class="purchase-supplier-cell" data-label="Nhà cung cấp"><strong>${escapeHtml(purchase.supplierName || purchase.supplierCode)}</strong>${purchase.supplierName && purchase.supplierCode ? `<small>${escapeHtml(purchase.supplierCode)}</small>` : ''}</td><td class="purchase-money" data-label="Tổng gồm VAT">${formatCurrency(purchaseTotal(purchase))}</td><td class="purchase-money" data-label="Đã thanh toán">${formatCurrency(purchase.paidAmount)}</td><td class="purchase-money ${purchase.status === 'completed' && Number(purchase.balanceDue) > 0 ? 'purchase-outstanding' : ''}" data-label="Còn phải trả">${formatCurrency(purchase.balanceDue)}</td><td data-label="Trạng thái"><span class="purchase-status ${escapeHtml(purchase.status)}">${statusLabel(purchase.status)}</span></td><td data-label="Người tạo">${escapeHtml(purchase.createdBy || '-')}</td><td data-label="Thao tác"><button type="button" class="btn btn-secondary btn-sm purchase-row-toggle" aria-label="${String(activeId) === String(purchase.id) ? 'Thu gọn' : 'Xem'} phiếu ${escapeHtml(purchase.code)}" aria-expanded="${String(activeId) === String(purchase.id)}"><i data-lucide="${String(activeId) === String(purchase.id) ? 'chevron-up' : 'eye'}"></i> ${String(activeId) === String(purchase.id) ? 'Thu gọn' : 'Xem'}</button></td></tr>${String(activeId) === String(purchase.id) ? purchaseDetail(purchase) : ''}`).join('') : `<tr><td colspan="10" class="purchase-empty"><i data-lucide="${purchases.length ? 'search-x' : 'clipboard-list'}" aria-hidden="true"></i><strong>${purchases.length ? 'Không tìm thấy phiếu phù hợp' : 'Chưa có phiếu mua hàng'}</strong><p>${purchases.length ? 'Thử đổi từ khóa hoặc trạng thái để tìm lại.' : 'Tạo phiếu mua đầu tiên để theo dõi mua hàng và công nợ nhà cung cấp.'}</p>${purchases.length ? '<button type="button" class="btn btn-secondary btn-sm" id="btn-clear-purchase-filters">Xóa bộ lọc</button>' : ''}</td></tr>`}
      </tbody></table></div>
      <div class="purchase-pagination"><span role="status">${filtered.length ? `${start + 1}–${Math.min(start + pageSize, filtered.length)} / ${filtered.length}` : '0'} phiếu mua${query || status ? ` (lọc từ ${purchases.length} phiếu)` : ''}</span><div class="purchase-pagination-buttons"><button type="button" class="btn btn-secondary btn-sm" data-purchase-page="${page - 1}" ${page === 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i> Trước</button><span>Trang <strong>${page}</strong> / ${pages}</span><button type="button" class="btn btn-secondary btn-sm" data-purchase-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Sau <i data-lucide="chevron-right"></i></button></div></div>
    </div></div>`;
  // Keep the modal at document level so panel transforms cannot clip its backdrop or popup.
  if (existingPage) {
    existingPage.outerHTML = pageMarkup;
  } else {
    panel.innerHTML = pageMarkup;
  }
  if (!modal) {
    const modalTemplate = document.createElement('template');
    modalTemplate.innerHTML = purchaseModal().trim();
    modal = modalTemplate.content.firstElementChild;
  }
  if (modal.parentElement !== document.body) document.body.append(modal);
  syncPurchaseSupplierOptions(modal);
  attachEvents(panel, modal);
  safeCreateIcons();
}
