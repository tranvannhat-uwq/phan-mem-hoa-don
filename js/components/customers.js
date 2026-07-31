import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatPhoneNumber, isSameUser, getProvinceNameByCode, getManagerDisplayName, PROVINCES, makeSelectSearchable, getCompanyIdByBrand, normalizeCompanyId, formatDateOnly } from '../utils.js';
import { dbSaveCustomer, dbDeleteCustomer, dbSaveCustomersBulk, dbDeleteAllCustomers, dbFetchCustomers, dbRecordCustomerPayment, dbAdjustCustomerDebt, dbFetchCustomerOrderHistory, dbFetchCustomersOrderHistory } from '../services/supabase.js?v=20260731-customer-pricelist-fk';
import { renderAll } from '../main.js';
import { applyActivePriceListToInvoice, resetInvoiceCustomer } from './invoice.js?v=20260730-cashbook-reset';
import { addCashbookTransaction } from './so_quy.js?v=20260730-cashbook-reset';
import { getOrderFinancialBreakdown } from '../domain/order-financials.js';

const selectedCustomerIdsForExport = new Set();
let activeExportOrders = null;
let activeExportOrderIds = null;

const CUSTOMER_COLUMN_STORAGE_KEY = 'billing_customer_visible_columns';
const CUSTOMER_COLUMN_DEFINITIONS = [
  { key: 'code', label: 'Mã khách hàng', width: 100 },
  { key: 'name', label: 'Tên khách hàng', width: 165 },
  { key: 'phone', label: 'Số điện thoại', width: 105 },
  { key: 'address', label: 'Địa chỉ', width: 280 },
  { key: 'brand', label: 'Nhãn sơn', width: 90 },
  { key: 'manager', label: 'KD quản lý', width: 125 },
  { key: 'pricelist', label: 'Bảng giá', width: 125 },
  { key: 'debt', label: 'Công nợ', width: 115 },
  { key: 'grossSales', label: 'Tổng doanh số', width: 120 },
  { key: 'netSales', label: 'Doanh số sau trả hàng', width: 140 },
  { key: 'createdAt', label: 'Ngày tạo', width: 110 },
  { key: 'debtDays', label: 'Số ngày nợ', width: 95 },
  { key: 'lastTransaction', label: 'Ngày giao dịch cuối', width: 125 }
];

function getVisibleCustomerColumns() {
  const allKeys = CUSTOMER_COLUMN_DEFINITIONS.map(column => column.key);
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOMER_COLUMN_STORAGE_KEY) || 'null');
    if (Array.isArray(saved)) {
      return new Set(saved.filter(key => allKeys.includes(key)));
    }
  } catch (error) {
    console.warn('Không thể đọc cấu hình cột khách hàng:', error);
  }
  return new Set(allKeys);
}

function saveVisibleCustomerColumns(visibleColumns) {
  localStorage.setItem(
    CUSTOMER_COLUMN_STORAGE_KEY,
    JSON.stringify(CUSTOMER_COLUMN_DEFINITIONS.map(column => column.key).filter(key => visibleColumns.has(key)))
  );
}

function applyCustomerColumnVisibility() {
  const visibleColumns = getVisibleCustomerColumns();
  document.querySelectorAll('[data-customer-column]').forEach(element => {
    element.style.display = visibleColumns.has(element.dataset.customerColumn) ? '' : 'none';
  });

  const table = document.querySelector('.customers-table');
  if (table) {
    const dataWidth = CUSTOMER_COLUMN_DEFINITIONS.reduce(
      (sum, column) => sum + (visibleColumns.has(column.key) ? column.width : 0),
      0
    );
    table.style.minWidth = `${Math.max(420, dataWidth + 155)}px`;
  }

  document.querySelectorAll('.customer-column-option').forEach(input => {
    input.checked = visibleColumns.has(input.value);
  });

  const selectAll = document.getElementById('customer-column-picker-select-all');
  if (selectAll) {
    selectAll.checked = visibleColumns.size === CUSTOMER_COLUMN_DEFINITIONS.length;
    selectAll.indeterminate = visibleColumns.size > 0 && visibleColumns.size < CUSTOMER_COLUMN_DEFINITIONS.length;
  }

  const count = document.getElementById('customer-column-picker-count');
  if (count) count.textContent = `${visibleColumns.size}/${CUSTOMER_COLUMN_DEFINITIONS.length} cột`;
}

function setupCustomerColumnPicker() {
  const picker = document.getElementById('customer-column-picker');
  const button = document.getElementById('btn-customer-column-picker');
  const popover = document.getElementById('customer-column-picker-popover');
  const closeButton = document.getElementById('btn-close-customer-column-picker');
  const options = document.getElementById('customer-column-picker-options');
  const selectAll = document.getElementById('customer-column-picker-select-all');
  const resetButton = document.getElementById('btn-reset-customer-columns');
  if (!picker || !button || !popover || !options) return;

  options.innerHTML = CUSTOMER_COLUMN_DEFINITIONS.map(column => `
    <label class="customer-column-option-label">
      <input class="customer-column-option" type="checkbox" value="${column.key}">
      <span>${column.label}</span>
    </label>
  `).join('');

  const setOpen = (isOpen) => {
    popover.hidden = !isOpen;
    button.setAttribute('aria-expanded', String(isOpen));
  };

  button.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(popover.hidden);
  });
  closeButton?.addEventListener('click', () => setOpen(false));
  picker.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setOpen(false);
  });

  options.addEventListener('change', () => {
    const visibleColumns = new Set(
      Array.from(options.querySelectorAll('.customer-column-option:checked')).map(input => input.value)
    );
    saveVisibleCustomerColumns(visibleColumns);
    applyCustomerColumnVisibility();
  });

  selectAll?.addEventListener('change', () => {
    const visibleColumns = selectAll.checked
      ? new Set(CUSTOMER_COLUMN_DEFINITIONS.map(column => column.key))
      : new Set();
    saveVisibleCustomerColumns(visibleColumns);
    applyCustomerColumnVisibility();
  });

  resetButton?.addEventListener('click', () => {
    localStorage.removeItem(CUSTOMER_COLUMN_STORAGE_KEY);
    applyCustomerColumnVisibility();
  });

  applyCustomerColumnVisibility();
}

function parseImportedNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  let normalized = String(value)
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');
  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');
  if (hasComma && hasDot) {
    const decimalSeparator = normalized.lastIndexOf(',') > normalized.lastIndexOf('.') ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = normalized
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.');
  } else if (hasComma) {
    const commaParts = normalized.split(',');
    normalized = commaParts.length > 2 || commaParts.at(-1).length === 3
      ? commaParts.join('')
      : commaParts.join('.');
  } else if (hasDot) {
    const dotParts = normalized.split('.');
    normalized = dotParts.length > 2 || dotParts.at(-1).length === 3
      ? dotParts.join('')
      : normalized;
  }
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTimestamp(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function parseImportedDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  }

  if (typeof value === 'number' && Number.isFinite(value) && globalThis.XLSX?.SSF?.parse_date_code) {
    const parts = globalThis.XLSX.SSF.parse_date_code(value);
    if (parts) {
      return new Date(Date.UTC(
        parts.y,
        parts.m - 1,
        parts.d,
        parts.H || 0,
        parts.M || 0,
        Math.floor(parts.S || 0)
      )).toISOString();
    }
  }

  const text = String(value).trim();
  const dayFirstMatch = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dayFirstMatch) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = dayFirstMatch;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    if (
      parsed.getFullYear() === Number(year) &&
      parsed.getMonth() === Number(month) - 1 &&
      parsed.getDate() === Number(day)
    ) {
      return parsed.toISOString();
    }
    return '';
  }

  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function calculateCustomerTotals(customers) {
  return (customers || []).reduce((totals, customer) => {
    totals.count += 1;
    totals.debt += parseImportedNumber(customer.debt);
    totals.grossSales += parseImportedNumber(customer.totalTransaction ?? customer.total_transaction);
    totals.totalReturns += parseImportedNumber(customer.totalReturn ?? customer.total_return);
    totals.netSales += parseImportedNumber(customer.netRevenue ?? customer.net_revenue);
    return totals;
  }, { count: 0, debt: 0, grossSales: 0, totalReturns: 0, netSales: 0 });
}

function customerTotalsMatch(expected, actual) {
  return ['debt', 'grossSales', 'totalReturns', 'netSales']
    .every(key => Math.abs(expected[key] - actual[key]) < 1);
}

function makeImportCustomerCodesUnique(customers) {
  const normalizeCode = code => String(code || '').trim().toUpperCase().normalize('NFC');
  const reservedCodes = new Set(customers.map(customer => normalizeCode(customer.code)));
  const usedCodes = new Set();
  const occurrences = new Map();
  let adjustedCount = 0;

  customers.forEach(customer => {
    const baseCode = String(customer.code || '').trim();
    const normalizedBase = normalizeCode(baseCode);
    const occurrence = (occurrences.get(normalizedBase) || 0) + 1;
    occurrences.set(normalizedBase, occurrence);

    if (!usedCodes.has(normalizedBase)) {
      usedCodes.add(normalizedBase);
      return;
    }

    let suffix = occurrence;
    let candidate = `${baseCode}-DUP${suffix}`;
    while (reservedCodes.has(normalizeCode(candidate)) || usedCodes.has(normalizeCode(candidate))) {
      suffix += 1;
      candidate = `${baseCode}-DUP${suffix}`;
    }

    customer.code = candidate;
    usedCodes.add(normalizeCode(candidate));
    adjustedCount += 1;
  });

  return adjustedCount;
}

export function getCustomerMetrics(c) {
  if (!c) return { grossSales: 0, totalReturns: 0, netSales: 0, returnRate: '0', currentDebt: 0, totalPayments: 0 };
  const storedGrossSales = parseImportedNumber(c.totalTransaction ?? c.total_transaction ?? 0);
  const storedReturns = parseImportedNumber(c.totalReturn ?? c.total_return ?? 0);
  const storedNetSalesRaw = parseImportedNumber(c.netRevenue ?? c.net_revenue ?? 0);
  const storedNetSales = storedNetSalesRaw || Math.max(0, storedGrossSales - storedReturns);
  const baselineImportedAt = getTimestamp(
    c.salesBaselineImportedAt ||
    c.sales_baseline_imported_at ||
    c.brandDiscounts?.salesBaselineImportedAt ||
    c.brand_discounts?.salesBaselineImportedAt
  );
  if (baselineImportedAt || storedGrossSales || storedReturns || storedNetSalesRaw) {
    const grossSales = storedGrossSales;
    const totalReturns = storedReturns;
    const netSales = storedNetSales;
    const returnRate = grossSales > 0 ? ((totalReturns / grossSales) * 100).toFixed(1) : '0';
    const currentDebt = parseImportedNumber(c.debt || 0);
    const debtHistory = Array.isArray(c.debtHistory) ? c.debtHistory : [];
    const collectedPayments = debtHistory
      .filter(entry => entry.type === 'payment')
      .reduce((sum, entry) => sum + Math.abs(parseImportedNumber(entry.amount)), 0);
    const cancelledPayments = debtHistory
      .filter(entry =>
        entry.type === 'adjust' &&
        String(entry.notes || entry.note || '').toLowerCase().includes('hủy phiếu thu')
      )
      .reduce((sum, entry) => sum + Math.abs(parseImportedNumber(entry.amount)), 0);
    const totalPayments = Math.max(0, collectedPayments - cancelledPayments);
    return { grossSales, totalReturns, netSales, returnRate, currentDebt, totalPayments };
  }

  const customerOrders = state.savedOrders.filter(o => 
    (o.customerId === c.id || (o.customerName && o.customerName.toLowerCase() === c.name.toLowerCase())) &&
    (o.status === 'settled' || o.status === 'partially_returned' || o.status === 'returned')
  );
  const orderGrossSales = customerOrders.reduce((sum, o) => sum + parseImportedNumber(o.totalPayable), 0);
  
  const customerReturns = (state.salesReturns || []).filter(r => 
    (r.customerId === c.id || (r.customerName && r.customerName.toLowerCase() === c.name.toLowerCase())) &&
    r.status !== 'cancelled'
  );
  const liveReturns = customerReturns.reduce((sum, r) => sum + parseImportedNumber(r.totalRefund), 0);
  
  const grossSales = orderGrossSales;
  const totalReturns = liveReturns;
  const netSales = Math.max(0, grossSales - totalReturns);
  const returnRate = grossSales > 0 ? ((totalReturns / grossSales) * 100).toFixed(1) : '0';
  const currentDebt = parseFloat(c.debt || 0);
  const debtHistory = Array.isArray(c.debtHistory) ? c.debtHistory : [];
  const collectedPayments = debtHistory
    .filter(entry => entry.type === 'payment')
    .reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount) || 0), 0);
  const cancelledPayments = debtHistory
    .filter(entry =>
      entry.type === 'adjust' &&
      String(entry.notes || entry.note || '').toLowerCase().includes('hủy phiếu thu')
    )
    .reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount) || 0), 0);
  const totalPayments = Math.max(0, collectedPayments - cancelledPayments);
  
  return { grossSales, totalReturns, netSales, returnRate, currentDebt, totalPayments };
}

