import { state } from '../state.js';
import { formatCurrency, safeCreateIcons, formatDateTime, getUserDisplayName, getManagerDisplayName, getCustomerName, getProvinceNameByCode, showToast } from '../utils.js';
import { dbFetchPhase5Report, dbFetchEmployeeBusinessReport } from '../services/supabase.js?v=20260907-password-reset-v2';
import { buildCustomerDebtDisplayHistory, getCustomerDebtBusinessDate } from '../domain/customer-debt.js?v=20260907-password-reset-v2';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let employeeBusinessChart = null;
let employeeBusinessPage = 0;
let employeeBusinessRequestId = 0;
let employeeBusinessLastReport = null;
let employeeBusinessOverview = null;
let employeeBusinessDetail = null;
let employeeBusinessDetailRequestId = 0;
const EMPLOYEE_BUSINESS_CACHE_TTL_MS = 30_000;
const employeeBusinessReportCache = new Map();
const employeeBusinessReportInFlight = new Map();

function employeeBusinessCacheKey(input) {
  return JSON.stringify(Object.keys(input).sort().reduce((result, key) => ({ ...result, [key]: input[key] }), {}));
}

// The cache contains only the bounded, already-authorized RPC response.  It
// never derives financial figures in the browser and expires quickly so a user
// can always force an up-to-date Cloud read through the filter action.
async function fetchEmployeeBusinessReport(input, { force = false } = {}) {
  const key = employeeBusinessCacheKey(input);
  const cached = employeeBusinessReportCache.get(key);
  if (!force && cached && Date.now() - cached.cachedAt < EMPLOYEE_BUSINESS_CACHE_TTL_MS) return cached.payload;
  if (!force && employeeBusinessReportInFlight.has(key)) return employeeBusinessReportInFlight.get(key);
  const request = dbFetchEmployeeBusinessReport(input)
    .then(payload => {
      employeeBusinessReportCache.set(key, { payload, cachedAt: Date.now() });
      return payload;
    })
    .finally(() => employeeBusinessReportInFlight.delete(key));
  employeeBusinessReportInFlight.set(key, request);
  return request;
}

export function setupReportsPanel() {
  const tabBtns = document.querySelectorAll('.report-subtab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const subtab = e.currentTarget.getAttribute('data-subtab');
      switchReportSubtab(subtab);
    });
  });

  const debtSearch = document.getElementById('report-debt-search');
  if (debtSearch) {
    debtSearch.addEventListener('input', () => renderDebtReport());
  }

  const returnFilter = document.getElementById('report-return-filter');
  if (returnFilter) {
    returnFilter.addEventListener('change', () => renderReturnsReport());
  }

  const employeeBusinessApply = document.getElementById('employee-business-apply-filter');
  if (employeeBusinessApply) employeeBusinessApply.addEventListener('click', () => {
    employeeBusinessPage = 0;
    employeeBusinessOverview = null;
    renderEmployeeBusinessReport({ force: true });
  });
  document.getElementById('employee-business-export')?.addEventListener('click', exportEmployeeBusinessReport);
  document.getElementById('employee-business-prev')?.addEventListener('click', () => {
    if (employeeBusinessPage > 0) {
      employeeBusinessPage -= 1;
      renderEmployeeBusinessReport();
    }
  });
  document.getElementById('employee-business-next')?.addEventListener('click', () => {
    if (employeeBusinessLastReport && (employeeBusinessPage + 1) * 25 < Number(employeeBusinessLastReport.total || 0)) {
      employeeBusinessPage += 1;
      renderEmployeeBusinessReport();
    }
  });
  document.getElementById('employee-business-detail-close')?.addEventListener('click', closeEmployeeBusinessDetail);
  document.getElementById('employee-business-detail-prev')?.addEventListener('click', () => {
    if (employeeBusinessDetail?.page > 0) loadEmployeeBusinessDetail(employeeBusinessDetail.page - 1);
  });
  document.getElementById('employee-business-detail-next')?.addEventListener('click', () => {
    if (employeeBusinessDetail && (employeeBusinessDetail.page + 1) * employeeBusinessDetail.limit < employeeBusinessDetail.total) {
      loadEmployeeBusinessDetail(employeeBusinessDetail.page + 1);
    }
  });
}

