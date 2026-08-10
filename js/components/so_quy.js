import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatDateTime } from '../utils.js';
import { renderAll } from '../main.js?v=20260810-order-finalize1';
import { dbSaveCashbookTransaction, dbSaveStartingBalances, dbRecordCustomerPayment, dbCancelCashbookEntry, dbSetCashbookStarred, dbUpdateManualCashbookTransaction, dbReconcileLegacyCustomerReceipt, dbRefreshCustomerFinancialState, dbFetchCashbookTransactions } from '../services/supabase.js?v=20260810-order-finalize1';
import { getCanonicalCashbookId } from '../domain/cashbook.js?v=20260810-order-finalize1';

// Seed transactions (empty to start clean)
const seedTransactions = [];
let pendingReceiptIdempotencyKey = '';

function escapeCashbookHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function getTransactionPartnerAddress(transaction = {}) {
  const directAddress = transaction.partnerAddress || transaction.partner_address;
  if (directAddress) return String(directAddress).trim();

  const customer = transaction.customerId
    ? (state.customers || []).find(item => String(item.id) === String(transaction.customerId))
    : (transaction.type === 'thu' ? findCustomerByInput(transaction.partner) : null);
  if (customer) return String(customer.address || customer.invoiceAddress || '').trim();

  const supplier = transaction.supplierId
    ? (state.suppliers || []).find(item => String(item.id) === String(transaction.supplierId))
    : findSupplierByInput(transaction.partner);
  return String(supplier?.address || '').trim();
}

function canEditCashbookTransaction(transaction = {}) {
  return ['admin', 'accounting'].includes(state.currentUser?.role)
    && !isCancelledStatus(transaction.status)
    && ['manual_thu', 'manual_chi'].includes(String(transaction.transactionType || '').toLowerCase());
}

function toLocalDateTimeInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

// Helper: load/save transactions from LocalStorage
export function getCashbookTransactions() {
  const stored = localStorage.getItem('billing_system_cashbook_transactions');
  if (stored) {
    let txs = JSON.parse(stored).map(t => {
      const rawNote = t.note || '';
      const supplierMeta = rawNote.match(/__supplierId=([^\s]+)/);
      return {
        ...t,
        supplierId: t.supplierId || (supplierMeta ? supplierMeta[1] : null),
        note: rawNote.replace(/\s*__supplierId=[^\s]+/g, '').trim()
      };
    });
    // Filter out old seed transaction IDs and auto-generated order receipts from storage
    const seedIds = ["TTM001686", "TTM001685", "TTM001684", "TTM001683", "TTM001682", "TTM001681", "TTM001680", "TTM001678", "TTM001679", "TTM001600"];
    const filtered = txs.filter(t => {
      if (seedIds.includes(t.id)) return false;
      const isAutoOrderReceipt = t.note && t.note.startsWith('Thu tiền hàng cho hóa đơn');
      return !isAutoOrderReceipt;
    });
    if (filtered.length !== txs.length) {
      localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify(filtered));
      return filtered;
    }
    return txs;
  }
  localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify([]));
  return [];
}

export function saveCashbookTransactions(txs) {
  localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify(txs));
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function isPaidStatus(status) {
  const clean = normalizeText(status || 'Đã thanh toán');
  return clean === 'completed' || clean === 'paid' || clean.includes('thanh');
}

function isCancelledStatus(status) {
  const clean = normalizeText(status);
  return clean === 'cancelled' || clean === 'canceled' || clean.includes('hủy') || clean.includes('huy') || clean.includes('cancel');
}

function findCustomerByInput(input) {
  const clean = normalizeText(input);
  if (!clean) return null;
  return (state.customers || []).find(customer => {
    const name = normalizeText(customer.name);
    const code = normalizeText(customer.code);
    return clean === name
      || (code && clean === code)
      || (name && code && (clean === `${name} — ${code}` || clean === `${name} - ${code}`));
  }) || null;
}

function getLegacyReceiptCustomer(transaction = {}) {
  const transactionType = normalizeText(transaction.transactionType);
  const supportedLegacyTypes = ['', 'manual_thu', 'thu nợ khách hàng', 'thu tiền khách hàng'];
  if (!['admin', 'accounting'].includes(state.currentUser?.role)
      || transaction.type !== 'thu'
      || isCancelledStatus(transaction.status)
      || transaction.debtImpact
      || !supportedLegacyTypes.includes(transactionType)) {
    return null;
  }
  const category = normalizeText(`${transaction.category || ''} ${transaction.note || ''}`);
  if (!category.includes('nợ')
      && !category.includes('tiền hàng')
      && !category.includes('tiền khách hàng')
      && !category.includes('trả trước')) {
    return null;
  }
  if (transaction.customerId) {
    return (state.customers || []).find(customer => String(customer.id) === String(transaction.customerId)) || null;
  }
  const clean = normalizeText(transaction.partner);
  const matches = (state.customers || []).filter(customer => {
    const name = normalizeText(customer.name);
    const code = normalizeText(customer.code);
    return clean === name
      || (code && clean === code)
      || (name && code && (clean === `${name} — ${code}` || clean === `${name} - ${code}`));
  });
  return matches.length === 1 ? matches[0] : null;
}

function findSupplierByInput(input) {
  const raw = String(input || '').trim();
  const clean = normalizeText(raw);
  if (!clean) return null;
  return (state.suppliers || []).find(s => {
    const name = normalizeText(s.name);
    const code = normalizeText(s.code);
    return clean === name ||
      clean === code ||
      clean === `${name} — ${code}` ||
      clean === `${name} - ${code}` ||
      clean.includes(code) ||
      clean.includes(name);
  }) || null;
}

function populatePaymentRecipientDatalist() {
  const datalist = document.getElementById('payment-recipient-list');
  if (!datalist) return;
  datalist.innerHTML = (state.suppliers || []).map(s => {
    return `<option value="${s.name} — ${s.code}" data-supplier-id="${s.id}">${s.phone || 'N/A'}</option>`;
  }).join('');
}

// Helper: load/save starting balances
export function getStartingBalances() {
  const defaults = {
    cash: 0,
    bank: 0,
    wallet: 0
  };
  const stored = localStorage.getItem('billing_system_cashbook_start_balances');
  if (stored) {
    const parsed = JSON.parse(stored);
    // If the storage contains the large KiotViet sample initial balance, reset it to 0
    if (parsed.cash === 7620470195) {
      localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify(defaults));
      return defaults;
    }
    return parsed;
  }
  localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify(defaults));
  return defaults;
}

export async function saveStartingBalances(balances) {
  const saved = await dbSaveStartingBalances(balances);
  if (!saved) return false;
  localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify(balances));
  return true;
}

// Global active filters in this view
let activeFilters = {
  accountType: 'cash', // 'cash', 'bank', 'wallet', 'all'
  timeMode: 'month',   // 'month', 'custom'
  startDate: '',       // YYYY-MM-DD
  endDate: '',         // YYYY-MM-DD
  showThu: true,
  showChi: true,
  category: 'all',
  statusPaid: true,
  statusCancelled: false,
  accounting: 'all',   // 'all', 'yes', 'no'
  creator: 'all',
  searchQuery: '',
  employee: 'all',
  partnerType: 'all',
  partnerSearch: '',
  partnerPhone: '',
  debtImpactYes: true,
  debtImpactNo: true,
  debtImpactNone: true
};