function getCustomerLastTransactionDate(c) {
  if (!c) return '';
  const timestamps = [];
  const addDate = (value) => {
    if (!value) return;
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) timestamps.push(time);
  };

  addDate(c.lastOrderAt || c.last_order_at);
  addDate(c.lastPaymentAt || c.last_payment_at);

  (state.savedOrders || []).forEach(o => {
    const belongsToCustomer = o.customerId === c.id || (o.customerName && c.name && o.customerName.toLowerCase() === c.name.toLowerCase());
    if (!belongsToCustomer) return;
    addDate(o.createdAt || o.date || o.orderDate || o.updatedAt);
  });

  (state.salesReturns || []).forEach(r => {
    const belongsToCustomer = r.customerId === c.id || (r.customerName && c.name && r.customerName.toLowerCase() === c.name.toLowerCase());
    if (!belongsToCustomer || r.status === 'cancelled') return;
    addDate(r.createdAt || r.returnDate || r.date || r.updatedAt);
  });

  const debtHistory = Array.isArray(c.debtHistory) ? c.debtHistory : [];
  debtHistory
    .filter(entry => entry.type !== 'adjust' || !String(entry.notes || entry.note || '').toLowerCase().includes('kiotviet'))
    .forEach(entry => addDate(entry.date || entry.createdAt || entry.transactionDate));

  if (timestamps.length === 0) return '';
  return new Date(Math.max(...timestamps)).toISOString();
}

function getFilteredCustomersForCurrentView() {
  const searchInput = document.getElementById('customer-search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const filterSelect = document.getElementById('customer-managed-filter');
  const filterEmployee = filterSelect ? filterSelect.value : '';

  return (state.customers || []).filter(c => {
    if (!c) return false;
    const cCode = (c.code || c.id || '').toLowerCase();
    const cName = (c.name || '').toLowerCase();
    const cPhone = (c.phone || c.phone2 || '');
    if (searchVal && !cCode.includes(searchVal) && !cName.includes(searchVal) && !cPhone.includes(searchVal)) {
      return false;
    }
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (!isSameUser(c.managedBy, state.currentUser.username)) return false;
    } else if (filterEmployee) {
      if (filterEmployee === 'unassigned') {
        if (c.managedBy && c.managedBy !== '') return false;
      } else if (filterEmployee === 'unassigned_pricelist') {
        if (c.pricelistId && c.pricelistId !== '') return false;
      } else if (!isSameUser(c.managedBy, filterEmployee)) {
        return false;
      }
    }
    return true;
  });
}

export function renderCustomersTable() {

  const tableBody = document.getElementById('customers-table-body');
  if (!tableBody) return;
  const filtered = getFilteredCustomersForCurrentView();
  
  // Tính toán tổng nợ và doanh thu đại lý lọc được
  const totalDebt = filtered.reduce((sum, c) => sum + (parseFloat(c.debt) || 0), 0);
  let totalNetSales = 0;
  const totalSales = filtered.reduce((sum, c) => {
    const metrics = getCustomerMetrics(c);
    totalNetSales += metrics.netSales;
    return sum + metrics.grossSales;
  }, 0);
  
  const debtEl = document.getElementById('cust-summary-total-debt');
  const salesEl = document.getElementById('cust-summary-total-sales');
  const netSalesEl = document.getElementById('cust-summary-net-sales');
  if (debtEl) debtEl.innerText = formatCurrency(totalDebt);
  if (salesEl) salesEl.innerText = formatCurrency(totalSales);
  if (netSalesEl) netSalesEl.innerText = formatCurrency(totalNetSales);
  
  // Sắp xếp theo bảng chữ cái tên đại lý
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  
  const ITEMS_PER_PAGE = 20;
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  
  if (state.customersPage > totalPages) state.customersPage = totalPages;
  if (state.customersPage < 1) state.customersPage = 1;
  
  const startIndex = (state.customersPage - 1) * ITEMS_PER_PAGE;
  const paginatedCustomers = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  
  // Vẽ các nút phân trang
  const paginationContainer = document.getElementById('customers-pagination');
  if (paginationContainer) {
    paginationContainer.innerHTML = `
      <div class="pagination-controls" style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border-color); width: 100%;">
        <button class="btn btn-secondary btn-sm" id="customers-prev-page" ${state.customersPage === 1 ? 'disabled' : ''}>
          <i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i> Trước
        </button>
        <span style="font-size: 0.9rem; color: var(--text-secondary); font-weight: 500;">
          Trang <strong>${state.customersPage}</strong> / ${totalPages} (${totalItems} đại lý)
        </span>
        <button class="btn btn-secondary btn-sm" id="customers-next-page" ${state.customersPage === totalPages ? 'disabled' : ''}>
          Sau <i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>
        </button>
      </div>
    `;

    const prevPageBtn = document.getElementById('customers-prev-page');
    if (prevPageBtn) {
      prevPageBtn.addEventListener('click', () => {
        state.customersPage--;
        renderCustomersTable();
        document.getElementById('customers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }

    const nextPageBtn = document.getElementById('customers-next-page');
    if (nextPageBtn) {
      nextPageBtn.addEventListener('click', () => {
        state.customersPage++;
        renderCustomersTable();
        document.getElementById('customers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }
  }

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="${getVisibleCustomerColumns().size + 2}" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy khách hàng nào.
        </td>
      </tr>
    `;
    applyCustomerColumnVisibility();
    return;
  }
  
  tableBody.innerHTML = paginatedCustomers.map((c) => {
    const actualIndex = state.customers.findIndex(cust => cust.id === c.id);
    
    let pricelistName = '';
    let tooltipTitle = '';
    const plId = c.pricelistId || '';
    if (plId === '') {
      pricelistName = '<span style="color: #ef4444; font-weight: 500;">Chưa xác định</span>';
      tooltipTitle = 'Chưa áp dụng bảng giá';
    } else if (plId === 'custom') {
      const discSummary = [];
      if (c.brandDiscounts) {
        for (const [brand, pct] of Object.entries(c.brandDiscounts)) {
          if (!['province', 'salesBaselineImportedAt', 'debtDays'].includes(brand) && pct > 0) {
            discSummary.push(`${brand}: ${pct}%`);
          }
        }
      }
      pricelistName = discSummary.length > 0 
        ? `CK riêng (${discSummary.join(', ')})` 
        : 'Chiết khấu riêng';
      tooltipTitle = discSummary.length > 0 ? discSummary.join('\n') : 'Chiết khấu riêng (Chưa cấu hình)';
    } else if (plId === 'retail') {
      pricelistName = 'Khách lẻ (Nhập tay)';
      tooltipTitle = 'Khách lẻ (Tự nhập chiết khấu khi tạo đơn)';
    } else {
      const pl = state.pricelists.find(p => p.id === plId);
      if (pl) {
        pricelistName = pl.name;
        const plDiscs = [];
        if (pl.brandDiscounts) {
          for (const [brand, pct] of Object.entries(pl.brandDiscounts)) {
            if (pct > 0) {
              plDiscs.push(`${brand}: ${pct}%`);
            }
          }
        }
        tooltipTitle = `${pl.name}:\n${plDiscs.length > 0 ? plDiscs.join('\n') : 'Không chiết khấu hãng'}`;
      } else {
        pricelistName = plId;
        tooltipTitle = plId;
      }
    }
    

    
    const provinceName = getProvinceNameByCode(c.brandDiscounts && c.brandDiscounts.province);
    const displayAddr = provinceName ? `[${provinceName}] ${c.address || ''}` : (c.address || '<span style="color: var(--text-muted);">N/A</span>');
    const addrTitle = provinceName ? `[${provinceName}] ${c.address || ''}` : (c.address || '');
    
    const metrics = getCustomerMetrics(c);
    const lastTransactionDate = getCustomerLastTransactionDate(c);
    const lastTransactionLabel = lastTransactionDate ? formatDateOnly(lastTransactionDate) : '<span style="color: var(--text-muted);">Chưa có</span>';
    const createdAt = c.createdAt || c.created_at;
    const createdAtLabel = createdAt ? formatDateOnly(createdAt) : '<span style="color: var(--text-muted);">Chưa có</span>';
    const debtDays = Math.max(0, Math.trunc(parseImportedNumber(c.debtDays ?? c.brandDiscounts?.debtDays ?? 0)));
    
    return `
      <tr>
        <td style="text-align: center;">
          <input type="checkbox" class="customer-export-checkbox" data-id="${c.id}" ${selectedCustomerIdsForExport.has(String(c.id)) ? 'checked' : ''} title="Chọn khách hàng để xuất lịch sử">
        </td>
        <td data-customer-column="code" style="font-weight: 600; color: #fff;">${c.code}</td>
        <td data-customer-column="name" style="font-weight: 500;">
          <span class="view-cust-detail-link" data-index="${actualIndex}" style="cursor: pointer; color: #22c55e; text-decoration: underline; font-weight: 600;" title="Xem chi tiết & Lịch sử công nợ">
            ${c.name}
          </span>
        </td>
        <td data-customer-column="phone">${c.phone || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td data-customer-column="address" style="font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${addrTitle}">${displayAddr}</td>
        <td data-customer-column="brand">
          <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(34, 197, 94, 0.15)'}; color: ${c.assignedBrand === 'Tất cả' ? '#10b981' : '#22c55e'}; border: 1px solid ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(34, 197, 94, 0.3)'};">${c.assignedBrand}</span>
        </td>
        <td data-customer-column="manager" style="font-size: 0.85rem; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${c.managedBy ? getManagerDisplayName(c.managedBy, state.users) : '<span style="color: #ef4444; font-weight: 500;">Chưa bàn giao</span>'}
        </td>
        <td data-customer-column="pricelist" style="font-size: 0.75rem; color: var(--text-secondary); max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${tooltipTitle}">${pricelistName}</td>
        <td data-customer-column="debt" class="customer-money-cell" style="color: ${c.debt > 0 ? 'var(--color-danger)' : (c.debt < 0 ? 'var(--color-success)' : 'var(--text-muted)')};">${formatCurrency(c.debt)}</td>
        <td data-customer-column="grossSales" class="customer-money-cell" style="color: var(--color-primary);">${formatCurrency(metrics.grossSales)}</td>
        <td data-customer-column="netSales" class="customer-money-cell" style="color: #10b981;">${formatCurrency(metrics.netSales)}</td>
        <td data-customer-column="createdAt" style="text-align: center; font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap;">${createdAtLabel}</td>
        <td data-customer-column="debtDays" style="text-align: center; font-size: 0.8rem; color: ${debtDays > 0 ? 'var(--color-warning)' : 'var(--text-muted)'}; white-space: nowrap;">${debtDays}</td>
        <td data-customer-column="lastTransaction" style="text-align: center; font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap;">${lastTransactionLabel}</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-cust-btn" data-index="${actualIndex}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-primary btn-sm btn-circle pay-debt-btn" data-index="${actualIndex}" title="Thu nợ" style="background-color: var(--color-primary); color: #fff;">
              <i data-lucide="banknote" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-cust-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  applyCustomerColumnVisibility();
  
  // Gán sự kiện click cho các nút hành động
  document.querySelectorAll('.customer-export-checkbox').forEach(box => {
    box.addEventListener('change', () => {
      const id = String(box.getAttribute('data-id'));
      if (box.checked) selectedCustomerIdsForExport.add(id);
      else selectedCustomerIdsForExport.delete(id);
      const selectAll = document.getElementById('customer-select-all-export');
      if (selectAll) {
        const visibleIds = paginatedCustomers.map(c => String(c.id));
        selectAll.checked = visibleIds.length > 0 && visibleIds.every(id => selectedCustomerIdsForExport.has(id));
      }
    });
  });

  const selectAllExport = document.getElementById('customer-select-all-export');
  if (selectAllExport) {
    const visibleIds = paginatedCustomers.map(c => String(c.id));
    selectAllExport.checked = visibleIds.length > 0 && visibleIds.every(id => selectedCustomerIdsForExport.has(id));
    selectAllExport.onchange = () => {
      visibleIds.forEach(id => {
        if (selectAllExport.checked) selectedCustomerIdsForExport.add(id);
        else selectedCustomerIdsForExport.delete(id);
      });
      renderCustomersTable();
    };
  }

  document.querySelectorAll('.view-cust-detail-link').forEach(link => {
    link.addEventListener('click', () => {
      const idx = parseInt(link.getAttribute('data-index'));
      openCustomerDetailModal(idx);
    });
  });

  document.querySelectorAll('.edit-cust-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openCustomerModal(idx);
    });
  });
  
  document.querySelectorAll('.pay-debt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openPayDebtModal(idx);
    });
  });
  
  document.querySelectorAll('.delete-cust-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      deleteCustomer(idx);
    });
  });
  
  safeCreateIcons();
}

export function generateRandomCustomerCode(provinceCode) {
  const randNum = Math.floor(1000 + Math.random() * 9000); // 4 digits
  const pCode = provinceCode || 'DL';
  return `KH-${pCode}-${randNum}`;
}

export function generateUniqueCustomerCode(provinceCode) {
  let code = '';
  let exists = true;
  let attempts = 0;
  
  while (exists && attempts < 100) {
    code = generateRandomCustomerCode(provinceCode);
    exists = state.customers.some(c => c.code === code);
    attempts++;
  }
  return code;
}

