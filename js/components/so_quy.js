import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatDateTime, isSameUser, getManagerDisplayName } from '../utils.js';
import { fetchCloudData } from '../services/supabase.js';
import { renderAll } from '../main.js';
import { printOrderById } from './history.js';

export function setupSoQuyPanel() {
  const searchInput = document.getElementById('so-quy-search-input');
  
  const onFilterChange = () => {
    renderSoQuyTable();
  };

  if (searchInput) {
    searchInput.addEventListener('input', onFilterChange);
  }
  
  // Thiết lập các bộ lọc thời gian, khách hàng, nhân viên
  const dateModeSelect = document.getElementById('so-quy-date-mode');
  const filterDateInput = document.getElementById('so-quy-filter-date');
  const filterMonthInput = document.getElementById('so-quy-filter-month');
  const filterYearSelect = document.getElementById('so-quy-filter-year');
  const filterRangeDiv = document.getElementById('so-quy-filter-range');
  
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

    // Mặc định ban đầu hiển thị lọc theo ngày hôm nay
    dateModeSelect.value = 'date';
    filterDateInput.style.display = 'block';
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    filterDateInput.value = `${yyyy}-${mm}-${dd}`;

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
    document.getElementById('so-quy-filter-from').addEventListener('input', onFilterChange);
    document.getElementById('so-quy-filter-to').addEventListener('input', onFilterChange);
  }
  
  const customerFilter = document.getElementById('so-quy-customer-filter');
  if (customerFilter) {
    customerFilter.addEventListener('input', onFilterChange);
  }
  
  const creatorFilter = document.getElementById('so-quy-creator-filter');
  if (creatorFilter) {
    creatorFilter.addEventListener('input', onFilterChange);
  }

  const refreshBtn = document.getElementById('btn-refresh-so-quy');
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
}

let lastCustomerLength = 0;
let lastUserLength = 0;

export function populateSoQuyFilters() {
  const customerList = document.getElementById('so-quy-customer-list');
  const creatorList = document.getElementById('so-quy-creator-list');
  
  if (!customerList || !creatorList) return;
  
  if (state.customers.length === lastCustomerLength && state.users.length === lastUserLength) {
    return;
  }
  
  lastCustomerLength = state.customers.length;
  lastUserLength = state.users.length;
  
  customerList.innerHTML = '';
  state.customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = `${c.code} - ${c.name}`;
    customerList.appendChild(opt);
  });
  
  creatorList.innerHTML = '';
  state.users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.displayName;
    opt.textContent = `@${u.username}`;
    creatorList.appendChild(opt);
  });
}

