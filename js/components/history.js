import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatDateTime } from '../utils.js';
import { dbDeleteOrder, dbDeleteAllOrders, fetchCloudData } from '../services/supabase.js';
import { renderAll } from '../main.js';
import { openPrintTypeModal } from './invoice.js';

export function setupHistoryPanel() {
  const searchInput = document.getElementById('history-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', renderHistoryOrders);
  }
  
  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (state.savedOrders.length === 0) {
        showToast('Lịch sử đơn hàng trống!', 'warning');
        return;
      }
      
      if (confirm('CẢNH BÁO: Bạn có muốn xóa toàn bộ lịch sử đơn hàng không? Hành động này không thể hoàn tác.')) {
        const cleared = await dbDeleteAllOrders();
        if (cleared) {
          state.savedOrders = [];
          renderAll();
          showToast('Đã xóa toàn bộ lịch sử hóa đơn!', 'warning');
        }
      }
    });
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

export function renderHistoryOrders() {
  const container = document.getElementById('history-orders-container');
  if (!container) return;
  
  const searchVal = document.getElementById('history-search-input').value.toLowerCase().trim();

  const filtered = state.savedOrders.filter(o => {
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (o.createdBy !== state.currentUser.username) return false;
    }
    return o.id.toLowerCase().includes(searchVal) || o.customerName.toLowerCase().includes(searchVal);
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

  container.innerHTML = sorted.map(order => {
    const totalItemsCount = order.items.reduce((sum, item) => sum + Number(item.quantity), 0);
    const statusBadge = order.status === 'draft' ? 
      `<span style="background: var(--color-danger-light); color: var(--color-danger); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đơn nháp</span>` : 
      `<span style="background: var(--color-primary-light); color: var(--color-primary); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã chốt</span>`;
      
    const creator = state.users.find(u => u.username === order.createdBy);
    const creatorName = creator ? creator.displayName : order.createdBy;

    let showDeleteBtn = true;
    if (order.status === 'settled' && state.currentUser && state.currentUser.role !== 'admin') {
      showDeleteBtn = false;
    }
    const gridCols = showDeleteBtn ? '1fr 1fr 1fr' : '1fr 1fr';

    return `
      <div class="glass-panel order-card flex flex-col justify-between" style="padding: 1.25rem; gap: 1rem;">
        <div>
          <div class="flex justify-between items-center" style="margin-bottom: 0.75rem;">
            <span class="order-id" style="font-weight: 700; color: #fff; font-size: 1.05rem;">${order.id}</span>
            <div style="display: flex; gap: 0.35rem; align-items: center;">
              ${statusBadge}
            </div>
          </div>
          
          <div class="order-meta" style="font-size: 0.85rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;">
            <div class="flex items-center gap-1"><i data-lucide="user" style="width:13px;height:13px;color: var(--color-primary);"></i> <span>Khách hàng: <strong>${order.customerName}</strong></span></div>
            <div class="flex items-center gap-1"><i data-lucide="calendar" style="width:13px;height:13px;"></i> <span>Ngày lập: ${formatDateTime(order.date)}</span></div>
            <div class="flex items-center gap-1"><i data-lucide="user-check" style="width:13px;height:13px;"></i> <span>Người tạo: ${creatorName}</span></div>
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
          
          <div class="order-actions" style="display: grid; grid-template-columns: ${gridCols}; gap: 0.5rem;">
            <button class="btn btn-indigo btn-sm flex items-center justify-center gap-1 history-print-btn" data-id="${order.id}">
              <i data-lucide="printer" style="width: 14px; height: 14px;"></i> In đơn
            </button>
            
            ${order.status === 'draft' ? `
              <button class="btn btn-primary btn-sm flex items-center justify-center gap-1 history-edit-btn" data-id="${order.id}">
                <i data-lucide="edit" style="width: 14px; height: 14px;"></i> Sửa đơn
              </button>
            ` : `
              <button class="btn btn-teal btn-sm flex items-center justify-center gap-1 history-view-btn" data-id="${order.id}">
                <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Xem đơn
              </button>
            `}
            
            ${showDeleteBtn ? `
              <button class="btn btn-danger btn-sm flex items-center justify-center gap-1 history-delete-btn" data-id="${order.id}">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Xóa
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Gán sự kiện click cho các nút hành động trong lịch sử
  document.querySelectorAll('.history-print-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      printOrderById(id);
    });
  });

  document.querySelectorAll('.history-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      deleteOrder(id);
    });
  });

  document.querySelectorAll('.history-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const order = state.savedOrders.find(o => o.id === id);
      if (order) {
        // Tải đơn nháp lên bảng tính để chốt đơn
        loadDraftOrderIntoInvoice(order);
      }
    });
  });

  document.querySelectorAll('.history-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const order = state.savedOrders.find(o => o.id === id);
      if (order) {
        // Chỉ xem đơn (Chế độ Read-only)
        loadDraftOrderIntoInvoice(order, true);
      }
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