export function openCustomerModal(index = -1) {
  const modal = document.getElementById('customer-modal');
  const title = document.getElementById('customer-modal-title');
  const form = document.getElementById('customer-form');
  
  if (!modal) return;

  // Dynamic rendering of brand discount inputs in customer modal
  const container = document.getElementById('customer-brand-discounts-container');
  if (container) {
    const brands = state.brands && state.brands.length > 0
      ? state.brands
      : [
          { name: 'Nano10*' },
          { name: 'Hatacco nano' },
          { name: 'mutsutec' },
          { name: 'tdkaw' },
          { name: 'cova' },
          { name: 'festivanano' }
        ];
        
    container.innerHTML = brands.map(b => `
      <div class="form-group" style="margin-bottom: 0;">
        <label class="form-label">Chiết khấu ${b.name} (%)</label>
        <input type="number" class="form-control cust-brand-disc" data-brand="${b.name}" value="0" min="0" max="100" step="any">
      </div>
    `).join('');
  }

  // Dynamic population of cust-assigned-brand
  const assignedBrandSelect = document.getElementById('cust-assigned-brand');
  if (assignedBrandSelect) {
    const brands = state.brands && state.brands.length > 0
      ? state.brands.map(b => b.name)
      : ['Nano10*', 'Hatacco nano', 'mutsutec', 'tdkaw', 'cova', 'festivanano'];
      
    assignedBrandSelect.innerHTML = `
      <option value="Tất cả">Chọn nhãn sơn</option>
      ${brands.map(b => `<option value="${b}">${b}</option>`).join('')}
    `;
  }

  modal.classList.add('active');
  form.reset();
  
  // Giới hạn quyền sửa công nợ: Chỉ Admin mới được phép sửa công nợ trực tiếp
  const debtInput = document.getElementById('cust-debt');
  if (debtInput) {
    if (state.currentUser && state.currentUser.role === 'admin') {
      debtInput.removeAttribute('disabled');
      debtInput.style.opacity = '1';
      debtInput.style.cursor = 'auto';
    } else {
      debtInput.setAttribute('disabled', 'true');
      debtInput.style.opacity = '0.6';
      debtInput.style.cursor = 'not-allowed';
    }
  }
  
  const isSale = state.currentUser && state.currentUser.role === 'sale';
  const plSelect = document.getElementById('cust-pricelist');
  if (plSelect) {
    plSelect.innerHTML = `
      <option value="custom" ${isSale ? 'disabled' : ''}>Chiết khấu riêng (Tự thiết lập bên dưới)</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
    `;
  }
  
  document.querySelectorAll('.cust-brand-disc').forEach(input => {
    input.value = 0;
    if (isSale) {
      input.setAttribute('disabled', 'true');
    } else {
      input.removeAttribute('disabled');
    }
  });
  
  const provinceSelect = document.getElementById('cust-province');
  if (provinceSelect) {
    provinceSelect.value = '';
  }

  if (index === -1) {
    title.innerText = 'Thêm khách hàng mới';
    document.getElementById('customer-edit-index').value = '-1';
    document.getElementById('customer-edit-id').value = '';
    

    document.getElementById('cust-code').value = generateUniqueCustomerCode('');
    
    if (plSelect) {
      if (isSale && state.pricelists.length > 0) {
        plSelect.value = state.pricelists[0].id;
      } else {
        plSelect.value = 'custom';
      }
    }
    const discSection = document.getElementById('cust-brand-discounts-section');
    if (discSection) {
      discSection.style.display = (plSelect && plSelect.value === 'custom') ? 'block' : 'none';
    }
    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      mBySelect.value = state.currentUser ? state.currentUser.username : 'nhat';
    }
    
    document.getElementById('cust-assigned-brand').value = 'Tất cả';
    makeSelectSearchable('cust-assigned-brand', 'Chọn nhãn sơn', false);
  } else {
    title.innerText = 'Chỉnh sửa khách hàng';
    const customer = state.customers[index];
    document.getElementById('customer-edit-index').value = index;
    document.getElementById('customer-edit-id').value = customer.id;
    
    document.getElementById('cust-code').value = customer.code;
    document.getElementById('cust-name').value = customer.name;
    document.getElementById('cust-phone').value = customer.phone || '';
    document.getElementById('cust-address').value = customer.address || '';
    document.getElementById('cust-assigned-brand').value = customer.assignedBrand || 'Tất cả';
    makeSelectSearchable('cust-assigned-brand', 'Chọn nhãn sơn', false);
    document.getElementById('cust-debt').value = customer.debt || 0;
    document.getElementById('cust-notes').value = customer.notes || '';
    
    const cPlId = customer.pricelistId || 'custom';
    if (plSelect) plSelect.value = cPlId;
    
    const discSection = document.getElementById('cust-brand-discounts-section');
    if (discSection) {
      discSection.style.display = cPlId === 'custom' ? 'block' : 'none';
    }
    
    document.querySelectorAll('.cust-brand-disc').forEach(input => {
      const brand = input.getAttribute('data-brand');
      input.value = (customer.brandDiscounts && customer.brandDiscounts[brand] !== undefined) ? customer.brandDiscounts[brand] : 0;
    });

    if (provinceSelect) {
      provinceSelect.value = (customer.brandDiscounts && customer.brandDiscounts.province) ? customer.brandDiscounts.province : '';
    }

    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      const mByVal = customer.managedBy || 'nhat';
      const matchingUser = state.users.find(u => isSameUser(u.username, mByVal));
      mBySelect.value = matchingUser ? matchingUser.username : mByVal;
    }
  }
}

export function closeCustomerModal() {
  const modal = document.getElementById('customer-modal');
  if (modal) modal.classList.remove('active');
}

