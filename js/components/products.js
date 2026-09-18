import { state } from '../state.js';
import { showToast, safeCreateIcons, getBrandName } from '../utils.js';
import {
  dbDeleteProduct,
  dbSavePayrollProductGroup,
  dbSaveProductsBulk,
  dbSetPayrollProductGroupActive
} from '../services/supabase.js?v=20260918-customer-debt-invariant-v2';
import { renderAll } from '../main.js?v=20260918-customer-debt-invariant-v2';
import {
  buildProductFamilies,
  getProductBaseCode,
  normalizeCatalogText,
  searchProductFamilies,
  variantSpecification
} from '../domain/product-catalog.js';

let excelImportData = [];
let isSelectingFile = false;
let editingProductFamilyKey = '';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function canManagePayrollProductGroups() {
  return ['admin', 'accounting'].includes(String(state.currentUser?.role || '').toLowerCase());
}

function getPayrollProductGroup(groupId) {
  return (state.payrollProductGroups || []).find(group => String(group.id) === String(groupId || '')) || null;
}

function findPayrollProductGroup(value) {
  const normalized = normalizeCatalogText(value);
  if (!normalized) return null;
  return (state.payrollProductGroups || []).find(group =>
    normalizeCatalogText(group.code) === normalized || normalizeCatalogText(group.name) === normalized
  ) || null;
}

function createPayrollProductGroupId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `paygrp-${globalThis.crypto.randomUUID()}`;
  }
  return `paygrp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isSku(product) {
  return Boolean(product && product.id && product.packageType && !product.isLegacy);
}

function specificationOf(product) {
  return variantSpecification(product);
}

function createProductId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `sku-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createProductGroupId(baseCode, name, brand) {
  const source = normalizeCatalogText(`${baseCode} ${name} ${brand}`).replace(/\s+/g, '-').slice(0, 48);
  const suffix = Math.random().toString(16).slice(2, 8);
  return `pg-${source || Date.now()}-${suffix}`;
}

function getFilteredSkuProducts() {
  const search = (document.getElementById('product-search-input')?.value || '').trim().toLowerCase();
  const brandFilter = document.getElementById('product-brand-filter')?.value || '';
  const packageFilter = document.getElementById('product-package-filter')?.value || '';
  const payrollGroupFilter = document.getElementById('product-payroll-group-filter')?.value || '';
  const statusFilter = document.getElementById('product-status-filter')?.value || '';

  return (state.products || [])
    .filter(isSku)
    .filter(product => {
      const brand = getBrandName(product.brandId || product.brand, product.brand || '');
      const haystack = `${product.code} ${product.name} ${brand} ${specificationOf(product)} ${product.group || ''}`.toLowerCase();
      if (search && !haystack.includes(search)) return false;
      if (brandFilter && brand !== brandFilter) return false;
      if (packageFilter && product.packageType !== packageFilter) return false;
      if (payrollGroupFilter && String(product.payrollProductGroupId || '') !== payrollGroupFilter) return false;
      if (statusFilter === 'active' && product.isActive === false) return false;
      if (statusFilter === 'inactive' && product.isActive !== false) return false;
      return true;
    })
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'vi'));
}

function getFilteredProductFamilies() {
  const search = (document.getElementById('product-search-input')?.value || '').trim();
  const brandFilter = document.getElementById('product-brand-filter')?.value || '';
  const packageFilter = document.getElementById('product-package-filter')?.value || '';
  const payrollGroupFilter = document.getElementById('product-payroll-group-filter')?.value || '';
  const statusFilter = document.getElementById('product-status-filter')?.value || '';
  let families = buildProductFamilies(state.products, { includeInactive: true });

  if (search) families = searchProductFamilies(families, search);
  return families.filter(family => {
    if (brandFilter && family.brand !== brandFilter) return false;
    if (packageFilter && !family.variants.some(variant => variant.packageType === packageFilter)) return false;
    if (payrollGroupFilter && !family.variants.some(variant =>
      String(variant.payrollProductGroupId || '') === payrollGroupFilter
    )) return false;
    if (statusFilter === 'active' && !family.variants.some(variant => variant.isActive !== false)) return false;
    if (statusFilter === 'inactive' && !family.variants.every(variant => variant.isActive === false)) return false;
    return true;
  });
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

function payrollGroupOptions(selectedId = '', { includeInactiveSelection = true } = {}) {
  const selected = getPayrollProductGroup(selectedId);
  const groups = (state.payrollProductGroups || [])
    .filter(group => group.isActive !== false || (includeInactiveSelection && String(group.id) === String(selectedId)))
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'vi'));
  return groups.map(group => {
    const inactive = group.isActive === false ? ' (ngừng dùng)' : '';
    return `<option value="${escapeHtml(group.id)}" ${String(group.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(group.code)} - ${escapeHtml(group.name)}${inactive}</option>`;
  }).join('') || (selected ? `<option value="${escapeHtml(selected.id)}" selected>${escapeHtml(selected.name)}</option>` : '');
}