// setup listeners
export function setupSoQuyPanel() {
  // 1. Account type selection (Quỹ tiền)
  document.querySelectorAll('input[name="so-quy-acc-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      activeFilters.accountType = e.target.value;
      const titleDisplay = document.getElementById('so-quy-title-display');
      if (titleDisplay) {
        if (activeFilters.accountType === 'cash') titleDisplay.innerText = 'Sổ quỹ tiền mặt';
        else if (activeFilters.accountType === 'bank') titleDisplay.innerText = 'Sổ quỹ ngân hàng';
        else if (activeFilters.accountType === 'wallet') titleDisplay.innerText = 'Sổ quỹ ví điện tử';
        else titleDisplay.innerText = 'Tổng sổ quỹ';
      }
      renderSoQuyTable();
    });
  });

  // 2. Time filter selection
  document.querySelectorAll('input[name="so-quy-time"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      activeFilters.timeMode = e.target.value;
      const rangeInputs = document.getElementById('so-quy-sidebar-range-inputs');
      if (rangeInputs) {
        rangeInputs.style.display = activeFilters.timeMode === 'custom' ? 'flex' : 'none';
      }
      renderSoQuyTable();
    });
  });

  // Start & End dates for custom range
  const dateFromInput = document.getElementById('so-quy-sidebar-from');
  const dateToInput = document.getElementById('so-quy-sidebar-to');
  
  // Set defaults for custom range (current month)
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  if (dateFromInput) {
    dateFromInput.value = `${yyyy}-${mm}-01`;
    activeFilters.startDate = dateFromInput.value;
    dateFromInput.addEventListener('input', (e) => {
      activeFilters.startDate = e.target.value;
      renderSoQuyTable();
    });
  }
  if (dateToInput) {
    const lastDay = new Date(yyyy, today.getMonth() + 1, 0).getDate();
    dateToInput.value = `${yyyy}-${mm}-${String(lastDay).padStart(2, '0')}`;
    activeFilters.endDate = dateToInput.value;
    dateToInput.addEventListener('input', (e) => {
      activeFilters.endDate = e.target.value;
      renderSoQuyTable();
    });
  }

  // 3. Document types
  const typeThuCb = document.getElementById('so-quy-type-thu');
  const typeChiCb = document.getElementById('so-quy-type-chi');
  if (typeThuCb) {
    typeThuCb.addEventListener('change', (e) => {
      activeFilters.showThu = e.target.checked;
      renderSoQuyTable();
    });
  }
  if (typeChiCb) {
    typeChiCb.addEventListener('change', (e) => {
      activeFilters.showChi = e.target.checked;
      renderSoQuyTable();
    });
  }

  // 4. Categories select (filled dynamically)
  const catSelect = document.getElementById('so-quy-category-select');
  if (catSelect) {
    catSelect.addEventListener('change', (e) => {
      activeFilters.category = e.target.value;
      renderSoQuyTable();
    });
  }

  // 5. Status
  const statusPaidCb = document.getElementById('so-quy-status-paid');
  const statusCancelledCb = document.getElementById('so-quy-status-cancelled');
  if (statusPaidCb) {
    statusPaidCb.addEventListener('change', (e) => {
      activeFilters.statusPaid = e.target.checked;
      renderSoQuyTable();
    });
  }
  if (statusCancelledCb) {
    statusCancelledCb.addEventListener('change', (e) => {
      activeFilters.statusCancelled = e.target.checked;
      renderSoQuyTable();
    });
  }

  // 6. Business Results Accounting (Hạch toán kết quả kinh doanh) - Pill Group
  document.querySelectorAll('.kiot-pill-group .kiot-pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const parent = btn.closest('.kiot-pill-group');
      parent.querySelectorAll('.kiot-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilters.accounting = btn.getAttribute('data-value');
      renderSoQuyTable();
    });
  });

  // 7. Creator select (filled dynamically)
  const creatorSelect = document.getElementById('so-quy-creator-select');
  if (creatorSelect) {
    creatorSelect.addEventListener('change', (e) => {
      activeFilters.creator = e.target.value;
      renderSoQuyTable();
    });
  }

  // 8. Employee select (filled dynamically)
  const employeeSelect = document.getElementById('so-quy-employee-select');
  if (employeeSelect) {
    employeeSelect.addEventListener('change', (e) => {
      activeFilters.employee = e.target.value;
      renderSoQuyTable();
    });
  }

  // 9. Partner type select
  const partnerTypeSelect = document.getElementById('so-quy-partner-type');
  if (partnerTypeSelect) {
    partnerTypeSelect.addEventListener('change', (e) => {
      activeFilters.partnerType = e.target.value;
      renderSoQuyTable();
    });
  }

  // 10. Partner name / code search
  const partnerSearchInput = document.getElementById('so-quy-partner-search');
  if (partnerSearchInput) {
    partnerSearchInput.addEventListener('input', (e) => {
      activeFilters.partnerSearch = e.target.value.toLowerCase().trim();
      renderSoQuyTable();
    });
  }

  // 11. Partner phone search
  const partnerPhoneInput = document.getElementById('so-quy-partner-phone');
  if (partnerPhoneInput) {
    partnerPhoneInput.addEventListener('input', (e) => {
      activeFilters.partnerPhone = e.target.value.trim();
      renderSoQuyTable();
    });
  }

  // 12. Partner debt impact checkboxes
  const debtImpactYesCb = document.getElementById('so-quy-debt-impact-yes');
  const debtImpactNoCb = document.getElementById('so-quy-debt-impact-no');
  const debtImpactNoneCb = document.getElementById('so-quy-debt-impact-none');

  if (debtImpactYesCb) {
    debtImpactYesCb.addEventListener('change', (e) => {
      activeFilters.debtImpactYes = e.target.checked;
      renderSoQuyTable();
    });
  }
  if (debtImpactNoCb) {
    debtImpactNoCb.addEventListener('change', (e) => {
      activeFilters.debtImpactNo = e.target.checked;
      renderSoQuyTable();
    });
  }
  if (debtImpactNoneCb) {
    debtImpactNoneCb.addEventListener('change', (e) => {
      activeFilters.debtImpactNone = e.target.checked;
      renderSoQuyTable();
    });
  }

  // 13. Search query input (Mã phiếu, v.v.)
  const searchInput = document.getElementById('so-quy-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      activeFilters.searchQuery = e.target.value.toLowerCase().trim();
      renderSoQuyTable();
    });
  }

  // 14. Table select-all checkbox
  const selectAllCb = document.getElementById('so-quy-select-all');
  if (selectAllCb) {
    selectAllCb.addEventListener('change', (e) => {
      const checkVal = e.target.checked;
      document.querySelectorAll('.so-quy-row-checkbox').forEach(cb => {
        cb.checked = checkVal;
      });
    });
  }

  // 15. Manual edit starting balance (Double click balance value)
  const startBalEl = document.getElementById('so-quy-stat-start');
  if (startBalEl) {
    startBalEl.style.cursor = 'pointer';
    startBalEl.title = 'Kích đúp để thay đổi Quỹ đầu kỳ';
    startBalEl.addEventListener('dblclick', async () => {
      const type = activeFilters.accountType;
      if (type === 'all') {
        showToast('Vui lòng chọn cụ thể một loại Quỹ (Tiền mặt, Ngân hàng, Ví điện tử) để thay đổi quỹ đầu kỳ.', 'warning');
        return;
      }
      const balances = getStartingBalances();
      const currentVal = balances[type] || 0;
      const newValStr = prompt(`Nhập số tiền quỹ đầu kỳ mới cho quỹ [${type === 'cash' ? 'Tiền mặt' : type === 'bank' ? 'Ngân hàng' : 'Ví điện tử'}]:`, currentVal);
      if (newValStr !== null) {
        const newVal = parseFloat(newValStr.replace(/,/g, ''));
        if (!isNaN(newVal)) {
          const nextBalances = { ...balances, [type]: newVal };
          if (await saveStartingBalances(nextBalances)) {
            showToast('Đã cập nhật Quỹ đầu kỳ thành công!', 'success');
            renderSoQuyTable();
          }
        } else {
          showToast('Giá trị nhập vào không hợp lệ!', 'danger');
        }
      }
    });
  }

  // 16. Modal actions: + Phiếu thu
  const addThuBtn = document.getElementById('so-quy-btn-add-thu');
  const receiptModal = document.getElementById('so-quy-receipt-modal');
  const receiptForm = document.getElementById('so-quy-receipt-form');
  const receiptTimeInput = document.getElementById('receipt-time');
  
  if (addThuBtn && receiptModal) {
    addThuBtn.addEventListener('click', () => {
      // One stable key per modal attempt: retrying the same form is safe, while
      // a newly opened receipt can never reuse an older display-code key.
      pendingReceiptIdempotencyKey = globalThis.crypto.randomUUID();
      // Set time default to now in local format
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      if (receiptTimeInput) {
        receiptTimeInput.value = now.toISOString().slice(0, 16);
      }
      // Set method select to match current view filter
      const rMethod = document.getElementById('receipt-method');
      if (rMethod && ['cash','bank','wallet'].includes(activeFilters.accountType)) {
        rMethod.value = activeFilters.accountType;
      }
      receiptModal.classList.add('active');
    });
  }
  
  const closeReceiptBtn = document.getElementById('btn-close-receipt-modal');
  const cancelReceiptBtn = document.getElementById('btn-cancel-receipt-modal');
  
  const hideReceiptModal = () => {
    if (receiptModal) receiptModal.classList.remove('active');
    if (receiptForm) receiptForm.reset();
    pendingReceiptIdempotencyKey = '';
  };
  
  if (closeReceiptBtn) closeReceiptBtn.addEventListener('click', hideReceiptModal);
  if (cancelReceiptBtn) cancelReceiptBtn.addEventListener('click', hideReceiptModal);

  if (receiptForm) {
    receiptForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const code = document.getElementById('receipt-code').value.trim();
      const time = document.getElementById('receipt-time').value;
      const category = document.getElementById('receipt-category').value;
      const payer = document.getElementById('receipt-payer').value.trim();
      const value = parseFloat(document.getElementById('receipt-value').value) || 0;
      const method = document.getElementById('receipt-method').value;
      const accounting = document.getElementById('receipt-accounting').checked;
      const note = document.getElementById('receipt-note').value.trim();
      if (!pendingReceiptIdempotencyKey) {
        pendingReceiptIdempotencyKey = globalThis.crypto.randomUUID();
      }
      
      // Auto-generate code if empty
      let finalCode = code;
      const txs = getCashbookTransactions();
      if (!finalCode) {
        let maxSeq = 0;
        txs.forEach(t => {
          if (t.id.startsWith('TTM')) {
            const num = parseInt(t.id.slice(3));
            if (!isNaN(num) && num > maxSeq) maxSeq = num;
          }
        });
        finalCode = `TTM${String(maxSeq + 1).padStart(6, '0')}`;
      } else {
        // Verify unique code
        if (txs.some(t => t.id.toLowerCase() === finalCode.toLowerCase())) {
          showToast(`Mã phiếu ${finalCode} đã tồn tại! Vui lòng nhập mã khác.`, 'danger');
          return;
        }
      }
      
      const newTx = {
        id: finalCode,
        date: new Date(time).toISOString(),
        type: 'thu',
        category,
        partner: payer,
        value,
        method,
        accounting,
        status: 'Đã thanh toán',
        creator: state.currentUser ? state.currentUser.displayName : 'Administrator',
        note,
        starred: false,
        idempotencyKey: pendingReceiptIdempotencyKey
      };
      
      const normalizedCategory = category.toLowerCase();
      const affectsCustomerDebt = normalizedCategory.includes('nợ')
        || normalizedCategory.includes('tiền hàng')
        || normalizedCategory.includes('tiền khách hàng')
        || normalizedCategory.includes('trả trước');
      let paymentResult = null;
      let matchedCustomer = null;

      if (affectsCustomerDebt) {
        const selectedOption = Array.from(
          document.getElementById('receipt-payer-list')?.options || []
        ).find(option => option.value === payer);
        const selectedCustomerId = selectedOption?.dataset.customerId || '';
        const customerMatches = state.customers.filter(c =>
          String(c.name || '').trim().toLowerCase() === payer.toLowerCase()
        );
        matchedCustomer = selectedCustomerId
          ? state.customers.find(c => String(c.id) === selectedCustomerId)
          : (customerMatches.length === 1 ? customerMatches[0] : null);

        if (!matchedCustomer) {
          showToast('Phiếu thu công nợ phải chọn đúng một khách hàng trong danh sách!', 'danger');
          return;
        }

        newTx.partner = matchedCustomer.name;
        if (value <= 0) {
          showToast('Số tiền thu phải lớn hơn 0!', 'danger');
          return;
        }

        paymentResult = await dbRecordCustomerPayment(
          matchedCustomer.id,
          value,
          note || `${category} - ${finalCode}`,
          method,
          pendingReceiptIdempotencyKey
        );
        if (!paymentResult) return;

        const newDebt = Number(paymentResult.new_debt);
        if (!Number.isFinite(newDebt)) {
          showToast('Database không trả về số công nợ mới. Phiếu thu chưa được ghi nhận trên giao diện.', 'danger');
          return;
        }

        // Re-read the authoritative balance after the transaction. Realtime can
        // replace the customer object while the RPC is in flight, so mutating
        // matchedCustomer here may otherwise update a detached, stale object.
        const refreshedCustomer = await dbRefreshCustomerFinancialState(matchedCustomer.id);
        const currentCustomer = refreshedCustomer
          || state.customers.find(customer => String(customer.id) === String(matchedCustomer.id))
          || matchedCustomer;

        if (!refreshedCustomer) {
          currentCustomer.debt = newDebt;
          currentCustomer.lastPaymentAt = new Date().toISOString();
        }
        if (!refreshedCustomer && !paymentResult.already_recorded) {
          if (!currentCustomer.debtHistory) currentCustomer.debtHistory = [];
          currentCustomer.debtHistory.push({
            id: paymentResult.ledger_id || `pay-${finalCode}`,
            date: new Date().toISOString(),
            type: 'payment',
            amount: value,
            notes: note || `${category} - ${finalCode}`,
            debtAfter: newDebt
          });
        }
        localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));

        newTx.customerId = currentCustomer.id;
        newTx.cloudId = paymentResult.cashbook_id || null;
        newTx.debtImpact = true;
      } else {
        const savedToCloud = await dbSaveCashbookTransaction(newTx);
        if (!savedToCloud) {
          showToast('Không thể lưu phiếu thu lên Cloud. Dữ liệu trên form được giữ nguyên.', 'danger');
          return;
        }
        newTx.debtImpact = false;
      }

      txs.unshift(newTx);
      saveCashbookTransactions(txs);
      
      // Update customer debt (subtract debt balance)
      
      showToast(`Đã tạo phiếu thu ${finalCode} thành công!`, 'success');
      hideReceiptModal();
      renderAll();
    });
  }

  // 17. Modal actions: + Phiếu chi
  const addChiBtn = document.getElementById('so-quy-btn-add-chi');
  const paymentModal = document.getElementById('so-quy-payment-modal');
  const paymentForm = document.getElementById('so-quy-payment-form');
  const paymentTimeInput = document.getElementById('payment-time');
  
  if (addChiBtn && paymentModal) {
    addChiBtn.addEventListener('click', () => {
      populatePaymentRecipientDatalist();
      // Set time default to now
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      if (paymentTimeInput) {
        paymentTimeInput.value = now.toISOString().slice(0, 16);
      }
      // Set method select to match current view filter
      const pMethod = document.getElementById('payment-method');
      if (pMethod && ['cash','bank','wallet'].includes(activeFilters.accountType)) {
        pMethod.value = activeFilters.accountType;
      }
      paymentModal.classList.add('active');
    });
  }
  
  const closePaymentBtn = document.getElementById('btn-close-payment-modal');
  const cancelPaymentBtn = document.getElementById('btn-cancel-payment-modal');
  
  const hidePaymentModal = () => {
    if (paymentModal) paymentModal.classList.remove('active');
    if (paymentForm) paymentForm.reset();
  };
  
  if (closePaymentBtn) closePaymentBtn.addEventListener('click', hidePaymentModal);
  if (cancelPaymentBtn) cancelPaymentBtn.addEventListener('click', hidePaymentModal);

  if (paymentForm) {
    paymentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const code = document.getElementById('payment-code').value.trim();
      const time = document.getElementById('payment-time').value;
      const category = document.getElementById('payment-category').value;
      const recipient = document.getElementById('payment-recipient').value.trim();
      const value = parseFloat(document.getElementById('payment-value').value) || 0;
      const method = document.getElementById('payment-method').value;
      const accounting = document.getElementById('payment-accounting').checked;
      const note = document.getElementById('payment-note').value.trim();
      const matchedSupplier = findSupplierByInput(recipient);
      
      // Auto-generate code if empty
      let finalCode = code;
      const txs = getCashbookTransactions();
      if (!finalCode) {
        let maxSeq = 0;
        txs.forEach(t => {
          if (t.id.startsWith('TCM')) {
            const num = parseInt(t.id.slice(3));
            if (!isNaN(num) && num > maxSeq) maxSeq = num;
          }
        });
        finalCode = `TCM${String(maxSeq + 1).padStart(6, '0')}`;
      } else {
        // Verify unique code
        if (txs.some(t => t.id.toLowerCase() === finalCode.toLowerCase())) {
          showToast(`Mã phiếu ${finalCode} đã tồn tại! Vui lòng nhập mã khác.`, 'danger');
          return;
        }
      }
      
      const newTx = {
        id: finalCode,
        date: new Date(time).toISOString(),
        type: 'chi',
        category,
        partner: matchedSupplier ? matchedSupplier.name : recipient,
        supplierId: matchedSupplier ? matchedSupplier.id : null,
        value,
        method,
        accounting,
        status: 'Đã thanh toán',
        creator: state.currentUser ? state.currentUser.displayName : 'Administrator',
        note,
        starred: false
      };
      
      const savedToCloud = await dbSaveCashbookTransaction(newTx);
      if (!savedToCloud) {
        showToast('Không thể lưu phiếu chi vào Sổ quỹ Cloud. Dữ liệu trên form được giữ nguyên.', 'danger');
        return;
      }

      txs.unshift(newTx);
      saveCashbookTransactions(txs);
      
      showToast(`Đã tạo phiếu chi ${finalCode} thành công!`, 'success');
      hidePaymentModal();
      renderAll();
    });
  }

  // 18. Export file report
  const exportBtn = document.getElementById('so-quy-btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const data = getFilteredTransactionsForExport();
      if (data.length === 0) {
        showToast('Không có dữ liệu trong khoảng thời gian được lọc để xuất báo cáo!', 'warning');
        return;
      }
      exportSoQuyToExcel(data);
    });
  }

  // 19. Detail modal closes
  const detailModal = document.getElementById('so-quy-detail-modal');
  const closeDetailBtn = document.getElementById('btn-close-detail-modal');
  const closeDetailFooterBtn = document.getElementById('btn-close-detail-modal-footer');
  
  const hideDetailModal = () => {
    if (detailModal) detailModal.classList.remove('active');
  };
  
  if (closeDetailBtn) closeDetailBtn.addEventListener('click', hideDetailModal);
  if (closeDetailFooterBtn) closeDetailFooterBtn.addEventListener('click', hideDetailModal);

  const editModal = document.getElementById('so-quy-edit-modal');
  const editForm = document.getElementById('so-quy-edit-form');
  const hideEditModal = () => {
    editModal?.classList.remove('active');
    editForm?.reset();
    const editId = document.getElementById('cashbook-edit-id');
    if (editId) editId.value = '';
  };
  document.getElementById('btn-close-cashbook-edit')?.addEventListener('click', hideEditModal);
  document.getElementById('btn-cancel-cashbook-edit')?.addEventListener('click', hideEditModal);

  editForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const txId = document.getElementById('cashbook-edit-id')?.value || '';
    const transaction = getCashbookTransactions().find(item => String(item.id) === String(txId));
    if (!transaction || !canEditCashbookTransaction(transaction)) {
      showToast('Phiếu này không thuộc nhóm phiếu nhập tay được phép sửa.', 'warning');
      return;
    }

    const value = Number(document.getElementById('cashbook-edit-value')?.value || 0);
    const localDate = document.getElementById('cashbook-edit-time')?.value || '';
    const parsedDate = new Date(localDate);
    if (!Number.isFinite(value) || value <= 0 || Number.isNaN(parsedDate.getTime())) {
      showToast('Vui lòng nhập thời gian và giá trị phiếu hợp lệ.', 'danger');
      return;
    }

    const saveButton = document.getElementById('btn-save-cashbook-edit');
    if (saveButton) saveButton.disabled = true;
    try {
      const updated = await dbUpdateManualCashbookTransaction(getCanonicalCashbookId(transaction), {
        transactionDate: parsedDate.toISOString(),
        category: document.getElementById('cashbook-edit-category')?.value.trim() || '',
        partner: document.getElementById('cashbook-edit-partner')?.value.trim() || '',
        value,
        method: document.getElementById('cashbook-edit-method')?.value || 'cash',
        accounting: document.getElementById('cashbook-edit-accounting')?.checked === true,
        note: document.getElementById('cashbook-edit-note')?.value.trim() || ''
      });
      if (!updated) return;

      const refreshed = await dbFetchCashbookTransactions();
      if (!refreshed) {
        showToast('Phiếu đã sửa trên Cloud nhưng giao diện chưa tải lại được. Vui lòng tải lại trang.', 'warning');
      } else {
        showToast(`Đã cập nhật phiếu ${transaction.id}.`, 'success');
      }
      hideEditModal();
      hideDetailModal();
      renderAll();
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  });
}