export async function saveCustomer() {
  const index = parseInt(document.getElementById('customer-edit-index').value);
  const editId = document.getElementById('customer-edit-id').value;
  
  const code = document.getElementById('cust-code').value.trim().toUpperCase();
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const address = document.getElementById('cust-address').value.trim();
  const assignedBrand = document.getElementById('cust-assigned-brand').value;
  
  // Bảo mật: Nếu không phải Admin thì không được phép thay đổi công nợ trong form
  let debt = parseFloat(document.getElementById('cust-debt').value) || 0;
  if (state.currentUser && state.currentUser.role !== 'admin') {
    if (index === -1) {
      debt = 0;
    } else {
      debt = state.customers[index].debt || 0;
    }
  }
  
  const notes = document.getElementById('cust-notes').value.trim();
  const pricelistId = document.getElementById('cust-pricelist').value;
  
  if (!assignedBrand) {
    showToast('Vui lòng chọn nhãn đại lý độc quyền!', 'warning');
    return;
  }
  if (!pricelistId) {
    showToast('Vui lòng chọn bảng giá mặc định áp dụng!', 'warning');
    return;
  }
  
  let managedBy = 'nhat';
  if (state.currentUser) {
    if (state.currentUser.role === 'sale') {
      if (index === -1) {
        managedBy = state.currentUser.username;
      } else {
        managedBy = state.customers[index].managedBy || state.currentUser.username;
      }
    } else {
      managedBy = document.getElementById('cust-managed-by').value;
    }
  }
  // Lưu trữ đầy đủ email/username để đảm bảo tính đồng nhất
  
  const duplicateCode = state.customers.some((c, idx) => c.code === code && idx !== index);
  if (duplicateCode) {
    showToast('Mã khách hàng đã tồn tại trên hệ thống!', 'danger');
    return;
  }
  
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone) {
    const duplicatePhone = state.customers.some((c, idx) => {
      if (idx === index) return false;
      const cPhone = (c.phone || '').replace(/\D/g, '');
      return cPhone === cleanPhone;
    });
    if (duplicatePhone) {
      showToast('Số điện thoại đã được đăng ký cho khách hàng khác!', 'danger');
      return;
    }
  }
  
  const brandDiscounts = {};
  document.querySelectorAll('.cust-brand-disc').forEach(input => {
    const brand = input.getAttribute('data-brand');
    brandDiscounts[brand] = parseFloat(input.value) || 0;
  });
  
  const provinceSelect = document.getElementById('cust-province');
  if (provinceSelect) {
    brandDiscounts.province = provinceSelect.value;
  }
  if (index !== -1 && state.customers[index].brandDiscounts?.salesBaselineImportedAt) {
    brandDiscounts.salesBaselineImportedAt = state.customers[index].brandDiscounts.salesBaselineImportedAt;
  }
  if (index !== -1 && state.customers[index].brandDiscounts?.debtDays !== undefined) {
    brandDiscounts.debtDays = state.customers[index].brandDiscounts.debtDays;
  }
  
  const customerId = index === -1 ? `cust-${Date.now()}` : editId;
  
  // Ghi nhận biến động công nợ nếu Admin/Kế toán trực tiếp điều chỉnh công nợ khách hàng
  const oldCust = index === -1 ? null : state.customers[index];
  const oldDebt = oldCust ? oldCust.debt || 0 : 0;
  const debtHistory = oldCust ? [...(oldCust.debtHistory || [])] : [];
  
  if (debt !== oldDebt) {
    debtHistory.push({
      id: `adjust-${Date.now()}`,
      date: new Date().toISOString(),
      type: 'adjust',
      amount: debt - oldDebt,
      notes: index === -1 ? 'Khởi tạo công nợ ban đầu' : 'Điều chỉnh số dư công nợ thủ công',
      debtAfter: debt
    });
    const currentUserDisp = state.currentUser ? (state.currentUser.displayName || state.currentUser.username) : 'Administrator';
    await dbAdjustCustomerDebt(customerId, debt, index === -1 ? 'Khởi tạo công nợ ban đầu' : 'Điều chỉnh số dư công nợ thủ công', currentUserDisp);
  }

  const matchedCustBrand = (state.brands || []).find(b => b.name.toLowerCase() === (assignedBrand || '').toLowerCase() || b.id === assignedBrand);
  const assignedBrandId = matchedCustBrand ? matchedCustBrand.id : (assignedBrand === 'Tất cả' ? 'Tất cả' : ('brand_' + String(assignedBrand).toLowerCase().replace(/[^a-z0-9]/g, '')));

  const customerData = {
    id: customerId,
    code,
    name,
    phone,
    address,
    assignedBrand,
    assignedBrandId,
    brandDiscounts,
    debt,
    totalTransaction: index === -1 ? 0 : state.customers[index].totalTransaction || 0,
    totalReturn: index === -1 ? 0 : state.customers[index].totalReturn || 0,
    netRevenue: index === -1 ? 0 : state.customers[index].netRevenue || 0,
    debtDays: index === -1 ? 0 : state.customers[index].debtDays ?? state.customers[index].brandDiscounts?.debtDays ?? 0,
    lastOrderAt: index === -1 ? null : state.customers[index].lastOrderAt || state.customers[index].last_order_at || null,
    lastPaymentAt: index === -1 ? null : state.customers[index].lastPaymentAt || state.customers[index].last_payment_at || null,
    createdAt: index === -1 ? new Date().toISOString() : state.customers[index].createdAt || state.customers[index].created_at || new Date().toISOString(),
    salesBaselineImportedAt: index === -1 ? '' : state.customers[index].salesBaselineImportedAt || '',
    notes,
    pricelistId,
    managedBy,
    debtHistory
  };
  
  const saved = await dbSaveCustomer(customerData);
  if (saved) {
    if (index === -1) showToast('Thêm khách hàng thành công!');
    else showToast('Cập nhật khách hàng thành công!');
    
    // Nếu cập nhật đúng khách hàng đang chọn lên đơn, cập nhật lại giao diện lên đơn
    if (state.activeCustomerId === customerId) {
      state.activeCustomerBrand = assignedBrand;
      document.getElementById('selected-customer-name-lbl').innerText = name;
      document.getElementById('selected-customer-phone-lbl').innerText = phone || 'N/A';
      document.getElementById('selected-customer-address-lbl').innerText = address || 'N/A';
      document.getElementById('selected-customer-brand-lbl').innerText = assignedBrand;
      
      const pl = state.pricelists.find(p => p.id === pricelistId);
      const plName = pl ? pl.name : (pricelistId === 'custom' ? 'Chiết khấu riêng' : (pricelistId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
      const plLbl = document.getElementById('selected-customer-pricelist-lbl');
      if (plLbl) plLbl.innerText = plName;
      
      document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(debt);
      

      
      const invoicePlSelect = document.getElementById('invoice-pricelist-select');
      if (invoicePlSelect) invoicePlSelect.value = pricelistId;
      
      applyActivePriceListToInvoice();
    }
    
    // Cập nhật State local
    const idx = state.customers.findIndex(c => c.id === customerId);
    if (idx !== -1) state.customers[idx] = customerData;
    else state.customers.push(customerData);
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
    
    closeCustomerModal();
    renderAll();
  }
}

export async function deleteCustomer(index) {
  const cust = state.customers[index];
  if (confirm(`Bạn có chắc chắn muốn xóa khách hàng "${cust.name}" (${cust.code})?`)) {
    const deleted = await dbDeleteCustomer(cust.id);
    if (deleted) {
      if (state.activeCustomerId === cust.id) {
        resetInvoiceCustomer();
      }
      state.customers = state.customers.filter(c => c.id !== cust.id);
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      renderAll();
      showToast('Xóa khách hàng thành công!', 'warning');
    }
  }
}

// --- Logic Thu Nợ khách hàng ---
export function openPayDebtModal(customerIndex) {
  const modal = document.getElementById('pay-debt-modal');
  const form = document.getElementById('pay-debt-form');
  const cust = state.customers[customerIndex];
  if (!modal || !cust) return;
  
  modal.classList.add('active');
  form.reset();
  
  document.getElementById('pay-debt-customer-id').value = cust.id;
  document.getElementById('pay-debt-cust-name').innerText = `${cust.name} (${cust.code})`;
  document.getElementById('pay-debt-cust-current-debt').innerText = formatCurrency(cust.debt);
}

export function closePayDebtModal() {
  const modal = document.getElementById('pay-debt-modal');
  if (modal) modal.classList.remove('active');
}

export async function handlePayDebtSubmit(e) {
  e.preventDefault();
  const customerId = document.getElementById('pay-debt-customer-id').value;
  const amountPaid = parseFloat(document.getElementById('pay-debt-amount').value);
  const notes = document.getElementById('pay-debt-notes').value.trim() || 'Thu nợ khách hàng';
  
  if (!customerId || isNaN(amountPaid) || amountPaid <= 0) {
    showToast('Số tiền trả không hợp lệ!', 'danger');
    return;
  }
  
  const cust = state.customers.find(c => c.id === customerId);
  if (!cust) return;

  const debtBefore = Number(cust.debt) || 0;
  if (amountPaid > Math.abs(debtBefore)) {
    if (!confirm(`Số tiền khách trả (${formatCurrency(amountPaid)}) lớn hơn số công nợ hiện tại (${formatCurrency(cust.debt)}). Bạn có muốn tiếp tục?`)) {
      return;
    }
  }
  
  const currentUserDisp = state.currentUser ? (state.currentUser.displayName || state.currentUser.username) : 'Administrator';
  const paymentResult = await dbRecordCustomerPayment(cust.id, amountPaid, notes, currentUserDisp);
  if (!paymentResult) return;

  const rpcDebt = Number(paymentResult.new_debt);
  cust.debt = Number.isFinite(rpcDebt)
    ? rpcDebt
    : (debtBefore < 0 ? debtBefore + amountPaid : debtBefore - amountPaid);
  cust.lastPaymentAt = new Date().toISOString();
  
  // Ghi nhận lịch sử thu nợ
  if (!cust.debtHistory) cust.debtHistory = [];
  cust.debtHistory.push({
    id: `pay-${Date.now()}`,
    date: new Date().toISOString(),
    type: 'payment',
    amount: amountPaid,
    notes: notes,
    debtAfter: cust.debt
  });
  
  localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  addCashbookTransaction({
      type: 'thu',
      category: 'Thu nợ khách hàng',
      partner: cust.name,
      value: amountPaid,
      method: 'cash',
      accounting: true,
      note: notes,
      creator: currentUserDisp,
      id: paymentResult.cashbook_id || '',
      cloudId: paymentResult.cashbook_id || null,
      customerId: cust.id,
      debtImpact: true,
      syncToCloud: !paymentResult.cashbook_id
    });
    closePayDebtModal();
    renderAll();
    showToast(`Đã thu nợ ${formatCurrency(amountPaid)} từ khách hàng ${cust.name}!`, 'success');
}

export function setupCustomerManagement() {
  const searchInput = document.getElementById('customer-search-input');
  
  const onFilterChange = () => {
    state.customersPage = 1;
    renderCustomersTable();
  };

  if (searchInput) searchInput.addEventListener('input', onFilterChange);

  const managedFilter = document.getElementById('customer-managed-filter');
  if (managedFilter) managedFilter.addEventListener('change', onFilterChange);

  setupCustomerColumnPicker();

  const addBtn = document.getElementById('btn-open-add-customer-modal');
  if (addBtn) addBtn.addEventListener('click', () => openCustomerModal());

  const closeBtn = document.getElementById('btn-close-customer-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeCustomerModal);

  const cancelBtn = document.getElementById('btn-cancel-customer');
  if (cancelBtn) cancelBtn.addEventListener('click', closeCustomerModal);

  const customerForm = document.getElementById('customer-form');
  if (customerForm) {
    customerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveCustomer();
    });
  }

  const provinceSelect = document.getElementById('cust-province');
  if (provinceSelect) {
    // Populate dynamically with all 63 provinces
    provinceSelect.innerHTML = `
      <option value="">-- Chọn Tỉnh/Thành --</option>
      ${Object.entries(PROVINCES).map(([code, name]) => {
        if (code === 'OTHER') return '';
        return `<option value="${code}">${name}</option>`;
      }).join('')}
      <option value="OTHER">Khác</option>
    `;

    provinceSelect.addEventListener('change', () => {
      const editIndex = document.getElementById('customer-edit-index').value;
      if (editIndex === '-1') {
        const pCode = provinceSelect.value;
        const codeInput = document.getElementById('cust-code');
        if (codeInput) {
          codeInput.value = generateUniqueCustomerCode(pCode);
        }
      }
    });

    makeSelectSearchable('cust-province', '-- Chọn Tỉnh/Thành --');
  }
  
  makeSelectSearchable('cust-assigned-brand', 'Chọn nhãn sơn', false);

  const closePayDebtBtn = document.getElementById('btn-close-pay-debt-modal');
  const cancelPayDebtBtn = document.getElementById('btn-cancel-pay-debt');
  const payDebtForm = document.getElementById('pay-debt-form');

  if (closePayDebtBtn) closePayDebtBtn.addEventListener('click', closePayDebtModal);
  if (cancelPayDebtBtn) cancelPayDebtBtn.addEventListener('click', closePayDebtModal);
  if (payDebtForm) {
    payDebtForm.addEventListener('submit', handlePayDebtSubmit);
  }

  // Thay đổi hiển thị phần trăm chiết khấu hãng sơn theo bảng giá
  const custPricelistSelect = document.getElementById('cust-pricelist');
  if (custPricelistSelect) {
    custPricelistSelect.addEventListener('change', () => {
      const discSection = document.getElementById('cust-brand-discounts-section');
      if (discSection) {
        discSection.style.display = custPricelistSelect.value === 'custom' ? 'block' : 'none';
      }
    });
  }

  // Sự kiện đóng modal chi tiết công nợ
  const closeDetailBtn = document.getElementById('btn-close-customer-detail-modal');
  const closeDetailFooterBtn = document.getElementById('btn-close-detail-modal-footer');
  if (closeDetailBtn) closeDetailBtn.addEventListener('click', closeCustomerDetailModal);
  if (closeDetailFooterBtn) closeDetailFooterBtn.addEventListener('click', closeCustomerDetailModal);

  const openOrderExportBtn = document.getElementById('btn-open-customer-order-export');
  const closeOrderExportBtn = document.getElementById('btn-close-customer-order-export-modal');
  const cancelOrderExportBtn = document.getElementById('btn-cancel-customer-order-export');
  const submitOrderExportBtn = document.getElementById('btn-submit-customer-order-export');
  const openBulkOrderExportBtn = document.getElementById('btn-open-customer-history-export-modal');
  const rangeModeSelect = document.getElementById('customer-order-export-range-mode');
  const selectAllColumnsBtn = document.getElementById('btn-customer-order-export-select-all-columns');
  const clearColumnsBtn = document.getElementById('btn-customer-order-export-clear-columns');
  if (openBulkOrderExportBtn) {
    openBulkOrderExportBtn.addEventListener('click', () => openCustomerOrderExportModal(null));
  }
  if (openOrderExportBtn) {
    openOrderExportBtn.addEventListener('click', () => {
      openCustomerOrderExportModal(openOrderExportBtn.getAttribute('data-customer-id'));
    });
  }
  if (closeOrderExportBtn) closeOrderExportBtn.addEventListener('click', closeCustomerOrderExportModal);
  if (cancelOrderExportBtn) cancelOrderExportBtn.addEventListener('click', closeCustomerOrderExportModal);
  if (submitOrderExportBtn) submitOrderExportBtn.addEventListener('click', exportCustomerOrderHistoryExcel);
  if (rangeModeSelect) {
    rangeModeSelect.addEventListener('change', () => {
      const customBox = document.getElementById('customer-order-export-custom-range');
      if (customBox) customBox.style.display = rangeModeSelect.value === 'custom' ? 'grid' : 'none';
      const range = getCustomerOrderExportDateRange();
      const fromInput = document.getElementById('customer-order-export-from');
      const toInput = document.getElementById('customer-order-export-to');
      if (fromInput && range.fromDate) fromInput.value = range.fromDate;
      if (toInput && range.toDate) toInput.value = range.toDate;
    });
  }
  if (selectAllColumnsBtn) {
    selectAllColumnsBtn.addEventListener('click', () => {
      document.querySelectorAll('.customer-order-export-column').forEach(input => { input.checked = true; });
    });
  }
  if (clearColumnsBtn) {
    clearColumnsBtn.addEventListener('click', () => {
      document.querySelectorAll('.customer-order-export-column').forEach(input => { input.checked = false; });
    });
  }

  // Customer Excel Import Listeners
  const openImportBtn = document.getElementById('btn-open-cust-excel-modal');
  if (openImportBtn) openImportBtn.onclick = openCustExcelModal;
  
  const closeImportBtn = document.getElementById('btn-close-cust-excel-modal');
  if (closeImportBtn) closeImportBtn.onclick = closeCustExcelModal;
  
  const cancelImportBtn = document.getElementById('btn-cancel-cust-excel');
  if (cancelImportBtn) cancelImportBtn.onclick = closeCustExcelModal;
  
  const fileInput = document.getElementById('cust-excel-file-input');
  const browseBtn = document.getElementById('btn-browse-cust-excel');
  const dropzone = document.getElementById('cust-excel-dropzone');
  
  if (browseBtn && fileInput) {
    browseBtn.onclick = (e) => {
      e.stopPropagation();
      if (isSelectingFile) return;
      isSelectingFile = true;
      fileInput.click();
    };
  }
  if (dropzone && fileInput) {
    dropzone.onclick = (e) => {
      // Tránh kích hoạt click 2 lần khi nhấp trúng nút browseBtn hoặc bản thân fileInput
      if (e.target === browseBtn || browseBtn.contains(e.target) || e.target === fileInput) {
        return;
      }
      e.stopPropagation();
      if (isSelectingFile) return;
      isSelectingFile = true;
      fileInput.click();
    };
  }
  if (fileInput) {
    fileInput.onclick = (e) => {
      e.stopPropagation();
    };
    
    const resetLock = () => {
      isSelectingFile = false;
    };
    
    fileInput.onchange = (e) => {
      resetLock();
      if (e.target.files.length > 0) {
        handleCustExcelFile(e.target.files[0]);
      }
    };
    fileInput.oncancel = resetLock;
  }
  
  if (dropzone) {
    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    };
    dropzone.ondragleave = () => {
      dropzone.classList.remove('dragover');
    };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleCustExcelFile(e.dataTransfer.files[0]);
      }
    };
  }
  
  const downloadTemplateBtn = document.getElementById('btn-download-cust-excel-template');
  if (downloadTemplateBtn) {
    downloadTemplateBtn.onclick = (e) => {
      e.stopPropagation();
      downloadCustomerExcelTemplate();
    };
  }

  const submitImportBtn = document.getElementById('btn-save-cust-excel-submit');
  if (submitImportBtn) {
    submitImportBtn.onclick = processCustomerExcelImport;
  }
}

export function downloadCustomerExcelTemplate() {
  const sampleData = [
    {
      "Mã khách hàng": "BG01-HN-001",
      "Tên khách hàng": "Đại lý Sơn Tuấn Anh",
      "Điện thoại": "0987654321",
      "Địa chỉ": "Số 12 Phố Vọng, Phường Phương Mai, Quận Đống Đa, Hà Nội",
      "Nhãn sơn": "Nano10*",
      "Bảng giá": "Bảng giá BG01",
      "Người quản lý": "Nguyễn Thanh Thụy",
      "Tổng doanh số": 85000000,
      "Tổng giá trị trả hàng": 5000000,
      "Doanh số sau trả": 80000000,
      "Công nợ hiện tại": 15000000,
      "Ngày giao dịch cuối": new Date(2026, 6, 25),
      "Ngày tạo": new Date(2024, 2, 15),
      "Số ngày nợ": 5
    },
    {
      "Mã khách hàng": "BG02-HP-002",
      "Tên khách hàng": "Cửa hàng Vật Tư Minh Đức",
      "Điện thoại": "0912345678",
      "Địa chỉ": "45 Đường Lạch Tray, Quận Ngô Quyền, Hải Phòng",
      "Nhãn sơn": "Hatacco nano",
      "Bảng giá": "Bảng giá đại lý cấp 1",
      "Người quản lý": "Dương Như Hoàn",
      "Tổng doanh số": 42000000,
      "Tổng giá trị trả hàng": 0,
      "Doanh số sau trả": 42000000,
      "Công nợ hiện tại": 0,
      "Ngày giao dịch cuối": new Date(2026, 6, 20),
      "Ngày tạo": new Date(2024, 4, 10),
      "Số ngày nợ": 0
    },
    {
      "Mã khách hàng": "BG03-DN-003",
      "Tên khách hàng": "Đại lý Sơn & Hóa Chất Hoàng Long",
      "Điện thoại": "0905123456",
      "Địa chỉ": "78 Đường Nguyễn Văn Linh, Quận Thanh Khê, Đà Nẵng",
      "Nhãn sơn": "mutsutec",
      "Bảng giá": "Chiết khấu riêng",
      "Người quản lý": "ctyabs@lendon.com",
      "Tổng doanh số": 120000000,
      "Tổng giá trị trả hàng": 10000000,
      "Doanh số sau trả": 110000000,
      "Công nợ hiện tại": 5500000,
      "Ngày giao dịch cuối": new Date(2026, 6, 12),
      "Ngày tạo": new Date(2023, 10, 2),
      "Số ngày nợ": 18
    },
    {
      "Mã khách hàng": "BG04-TH-004",
      "Tên khách hàng": "NPP Anh Chung Thanh Hóa",
      "Điện thoại": "0943218765",
      "Địa chỉ": "156 Đường Lê Lai, Phường Đông Sơn, TP Thanh Hóa, Thanh Hóa",
      "Nhãn sơn": "Tất cả",
      "Bảng giá": "Bảng giá 04",
      "Người quản lý": "Trần Văn Nhất",
      "Tổng doanh số": 65000000,
      "Tổng giá trị trả hàng": 2000000,
      "Doanh số sau trả": 63000000,
      "Công nợ hiện tại": 2550000,
      "Ngày giao dịch cuối": new Date(2026, 6, 8),
      "Ngày tạo": new Date(2024, 7, 21),
      "Số ngày nợ": 22
    },
    {
      "Mã khách hàng": "BG05-BD-005",
      "Tên khách hàng": "Công Ty TNHH XD Sơn Nam Dương",
      "Điện thoại": "0978112233",
      "Địa chỉ": "89 Đại Lộ Bình Dương, Phường Phú Hòa, TP Thủ Dầu Một, Bình Dương",
      "Nhãn sơn": "tdkaw",
      "Bảng giá": "Chiết khấu riêng",
      "Người quản lý": "Dương Như Hoàn",
      "Tổng doanh số": 195000000,
      "Tổng giá trị trả hàng": 0,
      "Doanh số sau trả": 195000000,
      "Công nợ hiện tại": 0,
      "Ngày giao dịch cuối": new Date(2026, 6, 1),
      "Ngày tạo": new Date(2025, 0, 8),
      "Số ngày nợ": 0
    }
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleData);
  worksheet['!cols'] = [
    { wch: 18 }, // Mã khách hàng
    { wch: 38 }, // Tên khách hàng
    { wch: 16 }, // Điện thoại
    { wch: 55 }, // Địa chỉ
    { wch: 18 }, // Nhãn sơn
    { wch: 25 }, // Bảng giá
    { wch: 25 }, // Người quản lý
    { wch: 18 }, // Tổng doanh số
    { wch: 22 }, // Tổng giá trị trả hàng
    { wch: 20 }, // Doanh số sau trả
    { wch: 20 }, // Công nợ hiện tại
    { wch: 20 }, // Ngày giao dịch cuối
    { wch: 16 }, // Ngày tạo
    { wch: 14 }  // Số ngày nợ
  ];

  for (let row = 2; row <= sampleData.length + 1; row++) {
    if (worksheet[`L${row}`]) worksheet[`L${row}`].z = 'yyyy-mm-dd';
    if (worksheet[`M${row}`]) worksheet[`M${row}`].z = 'yyyy-mm-dd';
    if (worksheet[`N${row}`]) worksheet[`N${row}`].z = '0';
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "DanhSachKhachHang");
  XLSX.writeFile(workbook, "Mau_Nhap_Danh_Sach_Khach_Hang.xlsx");
}




