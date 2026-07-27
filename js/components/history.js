import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatDateTime, isSameUser, getManagerDisplayName } from '../utils.js';
import { dbDeleteOrder, dbDeleteAllOrders, fetchCloudData, dbSaveSalesReturn, dbSaveCustomer, dbSaveOrder } from '../services/supabase.js';
import { renderAll } from '../main.js';
import { openPrintTypeModal } from './invoice.js';


export function setupHistoryPanel() {
  const searchInput = document.getElementById('history-search-input');
  
  const onFilterChange = () => {
    state.historyPage = 1;
    renderHistoryOrders();
  };

  if (searchInput) {
    searchInput.addEventListener('input', onFilterChange);
  }
  
  // Thiết lập các bộ lọc thời gian, khách hàng, nhân viên
  const dateModeSelect = document.getElementById('history-date-mode');
  const filterDateInput = document.getElementById('history-filter-date');
  const filterMonthInput = document.getElementById('history-filter-month');
  const filterYearSelect = document.getElementById('history-filter-year');
  const filterRangeDiv = document.getElementById('history-filter-range');
  
  if (dateModeSelect) {
    // Khởi tạo năm động (năm hiện tại lùi về 5 năm)
    const currentYear = new Date().getFullYear();
    filterYearSelect.innerHTML = '<option value="">-- Chọn năm --</option>';
    for (let y = currentYear; y >= currentYear - 5; y--) {
      const opt = document.createElement('option');
      opt.value = y.toString();
      opt.textContent = y.toString();
      filterYearSelect.appendChild(opt);
    }
    filterYearSelect.value = currentYear.toString();



    dateModeSelect.addEventListener('change', () => {
      const mode = dateModeSelect.value;
      
      // Ẩn tất cả trước
      filterDateInput.style.display = 'none';
      filterMonthInput.style.display = 'none';
      filterYearSelect.style.display = 'none';
      filterRangeDiv.style.display = 'none';
      
      // Hiện cái tương ứng
      if (mode === 'date') filterDateInput.style.display = 'block';
      else if (mode === 'month') filterMonthInput.style.display = 'block';
      else if (mode === 'year') filterYearSelect.style.display = 'block';
      else if (mode === 'range') filterRangeDiv.style.display = 'flex';
      
      onFilterChange();
    });
    
    filterDateInput.addEventListener('input', onFilterChange);
    filterMonthInput.addEventListener('input', onFilterChange);
    filterYearSelect.addEventListener('change', onFilterChange);
    document.getElementById('history-filter-from').addEventListener('input', onFilterChange);
    document.getElementById('history-filter-to').addEventListener('input', onFilterChange);
  }
  
  const customerFilter = document.getElementById('history-customer-filter');
  if (customerFilter) {
    customerFilter.addEventListener('input', onFilterChange);
  }
  
  const creatorFilter = document.getElementById('history-creator-filter');
  if (creatorFilter) {
    creatorFilter.addEventListener('input', onFilterChange);
  }

  const refreshBtn = document.getElementById('btn-refresh-history');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const icon = refreshBtn.querySelector('i');
      if (icon) icon.classList.add('spin-animation');
      
      showToast('Đang làm mới dữ liệu từ Cloud...', 'info');
      try {
        await fetchCloudData();
        renderAll();
        showToast('Đã làm mới dữ liệu từ Cloud thành công!', 'success');
      } catch (err) {
        showToast('Lỗi khi làm mới dữ liệu: ' + err.message, 'danger');
      } finally {
        if (icon) {
          setTimeout(() => icon.classList.remove('spin-animation'), 500);
        }
      }
    });
  }

  const returnForm = document.getElementById('sales-return-form');
  if (returnForm) {
    returnForm.addEventListener('submit', processSalesReturnSubmit);
  }
}

export function printOrderById(orderId) {
  const order = state.savedOrders.find(o => o.id === orderId);
  if (!order) {
    showToast(`Không tìm thấy đơn hàng "${orderId}"!`, 'danger');
    return;
  }
  openPrintTypeModal(order);
}

export async function deleteOrder(id) {
  const order = state.savedOrders.find(o => o.id === id);
  if (!order) return;
  
  if (order.status === 'settled' && state.currentUser && state.currentUser.role !== 'admin') {
    showToast('Chỉ có quản trị viên (Admin) mới có quyền xóa đơn hàng đã chốt thanh toán!', 'danger');
    return;
  }
  
  if (confirm(`Bạn có chắc chắn muốn xóa đơn hàng "${id}" không?`)) {
    const deleted = await dbDeleteOrder(id, order.status);
    if (deleted) {
      state.savedOrders = state.savedOrders.filter(o => o.id !== id);
      renderAll();
      showToast(`Đã xóa đơn hàng ${id} thành công!`, 'warning');
    }
  }
}

let lastCustomerLength = 0;
let lastUserLength = 0;