// External helper to add automated transactions from Sales / Payments
export function addCashbookTransaction({
  id = '',
  type,
  category,
  partner,
  value,
  method,
  accounting = true,
  note = '',
  creator = '',
  customerId = null,
  supplierId = null,
  cloudId = null,
  debtImpact = false,
  syncToCloud = false
}) {
  const txs = getCashbookTransactions();
  
  const prefix = type === 'thu' ? 'TTM' : 'TCM';
  let maxSeq = 0;
  txs.forEach(t => {
    if (t.id.startsWith(prefix)) {
      const num = parseInt(t.id.slice(3));
      if (!isNaN(num) && num > maxSeq) maxSeq = num;
    }
  });
  
  const finalCode = id || `${prefix}${String(maxSeq + 1).padStart(6, '0')}`;
  const existing = txs.find(t => String(t.id).toLowerCase() === String(finalCode).toLowerCase());
  if (existing) return existing;
  
  const newTx = {
    id: finalCode,
    date: new Date().toISOString(),
    type,
    category,
    partner,
    value: parseFloat(value) || 0,
    method: method || 'cash', // 'cash', 'bank', 'wallet'
    accounting,
    status: 'Đã thanh toán',
    creator: creator || (state.currentUser ? state.currentUser.displayName : 'Administrator'),
    note,
    starred: false,
    customerId,
    supplierId,
    cloudId,
    debtImpact
  };
  
  txs.unshift(newTx);
  saveCashbookTransactions(txs);
  
  // Sync to Supabase in background
  if (syncToCloud) dbSaveCashbookTransaction(newTx);
  
  // Re-render when added dynamically
  setTimeout(() => renderAll(), 100);
  return newTx;
}