// --- Logic hiển thị chi tiết đại lý và lịch sử công nợ ---
const CUSTOMER_ORDER_EXPORT_COLUMNS = [
  'Mã hóa đơn', 'Thời gian', 'Ngày cập nhật', 'Mã trả hàng',
  'Mã khách hàng', 'Tên khách hàng', 'Điện thoại', 'Địa chỉ (Khách hàng)',
  'Khu vực (Khách hàng)', 'Bảng giá', 'Kinh doanh quản lý',
  'Người bán', 'Người tạo', 'Ghi chú', 'Tổng tiền hàng', 'Tổng giảm giá',
  'Tổng sau giảm giá', 'Phí vận chuyển', 'Khách cọc', 'Còn phải thu',
  'Trạng thái', 'Mã hàng', 'Tên hàng', 'Thương hiệu', 'Quy cách', 'ĐVT',
  'Ghi chú hàng hóa', 'Số lượng', 'Đơn giá',
  'Giảm giá %', 'Giảm giá', 'Giá bán', 'Thành tiền'
];

const CUSTOMER_ORDER_EXPORT_COLUMN_GROUPS = [
  { title: 'Thông tin hóa đơn', columns: ['Mã hóa đơn', 'Thời gian', 'Ngày cập nhật', 'Mã trả hàng', 'Trạng thái', 'Người bán', 'Người tạo', 'Ghi chú'] },
  { title: 'Thông tin khách hàng', columns: ['Mã khách hàng', 'Tên khách hàng', 'Điện thoại', 'Địa chỉ', 'Khu vực', 'Bảng giá', 'Kinh doanh quản lý'] },
  { title: 'Thông tin thanh toán', columns: ['Tổng tiền hàng', 'Tổng giảm giá', 'Tổng sau giảm giá', 'Phí vận chuyển', 'Khách cọc', 'Còn phải thu'] },
  { title: 'Thông tin sản phẩm', columns: ['Mã hàng', 'Tên hàng', 'Thương hiệu/Nhãn sơn', 'Quy cách', 'Đơn vị tính', 'Ghi chú hàng hóa', 'Số lượng', 'Đơn giá', 'Giảm giá %', 'Giảm giá', 'Giá bán', 'Thành tiền'] }
];

const DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS = CUSTOMER_ORDER_EXPORT_COLUMN_GROUPS.flatMap(g => g.columns);
const CUSTOMER_ORDER_EXPORT_COLUMNS_STORAGE_KEY = 'billing_system_customer_order_export_columns';

let activeExportCustomerId = null;
let activeExportScopeMode = 'filtered';

function toExportNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : fallback;
}

function formatExportDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(',', '');
}