function populatePayrollProductGroupOptions() {
  const filter = document.getElementById('product-payroll-group-filter');
  if (filter) {
    const current = filter.value;
    filter.innerHTML = '<option value="">Tất cả nhóm tính lương</option>' +
      (state.payrollProductGroups || [])
        .map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.code)} - ${escapeHtml(group.name)}${group.isActive === false ? ' (ngừng dùng)' : ''}</option>`)
        .join('');
    filter.value = [...filter.options].some(option => option.value === current) ? current : '';
  }

  const modalSelect = document.getElementById('prod-product-group');
  if (modalSelect) {
    const current = modalSelect.value;
    modalSelect.innerHTML = '<option value="">Chưa phân nhóm</option>' + payrollGroupOptions(current);
    modalSelect.value = [...modalSelect.options].some(option => option.value === current) ? current : '';
  }
}

export function renderProductsTable() {
  const tableBody = document.getElementById('products-table-body');
  if (!tableBody) return;
  populateBrandOptions();
  populatePayrollProductGroupOptions();

  const packageSelect = document.getElementById('product-package-filter');
  if (packageSelect) {
    const current = packageSelect.value;
    const packages = [...new Set((state.products || []).filter(isSku).map(product => product.packageType))].sort();
    packageSelect.innerHTML = `<option value="">Tất cả loại bao bì</option>${packages.map(type => `<option value="${type}">${type}</option>`).join('')}`;
    packageSelect.value = packages.includes(current) ? current : '';
  }

  const filtered = getFilteredProductFamilies();

  const itemsPerPage = 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / itemsPerPage));
  state.productsPage = Math.min(Math.max(1, state.productsPage), totalPages);
  const start = (state.productsPage - 1) * itemsPerPage;
  const pageItems = filtered.slice(start, start + itemsPerPage);

  tableBody.innerHTML = pageItems.length
    ? pageItems.map((family, index) => {
      const activeVariants = family.variants.filter(variant => variant.isActive !== false);
      const packageNames = [...new Set(family.variants.map(variant => variant.packagingName || variant.packageType))].join(', ');
      const weights = family.variants.map(variant => {
        const value = variant.weightOrVolume ?? variant.packageWeight ?? '';
        const unit = variant.unitName || variant.packageWeightUnit || '';
        return `${String(value).replace('.', ',')} ${unit}`.trim();
      }).join(', ');
      const payrollGroup = getPayrollProductGroup(family.payrollProductGroupId);
      const groupLabel = family.hasMixedPayrollProductGroups
        ? 'Nhiều nhóm / chưa đồng nhất'
        : family.payrollProductGroupId
        ? (payrollGroup?.name || family.group || 'Nhóm không còn trong danh mục')
        : 'Chưa phân nhóm';
      return `
      <tr>
        <td class="text-center">${start + index + 1}</td>
        <td class="sku-code">${family.baseCode}</td>
        <td title="${family.name}">${family.name}</td>
        <td>
          ${canManagePayrollProductGroups() ? `
            <select class="form-control product-payroll-group-assignment" data-family-key="${escapeHtml(family.key)}" title="Chọn nhóm dùng để lọc khi tính lương">
              <option value="">${family.hasMixedPayrollProductGroups ? 'Nhiều nhóm / chưa đồng nhất' : 'Chưa phân nhóm'}</option>
              ${payrollGroupOptions(family.payrollProductGroupId)}
            </select>
          ` : escapeHtml(groupLabel)}
        </td>
        <td>${family.brand}</td>
        <td>${packageNames || '-'}</td>
        <td title="${weights}">${weights || '-'}</td>
        <td><strong>${family.variants.length} quy cách</strong><br><small>${family.variants.map(variant => variant.code).join(', ')}</small></td>
        <td><span class="status-badge ${activeVariants.length ? 'active' : 'inactive'}">${activeVariants.length ? `${activeVariants.length} hoạt động` : 'Ngừng áp dụng'}</span></td>
        <td class="text-center">
          <div class="actions-cell">
            <button class="btn btn-secondary btn-sm btn-circle edit-prod-btn" data-family-key="${family.key}" title="Sửa sản phẩm và quy cách">
              <i data-lucide="edit-2"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle archive-prod-btn" data-family-key="${family.key}" title="Ngừng áp dụng toàn bộ quy cách">
              <i data-lucide="archive"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
    }).join('')
    : `<tr><td colspan="10" class="empty-table-cell">Không tìm thấy sản phẩm phù hợp.</td></tr>`;

  const pagination = document.getElementById('products-pagination');
  if (pagination) {
    const filteredSkuCount = filtered.reduce((count, family) => count + family.variants.length, 0);
    pagination.innerHTML = `
      <div class="pagination-controls">
        <button class="btn btn-secondary btn-sm" id="products-prev-page" ${state.productsPage === 1 ? 'disabled' : ''}><i data-lucide="chevron-left"></i> Trước</button>
        <span>Trang <strong>${state.productsPage}</strong> / ${totalPages} (${filtered.length} sản phẩm gốc, ${filteredSkuCount} SKU)</span>
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
    button.addEventListener('click', () => {
      const family = buildProductFamilies(state.products, { includeInactive: true })
        .find(item => item.key === button.dataset.familyKey);
      const firstVariantIndex = family
        ? state.products.findIndex(product => product.id === family.variants[0]?.id)
        : -1;
      openProductModal(firstVariantIndex);
    });
  });
  document.querySelectorAll('.archive-prod-btn').forEach(button => {
    button.addEventListener('click', () => archiveProductFamily(button.dataset.familyKey));
  });
  document.querySelectorAll('.product-payroll-group-assignment').forEach(select => {
    select.addEventListener('change', () => assignPayrollGroupToFamily(select.dataset.familyKey, select.value));
  });
  safeCreateIcons();
}

function addVariantEditorRow(variant = {}) {
  const body = document.getElementById('prod-variants-body');
  if (!body) return;
  const id = variant.id || '';
  const packageName = variant.packagingName || variant.packageType || '';
  const weight = variant.weightOrVolume ?? variant.packageWeight ?? '';
  const unit = variant.unitName || variant.packageWeightUnit || 'kg';
  body.insertAdjacentHTML('beforeend', `
    <tr class="product-variant-editor-row" data-variant-id="${id}">
      <td><input class="form-control variant-code-input" value="${variant.variantCode || variant.code || ''}" placeholder="CT-Đ1-LON" required></td>
      <td>
        <select class="form-control variant-package-input" required>
          <option value="">Chọn</option>
          ${['Thùng', 'Lon', 'Hộp', 'Bao', 'Túi', 'Chai', 'Gói', 'Kg', 'Lít', 'Cái', 'Bộ', 'Mét', 'Lọ'].map(value =>
            `<option value="${value}" ${packageName === value ? 'selected' : ''}>${value}</option>`
          ).join('')}
        </select>
      </td>
      <td><input class="form-control variant-weight-input" inputmode="decimal" value="${String(weight).replace('.', ',')}" placeholder="6,3" required></td>
      <td>
        <select class="form-control variant-unit-input">
          ${['kg', 'g', 'l', 'ml', 'bộ', 'cái'].map(value =>
            `<option value="${value}" ${unit === value ? 'selected' : ''}>${value}</option>`
          ).join('')}
        </select>
      </td>
      <td><input class="form-control variant-purchase-price-input" inputmode="numeric" value="${Number(variant.purchasePrice || 0)}"></td>
      <td class="text-center"><input type="checkbox" class="variant-active-input" ${variant.isActive === false ? '' : 'checked'} aria-label="Đang hoạt động"></td>
      <td class="text-center">
        <button type="button" class="icon-btn remove-product-variant" title="Bỏ quy cách"><i data-lucide="trash-2"></i></button>
      </td>
    </tr>
  `);
  safeCreateIcons();
}

export function openProductModal(index = -1) {
  const modal = document.getElementById('product-modal');
  const form = document.getElementById('product-form');
  if (!modal || !form) return;
  form.reset();
  populateBrandOptions();

  const families = buildProductFamilies(state.products, { includeInactive: true });
  const product = index >= 0 ? state.products[index] : null;
  const family = product
    ? families.find(item => item.variants.some(variant => variant.id === product.id))
    : null;
  editingProductFamilyKey = family?.key || '';

  document.getElementById('product-edit-index').value = String(index);
  document.getElementById('product-modal-title').innerText = family ? 'Chỉnh sửa sản phẩm và quy cách' : 'Thêm sản phẩm và quy cách';
  document.getElementById('prod-id').value = family?.id || '';
  document.getElementById('prod-code').value = family?.baseCode || '';
  document.getElementById('prod-name').value = family?.name || '';
  const payrollGroupSelect = document.getElementById('prod-product-group');
  payrollGroupSelect.innerHTML = '<option value="">Chưa phân nhóm</option>' + payrollGroupOptions(family?.payrollProductGroupId || '');
  payrollGroupSelect.value = family?.payrollProductGroupId || '';
  document.getElementById('prod-description').value = family?.description || '';
  const brandSelect = document.getElementById('prod-brand');
  const customBrandGroup = document.getElementById('prod-brand-custom-group');
  const customBrandInput = document.getElementById('prod-brand-custom');
  if (family?.brand && [...brandSelect.options].some(option => option.value === family.brand)) {
    brandSelect.value = family.brand;
  } else if (family?.brand) {
    brandSelect.value = 'Khác';
    customBrandInput.value = family.brand;
  } else if (brandSelect.options.length) {
    brandSelect.selectedIndex = 0;
    customBrandInput.value = '';
  }
  customBrandGroup.style.display = brandSelect.value === 'Khác' ? 'block' : 'none';

  const body = document.getElementById('prod-variants-body');
  body.innerHTML = '';
  (family?.variants || [{}]).forEach(addVariantEditorRow);
  modal.classList.add('active');
}

export function closeProductModal() {
  document.getElementById('product-modal')?.classList.remove('active');
}

export async function saveProduct() {
  const baseCode = document.getElementById('prod-code').value.trim().toUpperCase();
  const name = document.getElementById('prod-name').value.trim();
  let brand = document.getElementById('prod-brand').value;
  if (brand === 'Khác') brand = document.getElementById('prod-brand-custom').value.trim();

  const rows = [...document.querySelectorAll('.product-variant-editor-row')];
  if (!baseCode || !name || !brand || rows.length === 0) {
    showToast('Vui lòng nhập thông tin chung và ít nhất một quy cách.', 'warning');
    return;
  }

  const matchedBrand = (state.brands || []).find(item => item.name.toLowerCase() === brand.toLowerCase());
  const payrollGroupId = document.getElementById('prod-product-group').value || null;
  const payrollGroup = payrollGroupId ? getPayrollProductGroup(payrollGroupId) : null;
  if (payrollGroupId && !payrollGroup) {
    showToast('Nhóm sản phẩm tính lương không tồn tại. Vui lòng chọn lại.', 'warning');
    return;
  }
  const groupId = document.getElementById('prod-id').value || createProductGroupId(baseCode, name, brand);
  const existingFamily = editingProductFamilyKey
    ? buildProductFamilies(state.products, { includeInactive: true }).find(item => item.key === editingProductFamilyKey)
    : null;

  const variants = rows.map(row => {
    const variantCode = row.querySelector('.variant-code-input').value.trim().toUpperCase();
    const packageType = row.querySelector('.variant-package-input').value;
    const weightRaw = row.querySelector('.variant-weight-input').value.trim().replace(',', '.');
    const weight = weightRaw === '' ? null : Number(weightRaw);
    const unit = row.querySelector('.variant-unit-input').value || 'kg';
    const existing = (existingFamily?.variants || []).find(item => item.id === row.dataset.variantId);
    return {
      ...(existing || {}),
      id: existing?.id || createProductId(),
      code: variantCode,
      variantCode,
      productGroupId: groupId,
      baseCode,
      name,
      brand,
      brandId: matchedBrand?.id || existing?.brandId || null,
      packageType,
      packagingName: packageType,
      packageWeight: weight,
      weightOrVolume: weight,
      packageWeightUnit: unit,
      unitName: unit,
      displaySpecification: `${packageType} ${String(weight ?? '').replace('.', ',')} ${unit}`.trim(),
      purchasePrice: Number(row.querySelector('.variant-purchase-price-input').value.replace(/\D/g, '') || 0),
      conversionQuantity: Number(existing?.conversionQuantity || 1),
      payrollProductGroupId: payrollGroup?.id || null,
      group: payrollGroup?.name || '',
      description: document.getElementById('prod-description').value.trim(),
      isActive: row.querySelector('.variant-active-input').checked,
      isLegacy: false
    };
  });

  if (variants.some(variant => !variant.code || !variant.packageType || variant.packageWeight === null || !Number.isFinite(variant.packageWeight) || variant.packageWeight < 0)) {
    showToast('Mỗi quy cách phải có mã SKU, loại đóng gói và khối lượng hợp lệ.', 'warning');
    return;
  }
  const variantKeys = variants.map(variant => `${variant.code}\u0000${brand.toLowerCase()}`);
  if (new Set(variantKeys).size !== variantKeys.length) {
    showToast('Mã SKU trong cùng sản phẩm không được trùng nhau.', 'danger');
    return;
  }
  const editedIds = new Set(variants.map(variant => variant.id));
  const duplicate = state.products.some(product =>
    !editedIds.has(product.id) &&
    product.brand?.toLowerCase() === brand.toLowerCase() &&
    variants.some(variant => variant.code === product.code)
  );
  if (duplicate) {
    showToast('Có mã SKU đã tồn tại trong cùng hãng sơn.', 'danger');
    return;
  }

  if (!await dbSaveProductsBulk(variants)) return;
  variants.forEach(variant => {
    const existingIndex = state.products.findIndex(product => product.id === variant.id);
    if (existingIndex >= 0) state.products[existingIndex] = variant;
    else state.products.push(variant);
  });
  localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  closeProductModal();
  renderAll();
  showToast(`Đã lưu sản phẩm và ${variants.length} quy cách.`);
}

async function assignPayrollGroupToFamily(familyKey, payrollProductGroupId) {
  if (!canManagePayrollProductGroups()) {
    showToast('Chỉ Admin hoặc Kế toán được phân nhóm sản phẩm.', 'danger');
    renderProductsTable();
    return;
  }
  const family = buildProductFamilies(state.products, { includeInactive: true }).find(item => item.key === familyKey);
  if (!family) return;
  const selectedGroup = payrollProductGroupId ? getPayrollProductGroup(payrollProductGroupId) : null;
  if (payrollProductGroupId && (!selectedGroup || selectedGroup.isActive === false)) {
    showToast('Nhóm đã ngừng dùng hoặc không tồn tại.', 'warning');
    renderProductsTable();
    return;
  }

  const variants = family.variants.map(variant => ({
    ...variant,
    payrollProductGroupId: selectedGroup?.id || null,
    group: selectedGroup?.name || ''
  }));
  if (!await dbSaveProductsBulk(variants)) {
    renderProductsTable();
    return;
  }
  variants.forEach(variant => {
    const index = state.products.findIndex(product => product.id === variant.id);
    if (index >= 0) state.products[index] = variant;
  });
  localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  renderProductsTable();
  showToast(selectedGroup
    ? `Đã xếp “${family.name}” vào nhóm “${selectedGroup.name}”.`
    : `Đã bỏ nhóm tính lương của “${family.name}”.`);
}

async function archiveProductFamily(familyKey) {
  const family = buildProductFamilies(state.products, { includeInactive: true }).find(item => item.key === familyKey);
  if (!family || !confirm(`Ngừng áp dụng toàn bộ ${family.variants.length} quy cách của "${family.name}"?`)) return;
  const archivedVariants = family.variants.map(variant => ({ ...variant, isActive: false }));
  if (!await dbSaveProductsBulk(archivedVariants)) return;
  archivedVariants.forEach(variant => {
    const index = state.products.findIndex(product => product.id === variant.id);
    if (index >= 0) state.products[index] = variant;
  });
  localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  renderProductsTable();
  showToast('Sản phẩm và các quy cách đã được ngừng áp dụng.', 'warning');
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
    ['Mã SKU *', 'Tên sản phẩm *', 'Hãng sơn *', 'Mã sản phẩm gốc', 'Loại bao bì *', 'Khối lượng *', 'Đơn vị *', 'Quy cách hiển thị', 'Nhóm sản phẩm', 'Giá nhập', 'Đang áp dụng'],
    ['BA-46-LON', 'Sơn siêu bóng ngoại thất đặc biệt Nano', 'MUTSUTEC NANO', 'BA-46', 'Lon', 5.3, 'kg', 'Lon 5,3 kg', '', 0, true]
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 18 }, { wch: 45 }, { wch: 22 }, { wch: 18 }, { wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 20 }, { wch: 14 }, { wch: 14 }];
  sheet['!autofilter'] = { ref: 'A1:K2' };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Danh Sach SKU');
  const groupRows = (state.payrollProductGroups || []).map(group => ({
    'Mã nhóm': group.code,
    'Tên nhóm': group.name,
    'Trạng thái': group.isActive === false ? 'Ngừng dùng' : 'Đang dùng'
  }));
  const groupSheet = XLSX.utils.json_to_sheet(groupRows, { header: ['Mã nhóm', 'Tên nhóm', 'Trạng thái'] });
  groupSheet['!cols'] = [{ wch: 18 }, { wch: 35 }, { wch: 16 }];
  groupSheet['!autofilter'] = { ref: `A1:C${Math.max(1, groupRows.length + 1)}` };
  XLSX.utils.book_append_sheet(workbook, groupSheet, 'Nhom Tinh Luong');
  XLSX.writeFile(workbook, 'Mau_Danh_Sach_SKU.xlsx');
}

export function exportProductsExcel() {
  const products = getFilteredSkuProducts();
  const rows = products.map(product => {
    return {
      'Mã SKU *': product.code,
      'Tên sản phẩm *': product.name,
      'Hãng sơn *': getBrandName(product.brandId || product.brand, product.brand || ''),
      'Mã sản phẩm gốc': getProductBaseCode(product, state.products),
      'Loại bao bì *': product.packageType,
      'Khối lượng *': Number(product.packageWeight),
      'Đơn vị *': product.packageWeightUnit || 'kg',
      'Quy cách hiển thị': specificationOf(product),
      'Nhóm sản phẩm': product.payrollProductGroupId
        ? (getPayrollProductGroup(product.payrollProductGroupId)?.name || product.group || '')
        : '',
      'Giá nhập': Number(product.purchasePrice || 0),
      'Đang áp dụng': product.isActive !== false
    };
  });
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['Mã SKU *', 'Tên sản phẩm *', 'Hãng sơn *', 'Mã sản phẩm gốc', 'Loại bao bì *', 'Khối lượng *', 'Đơn vị *', 'Quy cách hiển thị', 'Nhóm sản phẩm', 'Giá nhập', 'Đang áp dụng']
  });
  sheet['!cols'] = [{ wch: 18 }, { wch: 45 }, { wch: 22 }, { wch: 20 }, { wch: 16 }, { wch: 13 }, { wch: 11 }, { wch: 24 }, { wch: 20 }, { wch: 14 }, { wch: 15 }];
  sheet['!autofilter'] = { ref: `A1:K${Math.max(1, products.length + 1)}` };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
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
      const hasPurchasePriceColumn = normalizeCatalogText(rows[0]?.[9]).includes('gia nhap');
      const importedGroupIds = new Map();
      const unknownPayrollGroups = new Set();
      excelImportData = rows.slice(1).filter(row => row[0]).map(row => {
        const brand = String(row[2] || '').trim();
        const name = String(row[1] || '').trim();
        const baseCode = String(row[3] || row[0]).trim().toUpperCase();
        const matchedBrand = (state.brands || []).find(item => item.name.toLowerCase() === brand.toLowerCase());
        const familyKey = `${normalizeCatalogText(baseCode)}::${normalizeCatalogText(name)}::${normalizeCatalogText(brand)}`;
        const existingFamily = buildProductFamilies(state.products, { includeInactive: true }).find(family => family.key === familyKey);
        if (!importedGroupIds.has(familyKey)) {
          importedGroupIds.set(familyKey, existingFamily?.id || createProductGroupId(baseCode, name, brand));
        }
        const productGroupId = importedGroupIds.get(familyKey);
        const packageType = String(row[4] || '').trim();
        const weight = Number(String(row[5] ?? '').replace(',', '.'));
        const unit = String(row[6] || 'kg').trim();
        const payrollGroupValue = String(row[8] || '').trim();
        const payrollGroup = findPayrollProductGroup(payrollGroupValue);
        if (payrollGroupValue && (!payrollGroup || payrollGroup.isActive === false)) {
          unknownPayrollGroups.add(payrollGroupValue);
        }
        return {
          id: createProductId(),
          code: String(row[0]).trim().toUpperCase(),
          variantCode: String(row[0]).trim().toUpperCase(),
          productGroupId,
          baseCode,
          name,
          brand,
          brandId: matchedBrand?.id || null,
          packageType,
          packagingName: packageType,
          packageWeight: weight,
          weightOrVolume: weight,
          packageWeightUnit: unit,
          unitName: unit,
          displaySpecification: String(row[7] || '').trim(),
          payrollProductGroupId: payrollGroup?.id || null,
          group: payrollGroup?.name || '',
          payrollGroupProvided: Boolean(payrollGroupValue),
          purchasePrice: Number(hasPurchasePriceColumn ? row[9] || 0 : 0),
          isActive: (hasPurchasePriceColumn ? row[10] : row[9]) !== false &&
            String(hasPurchasePriceColumn ? row[10] : row[9]).toLowerCase() !== 'false',
          isLegacy: false
        };
      }).filter(product => product.code && product.name && product.brand && product.packageType && Number.isFinite(product.packageWeight));

      if (unknownPayrollGroups.size > 0) {
        throw new Error(`Nhóm chưa được Kế toán tạo hoặc đã ngừng dùng: ${[...unknownPayrollGroups].join(', ')}`);
      }

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
    const { payrollGroupProvided, ...importedProduct } = imported;
    if (!existing) return importedProduct;
    return {
      ...existing,
      ...importedProduct,
      id: existing.id,
      payrollProductGroupId: payrollGroupProvided ? importedProduct.payrollProductGroupId : existing.payrollProductGroupId,
      group: payrollGroupProvided ? importedProduct.group : existing.group
    };
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

function resetPayrollProductGroupForm() {
  const form = document.getElementById('payroll-product-group-form');
  form?.reset();
  const idInput = document.getElementById('payroll-product-group-id');
  if (idInput) idInput.value = '';
}

function renderPayrollProductGroupsTable() {
  const body = document.getElementById('payroll-product-groups-table-body');
  if (!body) return;
  const groups = [...(state.payrollProductGroups || [])]
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'vi'));
  body.innerHTML = groups.length ? groups.map(group => `
    <tr>
      <td><strong>${escapeHtml(group.code)}</strong></td>
      <td>${escapeHtml(group.name)}</td>
      <td>${escapeHtml(group.description || '')}</td>
      <td><span class="status-badge ${group.isActive === false ? 'inactive' : 'active'}">${group.isActive === false ? 'Ngừng dùng' : 'Đang dùng'}</span></td>
      <td class="text-center">
        <div class="actions-cell">
          <button type="button" class="btn btn-secondary btn-sm btn-circle edit-payroll-product-group" data-id="${escapeHtml(group.id)}" title="Sửa nhóm"><i data-lucide="edit-2"></i></button>
          <button type="button" class="btn ${group.isActive === false ? 'btn-primary' : 'btn-danger'} btn-sm toggle-payroll-product-group" data-id="${escapeHtml(group.id)}">
            ${group.isActive === false ? 'Dùng lại' : 'Ngừng dùng'}
          </button>
        </div>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="empty-table-cell">Chưa có nhóm nào. Kế toán tạo nhóm đầu tiên ở biểu mẫu phía trên.</td></tr>';

  body.querySelectorAll('.edit-payroll-product-group').forEach(button => {
    button.addEventListener('click', () => {
      const group = getPayrollProductGroup(button.dataset.id);
      if (!group) return;
      document.getElementById('payroll-product-group-id').value = group.id;
      document.getElementById('payroll-product-group-code').value = group.code;
      document.getElementById('payroll-product-group-name').value = group.name;
      document.getElementById('payroll-product-group-description').value = group.description || '';
      document.getElementById('payroll-product-group-code').focus();
    });
  });
  body.querySelectorAll('.toggle-payroll-product-group').forEach(button => {
    button.addEventListener('click', async () => {
      const group = getPayrollProductGroup(button.dataset.id);
      if (!group) return;
      const nextActive = group.isActive === false;
      const assignedCount = (state.products || []).filter(product => product.payrollProductGroupId === group.id).length;
      if (!nextActive && !confirm(`Ngừng dùng nhóm “${group.name}”? ${assignedCount} SKU đang gán nhóm này vẫn được giữ nguyên.`)) return;
      if (!await dbSetPayrollProductGroupActive(group.id, nextActive)) return;
      group.isActive = nextActive;
      group.updatedAt = new Date().toISOString();
      localStorage.setItem('billing_system_payroll_product_groups', JSON.stringify(state.payrollProductGroups));
      renderPayrollProductGroupsTable();
      renderProductsTable();
      showToast(nextActive ? 'Đã cho phép dùng lại nhóm sản phẩm.' : 'Đã ngừng dùng nhóm; các gán cũ vẫn được giữ.');
    });
  });
  safeCreateIcons();
}