// Retrieve date range for current month
function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

// Retrieve currently filtered transactions for display/calculations
function getProcessedData() {
  const txs = getCashbookTransactions();
  const balances = getStartingBalances();
  
  // Define time range boundaries
  let rangeStart = null;
  let rangeEnd = null;
  
  if (activeFilters.timeMode === 'month') {
    const range = getCurrentMonthRange();
    rangeStart = range.start;
    rangeEnd = range.end;
  } else {
    if (activeFilters.startDate) {
      rangeStart = new Date(activeFilters.startDate);
      rangeStart.setHours(0, 0, 0, 0);
    }
    if (activeFilters.endDate) {
      rangeEnd = new Date(activeFilters.endDate);
      rangeEnd.setHours(23, 59, 59, 999);
    }
  }

  // 1. Calculate Quỹ đầu kỳ dynamically (transactions before rangeStart)
  // Quỹ đầu kỳ base for the selected account type
  let baseStartVal = 0;
  if (activeFilters.accountType === 'all') {
    baseStartVal = (balances.cash || 0) + (balances.bank || 0) + (balances.wallet || 0);
  } else {
    baseStartVal = balances[activeFilters.accountType] || 0;
  }
  
  let preIncome = 0;
  let preExpense = 0;
  
  if (rangeStart) {
    txs.forEach(t => {
      // Must be settled, match account type, and occur BEFORE the rangeStart
      if (!isPaidStatus(t.status)) return;
      
      if (activeFilters.accountType !== 'all' && t.method !== activeFilters.accountType) return;
      
      const tDate = new Date(t.date);
      if (tDate < rangeStart) {
        if (t.type === 'thu') preIncome += t.value;
        else if (t.type === 'chi') preExpense += t.value;
      }
    });
  }
  
  const calculatedStartBalance = baseStartVal + preIncome - preExpense;

  // 2. Filter transactions that are within the current date range
  let filtered = txs.filter(t => {
    // Account type
    if (activeFilters.accountType !== 'all' && t.method !== activeFilters.accountType) return false;
    
    // Time filter
    if (rangeStart || rangeEnd) {
      const tDate = new Date(t.date);
      if (rangeStart && tDate < rangeStart) return false;
      if (rangeEnd && tDate > rangeEnd) return false;
    }
    
    // Document type (Phiếu thu / Phiếu chi)
    if (t.type === 'thu' && !activeFilters.showThu) return false;
    if (t.type === 'chi' && !activeFilters.showChi) return false;
    
    // Category (Loại thu chi)
    if (activeFilters.category !== 'all' && t.category !== activeFilters.category) return false;
    
    // Status (Trạng thái)
    if (isPaidStatus(t.status) && !activeFilters.statusPaid) return false;
    if (isCancelledStatus(t.status) && !activeFilters.statusCancelled) return false;
    
    // Business Accounting (Hạch toán KQKD)
    if (activeFilters.accounting === 'yes' && !t.accounting) return false;
    if (activeFilters.accounting === 'no' && t.accounting) return false;
    
    // Creator (Người tạo)
    if (activeFilters.creator !== 'all' && t.creator !== activeFilters.creator) return false;

    // Filter by Employee (Nhân viên)
    if (activeFilters.employee !== 'all') {
      let matchesEmployee = false;
      const selectedUser = state.users.find(u => u.username === activeFilters.employee);
      if (selectedUser) {
        if (t.creator === selectedUser.displayName || t.creator === selectedUser.username) {
          matchesEmployee = true;
        }
      }
      
      const cust = state.customers.find(c => c.name === t.partner);
      if (cust && cust.managedBy === activeFilters.employee) {
        matchesEmployee = true;
      }
      
      if (!matchesEmployee) return false;
    }

    // Filter by Partner Type
    const linkedSupplier = t.supplierId
      ? state.suppliers.find(s => String(s.id) === String(t.supplierId))
      : findSupplierByInput(t.partner);
    const isCustomer = state.customers.some(c => c.name === t.partner) ||
                       t.category.toLowerCase().includes('khÃ¡ch hÃ ng') ||
                       t.category.toLowerCase().includes('tiá»n hÃ ng') ||
                       t.id.startsWith('TTM');
    const isSupplier = !!linkedSupplier ||
                       t.category.toLowerCase().includes('nháº­p hÃ ng') ||
                       t.category.toLowerCase().includes('nhÃ  cung cáº¥p') ||
                       t.id.startsWith('TCM');

    if (activeFilters.partnerType === 'customer') {
      if (!isCustomer) return false;
    } else if (activeFilters.partnerType === 'supplier') {
      if (!isSupplier) return false;
    } else if (activeFilters.partnerType === 'other') {
      if (isCustomer || isSupplier) return false;
    }
    // Filter by Partner Search Query (Tên, mã người nộp/nhận)
    if (activeFilters.partnerSearch) {
      const q = activeFilters.partnerSearch;
      let matchesPartner = t.partner.toLowerCase().includes(q);
      if (!matchesPartner) {
        const cust = state.customers.find(c => c.name === t.partner);
        if (cust && cust.code.toLowerCase().includes(q)) {
          matchesPartner = true;
        }
      }
      if (!matchesPartner && linkedSupplier) {
        matchesPartner = String(linkedSupplier.code || '').toLowerCase().includes(q) ||
          String(linkedSupplier.name || '').toLowerCase().includes(q);
      }
      if (!matchesPartner) return false;
    }

    // Filter by Partner Phone (Số điện thoại)
    if (activeFilters.partnerPhone) {
      const q = activeFilters.partnerPhone;
      const cust = state.customers.find(c => c.name === t.partner);
      const supplierPhoneMatch = linkedSupplier && linkedSupplier.phone && linkedSupplier.phone.includes(q);
      if ((!cust || !cust.phone || !cust.phone.includes(q)) && !supplierPhoneMatch) {
        return false;
      }
    }

    // Filter by Partner Debt Impact (Công nợ đối tác)
    // Classify transaction's debt impact:
    // 'yes' = affects customer debt (Thu nợ, Chi nợ v.v.)
    // 'none' = no partner / general accumulator
    // 'no' = other partner transactions (Thu tiền hàng v.v.)
    let debtImpact = 'no';
    if (t.category.toLowerCase().includes('nợ')) {
      debtImpact = 'yes';
    } else if (!t.partner || t.partner === 'Khách bán lẻ tích lũy đầu tháng' || t.partner === 'Hệ thống') {
      debtImpact = 'none';
    }

    if (debtImpact === 'yes' && !activeFilters.debtImpactYes) return false;
    if (debtImpact === 'no' && !activeFilters.debtImpactNo) return false;
    if (debtImpact === 'none' && !activeFilters.debtImpactNone) return false;
    
    // Search input (Mã phiếu, người nộp/nhận, ghi chú)
    if (activeFilters.searchQuery) {
      const idMatch = t.id.toLowerCase().includes(activeFilters.searchQuery);
      const partnerMatch = t.partner.toLowerCase().includes(activeFilters.searchQuery);
      const noteMatch = (t.note || '').toLowerCase().includes(activeFilters.searchQuery);
      if (!idMatch && !partnerMatch && !noteMatch) return false;
    }
    
    return true;
  });

  // 3. Calculate statistics for the CURRENT range
  let totalIncome = 0;
  let totalExpense = 0;
  
  filtered.forEach(t => {
    // Only count active (paid) transactions for statistics
    if (!isPaidStatus(t.status)) return;
    
    if (t.type === 'thu') totalIncome += t.value;
    else if (t.type === 'chi') totalExpense += t.value;
  });
  
  const finalBalance = calculatedStartBalance + totalIncome - totalExpense;

  return {
    filteredTransactions: filtered,
    stats: {
      startBalance: calculatedStartBalance,
      income: totalIncome,
      expense: totalExpense,
      balance: finalBalance
    }
  };
}

