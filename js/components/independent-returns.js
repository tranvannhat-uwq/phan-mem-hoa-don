import { state } from '../state.js';
import { dbRecordIndependentReturn, dbListIndependentReturns, dbCancelSalesReturn, dbRefreshCustomerFinancialState, getRetentionSessionScope } from '../services/supabase.js?v=20261030-supplier-cashbook-v1';
import { independentReturnTotal } from '../domain/data-retention.js';
import { formatCurrency, showToast } from '../utils.js';
import { printReturnSlip } from './history.js?v=20261030-supplier-cashbook-v1';

const el = id => document.getElementById(`independent-return-${id}`);
let offset = 0; let loadedScope = ''; let loading = false; let saving = false;
let request = null; let requestScope = ''; let lastPayload = ''; let rows = [];
let itemSequence = 0;
let customerLookup = null;
let modalTrigger = null;
let initialized = false;
const finance = () => ['admin', 'accounting'].includes(state.currentUser?.role);
const normalizeSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
const customerLabel = customer => [customer.code, customer.name].filter(Boolean).join(' — ');
const productLabel = product => [product.code || product.variantCode, product.name, product.brand, product.packageType || product.packagingName].filter(Boolean).join(' — ');

function setupReturnLookup(input, valueInput, getCandidates, labelFor, detailFor) {
  const wrapper = input.closest('.return-lookup');
  const results = wrapper.querySelector('.return-lookup-results');
  let matches = []; let activeIndex = -1; let scope = '';
  const close = () => {
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  };
  const select = item => {
    if (input.disabled || !finance() || scope !== getRetentionSessionScope()) { close(); return; }
    valueInput.value = item.id;
    input.value = labelFor(item);
    input.setCustomValidity('');
    close();
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const render = () => {
    if (input.disabled || !finance() || !input.value.trim()) { close(); return; }
    scope = getRetentionSessionScope();
    const tokens = normalizeSearch(input.value).split(/\s+/);
    const found = getCandidates().filter(item => {
      const text = normalizeSearch(`${labelFor(item)} ${detailFor(item)} ${String(item.phone || '').replace(/\D/g, '')}`);
      return tokens.every(token => text.includes(token));
    });
    matches = found.slice(0, 20); activeIndex = -1;
    results.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    matches.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'return-lookup-option';
      button.id = `${results.id}-${index}`;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
      const title = document.createElement('strong'); title.textContent = labelFor(item);
      const detail = document.createElement('small'); detail.textContent = detailFor(item);
      button.append(title, detail);
      button.addEventListener('click', () => select(item));
      results.append(button);
    });
    if (!found.length || found.length > matches.length) {
      const hint = document.createElement('div'); hint.className = 'return-lookup-hint';
      hint.setAttribute('role', 'status');
      hint.textContent = !found.length ? 'Không tìm thấy kết quả.' : 'Còn kết quả khác. Nhập thêm từ khóa để tìm chính xác hơn.';
      results.append(hint);
    }
    results.hidden = false; input.setAttribute('aria-expanded', 'true');
  };
  input.addEventListener('input', () => {
    valueInput.value = '';
    input.setCustomValidity(input.value ? 'Vui lòng chọn một kết quả tìm kiếm.' : '');
    render();
  });
  input.addEventListener('focus', () => { if (!valueInput.value) render(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !results.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.hidden) render();
      if (!matches.length || results.hidden) return;
      activeIndex = activeIndex < 0 ? (event.key === 'ArrowDown' ? 0 : matches.length - 1)
        : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      results.querySelectorAll('[role="option"]').forEach((button, index) => {
        button.setAttribute('aria-selected', String(index === activeIndex));
        if (index === activeIndex) {
          input.setAttribute('aria-activedescendant', button.id);
          button.scrollIntoView({ block: 'nearest' });
        }
      });
    } else if (event.key === 'Enter' && !results.hidden) {
      event.preventDefault();
      if (matches.length) select(matches[Math.max(0, activeIndex)]);
    }
  });
  wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
  return { reset() { valueInput.value = ''; input.value = ''; input.setCustomValidity(''); close(); } };
}

