import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons } from '../utils.js';
import { dbSaveProduct, dbDeleteProduct } from '../services/supabase.js';
import { renderAll } from '../main.js';

let excelImportData = [];

export function renderProductsTable() {
  const tableBody = document.getElementById('products-table-body');
  if (!tableBody) return;
  
  const searchVal = document.getElementById('product-search-input').value.toLowerCase().trim();
  const brandFilter = document.getElementById('product-brand-filter').value;
  
  const filtered = state.products.filter(p => {
    const matchesSearch = p.code.toLowerCase().includes(searchVal) || p.name.toLowerCase().includes(searchVal);
    const matchesBrand = brandFilter === '' || p.brand === brandFilter;
    return matchesSearch && matchesBrand;
  });
  
  // Điền dữ liệu vào Dropdown Hãng sơn (lọc trùng) nếu dropdown trống hoặc cần update
  const filterSelect = document.getElementById('product-brand-filter');
  const activeBrandFilter = filterSelect.value;
  
  const uniqueBrands = [...new Set(state.products.map(p => p.brand).filter(Boolean))];
  
  filterSelect.innerHTML = `
    <option value="">-- Tất cả hãng sơn --</option>
    ${uniqueBrands.map(b => `<option value="${b}">${b}</option>`).join('')}
  `;
  filterSelect.value = activeBrandFilter;

  // Lọc dropdown trong modal sản phẩm (nếu có)
  const prodBrandSelect = document.getElementById('prod-brand');
  if (prodBrandSelect) {
    const currentVal = prodBrandSelect.value;
    const staticBrands = ['Nano10*', 'mutsutec', 'tdkaw', 'cova', 'festivanano', 'Hatacco nano', 'Khác'];
    
    // Gộp cả các hãng tự định nghĩa từ dữ liệu
    const allBrands = [...new Set([...staticBrands.filter(b => b !== 'Khác'), ...uniqueBrands])];
    allBrands.push('Khác');
    
    prodBrandSelect.innerHTML = allBrands.map(b => `<option value="${b}">${b}</option>`).join('');
    
    // Khôi phục giá trị cũ
    if (currentVal && Array.from(prodBrandSelect.options).some(o => o.value === currentVal)) {
      prodBrandSelect.value = currentVal;
    }
  }

  // Đọc danh sách hãng sơn để gán nhãn suggestion trong dropdown lên đơn
  populateInvoiceBrandFilter(uniqueBrands);

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="11" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy sản phẩm nào.
        </td>
      </tr>
    `;
    return;
  }
  
  // Sắp xếp sản phẩm theo mã
  filtered.sort((a, b) => a.code.localeCompare(b.code));
  
  tableBody.innerHTML = filtered.map((p, index) => {
    const getWeightStr = () => {
      const parts = [];
      if (p.weightThung) parts.push(`Thùng: ${p.weightThung}`);
      if (p.weightLon) parts.push(`Lon: ${p.weightLon}`);
      if (p.weightHop) parts.push(`Hộp: ${p.weightHop}`);
      if (p.weightBao) parts.push(`Bao: ${p.weightBao}`);
      if (p.weightTui) parts.push(`Túi: ${p.weightTui}`);
      return parts.length > 0 ? parts.join('\n') : 'N/A';
    };
    
    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${index + 1}</td>
        <td style="font-weight: 600; color: #fff;">${p.code}</td>
        <td style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${p.name}">${p.name}</td>
        <td>
          <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); display: inline-block;">${p.brand || 'Nano10*'}</span>
        </td>
        <td style="font-size: 0.75rem; color: var(--text-secondary); white-space: pre-line; line-height: 1.3;" title="${getWeightStr()}">${getWeightStr().replace(/\n/g, ', ')}</td>
        <td style="text-align: right; font-weight: 600; color: #fff;">${p.priceThung > 0 ? formatCurrency(p.priceThung) : '<span style="color: var(--text-muted); font-weight: normal;">-</span>'}</td>
        <td style="text-align: right; font-weight: 600; color: #fff;">${p.priceLon > 0 ? formatCurrency(p.priceLon) : '<span style="color: var(--text-muted); font-weight: normal;">-</span>'}</td>
        <td style="text-align: right; font-weight: 600; color: #fff;">${p.priceHop > 0 ? formatCurrency(p.priceHop) : '<span style="color: var(--text-muted); font-weight: normal;">-</span>'}</td>
        <td style="text-align: right; font-weight: 600; color: #fff;">${p.priceBao > 0 ? formatCurrency(p.priceBao) : '<span style="color: var(--text-muted); font-weight: normal;">-</span>'}</td>
        <td style="text-align: right; font-weight: 600; color: #fff;">${p.priceTui > 0 ? formatCurrency(p.priceTui) : '<span style="color: var(--text-muted); font-weight: normal;">-</span>'}</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-prod-btn" data-code="${p.code}" data-brand="${p.brand}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-prod-btn" data-code="${p.code}" data-brand="${p.brand}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  // Gán sự kiện cho các nút
  document.querySelectorAll('.edit-prod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code');
      const brand = btn.getAttribute('data-brand');
      const idx = state.products.findIndex(p => p.code === code && p.brand === brand);
      openProductModal(idx);
    });
  });
  
  document.querySelectorAll('.delete-prod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code');
      const brand = btn.getAttribute('data-brand');
      deleteProduct(code, brand);
    });
  });
  
  safeCreateIcons();
}

function populateInvoiceBrandFilter(brands) {
  const brandBadge = document.getElementById('selected-customer-brand-lbl');
  // Hàm này giúp đồng bộ hãng sơn cho dropdown
}

export function openProductModal(index = -1) {
  const modal = document.getElementById('product-modal');
  const title = document.getElementById('product-modal-title');
  const form = document.getElementById('product-form');
  const codeInput = document.getElementById('prod-code');
  const customBrandGroup = document.getElementById('prod-brand-custom-group');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();
  if (customBrandGroup) customBrandGroup.style.display = 'none';
  
  if (index === -1) {
    title.innerText = 'Thêm sản phẩm mới';
    document.getElementById('product-edit-index').value = '-1';
    codeInput.removeAttribute('disabled');
  } else {
    title.innerText = 'Chỉnh sửa sản phẩm';
    const prod = state.products[index];
    document.getElementById('product-edit-index').value = index;
    
    codeInput.value = prod.code;
    codeInput.setAttribute('disabled', 'true'); // Khóa không cho sửa Mã SP trực tiếp
    
    document.getElementById('prod-name').value = prod.name;
    document.getElementById('prod-brand').value = prod.brand || 'Nano10*';
    
    document.getElementById('prod-price-thung').value = prod.priceThung || 0;
    document.getElementById('prod-price-lon').value = prod.priceLon || 0;
    document.getElementById('prod-price-hop').value = prod.priceHop || 0;
    document.getElementById('prod-price-bao').value = prod.priceBao || 0;
    document.getElementById('prod-price-tui').value = prod.priceTui || 0;
    
    document.getElementById('prod-weight-thung').value = prod.weightThung || '';
    document.getElementById('prod-weight-lon').value = prod.weightLon || '';
    document.getElementById('prod-weight-hop').value = prod.weightHop || '';
    document.getElementById('prod-weight-bao').value = prod.weightBao || '';
    document.getElementById('prod-weight-tui').value = prod.weightTui || '';
  }
}

export function closeProductModal() {
  const modal = document.getElementById('product-modal');
  if (modal) modal.classList.remove('active');
}

export async function saveProduct() {
  const index = parseInt(document.getElementById('product-edit-index').value);
  const code = document.getElementById('prod-code').value.trim().toUpperCase();
  const name = document.getElementById('prod-name').value.trim();
  
  let brand = document.getElementById('prod-brand').value;
  if (brand === 'Khác') {
    brand = document.getElementById('prod-brand-custom').value.trim();
    if (!brand) {
      showToast('Vui lòng điền tên hãng sơn khác!', 'warning');
      return;
    }
  }
  
  const priceThung = parseFloat(document.getElementById('prod-price-thung').value) || 0;
  const priceLon = parseFloat(document.getElementById('prod-price-lon').value) || 0;
  const priceHop = parseFloat(document.getElementById('prod-price-hop').value) || 0;
  const priceBao = parseFloat(document.getElementById('prod-price-bao').value) || 0;
  const priceTui = parseFloat(document.getElementById('prod-price-tui').value) || 0;
  
  const weightThung = document.getElementById('prod-weight-thung').value.trim();
  const weightLon = document.getElementById('prod-weight-lon').value.trim();
  const weightHop = document.getElementById('prod-weight-hop').value.trim();
  const weightBao = document.getElementById('prod-weight-bao').value.trim();
  const weightTui = document.getElementById('prod-weight-tui').value.trim();
  
  // Validate trùng khoá kép (code, brand)
  const duplicate = state.products.some((p, idx) => p.code === code && p.brand === brand && idx !== index);
  if (duplicate) {
    showToast('Mã sản phẩm với hãng sơn này đã tồn tại!', 'danger');
    return;
  }
  
  const productData = {
    code,
    name,
    brand,
    priceThung,
    priceLon,
    priceHop,
    priceBao,
    priceTui,
    weightThung,
    weightLon,
    weightHop,
    weightBao,
    weightTui
  };
  
  const saved = await dbSaveProduct(productData);
  if (saved) {
    if (index === -1) {
      showToast('Thêm sản phẩm thành công!');
    } else {
      showToast('Cập nhật sản phẩm thành công!');
    }
    
    // Cập nhật State local
    const idx = state.products.findIndex(p => p.code === code && p.brand === brand);
    if (idx > -1) state.products[idx] = productData;
    else state.products.push(productData);
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
    
    closeProductModal();
    renderAll();
  }
}

export async function deleteProduct(code, brand) {
  if (confirm(`Bạn có chắc chắn muốn xóa sản phẩm "${code}" của hãng "${brand}" không?`)) {
    const deleted = await dbDeleteProduct(code, brand);
    if (deleted) {
      state.products = state.products.filter(p => !(p.code === code && p.brand === brand));
      localStorage.setItem('billing_system_products', JSON.stringify(state.products));
      renderAll();
      showToast('Xóa sản phẩm thành công!', 'warning');
    }
  }
}

export function downloadExcelTemplate() {
  const headers = [[
    "Mã sản phẩm *", "Tên sản phẩm *", "Hãng sơn *", 
    "Giá Thùng (đ)", "Giá Lon (đ)", "Giá Hộp (đ)", "Giá Bao (đ)", "Giá Túi (đ)",
    "Khối lượng Thùng", "Khối lượng Lon", "Khối lượng Hộp", "Khối lượng Bao", "Khối lượng Túi"
  ]];
  
  const sampleRows = [
    ['SP001', 'Sơn bóng ngoại thất WeatherShield', 'Nano10*', 1250000, 380000, 120000, 0, 0, '19kg', '5kg', '1kg', '', ''],
    ['SP006', 'Bột bả tường cao cấp Nano10*', 'Nano10*', 0, 0, 0, 280000, 60000, '', '', '', '40kg', '5kg'],
    ['SP007', 'Chống thấm chuyên dụng Sika Latex', 'Hatacco nano', 850000, 250000, 0, 0, 75000, '23kg', '7kg', '', '', '0.5kg']
  ];

  const sheetData = headers.concat(sampleRows);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  
  ws['!cols'] = [
    { wch: 15 }, { wch: 45 }, { wch: 15 }, 
    { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
  ];
  
  XLSX.utils.book_append_sheet(wb, ws, "Danh Sach San Pham");
  XLSX.writeFile(wb, "Mau_Danh_Sach_San_Pham.xlsx");
  showToast("Đã tải xuống file Excel mẫu thành công!");
}

export function setupExcelImportAndTemplate() {
  const downloadTemplateBtn = document.getElementById('btn-download-excel-template');
  const openImportModalBtn = document.getElementById('btn-open-excel-modal');
  const closeImportModalBtn = document.getElementById('btn-close-excel-modal');
  const cancelImportBtn = document.getElementById('btn-cancel-excel');
  const browseExcelBtn = document.getElementById('btn-browse-excel');
  const excelFileInput = document.getElementById('excel-file-input');
  const excelDropzone = document.getElementById('excel-dropzone');
  const saveImportBtn = document.getElementById('btn-save-excel-submit');

  if (downloadTemplateBtn) {
    downloadTemplateBtn.addEventListener('click', downloadExcelTemplate);
  }

  const toggleImportModal = (show) => {
    const modal = document.getElementById('excel-modal');
    if (!modal) return;
    if (show) {
      modal.classList.add('active');
      excelImportData = [];
      if (excelFileInput) excelFileInput.value = '';
      if (saveImportBtn) saveImportBtn.setAttribute('disabled', 'true');
      document.getElementById('excel-preview-container').style.display = 'none';
      excelDropzone.className = 'upload-dropzone';
    } else {
      modal.classList.remove('active');
    }
  };

  if (openImportModalBtn) openImportModalBtn.addEventListener('click', () => toggleImportModal(true));
  if (closeImportModalBtn) closeImportModalBtn.addEventListener('click', () => toggleImportModal(false));
  if (cancelImportBtn) cancelImportBtn.addEventListener('click', () => toggleImportModal(false));

  // Kéo thả file Excel
  if (excelDropzone && excelFileInput) {
    excelDropzone.addEventListener('click', () => excelFileInput.click());
    
    excelDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      excelDropzone.classList.add('dragover');
    });

    excelDropzone.addEventListener('dragleave', () => {
      excelDropzone.classList.remove('dragover');
    });

    excelDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      excelDropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        excelFileInput.files = e.dataTransfer.files;
        handleExcelFileSelect(excelFileInput.files[0]);
      }
    });

    excelFileInput.addEventListener('change', () => {
      if (excelFileInput.files.length > 0) {
        handleExcelFileSelect(excelFileInput.files[0]);
      }
    });
  }

  if (saveImportBtn) {
    saveImportBtn.addEventListener('click', async () => {
      await processExcelImport();
      toggleImportModal(false);
    });
  }

  // Lắng nghe sự kiện đổi Hãng sơn trên bảng Sản phẩm
  const brandFilter = document.getElementById('product-brand-filter');
  if (brandFilter) {
    brandFilter.addEventListener('change', renderProductsTable);
  }

  const searchInput = document.getElementById('product-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', renderProductsTable);
  }

  const openAddModalBtn = document.getElementById('btn-open-add-product-modal');
  if (openAddModalBtn) {
    openAddModalBtn.addEventListener('click', () => openProductModal(-1));
  }

  const closeProductModalBtn = document.getElementById('btn-close-product-modal');
  if (closeProductModalBtn) {
    closeProductModalBtn.addEventListener('click', closeProductModal);
  }

  const cancelProductBtn = document.getElementById('btn-cancel-product');
  if (cancelProductBtn) {
    cancelProductBtn.addEventListener('click', closeProductModal);
  }

  const productForm = document.getElementById('product-form');
  if (productForm) {
    productForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveProduct();
    });
  }

  // Tự hiển thị khung nhập hãng sơn mới nếu chọn "Khác"
  const prodBrandSelect = document.getElementById('prod-brand');
  if (prodBrandSelect) {
    prodBrandSelect.addEventListener('change', () => {
      const customBrandGroup = document.getElementById('prod-brand-custom-group');
      if (customBrandGroup) {
        customBrandGroup.style.display = prodBrandSelect.value === 'Khác' ? 'block' : 'none';
      }
    });
  }
}

function handleExcelFileSelect(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
      
      if (rows.length <= 1) {
        showToast("Tệp Excel trống hoặc không đúng định dạng mẫu!", "danger");
        return;
      }

      excelImportData = [];
      const previewRows = [];

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (r.length === 0 || !r[0]) continue; // bỏ dòng trống
        
        const prod = {
          code: String(r[0]).trim().toUpperCase(),
          name: String(r[1]).trim(),
          brand: String(r[2]).trim(),
          priceThung: parseFloat(r[3]) || 0,
          priceLon: parseFloat(r[4]) || 0,
          priceHop: parseFloat(r[5]) || 0,
          priceBao: parseFloat(r[6]) || 0,
          priceTui: parseFloat(r[7]) || 0,
          weightThung: r[8] ? String(r[8]).trim() : '',
          weightLon: r[9] ? String(r[9]).trim() : '',
          weightHop: r[10] ? String(r[10]).trim() : '',
          weightBao: r[11] ? String(r[11]).trim() : '',
          weightTui: r[12] ? String(r[12]).trim() : ''
        };

        if (!prod.code || !prod.name || !prod.brand) {
          showToast(`Dòng ${i + 1} thiếu trường bắt buộc (Mã, Tên, Hãng sơn)!`, "warning");
          continue;
        }

        excelImportData.push(prod);
        if (previewRows.length < 5) {
          previewRows.push(prod);
        }
      }

      if (excelImportData.length === 0) {
        showToast("Không phân tích được sản phẩm nào hợp lệ!", "warning");
        return;
      }

      // Render bảng preview
      const previewBody = document.getElementById('excel-preview-table-body');
      previewBody.innerHTML = previewRows.map((p, idx) => `
        <tr>
          <td style="text-align: center;">${idx + 1}</td>
          <td style="font-weight: 600;">${p.code}</td>
          <td>${p.name}</td>
          <td>${p.brand}</td>
          <td>Thùng: ${p.weightThung || '-'}</td>
          <td style="text-align: right;">${formatCurrency(p.priceThung)}</td>
          <td style="text-align: right;">${formatCurrency(p.priceLon)}</td>
          <td style="text-align: right;">${formatCurrency(p.priceHop)}</td>
          <td style="text-align: right;">${formatCurrency(p.priceBao)}</td>
          <td style="text-align: right;">${formatCurrency(p.priceTui)}</td>
        </tr>
      `).join('');

      document.getElementById('excel-preview-summary').innerText = `Hiển thị 5 trên tổng số ${excelImportData.length} sản phẩm đọc được.`;
      document.getElementById('excel-preview-container').style.display = 'block';
      document.getElementById('btn-save-excel-submit').removeAttribute('disabled');
      
      const dropzone = document.getElementById('excel-dropzone');
      dropzone.className = 'upload-dropzone success-uploaded';
      showToast(`Đọc tệp thành công! Tìm thấy ${excelImportData.length} sản phẩm.`, "success");
    } catch (err) {
      console.error(err);
      showToast("Lỗi đọc tệp Excel: " + err.message, "danger");
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processExcelImport() {
  if (excelImportData.length === 0) return;
  
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  
  try {
    showToast("Đang nhập dữ liệu sản phẩm vào hệ thống...", "info");
    
    if (mode === 'overwrite') {
      // Xóa toàn bộ sản phẩm cũ trên Cloud và Local
      if (confirm("Chế độ ghi đè sẽ xóa sạch toàn bộ sản phẩm hiện tại của bạn. Bạn chắc chắn chứ?")) {
        state.products = [];
        // Lệnh xóa hết sản phẩm trên Cloud
        for (const p of state.products) {
          await dbDeleteProduct(p.code, p.brand);
        }
      } else {
        return;
      }
    }

    let successCount = 0;
    for (const p of excelImportData) {
      const saved = await dbSaveProduct(p);
      if (saved) {
        const idx = state.products.findIndex(op => op.code === p.code && op.brand === p.brand);
        if (idx > -1) {
          state.products[idx] = p;
        } else {
          state.products.push(p);
        }
        successCount++;
      }
    }

    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
    renderAll();
    showToast(`Nhập dữ liệu thành công! Đã thêm/cập nhật ${successCount} sản phẩm.`, "success");
  } catch (err) {
    console.error(err);
    showToast("Lỗi lưu sản phẩm import: " + err.message, "danger");
  }
}

export function setupProductManagement() {
  const addBtn = document.getElementById('btn-open-add-product-modal');
  if (addBtn) addBtn.addEventListener('click', () => openProductModal());
  
  const closeBtn = document.getElementById('btn-close-product-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeProductModal);
  
  const cancelBtn = document.getElementById('btn-cancel-product');
  if (cancelBtn) cancelBtn.addEventListener('click', closeProductModal);
  
  const productForm = document.getElementById('product-form');
  if (productForm) {
    productForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveProduct();
    });
  }
}