// Get filtered list for exporting without UI constraints
function getFilteredTransactionsForExport() {
  return getProcessedData().filteredTransactions;
}

// Populates dropdown filters dynamically based on current transaction properties
function refreshDynamicFilters(txs) {
  // 1. Categories filter
  const catSelect = document.getElementById('so-quy-category-select');
  if (catSelect) {
    const currentVal = catSelect.value;
    const cats = new Set();
    txs.forEach(t => {
      if (t.category) cats.add(t.category);
    });
    
    catSelect.innerHTML = '<option value="all">-- Chọn loại thu chi --</option>';
    Array.from(cats).sort().forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catSelect.appendChild(opt);
    });
    // Keep selection if still valid
    if (cats.has(currentVal)) {
      catSelect.value = currentVal;
      activeFilters.category = currentVal;
    } else {
      activeFilters.category = 'all';
    }
  }

  // 2. Creator filter
  const creatorSelect = document.getElementById('so-quy-creator-select');
  if (creatorSelect) {
    const currentVal = creatorSelect.value;
    const creators = new Set();
    txs.forEach(t => {
      if (t.creator) creators.add(t.creator);
    });
    
    creatorSelect.innerHTML = '<option value="all">Chọn người tạo</option>';
    Array.from(creators).sort().forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      creatorSelect.appendChild(opt);
    });
    
    if (creators.has(currentVal)) {
      creatorSelect.value = currentVal;
      activeFilters.creator = currentVal;
    } else {
      activeFilters.creator = 'all';
    }
  }

  // 3. Employee filter (from system users in state)
  const employeeSelect = document.getElementById('so-quy-employee-select');
  if (employeeSelect) {
    const currentVal = employeeSelect.value;
    employeeSelect.innerHTML = '<option value="all">Chọn nhân viên</option>';
    state.users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = u.displayName;
      employeeSelect.appendChild(opt);
    });
    
    if (state.users.some(u => u.username === currentVal)) {
      employeeSelect.value = currentVal;
      activeFilters.employee = currentVal;
    } else {
      activeFilters.employee = 'all';
    }
  }

  // 4. Receipt payer suggestions (danh sách khách hàng)
  const payerList = document.getElementById('receipt-payer-list');
  if (payerList) {
    payerList.innerHTML = '';
    state.customers.forEach(c => {
      const opt = document.createElement('option');
      const uniqueRef = c.code || c.phone || c.id;
      opt.value = `${c.name} — ${uniqueRef}`;
      opt.dataset.customerId = String(c.id);
      const subText = (c.code && c.code !== c.name) ? `${c.code} ${c.phone ? `• SĐT: ${c.phone}` : ''}` : (c.phone ? `SĐT: ${c.phone}` : '');
      opt.textContent = subText;
      payerList.appendChild(opt);
    });
  }
}