export function switchReportSubtab(subtab) {
  document.querySelectorAll('.report-subtab-btn').forEach(btn => {
    if (btn.getAttribute('data-subtab') === subtab) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  document.querySelectorAll('.report-subtab-content').forEach(content => {
    if (content.id === `report-subtab-${subtab}`) content.style.display = 'block';
    else content.style.display = 'none';
  });

  renderActiveReportSubtab(subtab);
}

function renderActiveReportSubtab(subtab) {
  if (subtab === 'debt') renderDebtReport();
  else if (subtab === 'returns') renderReturnsReport();
  else if (subtab === 'employee') renderEmployeeBusinessReport();
  else if (subtab === 'kpi') renderKpiReport();
}

export async function renderDebtReport() {
  const tbody = document.getElementById('report-debt-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem">Đang tải công nợ từ máy chủ...</td></tr>';
  try {
    const report = await dbFetchPhase5Report({ type: 'debt', search: document.getElementById('report-debt-search')?.value || '', limit: 200, offset: 0 });
    document.getElementById('report-debt-total-stat').innerText = formatCurrency(report.summary?.total_debt);
    document.getElementById('report-debt-overdue-stat').innerText = formatCurrency(report.summary?.overdue_debt);
    tbody.innerHTML = report.rows?.length ? report.rows.map(row => `<tr><td style="font-weight:600">${escapeHtml(row.code)}</td><td style="font-weight:600">${escapeHtml(row.name)}</td><td>${escapeHtml(row.phone || '---')}</td><td>${escapeHtml(getManagerDisplayName(row.managed_by, 'Chưa bàn giao', state.users))}</td><td>${row.last_order_at ? formatDateTime(row.last_order_at) : 'Chưa có'}</td><td>${row.last_payment_at ? formatDateTime(row.last_payment_at) : 'Chưa có'}</td><td style="text-align:right;font-weight:700;color:${Number(row.debt) > 0 ? 'var(--color-danger)' : 'var(--color-success)'}">${formatCurrency(row.debt)}</td><td style="text-align:center"><span title="Số liệu từ ledger máy chủ">Đã đối soát</span></td></tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có dữ liệu công nợ</td></tr>';
    safeCreateIcons();
  } catch (error) {
    console.error('Debt report RPC error:', error);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--color-danger)">Không tải được báo cáo công nợ. Kiểm tra migration 0012.</td></tr>';
  }
}

function renderDebtReportLegacy() {
  const tbody = document.getElementById('report-debt-table-body');
  if (!tbody) return;

  const searchVal = (document.getElementById('report-debt-search')?.value || '').toLowerCase().trim();
  const customers = state.customers || [];

  let totalDebtAll = 0;
  let overdueDebtAll = 0;

  const now = new Date();

  const filtered = customers.filter(c => {
    const code = (c.code || '').toLowerCase();
    const name = (c.name || '').toLowerCase();
    const phone = (c.phone || '').toLowerCase();
    return !searchVal || code.includes(searchVal) || name.includes(searchVal) || phone.includes(searchVal);
  });

  filtered.forEach(c => {
    const debt = parseFloat(c.debt || 0);
    totalDebtAll += debt;

    // Check overdue debt (>30 days since last payment or order)
    if (debt > 0 && c.lastOrderAt) {
      const days = Math.floor((now - new Date(c.lastOrderAt)) / (1000 * 60 * 60 * 24));
      if (days > 30) overdueDebtAll += debt;
    }
  });

  const statTotalEl = document.getElementById('report-debt-total-stat');
  if (statTotalEl) statTotalEl.innerText = formatCurrency(totalDebtAll);

  const statOverdueEl = document.getElementById('report-debt-overdue-stat');
  if (statOverdueEl) statOverdueEl.innerText = formatCurrency(overdueDebtAll);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không tìm thấy dữ liệu công nợ</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const debt = parseFloat(c.debt || 0);
    const lastOrderStr = c.lastOrderAt ? formatDateTime(c.lastOrderAt) : 'Chưa có';
    const lastPayStr = c.lastPaymentAt ? formatDateTime(c.lastPaymentAt) : 'Chưa có';
    const managerName = getManagerDisplayName(c.managedBy, 'Chưa bàn giao', state.users);

    return `
      <tr>
        <td style="font-weight: 600;">${c.code}</td>
        <td style="font-weight: 600; color: var(--text-primary);">${c.name}</td>
        <td>${c.phone || '---'}</td>
        <td>${managerName}</td>
        <td>${lastOrderStr}</td>
        <td>${lastPayStr}</td>
        <td style="text-align: right; font-weight: 700; color: ${debt > 0 ? 'var(--color-danger)' : 'var(--color-success)'};">${formatCurrency(debt)}</td>
        <td style="text-align: center;">
          <button class="btn btn-secondary btn-xs" onclick="window.viewCustomerDebtHistory('${c.id}')" title="Xem biến động công nợ">
            <i data-lucide="history" style="width: 14px; height: 14px;"></i> Lịch sử
          </button>
        </td>
      </tr>
    `;
  }).join('');

  safeCreateIcons();
}

window.viewCustomerDebtHistory = function(customerId) {
  const cust = (state.customers || []).find(c => c.id === customerId);
  if (!cust) return;

  const modal = document.getElementById('debt-history-modal');
  const modalTitle = document.getElementById('debt-history-modal-title');
  const modalBody = document.getElementById('debt-history-modal-body');
  if (!modal) return;

  if (modalTitle) modalTitle.innerText = `Lịch sử biến động công nợ - ${cust.name} (${cust.code})`;

  const history = buildCustomerDebtDisplayHistory(cust.debtHistory || [], cust.debt)
    .reverse();
  if (history.length === 0) {
    modalBody.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted);">Khách hàng chưa phát sinh biến động công nợ</div>`;
  } else {
    modalBody.innerHTML = `
      <table class="table" style="width: 100%;">
        <thead>
          <tr>
            <th>Thời gian chứng từ</th>
            <th>Loại biến động</th>
            <th style="text-align: right;">Ghi nợ / Phát sinh</th>
            <th style="text-align: right;">Số dư sau phát sinh</th>
            <th>Ghi chú / Mã đơn</th>
          </tr>
        </thead>
        <tbody>
          ${history.map(item => {
            const isCharge = item.type === 'charge' || item.type === 'order';
            const isPay = item.type === 'payment';
            const typeLabel = isCharge ? 'Phát sinh đơn hàng' : isPay ? 'Thu tiền nợ' : item.type === 'return' ? 'Khấu trừ trả hàng' : 'Điều chỉnh thủ công';
            const colorClass = isCharge ? 'var(--color-danger)' : isPay ? 'var(--color-success)' : 'var(--color-primary)';

            return `
              <tr>
                <td>${formatDateTime(getCustomerDebtBusinessDate(item))}</td>
                <td><span style="font-weight: 600; color: ${colorClass};">${typeLabel}</span></td>
                <td style="text-align: right; font-weight: 600; color: ${colorClass};">${isPay || item.type === 'return' ? '-' : '+'}${formatCurrency(item.amount)}</td>
                <td style="text-align: right; font-weight: 700;">${formatCurrency(item.debtAfter)}</td>
                <td style="font-size: 0.85rem; color: var(--text-secondary);">${item.notes || item.note || item.id || ''}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  modal.classList.add('active');
};

export function closeDebtHistoryModal() {
  const modal = document.getElementById('debt-history-modal');
  if (modal) modal.classList.remove('active');
}
window.closeDebtHistoryModal = closeDebtHistoryModal;

export async function renderReturnsReport() {
  const tbody = document.getElementById('report-return-table-body');
  const thead = document.getElementById('report-return-table-head');
  if (!tbody || !thead) return;
  const mode = document.getElementById('report-return-filter')?.value || 'product';
  thead.innerHTML = mode === 'product'
    ? '<tr><th>Mã SKU</th><th>Tên sản phẩm</th><th style="text-align:right">Số lượng trả</th><th style="text-align:right">Giá trị trả</th></tr>'
    : mode === 'customer'
      ? '<tr><th>Mã khách</th><th>Tên khách hàng / Đại lý</th><th style="text-align:right">Số lượt trả</th><th style="text-align:right">Giá trị trả</th></tr>'
      : '<tr><th>Nhân viên bán hàng</th><th style="text-align:right">Số lượt trả</th><th style="text-align:right">Giá trị trừ doanh số</th></tr>';
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem">Đang tải trả hàng từ máy chủ...</td></tr>';
  try {
    const report = await dbFetchPhase5Report({ type: 'returns', mode, limit: 200, offset: 0 });
    tbody.innerHTML = report.rows?.length ? report.rows.map(row => mode === 'product'
      ? `<tr><td style="font-weight:600">${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td style="text-align:right">${Number(row.quantity || 0)}</td><td style="text-align:right;font-weight:700;color:var(--color-danger)">${formatCurrency(row.amount)}</td></tr>`
      : mode === 'customer'
        ? `<tr><td style="font-weight:600">${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td style="text-align:right">${Number(row.count || 0)}</td><td style="text-align:right;font-weight:700;color:var(--color-danger)">${formatCurrency(row.amount)}</td></tr>`
        : `<tr><td style="font-weight:600">${escapeHtml(getUserDisplayName(row.key, 'Chưa phân công', state.users))}</td><td style="text-align:right">${Number(row.count || 0)}</td><td style="text-align:right;font-weight:700;color:var(--color-danger)">${formatCurrency(row.amount)}</td></tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có dữ liệu trả hàng</td></tr>';
  } catch (error) {
    console.error('Returns report RPC error:', error);
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--color-danger)">Không tải được báo cáo trả hàng. Kiểm tra migration 0012.</td></tr>';
  }
}

function vietnamDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function firstDayOfVietnamMonth() {
  const date = vietnamDateParts();
  return `${date.slice(0, 7)}-01`;
}

function addVietnamDays(dateValue, days) {
  const [year, month, day] = String(dateValue || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function populateEmployeeBusinessFilters() {
  const employeeSelect = document.getElementById('employee-business-employee');
  const companySelect = document.getElementById('employee-business-company');
  const fromInput = document.getElementById('employee-business-from');
  const toInput = document.getElementById('employee-business-to');
  if (fromInput && !fromInput.value) fromInput.value = firstDayOfVietnamMonth();
  if (toInput && !toInput.value) toInput.value = vietnamDateParts();

  if (employeeSelect) {
    const selected = employeeSelect.value;
    const users = (state.users || []).filter(user => user.isActive !== false && user.is_active !== false);
    employeeSelect.innerHTML = '<option value="all">Tất cả nhân viên</option>' + users.map(user =>
      `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName || user.display_name || user.username)}</option>`
    ).join('');
    employeeSelect.value = [...employeeSelect.options].some(option => option.value === selected) ? selected : 'all';
    const isSale = state.currentUser?.role === 'sale';
    employeeSelect.disabled = isSale;
    if (isSale) employeeSelect.value = state.currentUser.id || 'all';
  }
  if (companySelect) {
    const selected = companySelect.value;
    companySelect.innerHTML = '<option value="all">Tất cả công ty</option>' + (state.companies || []).map(company =>
      `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name || company.id)}</option>`
    ).join('');
    companySelect.value = [...companySelect.options].some(option => option.value === selected) ? selected : 'all';
  }
}

function employeeBusinessFilters({ limit = 25, offset = employeeBusinessPage * 25, employeeId, detailLimit, detailOffset, includeSummary, includeSeries } = {}) {
  populateEmployeeBusinessFilters();
  const from = document.getElementById('employee-business-from')?.value;
  const to = document.getElementById('employee-business-to')?.value;
  if (!from || !to || to < from) throw new Error('Khoảng ngày báo cáo không hợp lệ.');
  const filters = {
    start: `${from}T00:00:00+07:00`,
    end: `${addVietnamDays(to, 1)}T00:00:00+07:00`,
    employee_id: employeeId || document.getElementById('employee-business-employee')?.value || 'all',
    company_id: document.getElementById('employee-business-company')?.value || 'all',
    limit,
    offset
  };
  if (detailLimit !== undefined) filters.detail_limit = detailLimit;
  if (detailOffset !== undefined) filters.detail_offset = detailOffset;
  if (includeSummary !== undefined) filters.include_summary = includeSummary;
  if (includeSeries !== undefined) filters.include_series = includeSeries;
  return filters;
}

function setEmployeeBusinessSummary(summary = {}) {
  const values = {
    'employee-business-order-count': Number(summary.order_count || 0).toLocaleString('vi-VN'),
    'employee-business-net-sales': formatCurrency(summary.net_sales),
    'employee-business-collected': formatCurrency(summary.collected),
    'employee-business-debt-balance': formatCurrency(summary.debt_balance),
    'employee-business-commission': formatCurrency(summary.commission_amount)
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
}

function renderEmployeeBusinessChart(series = []) {
  const canvas = document.getElementById('employee-business-chart');
  const empty = document.getElementById('employee-business-chart-empty');
  if (!canvas || !globalThis.Chart) return;
  if (employeeBusinessChart) {
    employeeBusinessChart.destroy();
    employeeBusinessChart = null;
  }
  if (!series.length) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  canvas.style.display = 'block';
  if (empty) empty.style.display = 'none';
  employeeBusinessChart = new globalThis.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: series.map(row => row.date),
      datasets: [
        { label: 'Doanh số ròng', data: series.map(row => Number(row.net_sales || 0)), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.14)', fill: true, tension: .3, borderWidth: 2 },
        { label: 'Tiền đã thu', data: series.map(row => Number(row.collected || 0)), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.08)', fill: false, tension: .3, borderWidth: 2 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#64748b' } } }, scales: { x: { ticks: { color: '#64748b', maxTicksLimit: 8 } }, y: { ticks: { color: '#64748b', callback: value => `${Number(value || 0).toLocaleString('vi-VN')} ₫` } } } }
  });
}

function renderEmployeeBusinessRows(report) {
  const tbody = document.getElementById('employee-business-table-body');
  if (!tbody) return;
  const rows = report.rows || [];
  tbody.innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td><strong>${escapeHtml(row.employee_name)}</strong><br><small>${escapeHtml(row.employee_code)}</small></td>
      <td style="text-align:right">${Number(row.order_count || 0).toLocaleString('vi-VN')}</td>
      <td style="text-align:right">${Number(row.sold_quantity || 0).toLocaleString('vi-VN')}</td>
      <td style="text-align:right">${formatCurrency(row.net_sales)}</td>
      <td style="text-align:right;color:var(--color-danger)">${formatCurrency(row.return_amount)}</td>
      <td style="text-align:right;color:var(--color-success)">${formatCurrency(row.collected)}</td>
      <td style="text-align:right">${formatCurrency(row.debt_balance)}</td>
      <td style="text-align:right">${formatCurrency(row.commission_amount)}</td>
      <td style="text-align:right">${row.kpi_target > 0 ? `${Number(row.kpi_completion_percent || 0).toLocaleString('vi-VN')}%` : 'Chưa giao'}</td>
      <td style="text-align:center"><button class="btn btn-secondary btn-sm employee-business-detail" type="button" data-employee-id="${escapeHtml(row.employee_id)}" data-employee-name="${escapeHtml(row.employee_name)}">Chi tiết</button></td>
    </tr>`).join('') : '<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có dữ liệu nghiệp vụ trong kỳ đã chọn.</td></tr>';
  document.querySelectorAll('.employee-business-detail').forEach(button => button.addEventListener('click', () =>
    openEmployeeBusinessDetail(button.dataset.employeeId, button.dataset.employeeName)
  ));
  const total = Number(report.total || 0);
  const from = total ? employeeBusinessPage * 25 + 1 : 0;
  const to = Math.min((employeeBusinessPage + 1) * 25, total);
  const pager = document.getElementById('employee-business-page-label');
  if (pager) pager.textContent = total ? `${from}–${to} / ${total} nhân viên` : '0 nhân viên';
  const previous = document.getElementById('employee-business-prev');
  const next = document.getElementById('employee-business-next');
  if (previous) previous.disabled = employeeBusinessPage === 0;
  if (next) next.disabled = to >= total;
}

export async function renderEmployeeBusinessReport({ force = false } = {}) {
  const tbody = document.getElementById('employee-business-table-body');
  if (!tbody) return;
  const requestId = ++employeeBusinessRequestId;
  try {
    const baseFilters = employeeBusinessFilters();
    const overviewKey = employeeBusinessCacheKey({
      start: baseFilters.start, end: baseFilters.end, employee_id: baseFilters.employee_id, company_id: baseFilters.company_id
    });
    const needsOverview = !employeeBusinessOverview
      || employeeBusinessOverview.key !== overviewKey
      || Date.now() - employeeBusinessOverview.cachedAt >= EMPLOYEE_BUSINESS_CACHE_TTL_MS;
    const filters = {
      ...baseFilters,
      include_summary: needsOverview,
      include_series: needsOverview
    };
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem">Đang đối soát số liệu từ máy chủ...</td></tr>';
    const response = await fetchEmployeeBusinessReport(filters, { force });
    if (requestId !== employeeBusinessRequestId) return;
    if (needsOverview) employeeBusinessOverview = { key: overviewKey, summary: response.summary, series: response.series, cachedAt: Date.now() };
    const report = needsOverview ? response : { ...response, summary: employeeBusinessOverview.summary, series: employeeBusinessOverview.series };
    employeeBusinessLastReport = report;
    setEmployeeBusinessSummary(report.summary);
    renderEmployeeBusinessChart(report.series);
    renderEmployeeBusinessRows(report);
    safeCreateIcons();
  } catch (error) {
    console.error('Employee business report RPC error:', error);
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--color-danger)">${escapeHtml(error.message || 'Không tải được báo cáo nghiệp vụ.')}</td></tr>`;
  }
}

async function openEmployeeBusinessDetail(employeeId, employeeName) {
  const modal = document.getElementById('employee-business-detail-modal');
  if (!modal) return;
  document.getElementById('employee-business-detail-title').textContent = `Chi tiết nghiệp vụ: ${employeeName}`;
  employeeBusinessDetail = { employeeId, employeeName, page: 0, limit: 50, total: 0 };
  modal.classList.add('active');
  await loadEmployeeBusinessDetail(0);
}

function updateEmployeeBusinessDetailPager() {
  const label = document.getElementById('employee-business-detail-page-label');
  const previous = document.getElementById('employee-business-detail-prev');
  const next = document.getElementById('employee-business-detail-next');
  const detail = employeeBusinessDetail;
  if (!detail) return;
  const from = detail.total ? detail.page * detail.limit + 1 : 0;
  const to = Math.min((detail.page + 1) * detail.limit, detail.total);
  if (label) label.textContent = detail.total ? `${from}–${to} / ${detail.total} chứng từ` : '0 chứng từ';
  if (previous) previous.disabled = detail.page === 0;
  if (next) next.disabled = to >= detail.total;
}

async function loadEmployeeBusinessDetail(page) {
  const tbody = document.getElementById('employee-business-detail-table-body');
  const detail = employeeBusinessDetail;
  if (!tbody || !detail) return;
  const requestId = ++employeeBusinessDetailRequestId;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem">Đang tải chi tiết từ máy chủ...</td></tr>';
  try {
    const report = await fetchEmployeeBusinessReport(employeeBusinessFilters({
      limit: 1, offset: 0, employeeId: detail.employeeId,
      detailLimit: detail.limit, detailOffset: page * detail.limit,
      includeSummary: false, includeSeries: false
    }));
    if (requestId !== employeeBusinessDetailRequestId || !employeeBusinessDetail || employeeBusinessDetail.employeeId !== detail.employeeId) return;
    employeeBusinessDetail.page = page;
    employeeBusinessDetail.total = Number(report.metadata?.detail_total || 0);
    const details = report.details || [];
    tbody.innerHTML = details.length ? details.map(detail => `<tr>
      <td>${detail.document_date ? formatDateTime(detail.document_date) : '—'}</td><td>${escapeHtml(detail.document_type)}</td>
      <td>${escapeHtml(detail.document_id)}</td><td>${escapeHtml(detail.description)}</td>
      <td style="text-align:right;${Number(detail.amount) < 0 ? 'color:var(--color-danger)' : ''}">${formatCurrency(detail.amount)}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có chứng từ chi tiết trong kỳ.</td></tr>';
    updateEmployeeBusinessDetailPager();
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--color-danger)">${escapeHtml(error.message || 'Không tải được chi tiết.')}</td></tr>`;
    employeeBusinessDetail.total = 0;
    updateEmployeeBusinessDetailPager();
  }
}

function closeEmployeeBusinessDetail() {
  employeeBusinessDetailRequestId += 1;
  employeeBusinessDetail = null;
  document.getElementById('employee-business-detail-modal')?.classList.remove('active');
}

async function exportEmployeeBusinessReport() {
  if (!globalThis.XLSX) return;
  try {
    const report = await fetchEmployeeBusinessReport(employeeBusinessFilters({
      limit: 100, offset: 0, includeSummary: false, includeSeries: false
    }), { force: true });
    const rows = (report.rows || []).map(row => ({
      'Nhân viên': row.employee_name, 'Mã tài khoản': row.employee_code, 'Số đơn': Number(row.order_count || 0),
      'Số lượng SP': Number(row.sold_quantity || 0), 'Doanh số gốc': Number(row.gross_sales || 0),
      'Chiết khấu': Number(row.discount_amount || 0), 'Doanh số ròng': Number(row.net_sales || 0),
      'Trả hàng': Number(row.return_amount || 0), 'Đã thu': Number(row.collected || 0),
      'Công nợ cuối kỳ': Number(row.debt_balance || 0), 'Hoa hồng': Number(row.commission_amount || 0),
      'KPI mục tiêu': Number(row.kpi_target || 0), 'Hoàn thành KPI (%)': row.kpi_completion_percent ?? ''
    }));
    const sheet = globalThis.XLSX.utils.json_to_sheet(rows);
    const workbook = globalThis.XLSX.utils.book_new();
    globalThis.XLSX.utils.book_append_sheet(workbook, sheet, 'Bao cao nhan vien');
    globalThis.XLSX.writeFile(workbook, `Bao_cao_nghiep_vu_${vietnamDateParts()}.xlsx`);
  } catch (error) {
    console.error('Employee business export error:', error);
    showToast(error.message || 'Không thể xuất báo cáo nghiệp vụ.', 'danger');
  }
}

function renderReturnsReportLegacy() {
  const mode = document.getElementById('report-return-filter')?.value || 'product';
  const tbody = document.getElementById('report-return-table-body');
  const thead = document.getElementById('report-return-table-head');
  if (!tbody || !thead) return;

  const validReturns = (state.salesReturns || []).filter(r => r.status !== 'cancelled');

  if (mode === 'product') {
    thead.innerHTML = `
      <tr>
        <th>Mã SP</th>
        <th>Tên sản phẩm</th>
        <th style="text-align: right;">Số lượng trả</th>
        <th style="text-align: right;">Tổng giá trị hoàn tiền</th>
      </tr>
    `;

    const productMap = {};
    validReturns.forEach(r => {
      (r.items || []).forEach(item => {
        const code = item.productId || 'Unknown';
        const name = item.productName || code;
        const qty = Number(item.quantity || 0);
        const refund = Number(item.subtotal || (item.refundPrice * qty) || 0);

        if (!productMap[code]) productMap[code] = { code, name, qty: 0, refund: 0 };
        productMap[code].qty += qty;
        productMap[code].refund += refund;
      });
    });

    const entries = Object.values(productMap);
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu trả hàng theo sản phẩm</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td style="font-weight: 600;">${e.code}</td>
        <td>${e.name}</td>
        <td style="text-align: right; font-weight: 600;">${e.qty}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-danger);">${formatCurrency(e.refund)}</td>
      </tr>
    `).join('');

  } else if (mode === 'customer') {
    thead.innerHTML = `
      <tr>
        <th>Mã KH</th>
        <th>Tên khách hàng</th>
        <th style="text-align: right;">Số lượt trả</th>
        <th style="text-align: right;">Tổng tiền trả hàng</th>
      </tr>
    `;

    const custMap = {};
    validReturns.forEach(r => {
      const cId = r.customerId || 'Khách lẻ';
      const cObj = (state.customers || []).find(c => c.id === cId);
      const name = cObj ? cObj.name : getCustomerName(cId, state.customers);
      const code = cObj ? cObj.code : cId;
      const refund = Number(r.totalRefund || r.totalReturnAmount || 0);

      if (!custMap[cId]) custMap[cId] = { code, name, count: 0, refund: 0 };
      custMap[cId].count += 1;
      custMap[cId].refund += refund;
    });

    const entries = Object.values(custMap);
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu trả hàng theo khách hàng</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td style="font-weight: 600;">${e.code}</td>
        <td style="font-weight: 600; color: var(--text-primary);">${e.name}</td>
        <td style="text-align: right; font-weight: 600;">${e.count}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-danger);">${formatCurrency(e.refund)}</td>
      </tr>
    `).join('');

  } else if (mode === 'employee') {
    thead.innerHTML = `
      <tr>
        <th>Nhân viên</th>
        <th style="text-align: right;">Số lượt trả</th>
        <th style="text-align: right;">Tổng tiền trừ doanh số</th>
      </tr>
    `;

    const empMap = {};
    validReturns.forEach(r => {
      const empId = r.createdBy || r.salespersonId || 'admin';
      const empName = getUserDisplayName(empId, state.users);
      const refund = Number(r.totalRefund || r.totalReturnAmount || 0);

      if (!empMap[empId]) empMap[empId] = { empName, count: 0, refund: 0 };
      empMap[empId].count += 1;
      empMap[empId].refund += refund;
    });

    const entries = Object.values(empMap);
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu trả hàng theo nhân viên</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td style="font-weight: 600; color: var(--text-primary);">${e.empName}</td>
        <td style="text-align: right; font-weight: 600;">${e.count}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-danger);">${formatCurrency(e.refund)}</td>
      </tr>
    `).join('');
  }
}

export async function renderKpiReport() {
  const tbody = document.getElementById('report-kpi-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem">Đang tính KPI trên máy chủ...</td></tr>';
  try {
    const report = await dbFetchPhase5Report({ type: 'kpi' });
    const summary = report.summary || {};
    document.getElementById('kpi-gross-sales-stat').innerText = formatCurrency(summary.gross_sales);
    document.getElementById('kpi-net-sales-stat').innerText = formatCurrency(summary.net_sales);
    document.getElementById('kpi-cash-collected-stat').innerText = formatCurrency(summary.collected);
    document.getElementById('kpi-new-debt-stat').innerText = formatCurrency(summary.debt_issued);
    document.getElementById('kpi-debt-collected-stat').innerText = formatCurrency(summary.debt_collected);
    tbody.innerHTML = report.kpi_by_employee?.length ? report.kpi_by_employee.map(row => `<tr><td style="font-weight:600">${escapeHtml(getUserDisplayName(row.key, 'Chưa phân công', state.users))}</td><td style="text-align:right">${formatCurrency(row.gross_sales)}</td><td style="text-align:right;color:var(--color-danger)">${formatCurrency(row.returns)}</td><td style="text-align:right;font-weight:700;color:var(--color-primary)">${formatCurrency(row.net_sales)}</td><td style="text-align:right;color:var(--color-success)">${formatCurrency(row.collected)}</td><td style="text-align:right">${formatCurrency(row.debt_issued)}</td></tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có dữ liệu KPI</td></tr>';
  } catch (error) {
    console.error('KPI report RPC error:', error);
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--color-danger)">Không tải được KPI. Kiểm tra migration 0012.</td></tr>';
  }
}

