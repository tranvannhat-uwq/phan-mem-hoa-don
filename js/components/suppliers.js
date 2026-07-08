import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatPhoneNumber } from '../utils.js';
import { dbSaveSupplier, dbDeleteSupplier } from '../services/supabase.js';
import { renderAll } from '../main.js';

export function renderSuppliersTable() {
  const tableBody = document.getElementById('suppliers-table-body');
  if (!tableBody) return;
  
  const searchVal = document.getElementById('supplier-search-input').value.toLowerCase().trim();
  
  const filtered = state.suppliers.filter(s => {
    return s.code.toLowerCase().includes(searchVal) || 
           s.name.toLowerCase().includes(searchVal) || 
           (s.phone && s.phone.includes(searchVal));
  });
  
  // Sắp xếp theo tên nhà cung cấp
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  
  const ITEMS_PER_PAGE = 20;
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  
  if (state.suppliersPage > totalPages) state.suppliersPage = totalPages;
  if (state.suppliersPage < 1) state.suppliersPage = 1;
  
  const startIndex = (state.suppliersPage - 1) * ITEMS_PER_PAGE;
  const paginatedSuppliers = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  
  // Vẽ các nút phân trang
  const paginationContainer = document.getElementById('suppliers-pagination');
  if (paginationContainer) {
    paginationContainer.innerHTML = `
      <div class="pagination-controls" style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border-color); width: 100%;">
        <button class="btn btn-secondary btn-sm" id="suppliers-prev-page" ${state.suppliersPage === 1 ? 'disabled' : ''}>
          <i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i> Trước
        </button>
        <span style="font-size: 0.9rem; color: var(--text-secondary); font-weight: 500;">
          Trang <strong>${state.suppliersPage}</strong> / ${totalPages} (${totalItems} nhà cung cấp)
        </span>
        <button class="btn btn-secondary btn-sm" id="suppliers-next-page" ${state.suppliersPage === totalPages ? 'disabled' : ''}>
          Sau <i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>
        </button>
      </div>
    `;

    const prevPageBtn = document.getElementById('suppliers-prev-page');
    if (prevPageBtn) {
      prevPageBtn.addEventListener('click', () => {
        state.suppliersPage--;
        renderSuppliersTable();
        document.getElementById('suppliers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }

    const nextPageBtn = document.getElementById('suppliers-next-page');
    if (nextPageBtn) {
      nextPageBtn.addEventListener('click', () => {
        state.suppliersPage++;
        renderSuppliersTable();
        document.getElementById('suppliers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }
  }

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy nhà cung cấp nào.
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = paginatedSuppliers.map((s) => {
    const actualIndex = state.suppliers.findIndex(supp => supp.id === s.id);
    
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">${s.code}</td>
        <td style="font-weight: bold; color: #22c55e;">${s.name}</td>
        <td>${s.phone || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td>${s.address || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td style="font-size: 0.85rem; color: var(--text-secondary);">${s.notes || ''}</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-supplier-btn" data-index="${actualIndex}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-supplier-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  // Gán sự kiện click cho các nút hành động
  document.querySelectorAll('.edit-supplier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openEditSupplierModal(idx);
    });
  });

  document.querySelectorAll('.delete-supplier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      handleDeleteSupplier(idx);
    });
  });

  safeCreateIcons();
}

export function populateSupplierDatalist() {
  const datalist = document.getElementById('payment-recipient-list');
  if (!datalist) return;

  datalist.innerHTML = state.suppliers.map(s => {
    return `<option value="${s.name}">${s.code} - ${s.phone || 'N/A'}</option>`;
  }).join('');
}

export function setupSupplierManagement() {
  const btnOpenAdd = document.getElementById('btn-open-add-supplier-modal');
  const modal = document.getElementById('supplier-modal');
  const form = document.getElementById('supplier-form');
  const btnClose = document.getElementById('btn-close-supplier-modal');
  const btnCancel = document.getElementById('btn-cancel-supplier-modal');
  const searchInput = document.getElementById('supplier-search-input');

  if (btnOpenAdd && modal) {
    btnOpenAdd.addEventListener('click', () => {
      document.getElementById('supplier-modal-title').innerText = 'Thêm nhà cung cấp';
      form.reset();
      document.getElementById('supplier-id').value = '';
      
      // Auto-generate code if empty
      const nextNum = state.suppliers.length + 1;
      document.getElementById('supplier-code').value = 'NCC' + String(nextNum).padStart(3, '0');
      
      modal.classList.add('active');
    });
  }

  const closeModal = () => {
    if (modal) modal.classList.remove('active');
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const id = document.getElementById('supplier-id').value;
      const code = document.getElementById('supplier-code').value.trim();
      const name = document.getElementById('supplier-name').value.trim();
      const phone = document.getElementById('supplier-phone').value.trim();
      const address = document.getElementById('supplier-address').value.trim();
      const debt = parseFloat(document.getElementById('supplier-debt').value) || 0;
      const notes = document.getElementById('supplier-notes').value.trim();

      // Kiểm tra trùng mã
      const isDupCode = state.suppliers.some(s => s.code.toLowerCase() === code.toLowerCase() && s.id !== id);
      if (isDupCode) {
        showToast('Mã nhà cung cấp đã tồn tại!', 'danger');
        return;
      }

      const supplierData = {
        id: id || 'supplier-' + Date.now(),
        code,
        name,
        phone,
        address,
        debt,
        notes
      };

      if (id) {
        // Cập nhật
        const idx = state.suppliers.findIndex(s => s.id === id);
        if (idx !== -1) {
          state.suppliers[idx] = supplierData;
          showToast('Cập nhật nhà cung cấp thành công!');
        }
      } else {
        // Thêm mới
        state.suppliers.push(supplierData);
        showToast('Thêm nhà cung cấp thành công!');
      }

      // Lưu LocalStorage
      localStorage.setItem('billing_system_suppliers', JSON.stringify(state.suppliers));
      
      // Lưu đám mây
      dbSaveSupplier(supplierData);

      closeModal();
      
      // Vẽ lại bảng và các datalist liên quan
      renderSuppliersTable();
      populateSupplierDatalist();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.suppliersPage = 1;
      renderSuppliersTable();
    });
  }

  // Khởi tạo datalist cho phiếu chi ban đầu
  populateSupplierDatalist();
}

function openEditSupplierModal(idx) {
  const s = state.suppliers[idx];
  if (!s) return;

  const modal = document.getElementById('supplier-modal');
  if (!modal) return;

  document.getElementById('supplier-modal-title').innerText = 'Sửa nhà cung cấp';
  document.getElementById('supplier-id').value = s.id;
  document.getElementById('supplier-code').value = s.code;
  document.getElementById('supplier-name').value = s.name;
  document.getElementById('supplier-phone').value = s.phone || '';
  document.getElementById('supplier-address').value = s.address || '';
  document.getElementById('supplier-debt').value = s.debt || 0;
  document.getElementById('supplier-notes').value = s.notes || '';

  modal.classList.add('active');
}

function handleDeleteSupplier(idx) {
  const s = state.suppliers[idx];
  if (!s) return;

  if (confirm(`Bạn có chắc chắn muốn xóa nhà cung cấp "${s.name}"?`)) {
    state.suppliers.splice(idx, 1);
    localStorage.setItem('billing_system_suppliers', JSON.stringify(state.suppliers));
    dbDeleteSupplier(s.id);
    showToast('Đã xóa nhà cung cấp thành công!', 'warning');
    
    renderSuppliersTable();
    populateSupplierDatalist();
  }
}