// Render cashbook table and update stats in UI
export function renderSoQuyTable() {
  const tableBody = document.getElementById('so-quy-table-body');
  if (!tableBody) return;

  const allTxs = getCashbookTransactions();
  // Refresh dynamic dropdown options
  refreshDynamicFilters(allTxs);

  // Get processed transactions and statistics
  const { filteredTransactions, stats } = getProcessedData();

  // Update Statistics in UI (with integers rounding for clean display)
  const statStartEl = document.getElementById('so-quy-stat-start');
  const statIncomeEl = document.getElementById('so-quy-stat-income');
  const statExpenseEl = document.getElementById('so-quy-stat-expense');
  const statBalanceEl = document.getElementById('so-quy-stat-balance');
  
  if (statStartEl) statStartEl.innerText = formatCurrency(Math.round(stats.startBalance));
  if (statIncomeEl) statIncomeEl.innerText = formatCurrency(Math.round(stats.income));
  if (statExpenseEl) statExpenseEl.innerText = formatCurrency(Math.round(stats.expense));
  if (statBalanceEl) statBalanceEl.innerText = formatCurrency(Math.round(stats.balance));

  // Render Table rows
  if (filteredTransactions.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không có giao dịch sổ quỹ nào phù hợp với bộ lọc hiện tại
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filteredTransactions.map(t => {
    const isCancelled = isCancelledStatus(t.status);
    const partnerAddress = getTransactionPartnerAddress(t);
    const valText = t.type === 'thu' ? formatCurrency(t.value) : `-${formatCurrency(t.value)}`;
    const valStyle = isCancelled 
      ? 'color: var(--text-muted); text-decoration: line-through;' 
      : (t.type === 'thu' ? 'color: #0070d2; font-weight: 700;' : 'color: var(--color-danger); font-weight: 700;');

    return `
      <tr class="${isCancelled ? 'row-cancelled' : ''}" style="${isCancelled ? 'opacity: 0.6;' : ''}">
        <td style="text-align: center; padding: 0.5rem 0.25rem;">
          <input type="checkbox" class="so-quy-row-checkbox" data-id="${t.id}" style="cursor: pointer; width: 14px; height: 14px;">
        </td>
        <td style="text-align: center;">
          <button class="star-btn ${t.starred ? 'starred' : ''}" data-id="${t.id}" title="${t.starred ? 'Bỏ đánh dấu sao' : 'Đánh dấu sao'}">
            <i data-lucide="star" style="width: 14px; height: 14px;"></i>
          </button>
        </td>
        <td style="text-align: center;">
          <span style="font-weight: 700; color: #0070d2; cursor: pointer; text-decoration: underline;" class="so-quy-tx-code" data-id="${t.id}">
            ${t.id}
          </span>
        </td>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem;">
          ${formatDateTime(t.date)}
        </td>
        <td>
          <div style="font-weight: 500;">${escapeCashbookHtml(t.category)}</div>
          <span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic;">
            ${t.method === 'cash' ? 'Tiền mặt' : (t.method === 'bank' ? 'Ngân hàng' : 'Ví điện tử')}
          </span>
        </td>
        <td>
          <div style="font-weight: 500;">${escapeCashbookHtml(t.partner)}</div>
          ${t.note ? `<div style="font-size: 0.75rem; color: var(--text-muted); word-break: break-all; margin-top: 0.15rem;">HD: ${escapeCashbookHtml(t.note)}</div>` : ''}
        </td>
        <td style="color: var(--text-secondary); font-size: 0.8rem; line-height: 1.4;">
          ${partnerAddress ? escapeCashbookHtml(partnerAddress) : '<span style="color: var(--text-muted);">-</span>'}
        </td>
        <td style="text-align: right; ${valStyle}">
          ${valText}
        </td>
      </tr>
    `;
  }).join('');

  // Wire up Star toggle event
  tableBody.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const txId = btn.getAttribute('data-id');
      const txs = getCashbookTransactions();
      const found = txs.find(t => t.id === txId);
      if (found) {
        const nextStarred = !found.starred;
        const saved = await dbSetCashbookStarred(found.cloudId || found.id, nextStarred);
        if (!saved) {
          showToast('Không thể cập nhật đánh dấu trên Cloud.', 'danger');
          return;
        }
        found.starred = nextStarred;
        saveCashbookTransactions(txs);
        btn.classList.toggle('starred');
        showToast(found.starred ? 'Đã thêm vào mục quan trọng' : 'Đã bỏ đánh dấu quan trọng', 'info');
      }
    });
  });

  // Wire up Detail Modal display event
  tableBody.querySelectorAll('.so-quy-tx-code').forEach(el => {
    el.addEventListener('click', () => {
      const txId = el.getAttribute('data-id');
      showTransactionDetails(txId);
    });
  });

  safeCreateIcons();
}