function getVnDateInputValue(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getVnRangeIso(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00+07:00`);
  const endExclusive = new Date(`${endDate}T00:00:00+07:00`);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { startIso: start.toISOString(), endExclusiveIso: endExclusive.toISOString() };
}

function sanitizeFilePart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'KhachHang';
}

function getDisplayUserName(username) {
  if (!username) return '';
  const found = (state.users || []).find(u => isSameUser(u.username, username));
  return found ? (found.displayName || found.name || found.username) : username;
}

function getPricelistName(id) {
  if (!id) return '';
  if (id === 'retail') return 'Khách lẻ';
  if (id === 'custom') return 'Chiết khấu riêng';
  const found = (state.pricelists || []).find(p => String(p.id) === String(id));
  return found ? found.name : id;
}

function getOrderReturnCodes(orderId) {
  return (state.salesReturns || [])
    .filter(r => String(r.saleId || r.orderId || '') === String(orderId))
    .filter(r => !['cancelled', 'canceled', 'draft'].includes(String(r.status || 'completed').toLowerCase()))
    .map(r => r.id)
    .filter(Boolean)
    .join(', ');
}

function getLineAmount(item) {
  const qty = toExportNumber(item.quantity);
  const unitPrice = toExportNumber(item.price ?? item.unitPrice ?? item.listPrice);
  const discountPercent = toExportNumber(item.discountPercent ?? item.discount);
  if (item.subtotal !== undefined && item.subtotal !== null && item.subtotal !== '') return toExportNumber(item.subtotal);
  if (item.total !== undefined && item.total !== null && item.total !== '') return toExportNumber(item.total);
  if (item.lineTotal !== undefined && item.lineTotal !== null && item.lineTotal !== '') return toExportNumber(item.lineTotal);
  return Math.round(qty * unitPrice * (1 - discountPercent / 100));
}

function buildCustomerOrderExportRows(orders, customer) {
  const provinceName = getProvinceNameByCode(customer.brandDiscounts && customer.brandDiscounts.province);
  return orders.flatMap(order => {
    const items = Array.isArray(order.items) ? order.items : [];
    const financials = getOrderFinancialBreakdown(order, state.salesReturns || []);
    return items.map(item => {
      const qty = toExportNumber(item.quantity);
      const unitPrice = toExportNumber(item.price ?? item.unitPrice ?? item.listPrice);
      const discountPercent = toExportNumber(item.discountPercent ?? item.discount);
      const lineAmount = getLineAmount(item);
      const lineDiscount = toExportNumber(item.discountAmount, Math.max(0, Math.round(qty * unitPrice - lineAmount)));
      const salePrice = qty > 0 ? Math.round(lineAmount / qty) : unitPrice;
      return {
        'Mã hóa đơn': order.id || '',
        'Thời gian': formatExportDateTime(order.date || order.orderDate || order.createdAt),
        'Ngày cập nhật': formatExportDateTime(order.updatedAt || order.createdAt || order.date),
        'Mã trả hàng': getOrderReturnCodes(order.id),
        'Mã khách hàng': customer.code || customer.id || '',
        'Tên khách hàng': customer.name || order.customerName || '',
        'Điện thoại': customer.phone || order.customerPhone || '',
        'Địa chỉ (Khách hàng)': customer.address || order.customerAddress || '',
        'Địa chỉ': customer.address || order.customerAddress || '',
        'Khu vực (Khách hàng)': provinceName || '',
        'Khu vực': provinceName || '',
        'Bảng giá': getPricelistName(order.pricelistId || customer.pricelistId),
        'Kinh doanh quản lý': getDisplayUserName(customer.managedBy || customer.managed_by),
        'Người bán': getDisplayUserName(order.salespersonId || order.createdBy),
        'Người tạo': getDisplayUserName(order.createdBy),
        'Ghi chú': order.notes || '',
        'Tổng tiền hàng': financials.totalBeforeDiscount,
        'Tổng giảm giá': financials.totalDiscountAmount,
        'Tổng sau giảm giá': financials.totalAfterDiscount,
        'Phí vận chuyển': toExportNumber(order.shippingFeeAmount ?? order.shipping_fee_amount),
        'Khách cọc': toExportNumber(order.paidAmount ?? order.paid_amount ?? order.otherFeeAmount ?? order.other_fee_amount),
        'Còn phải thu': toExportNumber(order.amountDue ?? order.debtAmount ?? order.debt_amount, Math.max(
          0,
          financials.totalAfterDiscount +
          toExportNumber(order.shippingFeeAmount ?? order.shipping_fee_amount) -
          toExportNumber(order.paidAmount ?? order.paid_amount ?? order.otherFeeAmount ?? order.other_fee_amount)
        )),
        'Trạng thái': getOrderStatusLabel(order.status || 'settled'),
        'Mã hàng': item.variantCode || item.productCode || item.code || item.variantId || item.productId || '',
        'Tên hàng': item.productName || item.name || item.product?.name || '',
        'Thương hiệu': item.productBrand || item.brand || '',
        'Thương hiệu/Nhãn sơn': item.productBrand || item.brand || '',
        'Quy cách': item.specificationSnapshot || item.weightOrVolumeSnapshot || item.displaySpecification || [
          item.packagingName || item.packageType || item.package,
          item.weightOrVolume || item.packageWeight,
          item.unitName || item.packageWeightUnit
        ].filter(value => value !== null && value !== undefined && value !== '').join(' '),
        'ĐVT': item.unitName || item.unit || item.packagingName || item.packageType || item.package || '',
        'Đơn vị tính': item.unitName || item.unit || item.packagingName || item.packageType || item.package || '',
        'Ghi chú hàng hóa': item.note || item.notes || '',
        'Số lượng': qty,
        'Đơn giá': unitPrice,
        'Giảm giá %': discountPercent,
        'Giảm giá': lineDiscount,
        'Giá bán': salePrice,
        'Thành tiền': lineAmount
      };
    });
  });
}

function getSavedCustomerOrderExportColumns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOMER_ORDER_EXPORT_COLUMNS_STORAGE_KEY) || '[]');
    const allowed = new Set(DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS);
    const valid = parsed.filter(col => allowed.has(col));
    return valid.length > 0 ? valid : DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS;
  } catch (e) {
    return DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS;
  }
}

function renderCustomerOrderExportColumnOptions() {
  const container = document.getElementById('customer-order-export-columns');
  if (!container) return;
  const selected = new Set(getSavedCustomerOrderExportColumns());
  container.innerHTML = CUSTOMER_ORDER_EXPORT_COLUMN_GROUPS.map(group => `
    <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 0.75rem;">
      <div style="font-weight: 600; color: #fff; margin-bottom: 0.5rem;">${group.title}</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.45rem;">
        ${group.columns.map(col => `
          <label style="display: flex; gap: 0.4rem; align-items: center; font-size: 0.82rem; color: var(--text-secondary);">
            <input type="checkbox" class="customer-order-export-column" value="${col}" ${selected.has(col) ? 'checked' : ''}>
            <span>${col}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function getSelectedCustomerOrderExportColumns() {
  return Array.from(document.querySelectorAll('.customer-order-export-column:checked')).map(input => input.value);
}

function getCustomerOrderExportDateRange() {
  const mode = document.getElementById('customer-order-export-range-mode')?.value || 'last_month';
  const today = getVnDateInputValue(0);
  const todayParts = today.split('-').map(Number);
  if (mode === 'today') return { fromDate: today, toDate: today, label: 'HomNay' };
  if (mode === 'this_month') {
    const fromDate = `${todayParts[0]}-${String(todayParts[1]).padStart(2, '0')}-01`;
    return { fromDate, toDate: today, label: 'ThangNay' };
  }
  if (mode === 'custom') {
    const fromDate = document.getElementById('customer-order-export-from')?.value;
    const toDate = document.getElementById('customer-order-export-to')?.value;
    return { fromDate, toDate, label: `${fromDate}-${toDate}` };
  }
  const firstThisMonth = new Date(`${todayParts[0]}-${String(todayParts[1]).padStart(2, '0')}-01T00:00:00+07:00`);
  const lastPrevMonth = new Date(firstThisMonth);
  lastPrevMonth.setDate(0);
  const prevParts = getVnDateInputValueFromDate(lastPrevMonth).split('-').map(Number);
  return {
    fromDate: `${prevParts[0]}-${String(prevParts[1]).padStart(2, '0')}-01`,
    toDate: getVnDateInputValueFromDate(lastPrevMonth),
    label: 'ThangTruoc'
  };
}

function getVnDateInputValueFromDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getExportCustomersByScope() {
  if (activeExportCustomerId) {
    return (state.customers || []).filter(c => String(c.id) === String(activeExportCustomerId));
  }
  const filtered = getFilteredCustomersForCurrentView();
  if (selectedCustomerIdsForExport.size > 0) {
    return filtered.filter(c => selectedCustomerIdsForExport.has(String(c.id)));
  }
  return filtered;
}

function resetSearchableSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return null;
  const wrapper = select.parentNode;
  if (wrapper && wrapper.classList && wrapper.classList.contains('searchable-select-wrapper')) {
    const parent = wrapper.parentNode;
    parent.insertBefore(select, wrapper);
    wrapper.remove();
    select.style.display = '';
  }
  return select;
}

function getUserOptionValue(user) {
  return user.username || user.id || user.email || '';
}

function getManagedByOptions() {
  const options = new Map();
  (state.users || []).forEach(user => {
    const value = getUserOptionValue(user);
    if (value) options.set(String(value), user.displayName || user.name || user.username || user.id);
  });
  (state.customers || []).forEach(customer => {
    const value = customer.managedBy || customer.managed_by;
    if (!value) return;
    const matched = (state.users || []).find(user =>
      isSameUser(user.username, value) ||
      isSameUser(user.id, value) ||
      isSameUser(user.email, value)
    );
    options.set(String(value), matched ? (matched.displayName || matched.name || matched.username || matched.id) : String(value));
  });
  return Array.from(options.entries()).sort((a, b) => a[1].localeCompare(b[1], 'vi'));
}

function populateCustomerOrderExportManagerFilter() {
  const select = resetSearchableSelect('customer-order-export-manager');
  if (!select) return;
  const managerOptions = getManagedByOptions();
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${managerOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}`;
  const currentCustomerFilter = document.getElementById('customer-managed-filter')?.value || '';
  const hasCurrent = Array.from(select.options).some(opt => opt.value === currentCustomerFilter);
  select.value = currentCustomerFilter && hasCurrent && !['unassigned', 'unassigned_pricelist'].includes(currentCustomerFilter) ? currentCustomerFilter : 'all';
  makeSelectSearchable('customer-order-export-manager', 'Tất cả');
}

function getSelectedExportManagerId() {
  return document.getElementById('customer-order-export-manager')?.value || 'all';
}

function populateCustomerOrderExportCustomerFilter() {
  const select = resetSearchableSelect('customer-order-export-customer');
  if (!select) return;
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${(state.customers || []).map(c => {
    const phone = c.phone ? `SĐT: ${formatPhoneNumber(c.phone)}` : 'Chưa có SĐT';
    const provinceName = getProvinceNameByCode(c.brandDiscounts && c.brandDiscounts.province);
    const addressParts = [c.address, c.ward, provinceName].filter(Boolean);
    const address = addressParts.length > 0 ? addressParts.join(', ') : 'Chưa có địa chỉ';
    return `<option value="${c.id}">${c.name || c.code || c.id} • ${phone} • ${address}</option>`;
  }).join('')}`;
  select.value = activeExportCustomerId || 'all';
  makeSelectSearchable('customer-order-export-customer', 'Tất cả');
}
function getSelectedExportCustomerId() {
  return document.getElementById('customer-order-export-customer')?.value || 'all';
}

function populateCustomerOrderExportCompanyFilter() {
  const select = resetSearchableSelect('customer-order-export-company');
  if (!select) return;
  const companies = state.companies || [];
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${companies.map(c => `<option value="${c.id}">${c.name || c.id}</option>`).join('')}`;
  select.value = 'all';
  makeSelectSearchable('customer-order-export-company', 'Tất cả');
}

function populateCustomerOrderExportBrandFilter() {
  const select = resetSearchableSelect('customer-order-export-brand');
  if (!select) return;
  const brandNames = Array.from(new Set((state.brands || [])
    .map(b => b.name)
    .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, 'vi'));
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${brandNames.map(name => `<option value="${name}">${name}</option>`).join('')}`;
  select.value = 'all';
  makeSelectSearchable('customer-order-export-brand', 'Tất cả');
}

function getSelectedExportCompanyId() {
  return document.getElementById('customer-order-export-company')?.value || 'all';
}

function getSelectedExportBrand() {
  return document.getElementById('customer-order-export-brand')?.value || 'all';
}

function customerMatchesExportCompany(customer, companyId) {
  if (!companyId || companyId === 'all') return true;
  const selectedCompanyId = normalizeCompanyId(companyId);
  const customerCompanyId = customer.companyId || customer.company_id || getCompanyIdByBrand(customer.assignedBrand, state.brands);
  return normalizeCompanyId(customerCompanyId) === selectedCompanyId;
}

function customerMatchesExportBrand(customer, brandName) {
  if (!brandName || brandName === 'all') return true;
  const customerBrand = customer.assignedBrand || customer.assigned_brand || '';
  return customerBrand.toLowerCase() === brandName.toLowerCase();
}

function orderMatchesExportCompany(order, companyId) {
  if (!companyId || companyId === 'all') return true;
  const selectedCompanyId = normalizeCompanyId(companyId);
  if (normalizeCompanyId(order.companyId || order.company_id) === selectedCompanyId) return true;
  return (order.items || []).some(item => {
    const itemCompany = item.revenueCompany || item.companyId || item.company_id || getCompanyIdByBrand(item.revenueBrand || item.agencyBrand || item.productBrand || item.brand, state.brands);
    return normalizeCompanyId(itemCompany) === selectedCompanyId;
  });
}

function orderMatchesExportBrand(order, brandName) {
  if (!brandName || brandName === 'all') return true;
  const selected = brandName.toLowerCase();
  return (order.items || []).some(item =>
    [item.revenueBrand, item.agencyBrand, item.productBrand, item.brand]
      .filter(Boolean)
      .some(b => String(b).toLowerCase() === selected)
  );
}

function getOrderStatusLabel(status) {
  const labels = {
    all: 'Đơn hợp lệ',
    settled: 'Đã chốt',
    completed: 'Đã chốt',
    complete: 'Đã chốt',
    confirmed: 'Đã chốt',
    partially_returned: 'Trả một phần',
    returned: 'Đã trả toàn bộ',
    draft: 'Đơn nháp',
    cancelled: 'Đã hủy',
    canceled: 'Đã hủy'
  };
  return labels[status] || status;
}

function normalizeExportOrderStatus(status) {
  const normalized = String(status || 'settled').toLowerCase();
  if (['settled', 'completed', 'complete', 'confirmed'].includes(normalized)) return 'settled';
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  return normalized;
}

function orderMatchesExportStatus(order, selectedStatus) {
  if (!selectedStatus || selectedStatus === 'all') {
    return !['draft', 'cancelled'].includes(normalizeExportOrderStatus(order.status));
  }
  return normalizeExportOrderStatus(order.status) === selectedStatus;
}

function populateCustomerOrderExportStatusFilter(orders) {
  const select = document.getElementById('customer-order-export-status');
  if (!select) return;
  const allowedOrderStatuses = ['settled', 'partially_returned', 'returned', 'draft', 'cancelled'];
  const presentStatuses = new Set((orders || []).map(order => normalizeExportOrderStatus(order.status)));
  const statuses = allowedOrderStatuses.filter(status => presentStatuses.has(status));
  select.innerHTML = `
    <option value="all">${getOrderStatusLabel('all')}</option>
    ${statuses.map(status => `<option value="${status}">${getOrderStatusLabel(status)}</option>`).join('')}
  `;
}

function updateCustomerOrderExportScopeText() {
  const el = document.getElementById('customer-order-export-scope-text');
  if (!el) return;
  if (activeExportOrders) {
    el.innerText = activeExportOrderIds && activeExportOrderIds.length > 0
      ? `${activeExportOrderIds.length} đơn đã tích chọn`
      : `${activeExportOrders.length} đơn theo bộ lọc hiện tại`;
    return;
  }
  const count = getExportCustomersByScope().length;
  if (activeExportCustomerId) el.innerText = `1 khách hàng đang xem`;
  else if (selectedCustomerIdsForExport.size > 0) el.innerText = `${count} khách hàng đã tích chọn`;
  else el.innerText = `${count} khách hàng theo bộ lọc hiện tại`;
}

function openCustomerOrderExportModal(customerId = null) {
  activeExportOrders = null;
  activeExportOrderIds = null;
  activeExportCustomerId = customerId;
  activeExportScopeMode = customerId ? 'single' : (selectedCustomerIdsForExport.size > 0 ? 'selected' : 'filtered');
  const modal = document.getElementById('customer-order-export-modal');
  if (!modal) return;
  const relevantOrders = customerId
    ? (state.savedOrders || []).filter(order => String(order.customerId || '') === String(customerId))
    : (state.savedOrders || []);
  populateCustomerOrderExportStatusFilter(relevantOrders);
  const fromInput = document.getElementById('customer-order-export-from');
  const toInput = document.getElementById('customer-order-export-to');
  const rangeMode = document.getElementById('customer-order-export-range-mode');
  if (rangeMode) rangeMode.value = 'last_month';
  const lastMonthRange = getCustomerOrderExportDateRange();
  if (fromInput) fromInput.value = lastMonthRange.fromDate;
  if (toInput) toInput.value = lastMonthRange.toDate;
  populateCustomerOrderExportCompanyFilter();
  populateCustomerOrderExportBrandFilter();
  populateCustomerOrderExportManagerFilter();
  populateCustomerOrderExportCustomerFilter();
  renderCustomerOrderExportColumnOptions();
  updateCustomerOrderExportScopeText();
  modal.classList.add('active');
}

export function openHistoryOrderExportModal(orders, selectedOrderIds = []) {
  if ((!selectedOrderIds || selectedOrderIds.length === 0) && !confirm(`Xuất toàn bộ ${orders.length} đơn theo bộ lọc hiện tại?`)) {
    return;
  }
  activeExportCustomerId = null;
  activeExportScopeMode = selectedOrderIds.length > 0 ? 'history_selected' : 'history_filtered';
  activeExportOrders = orders || [];
  activeExportOrderIds = selectedOrderIds || null;
  const modal = document.getElementById('customer-order-export-modal');
  if (!modal) return;
  const rangeMode = document.getElementById('customer-order-export-range-mode');
  if (rangeMode) rangeMode.value = 'last_month';
  const range = getCustomerOrderExportDateRange();
  const fromInput = document.getElementById('customer-order-export-from');
  const toInput = document.getElementById('customer-order-export-to');
  if (fromInput) fromInput.value = range.fromDate;
  if (toInput) toInput.value = range.toDate;
  populateCustomerOrderExportCompanyFilter();
  populateCustomerOrderExportBrandFilter();
  populateCustomerOrderExportManagerFilter();
  populateCustomerOrderExportCustomerFilter();
  populateCustomerOrderExportStatusFilter(orders || []);
  renderCustomerOrderExportColumnOptions();
  updateCustomerOrderExportScopeText();
  modal.classList.add('active');
}

function closeCustomerOrderExportModal() {
  const modal = document.getElementById('customer-order-export-modal');
  if (modal) modal.classList.remove('active');
}

async function exportCustomerOrderHistoryExcel() {
  const customers = activeExportOrders ? (state.customers || []) : getExportCustomersByScope();
  if (customers.length === 0) {
    showToast('Không có khách hàng phù hợp để xuất.', 'warning');
    return;
  }
  const selectedColumns = getSelectedCustomerOrderExportColumns();
  if (selectedColumns.length === 0) {
    showToast('Vui lòng chọn ít nhất một cột để xuất.', 'warning');
    return;
  }
  localStorage.setItem(CUSTOMER_ORDER_EXPORT_COLUMNS_STORAGE_KEY, JSON.stringify(selectedColumns));

  const submitBtn = document.getElementById('btn-submit-customer-order-export');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Đang xuất...';
  }

  const range = getCustomerOrderExportDateRange();
  const fromDate = range.fromDate;
  const toDate = range.toDate;
  const status = document.getElementById('customer-order-export-status')?.value || 'all';
  if (!fromDate || !toDate || fromDate > toDate) {
    showToast('Vui lòng chọn khoảng ngày hợp lệ.', 'warning');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="download" style="width: 16px; height: 16px;"></i> Xuất Excel';
      safeCreateIcons();
    }
    return;
  }
  try {
    const { startIso, endExclusiveIso } = getVnRangeIso(fromDate, toDate);
    const selectedCompanyId = getSelectedExportCompanyId();
    const selectedBrand = getSelectedExportBrand();
    const selectedManagerId = getSelectedExportManagerId();
    const selectedCustomerId = getSelectedExportCustomerId();
    let scopedCustomers = customers;
    if (selectedCustomerId !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => String(c.id) === String(selectedCustomerId));
    }
    if (!activeExportOrders && selectedCompanyId !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => customerMatchesExportCompany(c, selectedCompanyId));
    }
    if (!activeExportOrders && selectedBrand !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => customerMatchesExportBrand(c, selectedBrand));
    }
    if (selectedManagerId !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => isSameUser(c.managedBy || c.managed_by, selectedManagerId));
    }
    const customerById = new Map(scopedCustomers.map(c => [String(c.id), c]));
    let orders = [];
    if (activeExportOrders) {
      const allowedOrderIds = activeExportOrderIds ? new Set(activeExportOrderIds.map(String)) : null;
      const startTime = new Date(startIso).getTime();
      const endTime = new Date(endExclusiveIso).getTime();
      orders = activeExportOrders.filter(order => {
        if (allowedOrderIds && !allowedOrderIds.has(String(order.id))) return false;
        const orderTime = new Date(order.date || order.createdAt || order.created_at).getTime();
        if (!Number.isFinite(orderTime) || orderTime < startTime || orderTime >= endTime) return false;
        if (!orderMatchesExportStatus(order, status)) return false;
        if (selectedCompanyId !== 'all' && !orderMatchesExportCompany(order, selectedCompanyId)) return false;
        if (selectedBrand !== 'all') {
          const cust = customerById.get(String(order.customerId || order.customer_id));
          const matchedCustomerBrand = cust && customerMatchesExportBrand(cust, selectedBrand);
          if (!matchedCustomerBrand && !orderMatchesExportBrand(order, selectedBrand)) return false;
        }
        if (selectedManagerId !== 'all') {
          const cust = customerById.get(String(order.customerId || order.customer_id));
          if (!cust || !isSameUser(cust.managedBy || cust.managed_by, selectedManagerId)) return false;
        }
        return true;
      });
    } else {
      orders = await dbFetchCustomersOrderHistory(scopedCustomers.map(c => c.id), startIso, endExclusiveIso, status);
    }
    const exportRows = orders.flatMap(order => {
      const customer = customerById.get(String(order.customerId));
      return customer ? buildCustomerOrderExportRows([order], customer) : [];
    });
    if (exportRows.length === 0) {
      showToast('Không có đơn hàng phù hợp để xuất Excel.', 'warning');
      return;
    }

    const sheetData = [
      selectedColumns,
      ...exportRows.map(row => selectedColumns.map(col => row[col] ?? ''))
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    worksheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sheetData.length - 1, c: selectedColumns.length - 1 } }) };
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    worksheet['!cols'] = selectedColumns.map(col => ({ wch: Math.min(38, Math.max(12, col.length + 4)) }));
    selectedColumns.forEach((_, idx) => {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c: idx });
      if (worksheet[cellRef]) worksheet[cellRef].s = { font: { bold: true } };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Lịch sử đơn hàng');
    const fileRange = range.label || `${fromDate}-${toDate}`;
    const fileName = `LichSuDonHang_${sanitizeFilePart(fileRange)}_${customers.length}Khach.xlsx`;
    XLSX.writeFile(workbook, fileName);
    closeCustomerOrderExportModal();
    showToast(`Đã xuất ${exportRows.length} dòng lịch sử đơn hàng.`, 'success');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="download" style="width: 16px; height: 16px;"></i> Xuất Excel';
      safeCreateIcons();
    }
  }
}

export function openCustomerDetailModal(index) {
  const modal = document.getElementById('customer-detail-modal');
  const cust = state.customers[index];
  if (!modal || !cust) return;

  modal.classList.add('active');

  // Điền thông tin cơ bản
  const modalTitle = document.getElementById('customer-detail-modal-title');
  if (modalTitle) {
    modalTitle.innerText = `Thông tin & Lịch sử công nợ của đại lý mã ${cust.code}`;
  }

  const exportBtn = document.getElementById('btn-open-customer-order-export');
  if (exportBtn) exportBtn.setAttribute('data-customer-id', cust.id);

  document.getElementById('detail-cust-code').innerText = cust.code;
  document.getElementById('detail-cust-name').innerText = cust.name;
  document.getElementById('detail-cust-phone').innerText = formatPhoneNumber(cust.phone);
  const provinceName = getProvinceNameByCode(cust.brandDiscounts && cust.brandDiscounts.province);
  const detailAddress = cust.address || 'N/A';
  document.getElementById('detail-cust-address').innerText = provinceName ? `[${provinceName}] ${detailAddress}` : detailAddress;
  
  const brandEl = document.getElementById('detail-cust-brand');
  if (brandEl) {
    brandEl.innerHTML = `<span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(34, 197, 94, 0.15)'}; color: ${cust.assignedBrand === 'Tất cả' ? '#10b981' : '#22c55e'}; border: 1px solid ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(34, 197, 94, 0.3)'};">${cust.assignedBrand}</span>`;
  }
  
  const mName = cust.managedBy ? getManagerDisplayName(cust.managedBy, state.users) : 'Chưa bàn giao / Trống';
  document.getElementById('detail-cust-manager').innerText = mName;
  
  // Xác định tên bảng giá đang áp dụng
  let plName = '';
  const plId = cust.pricelistId || '';
  if (plId === '') {
    plName = 'Chưa xác định';
  } else if (plId === 'custom') {
    const discSummary = [];
    if (cust.brandDiscounts) {
      for (const [brand, pct] of Object.entries(cust.brandDiscounts)) {
        if (pct > 0) {
          discSummary.push(`${brand}: ${pct}%`);
        }
      }
    }
    plName = discSummary.length > 0 
      ? `CK riêng (${discSummary.join(', ')})` 
      : 'Chiết khấu riêng';
  } else if (plId === 'retail') {
    plName = 'Khách lẻ (Nhập tay)';
  } else {
    const pl = state.pricelists.find(p => p.id === plId);
    plName = pl ? pl.name : plId;
  }
  document.getElementById('detail-cust-pricelist').innerText = plName;
  document.getElementById('detail-cust-notes').innerText = cust.notes || 'N/A';
  
  const metrics = getCustomerMetrics(cust);
  const grossEl = document.getElementById('detail-cust-sales-gross');
  if (grossEl) grossEl.innerText = formatCurrency(metrics.grossSales);
  
  const retTotEl = document.getElementById('detail-cust-returns-total');
  if (retTotEl) retTotEl.innerText = formatCurrency(metrics.totalReturns);

  const netEl = document.getElementById('detail-cust-sales-net');
  if (netEl) netEl.innerText = formatCurrency(metrics.netSales);

  const rateEl = document.getElementById('detail-cust-return-rate');
  if (rateEl) rateEl.innerText = `${metrics.returnRate}%`;

  const payEl = document.getElementById('detail-cust-total-payments');
  if (payEl) payEl.innerText = formatCurrency(metrics.totalPayments);

  const detailDebtEl = document.getElementById('detail-cust-debt');
  if (detailDebtEl) {
    detailDebtEl.innerText = formatCurrency(cust.debt || 0);
    detailDebtEl.style.color = (cust.debt > 0) ? 'var(--color-danger)' : ((cust.debt < 0) ? 'var(--color-success)' : 'var(--text-muted)');
  }


  // Vẽ danh sách lịch sử biến động công nợ
  const historyBody = document.getElementById('detail-debt-history-body');
  if (historyBody) {
    const history = cust.debtHistory || [];
    
    // Sắp xếp theo ngày giờ mới nhất lên trên
    const sortedHistory = [...history].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    if (sortedHistory.length === 0) {
      historyBody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            Chưa có lịch sử giao dịch công nợ nào cho đại lý này.
          </td>
        </tr>
      `;
    } else {
      historyBody.innerHTML = sortedHistory.map(h => {
        let typeBadge = '';
        let amountText = '';
        let debtBefore = 0;
        
        if (h.type === 'payment') {
          typeBadge = `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); font-weight: 600; white-space: nowrap;">Thu nợ</span>`;
          amountText = `<span style="color: var(--color-primary); font-weight: 600;">-${formatCurrency(h.amount)}</span>`;
          debtBefore = h.debtAfter + h.amount;
        } else if (h.type === 'charge') {
          typeBadge = `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); font-weight: 600; white-space: nowrap;">Ghi nợ</span>`;
          amountText = `<span style="color: var(--color-danger); font-weight: 600;">+${formatCurrency(h.amount)}</span>`;
          debtBefore = h.debtAfter - h.amount;
        } else {
          typeBadge = `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3); font-weight: 600; white-space: nowrap;">Điều chỉnh</span>`;
          const sign = h.amount >= 0 ? '+' : '';
          amountText = `<span style="color: #818cf8; font-weight: 600;">${sign}${formatCurrency(h.amount)}</span>`;
          debtBefore = h.debtAfter - h.amount;
        }
        
        const formattedTime = new Intl.DateTimeFormat('vi-VN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).format(new Date(h.date));
        
        const noteText = h.note || h.notes || '-';
        return `
          <tr>
            <td style="font-size: 0.8rem; white-space: nowrap;">${formattedTime}</td>
            <td style="text-align: center;">${typeBadge}</td>
            <td style="text-align: right;">${formatCurrency(debtBefore)}</td>
            <td style="text-align: right;">${amountText}</td>
            <td style="text-align: right; font-weight: 600;">${formatCurrency(h.debtAfter)}</td>
            <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${noteText}">${noteText}</td>
          </tr>
        `;

      }).join('');
    }
  }

  safeCreateIcons();
}

