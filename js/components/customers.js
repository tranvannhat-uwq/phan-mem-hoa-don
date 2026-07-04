import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatPhoneNumber } from '../utils.js';
import { dbSaveCustomer, dbDeleteCustomer } from '../services/supabase.js';
import { renderAll } from '../main.js';
import { applyActivePriceListToInvoice, resetInvoiceCustomer } from './invoice.js';

export function renderCustomersTable() {
  const tableBody = document.getElementById('customers-table-body');
  if (!tableBody) return;
  
  const searchVal = document.getElementById('customer-search-input').value.toLowerCase().trim();
  const filterSelect = document.getElementById('customer-managed-filter');
  const filterEmployee = filterSelect ? filterSelect.value : '';
  
  const filtered = state.customers.filter(c => {
    const cManager = c.managedBy ? (c.managedBy.includes('@') ? c.managedBy.split('@')[0] : c.managedBy) : '';
    const currentUserUname = state.currentUser ? (state.currentUser.username.includes('@') ? state.currentUser.username.split('@')[0] : state.currentUser.username) : '';
    const filterEmpUname = filterEmployee ? (filterEmployee.includes('@') ? filterEmployee.split('@')[0] : filterEmployee) : '';

    if (state.currentUser && state.currentUser.role === 'sale') {
      if (cManager !== currentUserUname) return false;
    } else if (filterEmployee) {
      if (cManager !== filterEmpUname) return false;
    }
    return c.code.toLowerCase().includes(searchVal) || 
           c.name.toLowerCase().includes(searchVal) || 
           (c.phone && c.phone.includes(searchVal));
  });
  
  // Tính toán tổng nợ và doanh thu đại lý lọc được
  const totalDebt = filtered.reduce((sum, c) => sum + (parseFloat(c.debt) || 0), 0);
  const totalSales = filtered.reduce((sum, c) => sum + (parseFloat(c.totalTransaction) || 0), 0);
  
  const debtEl = document.getElementById('cust-summary-total-debt');
  const salesEl = document.getElementById('cust-summary-total-sales');
  if (debtEl) debtEl.innerText = formatCurrency(totalDebt);
  if (salesEl) salesEl.innerText = formatCurrency(totalSales);
  
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
        <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy khách hàng nào.
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = paginatedCustomers.map((c) => {
    const actualIndex = state.customers.findIndex(cust => cust.id === c.id);
    
    let pricelistName = '';
    let tooltipTitle = '';
    const plId = c.pricelistId || 'custom';
    if (plId === 'custom') {
      const discSummary = [];
      if (c.brandDiscounts) {
        for (const [brand, pct] of Object.entries(c.brandDiscounts)) {
          if (pct > 0) {
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
    
    const shippingBadge = c.shippingSupport 
      ? `<span style="font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); margin-left: 0.35rem; display: inline-block; vertical-align: middle; font-weight: 600;">Hỗ trợ VC</span>` 
      : '';
    
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">${c.code}</td>
        <td style="font-weight: 500;">
          <span class="view-cust-detail-link" data-index="${actualIndex}" style="cursor: pointer; color: #60a5fa; text-decoration: underline; font-weight: 600;" title="Xem chi tiết & Lịch sử công nợ">
            ${c.name}
          </span>
          ${shippingBadge}
        </td>
        <td>${c.phone || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td style="font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${c.address || ''}">${c.address || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td>
          <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)'}; color: ${c.assignedBrand === 'Tất cả' ? '#10b981' : '#60a5fa'}; border: 1px solid ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)'};">${c.assignedBrand}</span>
        </td>
        <td style="font-size: 0.75rem; color: var(--text-secondary); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${tooltipTitle}">${pricelistName}</td>
        <td style="text-align: right; font-weight: 600; color: ${c.debt > 0 ? 'var(--color-danger)' : 'var(--text-muted)'};">${formatCurrency(c.debt)}</td>
        <td style="text-align: right; font-weight: 600; color: var(--color-primary);">${formatCurrency(c.totalTransaction)}</td>
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
  
  // Gán sự kiện click cho các nút hành động
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

export function openCustomerModal(index = -1) {
  const modal = document.getElementById('customer-modal');
  const title = document.getElementById('customer-modal-title');
  const form = document.getElementById('customer-form');
  
  if (!modal) return;
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
  
  const plSelect = document.getElementById('cust-pricelist');
  if (plSelect) {
    plSelect.innerHTML = `
      <option value="custom">Chiết khấu riêng (Tự thiết lập bên dưới)</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
    `;
  }
  
  document.querySelectorAll('.cust-brand-disc').forEach(input => input.value = 0);
  
  if (index === -1) {
    title.innerText = 'Thêm khách hàng mới';
    document.getElementById('customer-edit-index').value = '-1';
    document.getElementById('customer-edit-id').value = '';
    
    // Tạo mã KH tự động tăng
    let nextNum = 1;
    if (state.customers.length > 0) {
      const nums = state.customers.map(c => {
        const match = c.code.match(/\d+/);
        return match ? parseInt(match[0]) : 0;
      }).filter(Boolean);
      if (nums.length > 0) {
        nextNum = Math.max(...nums) + 1;
      }
    }
    document.getElementById('cust-shipping-support').checked = false;
    document.getElementById('cust-code').value = `KH-${nextNum.toString().padStart(3, '0')}`;
    
    if (plSelect) plSelect.value = 'custom';
    const discSection = document.getElementById('cust-brand-discounts-section');
    if (discSection) discSection.style.display = 'block';
    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      mBySelect.value = state.currentUser ? state.currentUser.username : 'nhat';
    }
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
    document.getElementById('cust-debt').value = customer.debt || 0;
    document.getElementById('cust-notes').value = customer.notes || '';
    document.getElementById('cust-shipping-support').checked = customer.shippingSupport || false;
    
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

    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      const mByVal = customer.managedBy || 'nhat';
      mBySelect.value = mByVal.includes('@') ? mByVal.split('@')[0] : mByVal;
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
  if (managedBy && managedBy.includes('@')) {
    managedBy = managedBy.split('@')[0];
  }
  
  const duplicateCode = state.customers.some((c, idx) => c.code === code && idx !== index);
  if (duplicateCode) {
    showToast('Mã khách hàng đã tồn tại trên hệ thống!', 'danger');
    return;
  }
  
  const brandDiscounts = {};
  document.querySelectorAll('.cust-brand-disc').forEach(input => {
    const brand = input.getAttribute('data-brand');
    brandDiscounts[brand] = parseFloat(input.value) || 0;
  });
  
  const shippingSupport = document.getElementById('cust-shipping-support').checked;
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
  }

  const customerData = {
    id: customerId,
    code,
    name,
    phone,
    address,
    assignedBrand,
    brandDiscounts,
    shippingSupport,
    debt,
    totalTransaction: index === -1 ? 0 : state.customers[index].totalTransaction || 0,
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
      document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(debt);
      
      const shipCheck = document.getElementById('invoice-shipping-support');
      if (shipCheck) shipCheck.checked = shippingSupport;
      
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
  
  if (amountPaid > cust.debt) {
    if (!confirm(`Số tiền khách trả (${formatCurrency(amountPaid)}) lớn hơn số công nợ hiện tại (${formatCurrency(cust.debt)}). Bạn có muốn tiếp tục?`)) {
      return;
    }
  }
  
  cust.debt = Math.max(0, cust.debt - amountPaid);
  
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
  
  const saved = await dbSaveCustomer(cust);
  if (saved) {
    closePayDebtModal();
    renderAll();
    showToast(`Đã thu nợ ${formatCurrency(amountPaid)} từ khách hàng ${cust.name}!`, 'success');
  }
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
}

// --- Logic hiển thị chi tiết đại lý và lịch sử công nợ ---
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

  document.getElementById('detail-cust-code').innerText = cust.code;
  document.getElementById('detail-cust-name').innerText = cust.name;
  document.getElementById('detail-cust-phone').innerText = formatPhoneNumber(cust.phone);
  document.getElementById('detail-cust-address').innerText = cust.address || 'N/A';
  
  const brandEl = document.getElementById('detail-cust-brand');
  if (brandEl) {
    brandEl.innerHTML = `<span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)'}; color: ${cust.assignedBrand === 'Tất cả' ? '#10b981' : '#60a5fa'}; border: 1px solid ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)'};">${cust.assignedBrand}</span>`;
  }
  
  const managerUsername = cust.managedBy ? (cust.managedBy.includes('@') ? cust.managedBy.split('@')[0] : cust.managedBy) : '';
  const user = state.users.find(u => u.username === managerUsername);
  document.getElementById('detail-cust-manager').innerText = user ? `${user.displayName} (${managerUsername})` : cust.managedBy;
  
  // Xác định tên bảng giá đang áp dụng
  let plName = '';
  const plId = cust.pricelistId || 'custom';
  if (plId === 'custom') {
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
  
  document.getElementById('detail-cust-sales').innerText = formatCurrency(cust.totalTransaction || 0);
  document.getElementById('detail-cust-debt').innerText = formatCurrency(cust.debt || 0);

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
        
        return `
          <tr>
            <td>${formattedTime}</td>
            <td style="text-align: center;">${typeBadge}</td>
            <td style="text-align: right;">${formatCurrency(debtBefore)}</td>
            <td style="text-align: right;">${amountText}</td>
            <td style="text-align: right; font-weight: 600;">${formatCurrency(h.debtAfter)}</td>
            <td title="${h.notes}">${h.notes}</td>
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
  
  select.innerHTML = state.users.map(u => `
    <option value="${u.username}">${u.displayName} (${u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale'})</option>
  `).join('');
}
