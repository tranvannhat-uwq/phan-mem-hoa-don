import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatPhoneNumber, isSameUser, getProvinceNameByCode, getManagerDisplayName } from '../utils.js';
import { dbSaveCustomer, dbDeleteCustomer, dbSaveCustomersBulk, dbDeleteAllCustomers } from '../services/supabase.js';
import { renderAll } from '../main.js';
import { applyActivePriceListToInvoice, resetInvoiceCustomer } from './invoice.js';

export function renderCustomersTable() {
  const tableBody = document.getElementById('customers-table-body');
  if (!tableBody) return;
  
  const searchVal = document.getElementById('customer-search-input').value.toLowerCase().trim();
  const filterSelect = document.getElementById('customer-managed-filter');
  const filterEmployee = filterSelect ? filterSelect.value : '';
  
  const filtered = state.customers.filter(c => {
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (!isSameUser(c.managedBy, state.currentUser.username)) return false;
    } else if (filterEmployee) {
      if (filterEmployee === 'unassigned') {
        if (c.managedBy && c.managedBy !== '') return false;
      } else if (filterEmployee === 'unassigned_pricelist') {
        if (c.pricelistId && c.pricelistId !== '') return false;
      } else {
        if (!isSameUser(c.managedBy, filterEmployee)) return false;
      }
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
        <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 3rem;">
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
    const plId = c.pricelistId || '';
    if (plId === '') {
      pricelistName = '<span style="color: #ef4444; font-weight: 500;">Chưa xác định</span>';
      tooltipTitle = 'Chưa áp dụng bảng giá';
    } else if (plId === 'custom') {
      const discSummary = [];
      if (c.brandDiscounts) {
        for (const [brand, pct] of Object.entries(c.brandDiscounts)) {
          if (brand !== 'province' && pct > 0) {
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
    
    const provinceName = getProvinceNameByCode(c.brandDiscounts && c.brandDiscounts.province);
    const displayAddr = provinceName ? `[${provinceName}] ${c.address || ''}` : (c.address || '<span style="color: var(--text-muted);">N/A</span>');
    const addrTitle = provinceName ? `[${provinceName}] ${c.address || ''}` : (c.address || '');
    
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
        <td style="font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${addrTitle}">${displayAddr}</td>
        <td>
          <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)'}; color: ${c.assignedBrand === 'Tất cả' ? '#10b981' : '#60a5fa'}; border: 1px solid ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)'};">${c.assignedBrand}</span>
        </td>
        <td style="font-size: 0.85rem; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${c.managedBy ? getManagerDisplayName(c.managedBy, state.users) : '<span style="color: #ef4444; font-weight: 500;">Chưa bàn giao</span>'}
        </td>
        <td style="font-size: 0.75rem; color: var(--text-secondary); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${tooltipTitle}">${pricelistName}</td>
        <td style="text-align: right; font-weight: 600; color: ${c.debt > 0 ? 'var(--color-danger)' : (c.debt < 0 ? 'var(--color-success)' : 'var(--text-muted)')};">${formatCurrency(c.debt)}</td>
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
    
    document.getElementById('cust-shipping-support').checked = false;
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
      
      const pl = state.pricelists.find(p => p.id === pricelistId);
      const plName = pl ? pl.name : (pricelistId === 'custom' ? 'Chiết khấu riêng' : (pricelistId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
      const plLbl = document.getElementById('selected-customer-pricelist-lbl');
      if (plLbl) plLbl.innerText = plName;
      
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
  
  cust.debt = cust.debt - amountPaid;
  
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

  // Customer Excel Import Listeners
  const openImportBtn = document.getElementById('btn-open-cust-excel-modal');
  if (openImportBtn) openImportBtn.addEventListener('click', openCustExcelModal);
  
  const closeImportBtn = document.getElementById('btn-close-cust-excel-modal');
  if (closeImportBtn) closeImportBtn.addEventListener('click', closeCustExcelModal);
  
  const cancelImportBtn = document.getElementById('btn-cancel-cust-excel');
  if (cancelImportBtn) cancelImportBtn.addEventListener('click', closeCustExcelModal);
  
  const fileInput = document.getElementById('cust-excel-file-input');
  const browseBtn = document.getElementById('btn-browse-cust-excel');
  const dropzone = document.getElementById('cust-excel-dropzone');
  
  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', () => fileInput.click());
  }
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleCustExcelFile(e.target.files[0]);
      }
    });
  }
  
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleCustExcelFile(e.dataTransfer.files[0]);
      }
    });
  }
  
  const submitImportBtn = document.getElementById('btn-save-cust-excel-submit');
  if (submitImportBtn) {
    submitImportBtn.addEventListener('click', processCustomerExcelImport);
  }
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
  const provinceName = getProvinceNameByCode(cust.brandDiscounts && cust.brandDiscounts.province);
  const detailAddress = cust.address || 'N/A';
  document.getElementById('detail-cust-address').innerText = provinceName ? `[${provinceName}] ${detailAddress}` : detailAddress;
  
  const brandEl = document.getElementById('detail-cust-brand');
  if (brandEl) {
    brandEl.innerHTML = `<span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)'}; color: ${cust.assignedBrand === 'Tất cả' ? '#10b981' : '#60a5fa'}; border: 1px solid ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)'};">${cust.assignedBrand}</span>`;
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
  
  document.getElementById('detail-cust-sales').innerText = formatCurrency(cust.totalTransaction || 0);
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
  
  select.innerHTML = `
    <option value="">-- Chưa bàn giao / Trống --</option>
    ${state.users.map(u => `
      <option value="${u.username}">${u.displayName} (${u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale')})</option>
    `).join('')}
  `;
}

let custExcelImportData = [];

export function openCustExcelModal() {
  const modal = document.getElementById('cust-excel-modal');
  if (modal) {
    modal.classList.add('active');
    


    // Reset UI
    custExcelImportData = [];
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
      const workbook = XLSX.read(data, { type: 'array' });
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
        debt: headers.indexOf('Nợ cần thu hiện tại'),
        totalTransaction: headers.indexOf('Tổng bán'),
        excelPricelist: headers.indexOf('Bảng giá'),
        excelManager: headers.indexOf('Người quản lý'),
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
        const nameLower = excelName.toString().toLowerCase().trim();
        
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
      const previewRows = [];
      
      const provinces = [
        { code: 'HN', name: 'Hà Nội' },
        { code: 'HP', name: 'Hải Phòng' },
        { code: 'HD', name: 'Hải Dương' },
        { code: 'HNam', name: 'Hà Nam' },
        { code: 'ND', name: 'Nam Định' },
        { code: 'TB', name: 'Thái Bình' },
        { code: 'NBi', name: 'Ninh Bình' },
        { code: 'TN', name: 'Thái Nguyên' },
        { code: 'VP', name: 'Vĩnh Phúc' },
        { code: 'BN', name: 'Bắc Ninh' },
        { code: 'BG', name: 'Bắc Giang' },
        { code: 'QN', name: 'Quảng Ninh' },
        { code: 'HY', name: 'Hưng Yên' },
        { code: 'HCM', name: 'Hồ Chí Minh' },
        { code: 'DN', name: 'Đà Nẵng' },
        { code: 'BD', name: 'Bình Dương' },
        { code: 'DNai', name: 'Đồng Nai' },
        { code: 'LA', name: 'Long An' },
        { code: 'BL', name: 'Bạc Liêu' }
      ];
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        
        let name = colMap.name !== -1 ? (row[colMap.name] || '').toString().trim() : '';
        if (!name) continue; // skip rows without name
        
        let code = colMap.code !== -1 ? (row[colMap.code] || '').toString().trim() : '';
        let phone = colMap.phone !== -1 ? (row[colMap.phone] || '').toString().trim() : '';
        let address = colMap.address !== -1 ? (row[colMap.address] || '').toString().trim() : '';
        let debt = colMap.debt !== -1 ? parseFloat(row[colMap.debt]) || 0 : 0;
        let totalTransaction = colMap.totalTransaction !== -1 ? parseFloat(row[colMap.totalTransaction]) || 0 : 0;
        
        // Auto detect brand
        const nameLower = name.toLowerCase();
        const codeLower = code.toLowerCase();
        let assignedBrand = defaultBrand;
        if (nameLower.includes('nano10') || codeLower.includes('nano10')) assignedBrand = 'Nano10*';
        else if (nameLower.includes('hatacco') || codeLower.includes('hatacco')) assignedBrand = 'Hatacco nano';
        else if (nameLower.includes('mutsutec') || codeLower.includes('mutsutec')) assignedBrand = 'mutsutec';
        else if (nameLower.includes('tdkaw') || codeLower.includes('tdkaw')) assignedBrand = 'tdkaw';
        else if (nameLower.includes('cova') || codeLower.includes('cova')) assignedBrand = 'cova';
        else if (nameLower.includes('festiva') || codeLower.includes('festiva')) assignedBrand = 'festiva';
        
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
            const numStr = matchBG[1].padStart(2, '0');
            const foundPl = state.pricelists.find(p => p.name.includes(numStr) || p.id.includes(numStr));
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
          brandDiscounts: { province: provinceCode },
          shippingSupport: false,
          debt: debt,
          totalTransaction: totalTransaction,
          notes: 'Imported from KiotViet',
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
        
        if (previewRows.length < 5) {
          previewRows.push({
            code: code,
            name: name,
            phone: phone,
            address: address,
            province: provinceCode,
            pricelistId: pricelistId,
            debt: debt,
            totalTransaction: totalTransaction
          });
        }
      }
      
      if (custExcelImportData.length === 0) {
        showToast("Không phân tích được khách hàng nào hợp lệ!", "warning");
        return;
      }
      
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
              <td style="text-align: right;">${formatCurrency(c.debt)}</td>
              <td style="text-align: right;">${formatCurrency(c.totalTransaction)}</td>
            </tr>
          `;
        }).join('');
      }
      
      const summaryText = document.getElementById('cust-excel-preview-summary');
      if (summaryText) {
        summaryText.innerText = `Hiển thị 5 trên tổng số ${custExcelImportData.length} khách hàng đọc được từ file.`;
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
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processCustomerExcelImport() {
  if (custExcelImportData.length === 0) return;
  
  const mode = document.querySelector('input[name="cust-import-mode"]:checked').value;
  
  try {
    showToast("Đang nhập dữ liệu khách hàng vào hệ thống...", "info");
    let successCount = 0;
    
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
    
    // Process local array mapping first (in-memory)
    for (const c of custExcelImportData) {
      let idx = -1;
      if (mode === 'merge') {
        idx = state.customers.findIndex(oc => oc.code === c.code || (c.phone && oc.phone && oc.phone.replace(/\D/g, '') === c.phone.replace(/\D/g, '')));
      }
      
      if (idx > -1) {
        // Update existing customer
        const oldId = state.customers[idx].id;
        c.id = oldId; // keep original ID
        
        // Merge debt histories
        const oldHistory = state.customers[idx].debtHistory || [];
        c.debtHistory = [...oldHistory, ...c.debtHistory];
        
        state.customers[idx] = c;
      } else {
        // Insert new customer
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
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      renderAll();
      closeCustExcelModal();
      showToast(`Nhập dữ liệu thành công! Đã thêm/cập nhật ${uniqueImportData.length} khách hàng.`, "success");
    }
  } catch (err) {
    console.error(err);
    showToast("Lỗi lưu dữ liệu khách hàng: " + err.message, "danger");
  }
}
