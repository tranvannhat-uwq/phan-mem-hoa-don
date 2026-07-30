import { state } from '../state.js';
import { showToast, safeCreateIcons, getBrandName } from '../utils.js';
import { dbSaveProduct, dbSaveProductsBulk, dbDeleteProduct } from '../services/supabase.js?v=20260730-cashbook-reset';
import { renderAll } from '../main.js';

let excelImportData = [];
let isSelectingFile = false;

function isSku(product) {
  return Boolean(product && product.id && product.packageType && !product.isLegacy);
}

function specificationOf(product) {
  if (product.displaySpecification) return product.displaySpecification;
  const weight = product.packageWeight !== null && product.packageWeight !== undefined && product.packageWeight !== ''
    ? ` ${String(product.packageWeight).replace('.', ',')}`
    : '';
  const unit = product.packageWeightUnit ? ` ${product.packageWeightUnit}` : '';
  return `${product.packageType || ''}${weight}${unit}`.trim();
}

function createProductId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `sku-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getFilteredSkuProducts() {
  const search = (document.getElementById('product-search-input')?.value || '').trim().toLowerCase();
  const brandFilter = document.getElementById('product-brand-filter')?.value || '';
  const packageFilter = document.getElementById('product-package-filter')?.value || '';
  const statusFilter = document.getElementById('product-status-filter')?.value || '';

  return (state.products || [])
    .filter(isSku)
    .filter(product => {
      const brand = getBrandName(product.brandId || product.brand, product.brand || '');
      const haystack = `${product.code} ${product.name} ${brand} ${specificationOf(product)} ${product.group || ''}`.toLowerCase();
      if (search && !haystack.includes(search)) return false;
      if (brandFilter && brand !== brandFilter) return false;
      if (packageFilter && product.packageType !== packageFilter) return false;
      if (statusFilter === 'active' && product.isActive === false) return false;
      if (statusFilter === 'inactive' && product.isActive !== false) return false;
      return true;
    })
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'vi'));
}

function populateBrandOptions() {
  const filter = document.getElementById('product-brand-filter');
  const modalSelect = document.getElementById('prod-brand');
  const brands = [...new Set([
    ...(state.brands || []).map(brand => brand.name),
    ...(state.products || []).map(product => getBrandName(product.brandId || product.brand, product.brand)).filter(Boolean)
  ])].sort((a, b) => a.localeCompare(b, 'vi'));

  if (filter) {
    const current = filter.value;
    filter.innerHTML = `<option value="">Tất cả hãng sơn</option>${brands.map(brand => `<option value="${brand}">${brand}</option>`).join('')}`;
    filter.value = brands.includes(current) ? current : '';
  }

  if (modalSelect) {
    const current = modalSelect.value;
    modalSelect.innerHTML = `${brands.map(brand => `<option value="${brand}">${brand}</option>`).join('')}<option value="Khác">Khác</option>`;
    if (current && [...modalSelect.options].some(option => option.value === current)) modalSelect.value = current;
  }
}

function populateBaseProductOptions(selectedId = '') {
  const select = document.getElementById('prod-base-product-id');
  if (!select) return;
  const roots = (state.products || [])
    .filter(product => product.isLegacy || (!product.packageType && product.id))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'vi'));
  select.innerHTML = `
    <option value="">Tạo nhóm sản phẩm mới</option>
    ${roots.map(product => `<option value="${product.id}">${product.code} - ${product.name}</option>`).join('')}
  `;
  if (selectedId && [...select.options].some(option => option.value === selectedId)) select.value = selectedId;
}

export function renderProductsTable() {
  const tableBody = document.getElementById('products-table-body');
  if (!tableBody) return;
  populateBrandOptions();

  const packageSelect = document.getElementById('product-package-filter');
  if (packageSelect) {
    const current = packageSelect.value;
    const packages = [...new Set((state.products || []).filter(isSku).map(product => product.packageType))].sort();
    packageSelect.innerHTML = `<option value="">Tất cả loại bao bì</option>${packages.map(type => `<option value="${type}">${type}</option>`).join('')}`;
    packageSelect.value = packages.includes(current) ? current : '';
  }

  const filtered = getFilteredSkuProducts();

  const itemsPerPage = 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage));
  state.productsPage = Math.min(Math.max(1, state.productsPage), totalPages);
  const start = (state.productsPage - 1) * itemsPerPage;
  const pageItems = filtered.slice(start, start + itemsPerPage);

  tableBody.innerHTML = pageItems.length
    ? pageItems.map((product, index) => `
      <tr>
        <td class="text-center">${start + index + 1}</td>
        <td class="sku-code">${product.code}</td>
        <td title="${product.name}">${product.name}</td>
        <td>${getBrandName(product.brandId || product.brand, product.brand || '')}</td>
        <td>${product.packageType}</td>
        <td>${product.packageWeight ?? '-'} ${product.packageWeightUnit || ''}</td>
        <td>${specificationOf(product) || '<span class="missing-price">N/A</span>'}</td>
        <td><span class="status-badge ${product.isActive === false ? 'inactive' : 'active'}">${product.isActive === false ? 'Ngừng áp dụng' : 'Đang áp dụng'}</span></td>
        <td class="text-center">
          <div class="actions-cell">
            <button class="btn btn-secondary btn-sm btn-circle edit-prod-btn" data-id="${product.id}" title="Sửa SKU">
              <i data-lucide="edit-2"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle archive-prod-btn" data-id="${product.id}" title="Ngừng áp dụng SKU">
              <i data-lucide="archive"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('')
    : `<tr><td colspan="9" class="empty-table-cell">Không tìm thấy SKU phù hợp.</td></tr>`;

  const pagination = document.getElementById('products-pagination');
  if (pagination) {
    pagination.innerHTML = `
      <div class="pagination-controls">
        <button class="btn btn-secondary btn-sm" id="products-prev-page" ${state.productsPage === 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i> Trước</button>
        <span>Trang <strong>${state.productsPage}</strong> / ${totalPages} (${filtered.length} SKU)</span>
        <button class="btn btn-secondary btn-sm" id="products-next-page" ${state.productsPage === totalPages ? 'disabled' : ''}>Sau <i data-lucide="chevron-right"></i></button>
      </div>
    `;
    document.getElementById('products-prev-page')?.addEventListener('click', () => {
      state.productsPage -= 1;
      renderProductsTable();
    });
    document.getElementById('products-next-page')?.addEventListener('click', () => {
      state.productsPage += 1;
      renderProductsTable();
    });
  }

  document.querySelectorAll('.edit-prod-btn').forEach(button => {
    button.addEventListener('click', () => openProductModal(state.products.findIndex(product => product.id === button.dataset.id)));
  });
  document.querySelectorAll('.archive-prod-btn').forEach(button => {
    button.addEventListener('click', () => {
      const product = state.products.find(item => item.id === button.dataset.id);
      if (product) deleteProduct(product.code, product.brand);
    });
  });
  safeCreateIcons();
}