function openPayrollProductGroupsModal() {
  if (!canManagePayrollProductGroups()) {
    showToast('Chỉ Admin hoặc Kế toán được quản lý nhóm sản phẩm tính lương.', 'danger');
    return;
  }
  resetPayrollProductGroupForm();
  renderPayrollProductGroupsTable();
  document.getElementById('payroll-product-groups-modal')?.classList.add('active');
}

function closePayrollProductGroupsModal() {
  document.getElementById('payroll-product-groups-modal')?.classList.remove('active');
}

async function savePayrollProductGroup() {
  if (!canManagePayrollProductGroups()) return;
  const idInput = document.getElementById('payroll-product-group-id');
  const id = idInput.value || createPayrollProductGroupId();
  const code = document.getElementById('payroll-product-group-code').value.trim().toUpperCase();
  const name = document.getElementById('payroll-product-group-name').value.trim();
  const description = document.getElementById('payroll-product-group-description').value.trim();
  if (!code || !name) {
    showToast('Vui lòng nhập mã nhóm và tên nhóm.', 'warning');
    return;
  }
  const duplicate = (state.payrollProductGroups || []).find(group =>
    group.id !== id && (
      normalizeCatalogText(group.code) === normalizeCatalogText(code) ||
      normalizeCatalogText(group.name) === normalizeCatalogText(name)
    )
  );
  if (duplicate) {
    showToast('Mã nhóm hoặc tên nhóm đã tồn tại.', 'danger');
    return;
  }

  const existing = getPayrollProductGroup(id);
  const group = {
    ...(existing || {}),
    id,
    code,
    name,
    description,
    isActive: existing?.isActive !== false,
    createdBy: existing?.createdBy || state.currentUser?.username || state.currentUser?.id || '',
    updatedBy: state.currentUser?.username || state.currentUser?.id || '',
    updatedAt: new Date().toISOString()
  };
  if (!await dbSavePayrollProductGroup(group)) return;

  const index = (state.payrollProductGroups || []).findIndex(item => item.id === id);
  if (index >= 0) state.payrollProductGroups[index] = group;
  else state.payrollProductGroups.push(group);
  if (existing && existing.name !== name) {
    (state.products || []).forEach(product => {
      if (product.payrollProductGroupId === id) product.group = name;
    });
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  }
  localStorage.setItem('billing_system_payroll_product_groups', JSON.stringify(state.payrollProductGroups));
  resetPayrollProductGroupForm();
  renderPayrollProductGroupsTable();
  renderProductsTable();
  showToast(existing ? 'Đã cập nhật nhóm sản phẩm.' : 'Đã tạo nhóm sản phẩm thủ công.');
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
  ['product-search-input', 'product-brand-filter', 'product-package-filter', 'product-payroll-group-filter', 'product-status-filter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', refresh);
    document.getElementById(id)?.addEventListener('change', refresh);
  });
  document.getElementById('btn-open-add-product-modal')?.addEventListener('click', () => openProductModal(-1));
  document.getElementById('btn-manage-payroll-product-groups')?.addEventListener('click', openPayrollProductGroupsModal);
  document.getElementById('btn-close-payroll-product-groups-modal')?.addEventListener('click', closePayrollProductGroupsModal);
  document.getElementById('btn-done-payroll-product-groups')?.addEventListener('click', closePayrollProductGroupsModal);
  document.getElementById('btn-reset-payroll-product-group-form')?.addEventListener('click', resetPayrollProductGroupForm);
  document.getElementById('payroll-product-group-form')?.addEventListener('submit', event => {
    event.preventDefault();
    savePayrollProductGroup();
  });
  document.getElementById('btn-close-product-modal')?.addEventListener('click', closeProductModal);
  document.getElementById('btn-cancel-product')?.addEventListener('click', closeProductModal);
  document.getElementById('product-form')?.addEventListener('submit', event => {
    event.preventDefault();
    saveProduct();
  });
  document.getElementById('btn-add-product-variant')?.addEventListener('click', () => {
    const baseCode = document.getElementById('prod-code')?.value.trim().toUpperCase() || '';
    addVariantEditorRow({ code: baseCode ? `${baseCode}-` : '' });
  });
  document.getElementById('prod-variants-body')?.addEventListener('click', event => {
    const button = event.target.closest('.remove-product-variant');
    if (!button) return;
    const row = button.closest('.product-variant-editor-row');
    if (!row) return;
    if (row.dataset.variantId) {
      row.querySelector('.variant-active-input').checked = false;
      row.dataset.removed = 'true';
      row.style.display = 'none';
    } else {
      row.remove();
    }
  });
  document.getElementById('prod-brand')?.addEventListener('change', event => {
    const custom = document.getElementById('prod-brand-custom-group');
    if (custom) custom.style.display = event.target.value === 'Khác' ? 'block' : 'none';
  });
}