function renderKpiReportLegacy() {
  const tbody = document.getElementById('report-kpi-table-body');
  if (!tbody) return;

  const orders = state.savedOrders || [];
  const returns = (state.salesReturns || []).filter(r => r.status !== 'cancelled');
  const cashbook = state.cashbookTransactions || [];

  let totalGrossSales = 0;
  orders.forEach(o => { totalGrossSales += (o.totalPayable || o.totalAmount || 0); });

  let totalReturns = 0;
  returns.forEach(r => { totalReturns += (r.totalRefund || r.totalReturnAmount || 0); });

  const totalNetRevenue = Math.max(0, totalGrossSales - totalReturns);

  let totalCashCollected = 0;
  cashbook.forEach(tx => {
    if (tx.type === 'thu' && tx.status !== 'cancelled') {
      totalCashCollected += (tx.value || 0);
    }
  });

  let totalNewDebt = totalGrossSales;
  let totalCollectedDebt = totalCashCollected;

  document.getElementById('kpi-gross-sales-stat').innerText = formatCurrency(totalGrossSales);
  document.getElementById('kpi-net-sales-stat').innerText = formatCurrency(totalNetRevenue);
  document.getElementById('kpi-cash-collected-stat').innerText = formatCurrency(totalCashCollected);
  document.getElementById('kpi-new-debt-stat').innerText = formatCurrency(totalNewDebt);
  document.getElementById('kpi-debt-collected-stat').innerText = formatCurrency(totalCollectedDebt);

  // Group performance by Salesperson / Employee
  const empMap = {};
  orders.forEach(o => {
    const empId = o.salespersonId || o.createdBy || 'admin';
    if (!empMap[empId]) empMap[empId] = { empId, gross: 0, returns: 0, cash: 0, debtNew: 0 };
    const amt = o.totalPayable || 0;
    empMap[empId].gross += amt;
    empMap[empId].debtNew += amt;
  });

  returns.forEach(r => {
    const empId = r.salespersonId || r.createdBy || 'admin';
    if (!empMap[empId]) empMap[empId] = { empId, gross: 0, returns: 0, cash: 0, debtNew: 0 };
    empMap[empId].returns += (r.totalRefund || 0);
  });

  cashbook.forEach(tx => {
    if (tx.type === 'thu' && tx.status !== 'cancelled') {
      const empId = tx.created_by || tx.creator || 'admin';
      if (!empMap[empId]) empMap[empId] = { empId, gross: 0, returns: 0, cash: 0, debtNew: 0 };
      empMap[empId].cash += (tx.value || 0);
    }
  });

  const empList = Object.values(empMap);
  if (empList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu hiệu suất KPI nhân viên</td></tr>`;
    return;
  }

  tbody.innerHTML = empList.map(e => {
    const net = Math.max(0, e.gross - e.returns);
    const empName = getUserDisplayName(e.empId, state.users);

    return `
      <tr>
        <td style="font-weight: 600; color: var(--text-primary);">${empName}</td>
        <td style="text-align: right; font-weight: 600;">${formatCurrency(e.gross)}</td>
        <td style="text-align: right; font-weight: 600; color: var(--color-danger);">${formatCurrency(e.returns)}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-primary);">${formatCurrency(net)}</td>
        <td style="text-align: right; font-weight: 600; color: var(--color-success);">${formatCurrency(e.cash)}</td>
        <td style="text-align: right; font-weight: 600;">${formatCurrency(e.debtNew)}</td>
      </tr>
    `;
  }).join('');
}