export function openProductModal(index = -1) {
  const modal = document.getElementById('product-modal');
  const form = document.getElementById('product-form');
  if (!modal || !form) return;
  form.reset();
  modal.classList.add('active');
  document.getElementById('product-edit-index').value = String(index);
  document.getElementById('product-modal-title').innerText = index === -1 ? 'Thêm SKU sản phẩm' : 'Chỉnh sửa SKU sản phẩm';
  document.getElementById('prod-code').disabled = index !== -1;
  document.getElementById('prod-active').checked = true;
  populateBrandOptions();
  populateBaseProductOptions();

  if (index !== -1) {
    const product = state.products[index];
    const currentBrandName = getBrandName(product.brandId || product.brand, product.brand || '');
    document.getElementById('prod-id').value = product.id;
    document.getElementById('prod-code').value = product.code;
    document.getElementById('prod-name').value = product.name;
    document.getElementById('prod-brand').value = currentBrandName;
    document.getElementById('prod-package-type').value = product.packageType || '';
    document.getElementById('prod-package-weight').value = product.packageWeight ?? '';
    document.getElementById('prod-package-weight-unit').value = product.packageWeightUnit || 'kg';
    document.getElementById('prod-display-specification').value = specificationOf(product);
    document.getElementById('prod-product-group').value = product.group || '';
    document.getElementById('prod-active').checked = product.isActive !== false;
    populateBaseProductOptions(product.baseProductId || product.parentProductId || '');
  } else {
    document.getElementById('prod-id').value = '';
  }
}