function openCashbookEditModal(transaction) {
  if (!canEditCashbookTransaction(transaction)) {
    showToast('Chỉ phiếu nhập tay còn hiệu lực mới được phép sửa.', 'warning');
    return;
  }
  const editModal = document.getElementById('so-quy-edit-modal');
  if (!editModal) return;

  document.getElementById('cashbook-edit-id').value = transaction.id;
  document.getElementById('cashbook-edit-code').value = transaction.id;
  document.getElementById('cashbook-edit-type').value = transaction.type === 'thu' ? 'Phiếu thu' : 'Phiếu chi';
  document.getElementById('cashbook-edit-time').value = toLocalDateTimeInput(transaction.date);
  document.getElementById('cashbook-edit-category').value = transaction.category || '';
  document.getElementById('cashbook-edit-partner').value = transaction.partner || '';
  document.getElementById('cashbook-edit-value').value = Number(transaction.value || 0);
  document.getElementById('cashbook-edit-method').value = transaction.method || 'cash';
  document.getElementById('cashbook-edit-accounting').checked = transaction.accounting !== false;
  document.getElementById('cashbook-edit-note').value = transaction.note || '';
  editModal.classList.add('active');
}

// Display details of a single transaction
function showTransactionDetails(txId) {
  const txs = getCashbookTransactions();
  const t = txs.find(tx => tx.id === txId);
  if (!t) return;

  const detailModal = document.getElementById('so-quy-detail-modal');
  if (!detailModal) return;

  // Set modal texts
  document.getElementById('so-quy-detail-code').innerText = t.id;
  document.getElementById('so-quy-detail-time').innerText = formatDateTime(t.date);
  document.getElementById('so-quy-detail-type').innerText = t.type === 'thu' ? 'Phiếu thu' : 'Phiếu chi';
  document.getElementById('so-quy-detail-category').innerText = t.category;
  
  const partnerLbl = document.getElementById('so-quy-detail-partner-lbl');
  if (partnerLbl) {
    partnerLbl.innerText = t.type === 'thu' ? 'Người nộp' : 'Người nhận';
  }
  document.getElementById('so-quy-detail-partner').innerText = t.partner;
  document.getElementById('so-quy-detail-address').innerText = getTransactionPartnerAddress(t) || '-';
  document.getElementById('so-quy-detail-method').innerText = t.method === 'cash' ? 'Tiền mặt' : (t.method === 'bank' ? 'Ngân hàng' : 'Ví điện tử');
  document.getElementById('so-quy-detail-accounting').innerText = t.accounting ? 'Có' : 'Không';
  document.getElementById('so-quy-detail-creator').innerText = t.creator || 'Hệ thống';
  document.getElementById('so-quy-detail-note').innerText = t.note || 'Không có ghi chú';
  
  const statusEl = document.getElementById('so-quy-detail-status');
  if (statusEl) {
    statusEl.innerHTML = `<span class="badge-status ${isPaidStatus(t.status) ? 'badge-status-paid' : 'badge-status-cancelled'}">${t.status}</span>`;
  }

  const valEl = document.getElementById('so-quy-detail-value');
  if (valEl) {
    valEl.innerText = (t.type === 'thu' ? '+' : '-') + ' ' + formatCurrency(t.value);
    valEl.style.color = isCancelledStatus(t.status) 
      ? 'var(--text-muted)' 
      : (t.type === 'thu' ? '#0070d2' : 'var(--color-danger)');
  }

  const editBtn = document.getElementById('btn-edit-cashbook-transaction');
  if (editBtn) {
    const newEditBtn = editBtn.cloneNode(true);
    editBtn.parentNode.replaceChild(newEditBtn, editBtn);
    newEditBtn.style.display = canEditCashbookTransaction(t) ? 'inline-flex' : 'none';
    if (canEditCashbookTransaction(t)) {
      newEditBtn.addEventListener('click', () => {
        detailModal.classList.remove('active');
        openCashbookEditModal(t);
      });
    }
  }

  const reconcileBtn = document.getElementById('btn-reconcile-customer-receipt');
  if (reconcileBtn) {
    const newReconcileBtn = reconcileBtn.cloneNode(true);
    reconcileBtn.parentNode.replaceChild(newReconcileBtn, reconcileBtn);
    const legacyCustomer = getLegacyReceiptCustomer(t);
    newReconcileBtn.style.display = legacyCustomer ? 'inline-flex' : 'none';
    if (legacyCustomer) {
      newReconcileBtn.addEventListener('click', async () => {
        const cashbookId = getCanonicalCashbookId(t);
        if (!cashbookId) {
          showToast('Không xác định được mã phiếu Cloud. Dữ liệu chưa thay đổi.', 'danger');
          return;
        }
        if (!confirm(`Ghi phiếu ${t.id} vào công nợ của ${legacyCustomer.name}? Công nợ sẽ giảm ${formatCurrency(t.value)}.`)) return;

        newReconcileBtn.disabled = true;
        try {
          const result = await dbReconcileLegacyCustomerReceipt(cashbookId, legacyCustomer.id);
          if (!result) return;
          await Promise.all([
            dbRefreshCustomerFinancialState(legacyCustomer.id),
            dbFetchCashbookTransactions()
          ]);
          detailModal.classList.remove('active');
          renderAll();
          showToast(result.already_reconciled
            ? 'Phiếu thu này đã có trong lịch sử công nợ.'
            : `Đã ghi phiếu ${t.id} vào lịch sử và cập nhật công nợ ${legacyCustomer.name}.`, 'success');
        } finally {
          newReconcileBtn.disabled = false;
        }
      });
    }
  }

  // Handle Hủy phiếu (Cancel transaction) button
  const cancelBtn = document.getElementById('btn-cancel-transaction');
  if (cancelBtn) {
    if (isCancelledStatus(t.status)) {
      cancelBtn.style.display = 'none';
    } else {
      cancelBtn.style.display = 'inline-flex';
      // Remove old listeners to avoid multiple fires
      const newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
      
      newCancelBtn.addEventListener('click', async () => {
        if (confirm(`Bạn có chắc chắn muốn hủy phiếu [${t.id}]? Số tiền giao dịch sẽ không còn được hạch toán vào Sổ quỹ và sẽ khôi phục lại công nợ đối tác nếu có.`)) {
          const cashbookId = getCanonicalCashbookId(t);
          if (!cashbookId) {
            showToast('Không xác định được mã phiếu Cloud. Dữ liệu chưa thay đổi.', 'danger');
            return;
          }

          const savedToCloud = await dbCancelCashbookEntry(cashbookId, `Hủy phiếu ${t.id}`);
          if (!savedToCloud) return;

          // The database ledger is authoritative. Do not convert an optional
          // RPC field with Number(null), because that incorrectly becomes zero.
          const customerRefreshed = savedToCloud.customer_id
            ? await dbRefreshCustomerFinancialState(savedToCloud.customer_id)
            : true;
          const cashbookRefreshed = await dbFetchCashbookTransactions();
          const supplierDebt = Number(savedToCloud.supplier_debt);
          if (savedToCloud.supplier_id && savedToCloud.supplier_debt != null && Number.isFinite(supplierDebt)) {
            const supplier = state.suppliers.find(s => String(s.id) === String(savedToCloud.supplier_id));
            if (supplier) supplier.debt = supplierDebt;
          }
          localStorage.setItem('billing_system_suppliers', JSON.stringify(state.suppliers));

          // Reversal rows have cancelled status so they do not affect totals.
          // Enable this audit filter after cancellation so both rows are visible.
          activeFilters.statusCancelled = true;
          const cancelledCheckbox = document.getElementById('so-quy-status-cancelled');
          if (cancelledCheckbox) cancelledCheckbox.checked = true;
          
          if (!customerRefreshed || !cashbookRefreshed) {
            showToast('Phiếu đã hủy trên Cloud nhưng giao diện chưa tải lại đầy đủ. Vui lòng tải lại trang.', 'warning');
          } else {
            showToast(`Đã hủy thành công phiếu ${t.id}`, 'warning');
          }
          detailModal.classList.remove('active');
          renderAll();
        }
      });
    }
  }

  // Open modal
  detailModal.classList.add('active');
  safeCreateIcons();
}

