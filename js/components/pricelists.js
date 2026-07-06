import { state } from '../state.js';
import { showToast, safeCreateIcons } from '../utils.js';
import { dbSavePricelist, dbDeletePricelist } from '../services/supabase.js';
import { renderAll } from '../main.js';
import { applyActivePriceListToInvoice } from './invoice.js';

export function renderPricelistsTable() {
  const tableBody = document.getElementById('pricelists-table-body');
  if (!tableBody) return;
  
  const searchInput = document.getElementById('pricelist-search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  const filtered = state.pricelists.filter(pl => pl.name.toLowerCase().includes(searchVal));
  
  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy bảng giá nào.
        </td>
      </tr>
    `;
    return;
  }
  
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  
  tableBody.innerHTML = filtered.map((pl) => {
    const actualIndex = state.pricelists.findIndex(p => p.id === pl.id);
    const getDisc = (brand) => (pl.brandDiscounts && pl.brandDiscounts[brand] !== undefined) ? pl.brandDiscounts[brand] : 0;
    
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">${pl.name}</td>
        <td style="text-align: center;">${getDisc('Nano10*')}%</td>
        <td style="text-align: center;">${getDisc('Hatacco nano')}%</td>
        <td style="text-align: center;">${getDisc('mutsutec')}%</td>
        <td style="text-align: center;">${getDisc('tdkaw')}%</td>
        <td style="text-align: center;">${getDisc('cova')}%</td>
        <td style="text-align: center;">${getDisc('festivanano')}%</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-pl-btn" data-index="${actualIndex}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-pl-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  document.querySelectorAll('.edit-pl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openPricelistModal(idx);
    });
  });
  
  document.querySelectorAll('.delete-pl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      deletePricelist(idx);
    });
  });
  
  safeCreateIcons();
}

export function openPricelistModal(index = -1) {
  const modal = document.getElementById('pricelist-modal');
  const title = document.getElementById('pricelist-modal-title');
  const form = document.getElementById('pricelist-form');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();
  
  document.querySelectorAll('.pl-brand-disc').forEach(input => input.value = 0);
  
  if (index === -1) {
    title.innerText = 'Thêm bảng giá mới';
    document.getElementById('pricelist-edit-index').value = '-1';
    document.getElementById('pricelist-edit-id').value = '';
  } else {
    title.innerText = 'Chỉnh sửa bảng giá';
    const pl = state.pricelists[index];
    document.getElementById('pricelist-edit-index').value = index;
    document.getElementById('pricelist-edit-id').value = pl.id;
    
    document.getElementById('pl-name').value = pl.name;
    
    document.querySelectorAll('.pl-brand-disc').forEach(input => {
      const brand = input.getAttribute('data-brand');
      input.value = (pl.brandDiscounts && pl.brandDiscounts[brand] !== undefined) ? pl.brandDiscounts[brand] : 0;
    });
  }
}

export function closePricelistModal() {
  const modal = document.getElementById('pricelist-modal');
  if (modal) modal.classList.remove('active');
}

export async function savePricelist() {
  const index = parseInt(document.getElementById('pricelist-edit-index').value);
  const editId = document.getElementById('pricelist-edit-id').value;
  const name = document.getElementById('pl-name').value.trim();
  
  const duplicateName = state.pricelists.some((p, idx) => p.name.toLowerCase() === name.toLowerCase() && idx !== index);
  if (duplicateName) {
    showToast('Tên bảng giá đã tồn tại!', 'danger');
    return;
  }
  
  const brandDiscounts = {};
  document.querySelectorAll('.pl-brand-disc').forEach(input => {
    const brand = input.getAttribute('data-brand');
    brandDiscounts[brand] = parseFloat(input.value) || 0;
  });
  
  const pricelistId = index === -1 ? `pl-${Date.now()}` : editId;
  const pricelistData = {
    id: pricelistId,
    name,
    brandDiscounts
  };
  
  const saved = await dbSavePricelist(pricelistData);
  if (saved) {
    if (index === -1) showToast('Thêm bảng giá thành công!');
    else showToast('Cập nhật bảng giá thành công!');
    
    const idx = state.pricelists.findIndex(p => p.id === pricelistId);
    if (idx !== -1) state.pricelists[idx] = pricelistData;
    else state.pricelists.push(pricelistData);
    localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
    
    closePricelistModal();
    renderAll();
    
    populatePricelistsDropdowns();
    const plSelect = document.getElementById('invoice-pricelist-select');
    if (plSelect && plSelect.value === pricelistId) {
      applyActivePriceListToInvoice();
    }
  }
}

export async function deletePricelist(index) {
  const pl = state.pricelists[index];
  if (confirm(`Bạn có chắc chắn muốn xóa bảng giá "${pl.name}"?`)) {
    const deleted = await dbDeletePricelist(pl.id);
    if (deleted) {
      state.pricelists = state.pricelists.filter(p => p.id !== pl.id);
      localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
      
      renderAll();
      populatePricelistsDropdowns();
      
      const plSelect = document.getElementById('invoice-pricelist-select');
      if (plSelect && plSelect.value === pl.id) {
        plSelect.value = '';
        applyActivePriceListToInvoice();
      }
      
      showToast('Xóa bảng giá thành công!', 'warning');
    }
  }
}

export function populatePricelistsDropdowns() {
  const isSale = state.currentUser && state.currentUser.role === 'sale';
  const select = document.getElementById('invoice-pricelist-select');
  if (select) {
    const currentVal = select.value;
    select.innerHTML = `
      <option value="">-- Chọn bảng giá --</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
      <option value="retail">Nhập tay (Khách lẻ)</option>
      <option value="custom" ${isSale ? 'disabled' : ''}>Chiết khấu riêng của đại lý</option>
    `;
    
    const exists = Array.from(select.options).some(opt => opt.value === currentVal);
    if (exists) select.value = currentVal;
    else select.value = '';
  }

  const custPlSelect = document.getElementById('cust-pricelist');
  if (custPlSelect) {
    const currentCustPlVal = custPlSelect.value;
    custPlSelect.innerHTML = `
      <option value="">-- Chọn bảng giá --</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
      <option value="custom" ${isSale ? 'disabled' : ''}>Chiết khấu riêng (Tự thiết lập bên dưới)</option>
    `;
    const exists = Array.from(custPlSelect.options).some(opt => opt.value === currentCustPlVal);
    if (exists) custPlSelect.value = currentCustPlVal;
    else custPlSelect.value = '';
  }
}

export function setupPricelistManagement() {
  const addBtn = document.getElementById('btn-open-add-pricelist-modal');
  if (addBtn) addBtn.addEventListener('click', () => openPricelistModal(-1));
  
  const closeBtn = document.getElementById('btn-close-pricelist-modal');
  if (closeBtn) closeBtn.addEventListener('click', closePricelistModal);
  
  const cancelBtn = document.getElementById('btn-cancel-pricelist');
  if (cancelBtn) cancelBtn.addEventListener('click', closePricelistModal);
  
  const form = document.getElementById('pricelist-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await savePricelist();
    });
  }
  
  const searchInput = document.getElementById('pricelist-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', renderPricelistsTable);
  }
}