function option(value, text) { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; }
function fillSelect(select, values, empty) {
  const prior = select.value; select.replaceChildren(option('', empty), ...values.map(item => option(item.id, item.label)));
  select.value = prior;
}
function status(text, showInForm = false) {
  el('status').textContent = text;
  if (showInForm) el('form-status').textContent = text;
}
function openReturnModal() {
  if (!finance()) return;
  modalTrigger = document.activeElement;
  renderIndependentReturns();
  el('modal').classList.add('active');
  el('modal').setAttribute('aria-hidden', 'false');
  document.body.classList.add('return-modal-open');
  (request ? el('reconcile') : el('customer-search')).focus();
}
function closeReturnModal(force = false) {
  if (saving && !force) return;
  el('modal').classList.remove('active');
  el('modal').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('return-modal-open');
  (modalTrigger?.isConnected ? modalTrigger : el('open')).focus();
}
function pendingControls() {
  el('form').querySelectorAll('input,select,textarea,button').forEach(input => { input.disabled = saving || Boolean(request); });
  if (saving || request) {
    el('form').querySelectorAll('.return-lookup-results').forEach(results => { results.hidden = true; });
    el('form').querySelectorAll('[role="combobox"]').forEach(input => {
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    });
  }
  el('reconcile').hidden = !request;
  el('reconcile').disabled = saving || !finance() || requestScope !== getRetentionSessionScope();
  el('close').disabled = saving;
  el('cancel').disabled = saving;
}
async function recordPending() {
  if (!finance() || !requestScope || requestScope !== getRetentionSessionScope()) {
    throw new Error('Lần gửi đang chờ kết quả thuộc tài khoản hoặc kết nối khác. Hãy đăng nhập lại đúng tài khoản và kết nối đã gửi rồi kiểm tra; không lập phiếu mới để thay thế.');
  }
  const input = JSON.parse(lastPayload);
  const response = await dbRecordIndependentReturn({ ...input, idempotencyKey: request });
  request = null; requestScope = ''; lastPayload = '';
  el('form').reset(); el('items').replaceChildren(); addItem();
  el('form-status').textContent = '';
  closeReturnModal(true);
  status(`Đã ghi phiếu ${response.return_id}. Công nợ mới: ${formatCurrency(response.new_debt)}.`);
  showToast(`Đã ghi phiếu ${response.return_id} và cập nhật công nợ.`, 'success');
  try {
    await dbRefreshCustomerFinancialState(input.customerId);
    offset = 0; await refreshList(true);
  } catch (_) { status(`Phiếu ${response.return_id} đã được ghi. Chưa tải lại được số dư; hãy làm mới dữ liệu.`); }
}
function addItem() {
  if (el('items').children.length >= 50) return;
  const row = document.createElement('div'); row.className = 'independent-return-item';
  const lookupId = `independent-return-product-${++itemSequence}`;
  row.innerHTML = `<div class="return-lookup"><label for="${lookupId}">Sản phẩm</label>`
    + `<input id="${lookupId}" class="form-control" type="text" placeholder="Tìm tên sản phẩm hoặc mã SKU..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${lookupId}-results" required>`
    + `<input type="hidden" data-field="productId"><div id="${lookupId}-results" class="return-lookup-results" role="listbox" aria-label="Sản phẩm tìm được" hidden></div></div>`
    + '<label>Số lượng<input class="form-control" data-field="quantity" type="number" min="0.0001" max="1000000" step="0.0001" value="1" required></label>'
    + '<label>Đơn giá nhận lại (₫)<input class="form-control" data-field="unitPrice" type="number" min="0" max="1000000000" step="1" required></label>'
    + '<label>Khấu trừ (%)<input class="form-control" data-field="deductionPercent" type="number" min="0" max="100" step="0.01" value="0" required></label>'
    + '<button type="button" class="btn btn-secondary" data-remove>Xóa dòng</button>';
  setupReturnLookup(row.querySelector('[role="combobox"]'), row.querySelector('[data-field="productId"]'),
    () => state.products.filter(p => p.isActive !== false && !p.isLegacy), productLabel,
    product => [product.variantCode, product.brand, product.packageType || product.packagingName].filter(Boolean).join(' · '));
  row.querySelector('[data-remove]').onclick = () => { row.remove(); updateTotal(); };
  row.addEventListener('input', updateTotal);
  el('items').append(row); updateTotal();
}
function items() {
  return [...el('items').children].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')]
    .map(input => [input.dataset.field, input.dataset.field === 'productId' ? input.value : Number(input.value)])));
}
function updateTotal() {
  try { el('total').textContent = formatCurrency(independentReturnTotal(items())); }
  catch (_) { el('total').textContent = 'Kiểm tra số lượng và đơn giá'; }
}
async function refreshList(force = false) {
  if (loading || !finance()) return;
  const scope = `${state.currentUser.id}|${state.retentionEpoch}|${offset}`;
  if (!force && scope === loadedScope) return;
  loading = true; status('Đang tải phiếu trả độc lập…');
  try {
    const result = await dbListIndependentReturns({ offset, limit: 25 });
    if (!finance() || scope !== `${state.currentUser.id}|${state.retentionEpoch}|${offset}`) return;
    rows = result.rows || []; loadedScope = scope;
    el('list').replaceChildren();
    for (const response of rows) {
      const ret = response.return; ret.customerName = response.customer_name;
      const tr = document.createElement('tr');
      const values = [ret.id, response.customer_name, new Date(ret.returnDate || ret.createdAt).toLocaleDateString('vi-VN'),
        formatCurrency(ret.totalRefund), ['cancelled', 'canceled'].includes(ret.status) ? 'Đã hủy' : 'Đã nhận'];
      values.forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.append(td); });
      const actions = document.createElement('td');
      const print = document.createElement('button'); print.className = 'btn btn-secondary btn-sm'; print.textContent = 'In';
      print.onclick = () => printReturnSlip(ret); actions.append(print);
      if (!['cancelled', 'canceled'].includes(ret.status)) {
        const cancel = document.createElement('button'); cancel.className = 'btn btn-danger btn-sm'; cancel.textContent = 'Hủy';
        cancel.onclick = async () => {
          if (saving) return;
          const reason = prompt(`Lý do hủy phiếu ${ret.id}:`);
          if (reason === null) return;
          if (reason.trim().length < 3) { showToast('Lý do cần ít nhất 3 ký tự.', 'warning'); return; }
          if (!confirm('Hủy phiếu sẽ đảo lại công nợ và lượng hàng đã nhập kho (nếu có). Tiếp tục?')) return;
          saving = true; cancel.disabled = true;
          try {
            if (!await dbCancelSalesReturn(ret.id, reason.trim())) return;
            await dbRefreshCustomerFinancialState(ret.customerId);
            await refreshList(true); showToast('Đã hủy phiếu trả.', 'success');
          } catch (error) { status(error.message || 'Chưa tải lại được kết quả. Hãy làm mới danh sách.'); }
          finally { saving = false; cancel.disabled = false; }
        };
        actions.append(cancel);
      }
      tr.append(actions); el('list').append(tr);
    }
    el('prev').disabled = offset === 0; el('next').disabled = offset + 25 >= result.total;
    status(result.total ? `Phiếu ${offset + 1}–${Math.min(offset + 25, result.total)} / ${result.total}` : 'Chưa có phiếu trả độc lập.');
  } catch (error) { status(error.message || 'Chưa tải được danh sách.'); }
  finally { loading = false; }
}
export function renderIndependentReturns() {
  const section = document.getElementById('independent-returns-section'); if (!section) return;
  setupIndependentReturns();
  section.hidden = !finance();
  if (!finance()) { loadedScope = ''; rows = []; el('list').replaceChildren(); return; }
  pendingControls();
  if (request && requestScope !== getRetentionSessionScope()) {
    status('Còn lần gửi chờ kết quả ở tài khoản/kết nối trước. Đăng nhập lại đúng tài khoản để kiểm tra trước khi lập phiếu khác.', true);
    return;
  }
  // Preserve an in-progress receipt when this page rerenders after data updates.
  fillSelect(el('company'), state.companies.map(c => ({ id: c.id, label: c.name })), 'Chọn công ty');
  if (!el('items').children.length && state.products.length) addItem();
  void refreshList();
}
export function setupIndependentReturns() {
  if (initialized || !el('form')) return;
  // Keep fixed-position overlays outside animated panels and glass cards.
  const appLayout = document.getElementById('app-layout');
  (appLayout || document.body).append(el('modal'));
  if (appLayout && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => { if (appLayout.classList.contains('auth-hidden')) closeReturnModal(true); })
      .observe(appLayout, { attributes: true, attributeFilter: ['class'] });
  }
  el('open').onclick = openReturnModal;
  el('close').onclick = () => closeReturnModal();
  el('cancel').onclick = () => closeReturnModal();
  el('modal').addEventListener('click', event => { if (event.target === el('modal')) closeReturnModal(); });
  el('modal').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeReturnModal(); }
    if (event.key !== 'Tab') return;
    const controls = [...el('modal').querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])')]
      .filter(input => input.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  customerLookup = setupReturnLookup(el('customer-search'), el('customer'), () => state.customers, customerLabel,
    customer => customer.phone || 'Chưa có số điện thoại');
  el('form').addEventListener('reset', () => customerLookup.reset());
  el('add').onclick = addItem;
  el('refresh').onclick = () => void refreshList(true);
  el('prev').onclick = () => { offset = Math.max(0, offset - 25); void refreshList(true); };
  el('next').onclick = () => { offset += 25; void refreshList(true); };
  el('form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !finance()) return;
    let firstAttempt = false;
    const input = { customerId: el('customer').value, companyId: el('company').value,
      reason: el('reason').value.trim(), sealConfirmed: el('seal').checked, items: items() };
    try {
      if (!input.items.length || !input.customerId || !input.companyId || !input.sealConfirmed || input.reason.length < 3) throw new Error('Điền khách, công ty, lý do và xác nhận tem niêm phong.');
      const total = independentReturnTotal(input.items);
      if (total <= 0 || input.items.some(i => !i.productId) || new Set(input.items.map(i => i.productId)).size !== input.items.length) throw new Error('Cần sản phẩm khác nhau và tổng tiền lớn hơn 0.');
      const serialized = JSON.stringify(input);
      const submissionScope = getRetentionSessionScope();
      if (request && serialized !== lastPayload) throw new Error('Lần gửi trước chưa xác định kết quả. Giữ nguyên thông tin và gửi lại để nhận đúng kết quả cũ; không tạo phiếu mới.');
      if (!confirm(`Nhận lại hàng và giảm công nợ ${formatCurrency(total)}? Nếu khách đã hết nợ, số dư sẽ thành tiền khách còn được cấn trừ.`)) return;
      if (!submissionScope || submissionScope !== getRetentionSessionScope()) throw new Error('Phiên đăng nhập đã thay đổi. Hãy kiểm tra lại trước khi gửi.');
      firstAttempt = !request;
      request ||= crypto.randomUUID(); requestScope ||= submissionScope; lastPayload = serialized;
      saving = true; pendingControls();
      await recordPending();
    } catch (error) {
      // A SQL error proves only THIS attempt rolled back. After an uncertain
      // earlier attempt, it cannot prove the original never committed.
      if (firstAttempt && /^[0-9A-Z]{5}$/.test(error.code || '')) { request = null; requestScope = ''; lastPayload = ''; }
      status(error.message || 'Chưa xác định kết quả. Giữ nguyên thông tin rồi gửi lại để kiểm tra, không tạo phiếu mới.', true);
    } finally { saving = false; pendingControls(); }
  });
  el('reconcile').onclick = async () => {
    if (!request || saving) return;
    saving = true; pendingControls();
    try { await recordPending(); }
    catch (error) {
      status(`${error.message || 'Chưa nhận được kết quả.'} Lần gửi trước vẫn chưa được đối soát; giữ nguyên mã gửi và kiểm tra lại, không lập phiếu thay thế.`, true);
    } finally { saving = false; pendingControls(); }
  };
  window.addEventListener('beforeunload', event => { if (request) { event.preventDefault(); event.returnValue = ''; } });
  initialized = true;
}