export function closeProductModal() {
  document.getElementById('product-modal')?.classList.remove('active');
}

export async function saveProduct() {
  const index = Number.parseInt(document.getElementById('product-edit-index').value, 10);
  const code = document.getElementById('prod-code').value.trim().toUpperCase();
  const name = document.getElementById('prod-name').value.trim();
  const packageType = document.getElementById('prod-package-type').value;
  const packageWeightRaw = document.getElementById('prod-package-weight').value.trim().replace(',', '.');
  const packageWeight = packageWeightRaw === '' ? null : Number(packageWeightRaw);
  let brand = document.getElementById('prod-brand').value;
  if (brand === 'Khác') brand = document.getElementById('prod-brand-custom').value.trim();

  if (!code || !name || !brand || !packageType || packageWeight === null || !Number.isFinite(packageWeight) || packageWeight < 0) {
    showToast('Vui lòng nhập đủ mã, tên, hãng, loại bao bì và khối lượng hợp lệ.', 'warning');
    return;
  }
  const duplicate = state.products.some((product, productIndex) =>
    product.code === code && product.brand === brand && productIndex !== index
  );
  if (duplicate) {
    showToast('Mã SKU này đã tồn tại trong cùng hãng sơn.', 'danger');
    return;
  }

  const matchedBrand = (state.brands || []).find(item => item.name.toLowerCase() === brand.toLowerCase());
  const id = document.getElementById('prod-id').value || createProductId();
  const selectedBaseId = document.getElementById('prod-base-product-id').value;
  const baseProductId = selectedBaseId || `family-${id}`;
  const packageWeightUnit = document.getElementById('prod-package-weight-unit').value || 'kg';
  const displaySpecification = document.getElementById('prod-display-specification').value.trim() ||
    `${packageType} ${String(packageWeight).replace('.', ',')} ${packageWeightUnit}`;

  const productData = {
    id,
    code,
    name,
    brand,
    brandId: matchedBrand?.id || null,
    baseProductId,
    parentProductId: baseProductId,
    packageType,
    packageWeight,
    packageWeightUnit,
    displaySpecification,
    group: document.getElementById('prod-product-group').value.trim(),
    isActive: document.getElementById('prod-active').checked,
    isLegacy: false
  };

  const saved = await dbSaveProduct(productData);
  if (!saved) return;
  const existingIndex = state.products.findIndex(product => product.id === id);
  if (existingIndex >= 0) state.products[existingIndex] = productData;
  else state.products.push(productData);
  localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  closeProductModal();
  renderAll();
  showToast(index === -1 ? 'Đã thêm SKU.' : 'Đã cập nhật SKU.');
}

export async function deleteProduct(code, brand) {
  const product = state.products.find(item => item.code === code && item.brand === brand);
  if (!product || !confirm(`Ngừng áp dụng SKU "${code}"? SKU vẫn được giữ cho lịch sử đơn hàng.`)) return;
  const archived = await dbDeleteProduct(code, brand);
  if (!archived) return;
  product.isActive = false;
  localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  renderProductsTable();
  showToast('SKU đã được ngừng áp dụng.', 'warning');
}