export function renderSoQuyTable() {
  const tableBody = document.getElementById('so-quy-table-body');
  if (!tableBody) return;
  
  populateSoQuyFilters();
  
  const searchVal = document.getElementById('so-quy-search-input').value.toLowerCase().trim();
  
  const dateModeSelect = document.getElementById('so-quy-date-mode');
  const filterDateInput = document.getElementById('so-quy-filter-date');
  const filterMonthInput = document.getElementById('so-quy-filter-month');
  const filterYearSelect = document.getElementById('so-quy-filter-year');
  const filterFromInput = document.getElementById('so-quy-filter-from');
  const filterToInput = document.getElementById('so-quy-filter-to');
  const customerFilterSelect = document.getElementById('so-quy-customer-filter');
  const creatorFilterSelect = document.getElementById('so-quy-creator-filter');
  
  const dateMode = dateModeSelect ? dateModeSelect.value : 'all';
  const filterDate = filterDateInput ? filterDateInput.value : '';
  const filterMonth = filterMonthInput ? filterMonthInput.value : '';
  const filterYear = filterYearSelect ? filterYearSelect.value : '';
  const filterFrom = filterFromInput ? filterFromInput.value : '';
  const filterTo = filterToInput ? filterToInput.value : '';
  const selectedCust = customerFilterSelect ? customerFilterSelect.value : '';
  const selectedCreator = creatorFilterSelect ? creatorFilterSelect.value : '';

  const filtered = state.savedOrders.filter(o => {
    // Chỉ lấy các đơn đã chốt
    if (o.status === 'draft') return false;

    // Phân quyền hiển thị đơn của Sale
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (!isSameUser(o.createdBy, state.currentUser.username)) return false;
    }
    
    // Lọc theo tìm kiếm từ khóa
    const matchesSearch = o.id.toLowerCase().includes(searchVal) || o.customerName.toLowerCase().includes(searchVal);
    if (!matchesSearch) return false;
    
    // Lọc theo khách hàng
    if (selectedCust && !o.customerName.toLowerCase().includes(selectedCust.toLowerCase().trim())) return false;
    
    // Lọc theo nhân viên quản lý (của khách hàng, fallback về người tạo đơn)
    if (selectedCreator) {
      const filterLower = selectedCreator.toLowerCase().trim();
      
      let managerUsername = o.createdBy || '';
      const cust = o.customerId ? state.customers.find(c => c.id === o.customerId) : null;
      if (cust && cust.managedBy) {
        managerUsername = cust.managedBy;
      }
      
      const matchingUsers = state.users.filter(u => 
        u.displayName.toLowerCase().includes(filterLower) || 
        u.username.toLowerCase().includes(filterLower)
      );
      
      let matched = false;
      if (matchingUsers.length > 0) {
        matched = matchingUsers.some(u => isSameUser(managerUsername, u.username));
      }
      
      if (!matched) {
        const managerClean = managerUsername.toLowerCase();
        if (managerClean.includes(filterLower)) {
          matched = true;
        }
      }
      
      if (!matched) return false;
    }
    
    // Lọc theo thời gian
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

  // Tính toán số liệu thống kê tổng hợp từ các đơn hàng đã lọc
  let totalOrdersCount = filtered.length;
  let sumMarket = 0;
  let sumDiscount = 0;
  let sumShipping = 0;
  let sumPayable = 0;
  
  filtered.forEach(o => {
    sumMarket += (o.totalMarket || 0);
    sumDiscount += (o.totalDiscount || 0);
    sumShipping += (o.shippingDiscount || 0);
    sumPayable += (o.totalPayable || 0);
  });
  
  const statsContainer = document.getElementById('so-quy-summary-stats');
  if (statsContainer) {
    statsContainer.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem;">
        <!-- Card 1: Số đơn hàng -->
        <div class="stat-card" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px; padding: 1.25rem; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 0.5rem;">
          <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Tổng đơn đã chốt</span>
          <span style="font-size: 1.75rem; font-weight: 800; color: var(--color-secondary);">${totalOrdersCount} đơn</span>
          <span style="font-size: 0.7rem; color: var(--text-muted);">Đã được lọc theo điều kiện</span>
        </div>
        
        <!-- Card 2: Thực thu -->
        <div class="stat-card" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px; padding: 1.25rem; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 0.5rem;">
          <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Thực tế bán được (Thực thu)</span>
          <span style="font-size: 1.75rem; font-weight: 800; color: var(--color-primary);">${formatCurrency(sumPayable)}</span>
          <span style="font-size: 0.7rem; color: var(--text-muted);">Tổng doanh số thực tế phải thu</span>
        </div>
      </div>
    `;
  }

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không có giao dịch chốt đơn nào trong khoảng thời gian đã chọn
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filtered.map((o, index) => {
    // Xác định nhân viên quản lý thực tế của khách hàng (hoặc fallback về người tạo đơn)
    let managerName = 'Chưa phân công';
    const cust = o.customerId ? state.customers.find(c => c.id === o.customerId) : null;
    if (cust && cust.managedBy) {
      managerName = getManagerDisplayName(cust.managedBy, state.users);
    } else {
      managerName = getManagerDisplayName(o.createdBy, state.users);
    }
    
    // Tên bảng giá áp dụng
    const pl = state.pricelists.find(p => p.id === o.pricelistId);
    const plName = pl ? pl.name : (o.pricelistId === 'custom' ? 'Chiết khấu riêng' : (o.pricelistId === 'retail' ? 'Nhập tay' : 'Bảng giá chuẩn'));

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${index + 1}</td>
        <td style="text-align: center; font-weight: 700; color: var(--color-primary); cursor: pointer;" class="so-quy-order-id" data-id="${o.id}">${o.id}</td>
        <td style="text-align: center; color: var(--text-muted);">${formatDateTime(o.date)}</td>
        <td>
          <div style="font-weight: 600; color: #fff;">${o.customerName}</div>
        </td>
        <td>
          <span style="color: var(--text-secondary); font-size: 0.85rem;">${managerName}</span>
        </td>
        <td>
          <span style="font-size: 0.8rem; background: rgba(245, 158, 11, 0.1); color: #f59e0b; padding: 2px 6px; border-radius: 4px;">${plName}</span>
        </td>
        <td style="text-align: right; font-weight: 500;">${formatCurrency(o.totalMarket)}</td>
        <td style="text-align: right; color: var(--color-danger);">${formatCurrency(o.totalDiscount + o.shippingDiscount)}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-primary);">${formatCurrency(o.totalPayable)}</td>
        <td style="text-align: center;">
          <button class="btn btn-primary btn-sm so-quy-print-btn" data-id="${o.id}" style="padding: 2px 8px; font-size: 0.75rem;">
            <i data-lucide="printer" style="width: 12px; height: 12px; margin-right: 2px;"></i> In đơn
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Gắn sự kiện click vào ID đơn hàng để xem chi tiết hoặc in ấn
  tableBody.querySelectorAll('.so-quy-order-id').forEach(el => {
    el.addEventListener('click', () => {
      const orderId = el.getAttribute('data-id');
      printOrderById(orderId);
    });
  });

  tableBody.querySelectorAll('.so-quy-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute('data-id');
      printOrderById(orderId);
    });
  });

  safeCreateIcons();
}