// Excel Export Report using SheetJS (XLSX)
function exportSoQuyToExcel(filteredTxs) {
  const sheetData = [
    ["Mã phiếu", "Thời gian", "Loại phiếu", "Loại thu chi", "Người nộp/nhận", "Địa chỉ", "Phương thức thanh toán", "Giá trị (đ)", "Hạch toán kết quả KD", "Trạng thái", "Người tạo", "Ghi chú"]
  ];
  
  filteredTxs.forEach(t => {
    sheetData.push([
      t.id,
      formatDateTime(t.date),
      t.type === 'thu' ? 'Phiếu thu' : 'Phiếu chi',
      t.category,
      t.partner,
      getTransactionPartnerAddress(t),
      t.method === 'cash' ? 'Tiền mặt' : (t.method === 'bank' ? 'Ngân hàng' : 'Ví điện tử'),
      t.value,
      t.accounting ? 'Có' : 'Không',
      t.status,
      t.creator || 'Hệ thống',
      t.note || ''
    ]);
  });
  
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  
  // Format column widths for export
  const wscols = [
    { wch: 15 }, // Code
    { wch: 18 }, // Time
    { wch: 12 }, // Type
    { wch: 25 }, // Category
    { wch: 35 }, // Partner
    { wch: 40 }, // Address
    { wch: 18 }, // Method
    { wch: 15 }, // Value
    { wch: 15 }, // Accounting
    { wch: 15 }, // Status
    { wch: 15 }, // Creator
    { wch: 30 }  // Note
  ];
  ws['!cols'] = wscols;

  XLSX.utils.book_append_sheet(wb, ws, "Báo Cáo Sổ Quỹ");
  
  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `So_quy_bao_cao_${dateStr}.xlsx`);
  showToast('Xuất báo cáo Sổ quỹ Excel thành công!', 'success');
}