export function downloadExcelTemplate() {
  const rows = [
    ['Mã SKU *', 'Tên sản phẩm *', 'Hãng sơn *', 'Mã sản phẩm gốc', 'Loại bao bì *', 'Khối lượng *', 'Đơn vị *', 'Quy cách hiển thị', 'Nhóm sản phẩm', 'Đang áp dụng'],
    ['BA-46-LON', 'Sơn siêu bóng ngoại thất đặc biệt Nano', 'MUTSUTEC NANO', 'BA-46', 'Lon', 5.3, 'kg', 'Lon 5,3 kg', '', true]
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 18 }, { wch: 45 }, { wch: 22 }, { wch: 18 }, { wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 20 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(workbook, sheet, 'Danh Sach SKU');
  XLSX.writeFile(workbook, 'Mau_Danh_Sach_SKU.xlsx');
}

export function exportProductsExcel() {
  const products = getFilteredSkuProducts();
  const rows = products.map(product => {
    const baseProduct = (state.products || []).find(item => item.id === (product.baseProductId || product.parentProductId));
    return {
      'Mã SKU *': product.code,
      'Tên sản phẩm *': product.name,
      'Hãng sơn *': getBrandName(product.brandId || product.brand, product.brand || ''),
      'Mã sản phẩm gốc': baseProduct?.code || String(product.baseProductId || '').replace(/^family-/, ''),
      'Loại bao bì *': product.packageType,
      'Khối lượng *': Number(product.packageWeight),
      'Đơn vị *': product.packageWeightUnit || 'kg',
      'Quy cách hiển thị': specificationOf(product),
      'Nhóm sản phẩm': product.group || '',
      'Đang áp dụng': product.isActive !== false
    };
  });
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['Mã SKU *', 'Tên sản phẩm *', 'Hãng sơn *', 'Mã sản phẩm gốc', 'Loại bao bì *', 'Khối lượng *', 'Đơn vị *', 'Quy cách hiển thị', 'Nhóm sản phẩm', 'Đang áp dụng']
  });
  sheet['!cols'] = [{ wch: 18 }, { wch: 45 }, { wch: 22 }, { wch: 20 }, { wch: 16 }, { wch: 13 }, { wch: 11 }, { wch: 24 }, { wch: 20 }, { wch: 15 }];
  sheet['!autofilter'] = { ref: `A1:J${Math.max(1, products.length + 1)}` };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Danh Sach SKU');
  XLSX.writeFile(workbook, `Danh_Sach_SKU_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(`Đã xuất ${products.length} SKU theo bộ lọc hiện tại.`);
}

function handleExcelFileSelect(file) {
  const reader = new FileReader();
  reader.onload = event => {
    try {
      const workbook = XLSX.read(new Uint8Array(event.target.result), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
      excelImportData = rows.slice(1).filter(row => row[0]).map(row => {
        const base = state.products.find(product => product.code === String(row[3] || '').trim());
        const brand = String(row[2] || '').trim();
        const matchedBrand = (state.brands || []).find(item => item.name.toLowerCase() === brand.toLowerCase());
        return {
          id: createProductId(),
          code: String(row[0]).trim().toUpperCase(),
          name: String(row[1] || '').trim(),
          brand,
          brandId: matchedBrand?.id || null,
          baseProductId: base?.id || `family-${String(row[3] || row[0]).trim()}`,
          parentProductId: base?.id || `family-${String(row[3] || row[0]).trim()}`,
          packageType: String(row[4] || '').trim(),
          packageWeight: Number(String(row[5] ?? '').replace(',', '.')),
          packageWeightUnit: String(row[6] || 'kg').trim(),
          displaySpecification: String(row[7] || '').trim(),
          group: String(row[8] || '').trim(),
          isActive: row[9] !== false && String(row[9]).toLowerCase() !== 'false',
          isLegacy: false
        };
      }).filter(product => product.code && product.name && product.brand && product.packageType && Number.isFinite(product.packageWeight));

      document.getElementById('excel-preview-table-body').innerHTML = excelImportData.slice(0, 5).map((product, index) => `
        <tr><td>${index + 1}</td><td>${product.code}</td><td>${product.name}</td><td>${product.brand}</td><td>${specificationOf(product)}</td><td>Quản lý tại màn hình Bảng giá</td></tr>
      `).join('');
      document.getElementById('excel-preview-summary').innerText = `Đọc được ${excelImportData.length} SKU hợp lệ.`;
      document.getElementById('excel-preview-container').style.display = 'block';
      document.getElementById('btn-save-excel-submit').disabled = excelImportData.length === 0;
    } catch (error) {
      showToast('Không thể đọc tệp Excel: ' + error.message, 'danger');
    } finally {
      document.getElementById('excel-file-input').value = '';
      isSelectingFile = false;
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processExcelImport() {
  const productsToSave = excelImportData.map(imported => {
    const existing = state.products.find(product =>
      String(product.code).toUpperCase() === imported.code &&
      getBrandName(product.brandId || product.brand, product.brand || '').toLowerCase() === imported.brand.toLowerCase()
    );
    return existing ? { ...existing, ...imported, id: existing.id } : { ...imported };
  });

  if (!await dbSaveProductsBulk(productsToSave)) return;

  productsToSave.forEach(product => {
    const index = state.products.findIndex(item =>
      item.id === product.id ||
      (String(item.code).toUpperCase() === product.code &&
        getBrandName(item.brandId || item.brand, item.brand || '').toLowerCase() === product.brand.toLowerCase())
    );
    if (index >= 0) state.products[index] = product;
    else state.products.push(product);
  });

  const successCount = productsToSave.length;
  localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  renderAll();
  showToast(`Đã nhập/cập nhật ${successCount} SKU.`);
}

export function setupExcelImportAndTemplate() {
  document.getElementById('btn-download-excel-template')?.addEventListener('click', downloadExcelTemplate);
  document.getElementById('btn-export-products-excel')?.addEventListener('click', exportProductsExcel);
  const modal = document.getElementById('excel-modal');
  const input = document.getElementById('excel-file-input');
  const open = () => {
    excelImportData = [];
    modal?.classList.add('active');
  };
  const close = () => modal?.classList.remove('active');
  document.getElementById('btn-open-excel-modal')?.addEventListener('click', open);
  document.getElementById('btn-close-excel-modal')?.addEventListener('click', close);
  document.getElementById('btn-cancel-excel')?.addEventListener('click', close);
  document.getElementById('btn-browse-excel')?.addEventListener('click', event => {
    event.stopPropagation();
    if (!isSelectingFile) {
      isSelectingFile = true;
      input?.click();
    }
  });
  document.getElementById('excel-dropzone')?.addEventListener('click', () => {
    if (!isSelectingFile) {
      isSelectingFile = true;
      input?.click();
    }
  });
  input?.addEventListener('change', () => {
    if (input.files?.[0]) handleExcelFileSelect(input.files[0]);
    else isSelectingFile = false;
  });
  document.getElementById('btn-save-excel-submit')?.addEventListener('click', async () => {
    await processExcelImport();
    close();
  });
}

export function setupProductManagement() {
  const refresh = () => {
    state.productsPage = 1;
    renderProductsTable();
  };
  ['product-search-input', 'product-brand-filter', 'product-package-filter', 'product-status-filter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', refresh);
    document.getElementById(id)?.addEventListener('change', refresh);
  });
  document.getElementById('btn-open-add-product-modal')?.addEventListener('click', () => openProductModal(-1));
  document.getElementById('btn-close-product-modal')?.addEventListener('click', closeProductModal);
  document.getElementById('btn-cancel-product')?.addEventListener('click', closeProductModal);
  document.getElementById('product-form')?.addEventListener('submit', event => {
    event.preventDefault();
    saveProduct();
  });
  document.getElementById('prod-brand')?.addEventListener('change', event => {
    const custom = document.getElementById('prod-brand-custom-group');
    if (custom) custom.style.display = event.target.value === 'Khác' ? 'block' : 'none';
  });
}
