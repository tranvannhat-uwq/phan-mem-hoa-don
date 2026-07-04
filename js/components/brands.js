import { state } from '../state.js';
import { showToast, safeCreateIcons } from '../utils.js';
import { dbSaveBrand, dbDeleteBrand } from '../services/supabase.js';
import { renderAll } from '../main.js';

export function renderBrandsTable() {
  const tableBody = document.getElementById('brands-table-body');
  if (!tableBody) return;
  
  if (!state.brands || state.brands.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không tìm thấy hãng sơn nào.
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = state.brands.map((b) => {
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">${b.name}</td>
        <td>${b.companyName}</td>
        <td><code>${b.logoFilename}</code></td>
        <td>${b.hotline}</td>
        <td>${b.cskh}</td>
        <td>${b.email}</td>
        <td>${b.addressMain}</td>
        <td>${b.addressFactory}</td>
        <td>${b.addressBusiness || '<span style="color: var(--text-muted); font-style: italic;">Không có (Ẩn ĐĐKD)</span>'}</td>
        <td class="admin-only" style="text-align: center;">
          <div style="display: inline-flex; gap: 0.5rem; justify-content: center;">
            <button class="btn btn-secondary btn-sm btn-circle edit-brand-btn" data-name="${b.name}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-brand-btn" data-name="${b.name}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  safeCreateIcons();
  
  // Gán sự kiện cho các nút sửa, xóa hãng sơn
  document.querySelectorAll('.edit-brand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      openBrandModal(name);
    });
  });
  
  document.querySelectorAll('.delete-brand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      deleteBrand(name);
    });
  });
}

function openBrandModal(brandName = null) {
  const modal = document.getElementById('brand-modal');
  const title = document.getElementById('brand-modal-title');
  const form = document.getElementById('brand-form');
  const nameInput = document.getElementById('brand-name');
  
  if (!modal || !title || !form) return;
  
  form.reset();
  
  if (brandName) {
    title.innerText = 'Chỉnh sửa hãng sơn';
    document.getElementById('brand-edit-is-new').value = 'false';
    nameInput.value = brandName;
    nameInput.setAttribute('disabled', 'true'); // Không cho sửa tên hãng sơn vì là khóa chính
    
    const brand = state.brands.find(b => b.name === brandName);
    if (brand) {
      document.getElementById('brand-company-name').value = brand.companyName;
      document.getElementById('brand-logo-filename').value = brand.logoFilename;
      document.getElementById('brand-hotline').value = brand.hotline;
      document.getElementById('brand-cskh').value = brand.cskh;
      document.getElementById('brand-email').value = brand.email;
      document.getElementById('brand-address-main').value = brand.addressMain;
      document.getElementById('brand-address-factory').value = brand.addressFactory;
      document.getElementById('brand-address-business').value = brand.addressBusiness || '';
    }
  } else {
    title.innerText = 'Thêm hãng sơn mới';
    document.getElementById('brand-edit-is-new').value = 'true';
    nameInput.removeAttribute('disabled');
  }
  
  modal.classList.add('active');
}

function closeBrandModal() {
  const modal = document.getElementById('brand-modal');
  if (modal) modal.classList.remove('active');
}

async function saveBrand() {
  const isNew = document.getElementById('brand-edit-is-new').value === 'true';
  const name = document.getElementById('brand-name').value.trim();
  const companyName = document.getElementById('brand-company-name').value.trim();
  const logoFilename = document.getElementById('brand-logo-filename').value.trim();
  const hotline = document.getElementById('brand-hotline').value.trim();
  const cskh = document.getElementById('brand-cskh').value.trim();
  const email = document.getElementById('brand-email').value.trim();
  const addressMain = document.getElementById('brand-address-main').value.trim();
  const addressFactory = document.getElementById('brand-address-factory').value.trim();
  const addressBusiness = document.getElementById('brand-address-business').value.trim() || null;
  
  if (!name || !companyName || !logoFilename || !hotline || !cskh || !email || !addressMain || !addressFactory) {
    showToast('Vui lòng nhập đầy đủ các trường bắt buộc (*)', 'danger');
    return;
  }
  
  const brandObj = {
    name,
    companyName,
    logoFilename,
    hotline,
    cskh,
    email,
    addressMain,
    addressFactory,
    addressBusiness
  };
  
  // Nếu thêm mới hãng sơn, kiểm tra trùng tên hãng sơn
  if (isNew) {
    const exists = state.brands.some(b => b.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      showToast(`Hãng sơn "${name}" đã tồn tại!`, 'danger');
      return;
    }
  }
  
  const success = await dbSaveBrand(brandObj);
  if (success) {
    if (isNew) {
      state.brands.push(brandObj);
      showToast(`Đã thêm hãng sơn "${name}" thành công!`);
    } else {
      const idx = state.brands.findIndex(b => b.name === name);
      if (idx !== -1) {
        state.brands[idx] = brandObj;
      }
      showToast(`Đã cập nhật hãng sơn "${name}" thành công!`);
    }
    
    // Đồng bộ lại local storage
    localStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
    
    closeBrandModal();
    renderAll();
  }
}

async function deleteBrand(name) {
  if (confirm(`Bạn có chắc chắn muốn xóa hãng sơn "${name}" không? Mọi sản phẩm thuộc hãng sơn này có thể không tìm thấy logo/thông tin liên kết.`)) {
    const success = await dbDeleteBrand(name);
    if (success) {
      state.brands = state.brands.filter(b => b.name !== name);
      localStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
      showToast(`Đã xóa hãng sơn "${name}"!`);
      renderAll();
    }
  }
}

export function setupBrandsPanel() {
  const addBtn = document.getElementById('btn-open-add-brand-modal');
  const closeBtn = document.getElementById('btn-close-brand-modal');
  const cancelBtn = document.getElementById('btn-cancel-brand-modal');
  const form = document.getElementById('brand-form');
  
  if (addBtn) addBtn.addEventListener('click', () => openBrandModal());
  if (closeBtn) closeBtn.addEventListener('click', closeBrandModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeBrandModal);
  
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveBrand();
    });
  }
}