export function populateHistoryFilters() {
  const customerList = document.getElementById('history-customer-list');
  const creatorList = document.getElementById('history-creator-list');
  
  if (!customerList || !creatorList) return;
  
  // Chỉ cập nhật nếu số lượng khách hàng hoặc người dùng thay đổi
  if (state.customers.length === lastCustomerLength && state.users.length === lastUserLength) {
    return;
  }
  
  lastCustomerLength = state.customers.length;
  lastUserLength = state.users.length;
  
  customerList.innerHTML = '';
  state.customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    const subText = (c.code && c.code !== c.name) ? c.code : (c.phone ? `SĐT: ${c.phone}` : '');
    opt.textContent = subText;
    customerList.appendChild(opt);
  });
  
  creatorList.innerHTML = '';
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.displayName;
    const roleText = u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale');
    opt.textContent = `@${u.username} • ${roleText}`;
    creatorList.appendChild(opt);
  });
}

export function renderHistoryOrders() {
  const container = document.getElementById('history-orders-container');
  if (!container) return;
  
  populateHistoryFilters();
  
  const searchVal = document.getElementById('history-search-input').value.toLowerCase().trim();
  
  const dateModeSelect = document.getElementById('history-date-mode');
  const filterDateInput = document.getElementById('history-filter-date');
  const filterMonthInput = document.getElementById('history-filter-month');
  const filterYearSelect = document.getElementById('history-filter-year');
  const filterFromInput = document.getElementById('history-filter-from');
  const filterToInput = document.getElementById('history-filter-to');
  const customerFilterSelect = document.getElementById('history-customer-filter');
  const creatorFilterSelect = document.getElementById('history-creator-filter');
  
  const dateMode = dateModeSelect ? dateModeSelect.value : 'all';
  const filterDate = filterDateInput ? filterDateInput.value : '';
  const filterMonth = filterMonthInput ? filterMonthInput.value : '';
  const filterYear = filterYearSelect ? filterYearSelect.value : '';
  const filterFrom = filterFromInput ? filterFromInput.value : '';
  const filterTo = filterToInput ? filterToInput.value : '';
  const selectedCust = customerFilterSelect ? customerFilterSelect.value : '';
  const selectedCreator = creatorFilterSelect ? creatorFilterSelect.value : '';

  const filtered = state.savedOrders.filter(o => {
    // 1. Phân quyền hiển thị đơn của Sale
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (!isSameUser(o.createdBy, state.currentUser.username)) return false;
    }
    
    // 2. Lọc theo tìm kiếm từ khóa
    const matchesSearch = o.id.toLowerCase().includes(searchVal) || o.customerName.toLowerCase().includes(searchVal);
    if (!matchesSearch) return false;
    
    // 3. Lọc theo khách hàng (Tìm kiếm tương đối)
    if (selectedCust && !o.customerName.toLowerCase().includes(selectedCust.toLowerCase().trim())) return false;
    
    // 4. Lọc theo nhân viên lên đơn (Tìm kiếm tương đối)
    if (selectedCreator) {
      const filterLower = selectedCreator.toLowerCase().trim();
      
      const matchingUsers = state.users.filter(u => 
        u.displayName.toLowerCase().includes(filterLower) || 
        u.username.toLowerCase().includes(filterLower)
      );
      
      let matched = false;
      if (matchingUsers.length > 0) {
        matched = matchingUsers.some(u => isSameUser(o.createdBy, u.username));
      }
      
      if (!matched) {
        const creatorClean = (o.createdBy || '').toLowerCase();
        if (creatorClean.includes(filterLower)) {
          matched = true;
        }
      }
      
      if (!matched) return false;
    }
    
    // 5. Lọc theo thời gian
    if (o.date) {
      const oDate = new Date(o.date);
      if (isNaN(oDate.getTime())) return true;
      
      if (dateMode === 'date') {
        if (!filterDate) return true;
        const orderDateStr = oDate.toLocaleDateString('en-CA'); // YYYY-MM-DD
        if (orderDateStr !== filterDate) return false;
      } 
      else if (dateMode === 'month') {
        if (!filterMonth) return true;
        const orderMonthStr = oDate.toISOString().slice(0, 7); // YYYY-MM
        if (orderMonthStr !== filterMonth) return false;
      } 
      else if (dateMode === 'year') {
        if (!filterYear) return true;
        if (oDate.getFullYear().toString() !== filterYear) return false;
      } 
      else if (dateMode === 'range') {
        const checkDate = new Date(oDate);
        checkDate.setHours(0,0,0,0);
        if (filterFrom) {
          const fromDate = new Date(filterFrom);
          fromDate.setHours(0,0,0,0);
          if (checkDate < fromDate) return false;
        }
        if (filterTo) {
          const toDate = new Date(filterTo);
          toDate.setHours(23,59,59,999);
          if (checkDate > toDate) return false;
        }
      }
    }
    
    return true;
  });



  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i data-lucide="clipboard-list"></i>
        <div class="empty-state-title">Không tìm thấy hóa đơn nào</div>
        <div class="empty-state-desc">Thử tìm bằng từ khóa khác hoặc tạo đơn hàng mới trên hệ thống.</div>
      </div>
    `;
    safeCreateIcons();
    return;
  }

  const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));

  const ITEMS_PER_PAGE = 20;
  const totalItems = sorted.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;

  if (state.historyPage > totalPages) state.historyPage = totalPages;
  if (state.historyPage < 1) state.historyPage = 1;

  const startIndex = (state.historyPage - 1) * ITEMS_PER_PAGE;
  const paginatedItems = sorted.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const cardsHtml = paginatedItems.map(order => {
    const totalItemsCount = order.items.reduce((sum, item) => sum + Number(item.quantity), 0);
    let statusBadge = '';
    if (order.status === 'draft') {
      statusBadge = `<span style="background: var(--color-danger-light); color: var(--color-danger); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đơn nháp</span>`;
    } else if (order.status === 'partially_returned') {
      statusBadge = `<span style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Trả 1 phần</span>`;
    } else if (order.status === 'returned') {
      statusBadge = `<span style="background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã trả toàn bộ</span>`;
    } else {
      statusBadge = `<span style="background: var(--color-primary-light); color: var(--color-primary); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã chốt</span>`;
    }
      
    const creator = state.users.find(u => isSameUser(u.username, order.createdBy));
    const creatorName = creator ? creator.displayName : (order.createdBy && order.createdBy.includes('@') ? order.createdBy.split('@')[0] : order.createdBy);

    let showDeleteBtn = true;
    if ((order.status === 'settled' || order.status === 'partially_returned' || order.status === 'returned') && state.currentUser && state.currentUser.role !== 'admin') {
      showDeleteBtn = false;
    }

    const cust = order.customerId ? state.customers.find(c => c.id === order.customerId) : null;
    
    let managerName = 'Chưa phân công';
    let plName = 'Nhập tay';
    let debtText = '0 ₫';
    
    if (cust) {
      managerName = cust.managedBy ? getManagerDisplayName(cust.managedBy, state.users) : 'Chưa phân công';
      
      const pl = state.pricelists.find(p => p.id === cust.pricelistId);
      plName = pl ? pl.name : (cust.pricelistId === 'custom' ? 'Chiết khấu riêng' : (cust.pricelistId === 'retail' ? 'Nhập tay' : 'Chưa xác định'));
      
      debtText = formatCurrency(cust.debt || 0);
    } else {
      const orderPlId = order.pricelistId || 'retail';
      const pl = state.pricelists.find(p => p.id === orderPlId);
      plName = pl ? pl.name : (orderPlId === 'custom' ? 'Chiết khấu riêng' : (orderPlId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
    }

    return `
      <div class="glass-panel order-card flex flex-col justify-between" style="padding: 1.25rem; gap: 1rem; position: relative;">
        ${showDeleteBtn ? `
          <button class="history-delete-btn" data-id="${order.id}" title="Xóa đơn hàng" style="position: absolute; top: 0.85rem; right: 0.85rem; width: 26px; height: 26px; border-radius: 50%; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #ef4444; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; padding: 0;">
            <i data-lucide="x" style="width: 15px; height: 15px; stroke-width: 2.5;"></i>
          </button>
        ` : ''}
        <div>
          <div class="flex justify-between items-center" style="margin-bottom: 0.75rem; padding-right: ${showDeleteBtn ? '2rem' : '0'};">
            <span class="order-id" style="font-weight: 700; color: #fff; font-size: 1.05rem;">${order.id}</span>
            <div style="display: flex; gap: 0.35rem; align-items: center;">
              ${statusBadge}
            </div>
          </div>
          
          <div class="order-meta" style="font-size: 0.85rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;">
            <div class="flex items-center gap-1"><i data-lucide="user" style="width:13px;height:13px;color: var(--color-primary);"></i> <span>Khách hàng: <strong>${order.customerName}</strong></span></div>
            <div class="flex items-center gap-1"><i data-lucide="calendar" style="width:13px;height:13px;"></i> <span>Ngày lập: ${formatDateTime(order.date)}</span></div>
            <div class="flex items-center gap-1"><i data-lucide="user-check" style="width:13px;height:13px;"></i> <span>Người tạo: ${creatorName}</span></div>
            <div class="flex items-center gap-1"><i data-lucide="users" style="width:13px;height:13px;"></i> <span>Kinh doanh quản lý: ${managerName}</span></div>
            <div class="flex items-center gap-1"><i data-lucide="tags" style="width:13px;height:13px;"></i> <span>Bảng giá: <strong style="color: var(--color-warning);">${plName}</strong></span></div>
            <div class="flex items-center gap-1"><i data-lucide="credit-card" style="width:13px;height:13px;"></i> <span>Công nợ hiện tại: <strong style="color: var(--color-danger);">${debtText}</strong></span></div>
          </div>
          
          <div class="order-details-summary" style="font-size: 0.85rem; background: rgba(255,255,255,0.02); border-radius: 6px; padding: 0.5rem 0.75rem; border: 1px solid var(--border-color); margin-bottom: 1rem; max-height: 120px; overflow-y: auto;">
            <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem; font-size: 0.75rem; text-transform: uppercase;">Chi tiết mặt hàng (${totalItemsCount}):</div>
            <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem;">
              ${order.items.map(item => `
                <li style="display: flex; justify-content: space-between; color: var(--text-secondary); font-size: 0.8rem;">
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;" title="${item.productName || item.product.name} (${item.package})">${item.productName || item.product.name} (${item.package})</span>
                  <span>${item.quantity} x ${formatCurrency(item.price)}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        </div>
        
        <div>
          <div class="flex justify-between items-center" style="margin-bottom: 1rem;">
            <span style="font-size: 0.85rem; color: var(--text-secondary);">Thành tiền:</span>
            <span class="order-total" style="font-size: 1.15rem; font-weight: 700; color: var(--color-primary);">${formatCurrency(order.totalPayable)}</span>
          </div>
          
          <div class="order-actions" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(75px, 1fr)); gap: 0.35rem;">
            <button class="btn btn-indigo btn-sm flex items-center justify-center gap-1 history-print-btn" data-id="${order.id}">
              <i data-lucide="printer" style="width: 13px; height: 13px;"></i> In
            </button>
            
            ${order.status === 'draft' ? `
              <button class="btn btn-primary btn-sm flex items-center justify-center gap-1 history-edit-btn" data-id="${order.id}">
                <i data-lucide="edit" style="width: 13px; height: 13px;"></i> Sửa
              </button>
            ` : `
              <button class="btn btn-teal btn-sm flex items-center justify-center gap-1 history-view-btn" data-id="${order.id}">
                <i data-lucide="eye" style="width: 13px; height: 13px;"></i> Xem
              </button>
              <button class="btn btn-warning btn-sm flex items-center justify-center gap-1 history-return-btn" data-id="${order.id}" onclick="openSalesReturnModal('${order.id}')" style="background: #f59e0b; border-color: #f59e0b; color: #fff;">
                <i data-lucide="rotate-ccw" style="width: 13px; height: 13px;"></i> Trả
              </button>
            `}
          </div>
        </div>
      </div>
    `;

  }).join('');

  const paginationHtml = `
    <div class="pagination-controls" style="grid-column: 1 / -1; display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border-color); width: 100%;">
      <button class="btn btn-secondary btn-sm" id="history-prev-page" ${state.historyPage === 1 ? 'disabled' : ''}>
        <i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i> Trước
      </button>
      <span style="font-size: 0.9rem; color: var(--text-secondary); font-weight: 500;">
        Trang <strong>${state.historyPage}</strong> / ${totalPages} (${totalItems} đơn)
      </span>
      <button class="btn btn-secondary btn-sm" id="history-next-page" ${state.historyPage === totalPages ? 'disabled' : ''}>
        Sau <i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>
      </button>
    </div>
  `;

  container.innerHTML = cardsHtml + paginationHtml;

  const prevPageBtn = document.getElementById('history-prev-page');
  if (prevPageBtn) {
    prevPageBtn.addEventListener('click', () => {
      state.historyPage--;
      renderHistoryOrders();
      container.scrollIntoView({ behavior: 'smooth' });
    });
  }

  const nextPageBtn = document.getElementById('history-next-page');
  if (nextPageBtn) {
    nextPageBtn.addEventListener('click', () => {
      state.historyPage++;
      renderHistoryOrders();
      container.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Gán sự kiện click cho các nút hành động trong lịch sử
  document.querySelectorAll('.history-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      printOrderById(id);
    });
  });

  document.querySelectorAll('.history-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      deleteOrder(id);
    });
  });

  document.querySelectorAll('.history-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      const order = state.savedOrders.find(o => String(o.id) === String(id));
      if (order) {
        loadDraftOrderIntoInvoice(order);
      }
    });
  });

  document.querySelectorAll('.history-view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      const order = state.savedOrders.find(o => String(o.id) === String(id));
      if (order) {
        loadDraftOrderIntoInvoice(order, true);
      }
    });
  });

  document.querySelectorAll('.history-return-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      openSalesReturnModal(id);
    });
  });

  safeCreateIcons();
}



function loadDraftOrderIntoInvoice(order, isReadOnly = false) {
  // Đồng bộ khách hàng
  if (order.customerId) {
    const cust = state.customers.find(c => c.id === order.customerId);
    if (cust) {
      state.activeCustomerId = cust.id;
      state.activeCustomerBrand = cust.assignedBrand;
      document.getElementById('invoice-customer-id').value = cust.id;
      document.getElementById('invoice-customer-search').value = cust.name;
      document.getElementById('invoice-customer-info-card').style.display = 'block';
      document.getElementById('selected-customer-name-lbl').innerText = cust.name;
      document.getElementById('selected-customer-phone-lbl').innerText = cust.phone || 'N/A';
      document.getElementById('selected-customer-address-lbl').innerText = cust.address || 'N/A';
      document.getElementById('selected-customer-brand-lbl').innerText = cust.assignedBrand;
      
      const pl = state.pricelists.find(p => p.id === cust.pricelistId);
      const plName = pl ? pl.name : (cust.pricelistId === 'custom' ? 'Chiết khấu riêng' : (cust.pricelistId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
      const plLbl = document.getElementById('selected-customer-pricelist-lbl');
      if (plLbl) plLbl.innerText = plName;
      
      document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(cust.debt);
    }
  } else {
    // Khách lẻ
    state.isQuickCustomerMode = true;
    document.getElementById('invoice-customer-search').value = order.customerName;
    document.getElementById('invoice-customer-search').setAttribute('disabled', 'true');
    document.getElementById('btn-clear-invoice-customer').style.display = 'inline-flex';
  }
  
  // Tải các mặt hàng
  state.invoiceItems = order.items.map(item => {
    let pObj = state.products.find(p => p.code === item.productCode && p.brand === item.brand);
    if (!pObj) {
      pObj = {
        code: item.productCode || item.code,
        name: item.productName || item.name,
        brand: item.brand
      };
    }
    return {
      product: pObj,
      brand: item.brand,
      package: item.package,
      colorCode: item.colorCode || '',
      colorPercent: item.colorPercent || 0,
      quantity: item.quantity,
      discountPercent: item.discountPercent,
      price: item.price,
      notes: item.notes || ''
    };
  });
  
  // Cài đặt Ghi chú & bảng giá
  document.getElementById('invoice-notes').value = order.notes || '';
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    plSelect.value = order.pricelistId || 'retail';
    plSelect.dispatchEvent(new Event('change'));
  }
  
  // Thiết lập checkbox hỗ trợ vận chuyển
  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck) {
    shipCheck.checked = order.shippingSupport || false;
  }
  
  // Đổi tiêu đề và trạng thái nút chốt đơn trên giao diện lập hóa đơn
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const panelTitle = document.querySelector('#invoice-panel .panel-title');
  
  if (isReadOnly) {
    if (saveBtn) saveBtn.style.display = 'none';
    if (draftBtn) draftBtn.style.display = 'none';
    if (panelTitle) panelTitle.innerHTML = `<i data-lucide="eye"></i> Chi tiết đơn hàng ${order.id} (Chỉ xem)`;
  } else {
    if (saveBtn) {
      saveBtn.style.display = 'inline-flex';
      saveBtn.innerHTML = `<i data-lucide="check-square"></i> Chốt đơn`;
      saveBtn.setAttribute('data-edit-order-id', order.id);
    }
    if (draftBtn) {
      draftBtn.style.display = 'inline-flex';
      draftBtn.innerHTML = `<i data-lucide="file-text"></i> Cập nhật nháp`;
    }
    if (panelTitle) panelTitle.innerHTML = `<i data-lucide="edit"></i> Hiệu chỉnh đơn nháp ${order.id}`;
  }
  
  // Chuyển Tab
  document.querySelectorAll('.nav-link').forEach(l => {
    if (l.getAttribute('data-target') === 'invoice-panel') {
      l.classList.add('active');
    } else {
      l.classList.remove('active');
    }
  });

  document.querySelectorAll('.panel').forEach(p => {
    if (p.id === 'invoice-panel') {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
  
  const heading = document.getElementById('page-title-heading');
  if (heading) heading.innerText = 'Cập nhật hóa đơn';
  
  // Tải lại bảng
  const invoiceItemsBody = document.getElementById('invoice-items-body');
  const emptyRow = document.getElementById('invoice-empty-row');
  if (emptyRow) emptyRow.style.display = 'none';
  
  // Re-render
  const renderInvTable = document.getElementById('invoice-items-body');
  if (renderInvTable) {
    // Gọi tính toán và vẽ lại bảng
    document.getElementById('invoice-product-search').focus();
  }
  
  // Trình kích hoạt Render bảng
  const event = new CustomEvent('loadDraftOrder', { detail: { order, isReadOnly } });
  document.dispatchEvent(event);
}

// --- PHÂN HỆ TRẢ HÀNG (SALES RETURN LOGIC) ---

export function openSalesReturnModal(orderId) {
  const order = state.savedOrders.find(o => String(o.id) === String(orderId));

  if (!order) {
    showToast('Không tìm thấy thông tin đơn hàng!', 'danger');
    return;
  }
  
  const modal = document.getElementById('sales-return-modal');
  if (!modal) return;

  document.getElementById('return-order-id').value = order.id;
  document.getElementById('return-meta-order-id').innerText = order.id;
  document.getElementById('return-meta-customer').innerText = order.customerName;
  document.getElementById('return-meta-date').innerText = formatDateTime(order.date);
  document.getElementById('return-meta-creator').innerText = state.currentUser ? state.currentUser.displayName : 'Administrator';
  document.getElementById('return-reason-input').value = '';

  const existingReturns = (state.salesReturns || []).filter(r => r.saleId === order.id && r.status !== 'cancelled');
  
  const returnedMap = {};
  existingReturns.forEach(ret => {
    (ret.items || []).forEach(item => {
      const key = item.saleItemId || `${item.productId}_${item.packageType}`;
      returnedMap[key] = (returnedMap[key] || 0) + (item.quantity || 0);
    });
  });

  const tbody = document.getElementById('sales-return-items-body');
  if (!tbody) return;

  tbody.innerHTML = (order.items || []).map((item, idx) => {
    const itemKey = item.id || `${item.productCode || item.code}_${item.package}`;
    const soldQty = Number(item.quantity || 0);
    const prevReturned = returnedMap[itemKey] || 0;
    const maxReturnable = Math.max(0, soldQty - prevReturned);
    const unitPrice = Number(item.price || 0);
    const prodName = item.productName || (item.product && item.product.name) || item.name || 'Sản phẩm';

    return `
      <tr class="return-item-row" data-key="${itemKey}" data-sale-item-id="${item.id || ''}" data-product-id="${item.productCode || item.code || ''}" data-product-name="${prodName}" data-package="${item.package}" data-unit-price="${unitPrice}" data-sold-qty="${soldQty}" data-prev-returned="${prevReturned}" data-max-returnable="${maxReturnable}">
        <td>${idx + 1}</td>
        <td style="font-weight: 600; color: #fff;">${prodName}</td>
        <td>${item.package || 'Cái'}</td>
        <td style="text-align: right;">${formatCurrency(unitPrice)}</td>
        <td style="text-align: center; font-weight: 600;">${soldQty}</td>
        <td style="text-align: center; color: var(--color-warning);">${prevReturned}</td>
        <td style="text-align: center;">
          <input type="number" class="form-control return-qty-input" min="0" max="${maxReturnable}" value="0" ${maxReturnable === 0 ? 'disabled' : ''} style="width: 70px; text-align: center; font-weight: 700; height: 32px; padding: 2px;">
        </td>
        <td>
          <select class="form-control return-disc-type" style="height: 32px; font-size: 0.78rem; padding: 0 4px;" ${maxReturnable === 0 ? 'disabled' : ''}>
            <option value="percent">%</option>
            <option value="amount">VNĐ</option>
          </select>
        </td>
        <td>
          <input type="number" class="form-control return-disc-val" min="0" value="0" style="width: 80px; height: 32px; font-size: 0.8rem; padding: 2px 4px;" ${maxReturnable === 0 ? 'disabled' : ''}>
        </td>
        <td style="text-align: right; font-weight: 600; color: var(--color-primary);" class="return-refund-price-lbl">${formatCurrency(unitPrice)}</td>
        <td style="text-align: right; font-weight: 700; color: #f59e0b;" class="return-subtotal-lbl">0 ₫</td>
      </tr>
    `;
  }).join('');

  const recalculateTotals = () => {
    let totalRefund = 0;
    document.querySelectorAll('.return-item-row').forEach(row => {
      const unitPrice = parseFloat(row.getAttribute('data-unit-price')) || 0;
      const maxReturnable = parseFloat(row.getAttribute('data-max-returnable')) || 0;
      
      const qtyInput = row.querySelector('.return-qty-input');
      const discTypeSelect = row.querySelector('.return-disc-type');
      const discValInput = row.querySelector('.return-disc-val');
      
      let qty = parseFloat(qtyInput.value) || 0;
      if (qty < 0) { qty = 0; qtyInput.value = 0; }
      if (qty > maxReturnable) {
        showToast(`Số lượng trả không được vượt quá số lượng còn lại (${maxReturnable})!`, 'warning');
        qty = maxReturnable;
        qtyInput.value = maxReturnable;
      }

      const discType = discTypeSelect.value;
      let discVal = parseFloat(discValInput.value) || 0;
      if (discVal < 0) { discVal = 0; discValInput.value = 0; }

      let discAmt = 0;
      if (discType === 'percent') {
        if (discVal > 100) { discVal = 100; discValInput.value = 100; }
        discAmt = (unitPrice * discVal) / 100;
      } else {
        if (discVal > unitPrice) { discVal = unitPrice; discValInput.value = unitPrice; }
        discAmt = discVal;
      }

      const refundPrice = Math.max(0, unitPrice - discAmt);
      const subtotal = Math.round(refundPrice * qty);

      row.querySelector('.return-refund-price-lbl').innerText = formatCurrency(refundPrice);
      row.querySelector('.return-subtotal-lbl').innerText = formatCurrency(subtotal);

      totalRefund += subtotal;
    });

    document.getElementById('return-total-refund-lbl').innerText = formatCurrency(totalRefund);

    const cust = order.customerId ? state.customers.find(c => c.id === order.customerId) : null;
    const warningDiv = document.getElementById('return-excess-warning');
    const excessAmtLbl = document.getElementById('return-excess-amount');
    
    if (cust && warningDiv && excessAmtLbl) {
      const currentDebt = parseFloat(cust.debt || 0);
      const debtAfter = currentDebt - totalRefund;
      if (debtAfter < 0) {
        warningDiv.style.display = 'block';
        excessAmtLbl.innerText = formatCurrency(Math.abs(debtAfter));
      } else {
        warningDiv.style.display = 'none';
      }
    }
  };

  document.querySelectorAll('.return-qty-input, .return-disc-type, .return-disc-val').forEach(el => {
    el.addEventListener('input', recalculateTotals);
    el.addEventListener('change', recalculateTotals);
  });

  recalculateTotals();
  modal.classList.add('active');
}

export async function processSalesReturnSubmit(e) {
  e.preventDefault();
  
  const orderId = document.getElementById('return-order-id').value;
  const reason = document.getElementById('return-reason-input').value.trim();
  
  const order = state.savedOrders.find(o => o.id === orderId);
  if (!order) {
    showToast('Không tìm thấy thông tin đơn hàng gốc!', 'danger');
    return;
  }

  if (!reason) {
    showToast('Vui lòng nhập lý do trả hàng!', 'warning');
    return;
  }

  const returnItems = [];
  let totalRefund = 0;
  let hasValidQty = false;
  let validationError = false;

  document.querySelectorAll('.return-item-row').forEach(row => {
    const qty = parseFloat(row.querySelector('.return-qty-input').value) || 0;
    const maxReturnable = parseFloat(row.getAttribute('data-max-returnable')) || 0;
    const prodName = row.getAttribute('data-product-name');
    
    if (qty > maxReturnable) {
      showToast(`Sản phẩm "${prodName}" có số lượng trả (${qty}) vượt quá giới hạn cho phép (${maxReturnable})!`, 'danger');
      validationError = true;
      return;
    }

    if (qty > 0) {
      hasValidQty = true;
      const unitPrice = parseFloat(row.getAttribute('data-unit-price')) || 0;
      const discType = row.querySelector('.return-disc-type').value;
      const discVal = parseFloat(row.querySelector('.return-disc-val').value) || 0;
      
      let discAmt = discType === 'percent' ? (unitPrice * discVal / 100) : discVal;
      const refundPrice = Math.max(0, unitPrice - discAmt);
      const subtotal = Math.round(refundPrice * qty);
      
      totalRefund += subtotal;

      returnItems.push({
        id: `thitem_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        saleItemId: row.getAttribute('data-sale-item-id'),
        productId: row.getAttribute('data-product-id'),
        productName: prodName,
        packageType: row.getAttribute('data-package'),
        quantity: qty,
        importPrice: unitPrice,
        discountType: discType,
        discountValue: discVal,
        refundPrice: refundPrice,
        subtotal: subtotal
      });
    }
  });

  if (validationError) return;

  if (!hasValidQty) {
    showToast('Vui lòng chọn ít nhất 1 sản phẩm có số lượng trả > 0!', 'warning');
    return;
  }

  const seq = (state.salesReturns || []).length + 1;
  const returnId = `TH${String(seq).padStart(6, '0')}`;
  
  const returnObj = {
    id: returnId,
    saleId: order.id,
    customerId: order.customerId || null,
    customerName: order.customerName,
    createdBy: state.currentUser ? state.currentUser.username : 'admin',
    creatorName: state.currentUser ? state.currentUser.displayName : 'Administrator',
    createdAt: new Date().toISOString(),
    reason: reason,
    totalRefund: totalRefund,
    status: 'completed',
    items: returnItems
  };

  // 1. Save Sales Return
  state.salesReturns.unshift(returnObj);
  await dbSaveSalesReturn(returnObj);

  // 2. Restore Finished Goods Stock
  returnItems.forEach(item => {
    const prodCode = item.productId;
    const pkg = item.packageType;
    let stockItem = state.finishedGoodsStock.find(s => s.productCode === prodCode && s.packageType === pkg);
    if (stockItem) {
      stockItem.quantity += item.quantity;
    } else {
      state.finishedGoodsStock.push({
        productCode: prodCode,
        brand: 'Nano10*',
        packageType: pkg,
        quantity: item.quantity
      });
    }
  });
  localStorage.setItem('billing_system_finished_goods_stock', JSON.stringify(state.finishedGoodsStock));

  // 3. Update Customer Debt & Debt History
  if (order.customerId) {
    const cust = state.customers.find(c => c.id === order.customerId);
    if (cust) {
      const oldDebt = parseFloat(cust.debt || 0);
      const newDebt = oldDebt - totalRefund;
      cust.debt = newDebt;

      if (!cust.debtHistory) cust.debtHistory = [];
      cust.debtHistory.push({
        date: new Date().toISOString(),
        type: 'return',
        amount: totalRefund,
        debtAfter: newDebt,
        note: `Phiếu trả hàng ${returnId} cho đơn ${order.id}: ${reason}`
      });

      await dbSaveCustomer(cust);
    }
  }

  // 4. Update Order Status
  const allOrderReturns = state.salesReturns.filter(r => r.saleId === order.id && r.status !== 'cancelled');
  const totalReturnedMap = {};
  allOrderReturns.forEach(r => {
    (r.items || []).forEach(i => {
      const key = i.saleItemId || `${i.productId}_${i.packageType}`;
      totalReturnedMap[key] = (totalReturnedMap[key] || 0) + i.quantity;
    });
  });

  let isFullyReturned = true;
  order.items.forEach(i => {
    const key = i.id || `${i.productCode || i.code}_${i.package}`;
    const retQty = totalReturnedMap[key] || 0;
    if (retQty < i.quantity) {
      isFullyReturned = false;
    }
  });

  order.status = isFullyReturned ? 'returned' : 'partially_returned';
  await dbSaveOrder(order);

  document.getElementById('sales-return-modal').classList.remove('active');
  renderAll();
  showToast(`Đã tạo thành công phiếu trả hàng ${returnId}!`, 'success');
}