export function closeCustomerDetailModal() {
  const modal = document.getElementById('customer-detail-modal');
  if (modal) modal.classList.remove('active');
}

// Bổ sung danh sách nhân viên vào Dropdown trong Customer Modal
export function populateManagedByDropdown() {
  const select = document.getElementById('cust-managed-by');
  if (!select) return;
  
  select.innerHTML = `
    <option value="">-- Chưa bàn giao / Trống --</option>
    ${state.users.map(u => `
      <option value="${u.username}">${u.displayName} (${u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale')})</option>
    `).join('')}
  `;
}

let custExcelImportData = [];
let custExcelDuplicateCodeCount = 0;
let isSelectingFile = false;

export function openCustExcelModal() {
  const modal = document.getElementById('cust-excel-modal');
  if (modal) {
    modal.classList.add('active');
    


    // Reset UI
    custExcelImportData = [];
    custExcelDuplicateCodeCount = 0;
    document.getElementById('cust-excel-file-input').value = '';
    document.getElementById('cust-excel-preview-container').style.display = 'none';
    const submitBtn = document.getElementById('btn-save-cust-excel-submit');
    if (submitBtn) {
      submitBtn.setAttribute('disabled', 'true');
      submitBtn.disabled = true;
    }
    const dropzone = document.getElementById('cust-excel-dropzone');
    if (dropzone) dropzone.className = 'upload-dropzone';
  }
}

export function closeCustExcelModal() {
  const modal = document.getElementById('cust-excel-modal');
  if (modal) modal.classList.remove('active');
}

function handleCustExcelFile(file) {
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array', cellDates: true });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      if (rows.length === 0) {
        showToast("Tập tin Excel trống!", "danger");
        return;
      }
      
      const headers = rows[0].map(h => (h || '').toString().trim());
      
      // Map columns
      const colMap = {
        code: headers.indexOf('Mã khách hàng'),
        name: headers.indexOf('Tên khách hàng'),
        phone: headers.indexOf('Điện thoại'),
        address: headers.indexOf('Địa chỉ'),
        excelBrand: headers.indexOf('Nhãn sơn') !== -1 ? headers.indexOf('Nhãn sơn') : headers.indexOf('Nhãn đại lý'),
        debt: headers.indexOf('Công nợ hiện tại') !== -1 ? headers.indexOf('Công nợ hiện tại') : (headers.indexOf('Công nợ') !== -1 ? headers.indexOf('Công nợ') : headers.indexOf('Nợ cần thu hiện tại')),
        totalTransaction: headers.indexOf('Tổng doanh số') !== -1 ? headers.indexOf('Tổng doanh số') : (headers.indexOf('Tổng bán') !== -1 ? headers.indexOf('Tổng bán') : headers.indexOf('Doanh số gốc')),
        totalReturns: headers.indexOf('Tổng giá trị trả hàng') !== -1 ? headers.indexOf('Tổng giá trị trả hàng') : headers.indexOf('Tổng trả hàng'),
        netSales: headers.indexOf('Doanh số sau trả'),
        excelPricelist: headers.indexOf('Bảng giá'),
        excelManager: headers.indexOf('Nhóm khách hàng') !== -1 ? headers.indexOf('Nhóm khách hàng') : (headers.indexOf('Người quản lý') !== -1 ? headers.indexOf('Người quản lý') : headers.indexOf('Người tạo')),
        notes: headers.indexOf('Ghi chú') !== -1 ? headers.indexOf('Ghi chú') : headers.indexOf('Ghi chu'),
        lastTransactionAt: headers.indexOf('Ngày giao dịch cuối') !== -1
          ? headers.indexOf('Ngày giao dịch cuối')
          : (headers.indexOf('Ngày giao dịch cuối cùng') !== -1
            ? headers.indexOf('Ngày giao dịch cuối cùng')
            : headers.indexOf('Giao dịch cuối')),
        createdAt: headers.indexOf('Ngày tạo'),
        debtDays: headers.indexOf('Số ngày nợ'),
      };
      
      if (colMap.name === -1) {
        showToast("Tập tin không có cột 'Tên khách hàng'!", "danger");
        return;
      }
      
      const defaultManager = 'nhat';
      const defaultBrand = 'Tất cả';
      const defaultPricelist = 'custom';
      
      // Fuzzy matcher helper for managers
      const findUserByExcelName = (excelName) => {
        if (!excelName) return null;
        let nameLower = excelName.toString().toLowerCase().trim();
        
        // Chuyển đổi biệt danh/tên tắt sang tên đầy đủ trong hệ thống
        if (nameLower === 'mr thụy' || nameLower === 'mr thuy' || nameLower === 'thụy' || nameLower === 'thuy') {
          nameLower = 'nguyễn thanh thụy';
        } else if (nameLower === 'mr dương hoàn' || nameLower === 'mr duong hoan' || nameLower === 'dương hoàn' || nameLower === 'duong hoan') {
          nameLower = 'dương như hoàn';
        }
        
        // Exact or direct match
        let found = state.users.find(u => 
          u.username.toLowerCase() === nameLower || 
          u.displayName.toLowerCase() === nameLower
        );
        if (found) return found;
        
        // Strip prefixes (Mr., Ms., Anh, Chị)
        const cleanExcelName = nameLower.replace(/^(mr|ms|mrs|anh|chị)\.?\s+/gi, '').trim();
        
        found = state.users.find(u => {
          const cleanUserDisp = u.displayName.toLowerCase().replace(/^(mr|ms|mrs|anh|chị)\.?\s+/gi, '').trim();
          return cleanUserDisp === cleanExcelName || u.username.toLowerCase() === cleanExcelName;
        });
        if (found) return found;
        
        // Fuzzy search: check if displayName contains clean name or vice-versa
        found = state.users.find(u => {
          const cleanUserDisp = u.displayName.toLowerCase().replace(/^(mr|ms|mrs|anh|chị)\.?\s+/gi, '').trim();
          return cleanUserDisp.includes(cleanExcelName) || cleanExcelName.includes(cleanUserDisp);
        });
        return found;
      };

      custExcelImportData = [];
      custExcelDuplicateCodeCount = 0;
      const previewRows = [];
      const importTimestamp = new Date().toISOString();
      
      const provinces = Object.entries(PROVINCES).map(([code, name]) => ({ code, name }));
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        
        let name = colMap.name !== -1 ? (row[colMap.name] || '').toString().trim().normalize('NFC') : '';
        if (!name) continue; // skip rows without name
        
        let code = colMap.code !== -1 ? (row[colMap.code] || '').toString().trim().toUpperCase().normalize('NFC') : '';
        let phone = colMap.phone !== -1 ? (row[colMap.phone] || '').toString().trim() : '';
        let address = colMap.address !== -1 ? (row[colMap.address] || '').toString().trim() : '';
        let debt = colMap.debt !== -1 ? parseImportedNumber(row[colMap.debt]) : 0;
        let totalTransaction = colMap.totalTransaction !== -1 ? parseImportedNumber(row[colMap.totalTransaction]) : 0;
        let totalReturn = colMap.totalReturns !== -1 ? parseImportedNumber(row[colMap.totalReturns]) : 0;
        let netRevenue = colMap.netSales !== -1 ? parseImportedNumber(row[colMap.netSales]) : Math.max(0, totalTransaction - totalReturn);
        let notes = colMap.notes !== -1 && row[colMap.notes] ? row[colMap.notes].toString().trim() : '';
        let lastTransactionAt = colMap.lastTransactionAt !== -1
          ? parseImportedDate(row[colMap.lastTransactionAt])
          : '';
        let createdAt = colMap.createdAt !== -1 ? parseImportedDate(row[colMap.createdAt]) : '';
        let debtDays = colMap.debtDays !== -1
          ? Math.max(0, Math.trunc(parseImportedNumber(row[colMap.debtDays])))
          : null;
        
        const nameLower = name.toLowerCase();
        const codeLower = code.toLowerCase();

        // Brand assignment
        let assignedBrand = defaultBrand;
        let excelBrandVal = colMap.excelBrand !== -1 && row[colMap.excelBrand] ? row[colMap.excelBrand].toString().trim() : '';
        if (excelBrandVal) {
          assignedBrand = excelBrandVal;
        } else {
          // Auto detect brand if not explicitly provided
          if (nameLower.includes('nano10') || nameLower.includes('nano 10') || codeLower.includes('nano10') || codeLower.includes('nano 10')) assignedBrand = 'Nano10*';
          else if (nameLower.includes('hatacco') || codeLower.includes('hatacco')) assignedBrand = 'Hatacco nano';
          else if (nameLower.includes('mutsutec') || nameLower.includes('mutsu') || codeLower.includes('mutsutec') || codeLower.includes('mutsu')) assignedBrand = 'mutsutec';
          else if (nameLower.includes('tdkaw') || codeLower.includes('tdkaw')) assignedBrand = 'tdkaw';
          else if (nameLower.includes('cova') || codeLower.includes('cova')) assignedBrand = 'cova';
          else if (nameLower.includes('festiva') || codeLower.includes('festiva')) assignedBrand = 'festiva';
        }

        
        // Auto detect pricelist
        let pricelistId = '';
        let excelPlVal = colMap.excelPricelist !== -1 && row[colMap.excelPricelist] ? row[colMap.excelPricelist].toString().trim() : '';
        if (excelPlVal) {
          const foundPl = state.pricelists.find(p => p.name.toLowerCase() === excelPlVal.toLowerCase() || p.id.toLowerCase() === excelPlVal.toLowerCase() || p.name.includes(excelPlVal));
          if (foundPl) {
            pricelistId = foundPl.id;
          }
        } else {
          const matchBG = code.match(/BG(\d+)/i);
          if (matchBG) {
            const rawNum = parseInt(matchBG[1]);
            const numStr = rawNum.toString().padStart(2, '0');
            const numStrShort = rawNum.toString();
            const foundPl = state.pricelists.find(p => 
              p.name.includes(numStr) || p.id.includes(numStr) ||
              p.name.includes(numStrShort) || p.id.includes(numStrShort)
            );
            if (foundPl) {
              pricelistId = foundPl.id;
            }
          }
        }
        
        // Auto detect province from address or code
        let provinceCode = 'OTHER';
        const addressLower = address.toLowerCase();
        for (const prov of provinces) {
          const provNameLower = prov.name.toLowerCase();
          if (addressLower.includes(provNameLower) || codeLower.includes(provNameLower)) {
            provinceCode = prov.code;
            break;
          }
        }
        
        if (!code) {
          code = generateUniqueCustomerCode(provinceCode);
        }
        
        const customerObj = {
          id: `cust-${Date.now()}-${i}-${Math.floor(Math.random() * 1000)}`,
          code: code,
          name: name,
          phone: phone,
          address: address,
          assignedBrand: assignedBrand,
          brandDiscounts: {
            province: provinceCode,
            salesBaselineImportedAt: importTimestamp,
            ...(debtDays !== null ? { debtDays } : {})
          },
          shippingSupport: false,
          debt: debt,
          totalTransaction: totalTransaction,
          totalReturn: totalReturn,
          netRevenue: netRevenue,
          debtDays: debtDays ?? 0,
          lastOrderAt: lastTransactionAt || null,
          createdAt: createdAt || null,
          salesBaselineImportedAt: importTimestamp,
          notes: notes || 'Imported from KiotViet',
          pricelistId: pricelistId,
          managedBy: (() => {
            // 1. Nếu Excel có cột Người quản lý và có giá trị, tìm khớp
            if (colMap.excelManager !== -1 && row[colMap.excelManager]) {
              const val = row[colMap.excelManager].toString().trim();
              if (val) {
                const valL = val.toLowerCase();
                if (valL.includes('abs japan')) return 'ctyabs@lendon.com';
                if (valL.includes('emp hoa kỳ') || valL.includes('emp hoa ky')) return 'emp_hoa_ky';
                
                const u = findUserByExcelName(val);
                if (u) return u.username;
              }
            }
            // 2. Nếu trống, để trống hoàn toàn để kế toán tự rà soát sau
            return '';
          })(),
          debtHistory: debt !== 0 ? [{
            date: new Date().toISOString(),
            type: 'adjust',
            amount: debt,
            debtAfter: debt,
            notes: 'Số dư đầu kỳ nhập từ KiotViet'
          }] : []
        };
        
        custExcelImportData.push(customerObj);
      }
      
      if (custExcelImportData.length === 0) {
        showToast("Không phân tích được khách hàng nào hợp lệ!", "warning");
        return;
      }

      custExcelDuplicateCodeCount = makeImportCustomerCodesUnique(custExcelImportData);
      custExcelImportData.slice(0, 5).forEach(customer => {
        previewRows.push({
          code: customer.code,
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          province: customer.brandDiscounts?.province || 'OTHER',
          pricelistId: customer.pricelistId,
          debt: customer.debt,
          totalTransaction: customer.totalTransaction,
          totalReturn: customer.totalReturn,
          netRevenue: customer.netRevenue,
          lastOrderAt: customer.lastOrderAt,
          createdAt: customer.createdAt,
          debtDays: customer.debtDays
        });
      });
      
      // Render preview table
      const previewBody = document.getElementById('cust-excel-preview-table-body');
      if (previewBody) {
        previewBody.innerHTML = previewRows.map((c, idx) => {
          const pl = state.pricelists.find(p => p.id === c.pricelistId);
          const plName = pl ? pl.name : (c.pricelistId === 'custom' ? 'Chiết khấu riêng' : 'Chiết khấu riêng');
          const provName = provinces.find(p => p.code === c.province)?.name || 'Khác';
          return `
            <tr>
              <td style="text-align: center;">${idx + 1}</td>
              <td style="font-weight: 600;">${c.code}</td>
              <td>${c.name}</td>
              <td>${c.phone || '-'}</td>
              <td>[${provName}] ${c.address || '-'}</td>
              <td>${plName}</td>
              <td style="text-align: center; white-space: nowrap;">${c.lastOrderAt ? formatDateOnly(c.lastOrderAt) : '-'}</td>
              <td style="text-align: center; white-space: nowrap;">${c.createdAt ? formatDateOnly(c.createdAt) : '-'}</td>
              <td style="text-align: center;">${c.debtDays}</td>
              <td style="text-align: right;">${formatCurrency(c.debt)}</td>
              <td style="text-align: right;">${formatCurrency(c.totalTransaction)}</td>
            </tr>
          `;
        }).join('');
      }
      
      const summaryText = document.getElementById('cust-excel-preview-summary');
      if (summaryText) {
        const totals = calculateCustomerTotals(custExcelImportData);
        summaryText.innerHTML = `
          Đã đọc <strong>${totals.count}</strong> khách hàng.
          Công nợ: <strong>${formatCurrency(totals.debt)}</strong> ·
          Doanh số: <strong>${formatCurrency(totals.grossSales)}</strong> ·
          Trả hàng: <strong>${formatCurrency(totals.totalReturns)}</strong> ·
          Sau trả hàng: <strong>${formatCurrency(totals.netSales)}</strong>
          ${custExcelDuplicateCodeCount > 0
            ? ` · Đã đổi mã cho <strong>${custExcelDuplicateCodeCount}</strong> dòng bị trùng để lưu đủ dữ liệu.`
            : ''}
        `;
      }
      
      const previewContainer = document.getElementById('cust-excel-preview-container');
      if (previewContainer) previewContainer.style.display = 'block';
      
      const submitBtn = document.getElementById('btn-save-cust-excel-submit');
      if (submitBtn) {
        submitBtn.removeAttribute('disabled');
        submitBtn.disabled = false;
      }
      
      const dropzone = document.getElementById('cust-excel-dropzone');
      if (dropzone) dropzone.className = 'upload-dropzone success-uploaded';
      
      showToast(`Đọc tệp thành công! Tìm thấy ${custExcelImportData.length} khách hàng.`, "success");
    } catch (err) {
      console.error(err);
      showToast("Lỗi đọc tập tin Excel: " + err.message, "danger");
    } finally {
      const el = document.getElementById('cust-excel-file-input');
      if (el) el.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processCustomerExcelImport() {
  if (custExcelImportData.length === 0) return;
  
  const mode = document.querySelector('input[name="cust-import-mode"]:checked').value;
  
  try {
    showToast("Đang đồng bộ dữ liệu đám mây mới nhất...", "info");
    await dbFetchCustomers();
    
    showToast("Đang nhập dữ liệu khách hàng vào hệ thống...", "info");
    
    // Import mode overwrite: delete existing customers
    if (mode === 'overwrite') {
      if (confirm("Chế độ ghi đè sẽ xóa sạch toàn bộ khách hàng hiện tại của bạn. Bạn chắc chắn chứ?")) {
        const deleted = await dbDeleteAllCustomers();
        if (!deleted) return;
        state.customers = [];
      } else {
        return;
      }
    }
    
    // Mỗi khách hiện có chỉ được ghép một lần để các mã trùng trong Excel
    // vẫn được giữ thành các dòng khách hàng riêng biệt.
    const claimedExistingIds = new Set();
    for (const c of custExcelImportData) {
      let idx = -1;
      if (mode === 'merge') {
        const cCodeClean = c.code.trim().toUpperCase().normalize('NFC');
        idx = state.customers.findIndex(oc =>
          !claimedExistingIds.has(oc.id) &&
          (oc.code || '').toString().trim().toUpperCase().normalize('NFC') === cCodeClean
        );
      }
      
      if (idx > -1) {
        // Update existing customer
        const oldId = state.customers[idx].id;
        claimedExistingIds.add(oldId);
        c.id = oldId; // keep original ID
        
        // Merge debt histories
        const oldHistory = state.customers[idx].debtHistory || [];
        c.debtHistory = [...oldHistory, ...c.debtHistory];
        c.lastOrderAt = c.lastOrderAt || state.customers[idx].lastOrderAt || state.customers[idx].last_order_at || null;
        c.lastPaymentAt = state.customers[idx].lastPaymentAt || state.customers[idx].last_payment_at || null;
        c.createdAt = c.createdAt || state.customers[idx].createdAt || state.customers[idx].created_at || new Date().toISOString();
        if (c.brandDiscounts?.debtDays === undefined && state.customers[idx].brandDiscounts?.debtDays !== undefined) {
          c.brandDiscounts.debtDays = state.customers[idx].brandDiscounts.debtDays;
          c.debtDays = state.customers[idx].brandDiscounts.debtDays;
        }
        
        state.customers[idx] = c;
      } else {
        // Insert new customer
        c.createdAt = c.createdAt || new Date().toISOString();
        state.customers.push(c);
      }
    }
    
    // Perform a single BULK UPSERT to Supabase (de-duplicate by id to prevent Postgres ON CONFLICT error)
    const uniqueImportMap = new Map();
    for (const c of custExcelImportData) {
      uniqueImportMap.set(c.id, c);
    }
    const uniqueImportData = Array.from(uniqueImportMap.values());
    
    const saved = await dbSaveCustomersBulk(uniqueImportData);
    if (saved) {
      const expectedTotals = calculateCustomerTotals(uniqueImportData);
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      const refreshedFromCloud = await dbFetchCustomers();
      const importedIds = new Set(uniqueImportData.map(customer => customer.id));
      const persistedImportData = refreshedFromCloud
        ? state.customers.filter(customer => importedIds.has(customer.id))
        : uniqueImportData;
      const persistedTotals = calculateCustomerTotals(persistedImportData);

      if (persistedImportData.length !== uniqueImportData.length || !customerTotalsMatch(expectedTotals, persistedTotals)) {
        console.error('Customer Excel import verification failed', { expectedTotals, persistedTotals });
        showToast(
          `Dữ liệu lưu chưa khớp file. Mong đợi ${formatCurrency(expectedTotals.grossSales)}, máy chủ trả về ${formatCurrency(persistedTotals.grossSales)}.`,
          "danger"
        );
        return;
      }

      renderAll();
      closeCustExcelModal();
      showToast(
        `Đã nhập đủ ${uniqueImportData.length} khách hàng · Doanh số ${formatCurrency(persistedTotals.grossSales)} · Sau trả hàng ${formatCurrency(persistedTotals.netSales)}.`,
        "success"
      );
    }
  } catch (err) {
    console.error(err);
    showToast("Lỗi lưu dữ liệu khách hàng: " + err.message, "danger");
  }
}