export async function cancelSalesReturn(returnId) {
  const ret = (state.salesReturns || []).find(r => r.id === returnId);
  if (!ret || ret.status === 'cancelled') {
    showToast('Phiếu trả hàng không tồn tại hoặc đã được hủy trước đó!', 'danger');
    return;
  }

  if (!confirm(`Bạn có chắc chắn muốn HỦY phiếu trả hàng [${returnId}]? Thao tác này sẽ trừ lại tồn kho, khôi phục lại công nợ đối tác và không thể hoàn tác.`)) {
    return;
  }

  ret.status = 'cancelled';

  (ret.items || []).forEach(item => {
    const prodCode = item.productId;
    const pkg = item.packageType;
    let stockItem = state.finishedGoodsStock.find(s => s.productCode === prodCode && s.packageType === pkg);
    if (stockItem) {
      stockItem.quantity = Math.max(0, stockItem.quantity - item.quantity);
    }
  });
  localStorage.setItem('billing_system_finished_goods_stock', JSON.stringify(state.finishedGoodsStock));

  if (ret.customerId) {
    const cust = state.customers.find(c => c.id === ret.customerId);
    if (cust) {
      const oldDebt = parseFloat(cust.debt || 0);
      const newDebt = oldDebt + ret.totalRefund;
      cust.debt = newDebt;

      if (!cust.debtHistory) cust.debtHistory = [];
      cust.debtHistory.push({
        date: new Date().toISOString(),
        type: 'return_cancel',
        amount: ret.totalRefund,
        debtAfter: newDebt,
        note: `Hủy phiếu trả hàng ${ret.id} của đơn ${ret.saleId}`
      });

      await dbSaveCustomer(cust);
    }
  }

  const order = state.savedOrders.find(o => o.id === ret.saleId);
  if (order) {
    const activeReturns = state.salesReturns.filter(r => r.saleId === order.id && r.status !== 'cancelled');
    if (activeReturns.length === 0) {
      order.status = 'settled';
    } else {
      order.status = 'partially_returned';
    }
    await dbSaveOrder(order);
  }

  await dbSaveSalesReturn(ret);
  renderAll();
  showToast(`Đã hủy phiếu trả hàng ${returnId} thành công!`, 'warning');
}

export function printReturnSlip(ret) {
  if (!ret) return;

  document.getElementById('print-return-id').innerText = ret.id;
  document.getElementById('print-return-sale-id').innerText = ret.saleId;
  document.getElementById('print-return-customer-name').innerText = ret.customerName;
  document.getElementById('print-return-date').innerText = formatDateTime(ret.createdAt);
  document.getElementById('print-return-creator').innerText = ret.creatorName || ret.createdBy;
  document.getElementById('print-return-reason').innerText = ret.reason || 'N/A';
  document.getElementById('print-return-total-refund').innerText = formatCurrency(ret.totalRefund);

  const tbody = document.getElementById('print-return-items-body');
  if (tbody) {
    tbody.innerHTML = (ret.items || []).map((item, idx) => `
      <tr>
        <td style="border: 1px solid #000; padding: 6px; text-align: center;">${idx + 1}</td>
        <td style="border: 1px solid #000; padding: 6px;">${item.productName}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: center;">${item.packageType || ''}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: center; font-weight: bold;">${item.quantity}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: right;">${formatCurrency(item.importPrice)}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: right;">${formatCurrency(item.refundPrice)}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: right; font-weight: bold;">${formatCurrency(item.subtotal)}</td>
      </tr>
    `).join('');
  }

  document.body.classList.add('printing-return');
  window.print();
  document.body.classList.remove('printing-return');
}

// Attach to window for inline HTML handlers
window.openSalesReturnModal = openSalesReturnModal;
window.cancelSalesReturn = cancelSalesReturn;
window.printReturnSlip = printReturnSlip;


