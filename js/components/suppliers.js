import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatPhoneNumber } from '../utils.js';
import { dbSaveSupplier, dbDeleteSupplier, dbSaveSuppliersBulk } from '../services/supabase.js?v=20261028-dashboard-access-v1';
import { filterSupplierDirectory, supplierDirectoryTotals, supplierFilterError, supplierNumber, supplierDay, supplierDateRange } from '../domain/supplier-directory.js';
import { renderAll, ensurePanelCloudData } from '../main.js?v=20261028-dashboard-access-v1';
import { resetSupplierReportPreview, previewSupplierReport, processSupplierReportImport, openSupplierDebtHistory } from './supplier-reports.js?v=20261028-dashboard-access-v1';
import { openSupplierPeriodReport } from './supplier-debt-report.js?v=20261028-dashboard-access-v1';

const toNumber = supplierNumber;
const deletingSuppliers = new Set();
const escapeSupplierHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function supplierDateLabel(value) {
  const day = supplierDay(value);
  return day ? day.split('-').reverse().join('/') : '—';
}
function supplierFilters() {
  const value = (id, fallback = '') => document.getElementById(id)?.value ?? fallback;
  return { query: value('supplier-search-input'), debt: value('supplier-debt-filter', 'all'),
    min: value('supplier-debt-min'), max: value('supplier-debt-max'),
    dateField: value('supplier-date-field', 'createdAt'), from: value('supplier-date-from'), to: value('supplier-date-to'),
    sort: value('supplier-sort', 'debt-desc') };
}
function calculateSupplierMetrics(supplier) {
  return { totalPurchase: toNumber(supplier.totalPurchase), payableDebt: toNumber(supplier.debt) };
}
function getFilteredSuppliers() { return filterSupplierDirectory(state.suppliers, supplierFilters()); }

export function exportSuppliersExcel() {
  if (!globalThis.XLSX) {
    showToast('Chưa tải được thư viện Excel. Hãy tải lại trang rồi thử lại.', 'warning');
    return;
  }
  const filterError = supplierFilterError(supplierFilters());
  if (filterError) { showToast(filterError, 'warning'); return; }
  const suppliers = getFilteredSuppliers();
  if (!suppliers.length) {
    showToast('Không có nhà cung cấp phù hợp để xuất Excel.', 'warning');
    return;
  }
  try {
    const headers = ['STT', 'Mã nhà cung cấp', 'Tên nhà cung cấp', 'Số điện thoại',
      'Địa chỉ', 'Công nợ hiện tại', 'Tổng mua', 'Ghi chú', 'Đã thanh toán', 'Mua gần nhất (còn lưu)', 'Chi gần nhất (còn lưu)', 'Ngày tạo hồ sơ', 'Ngày cập nhật'];
    let totalDebt = 0;
    let totalPurchase = 0;
    let totalPaid = 0;
    const rows = suppliers.map((supplier, index) => {
      const metrics = calculateSupplierMetrics(supplier);
      totalDebt += metrics.payableDebt;
      totalPurchase += metrics.totalPurchase;
      totalPaid += toNumber(supplier.totalPaid);
      return [index + 1, String(supplier.code || supplier.id || ''), String(supplier.name || ''),
        String(supplier.phone || ''), String(supplier.address || ''),
        metrics.payableDebt, metrics.totalPurchase, String(supplier.notes || ''), toNumber(supplier.totalPaid),
        supplierDateLabel(supplier.lastPurchaseAt), supplierDateLabel(supplier.lastPaymentAt), supplierDateLabel(supplier.createdAt), supplierDateLabel(supplier.updatedAt)];
    });
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows,
      ['', '', 'TỔNG CỘNG', '', '', totalDebt, totalPurchase, '', totalPaid, '', '', '', '']]);
    sheet['!cols'] = [7, 22, 40, 20, 50, 22, 22, 50, 22, 25, 25, 22, 22].map(wch => ({ wch }));
    sheet['!autofilter'] = { ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 }
    }) };
    for (let r = 1; r <= rows.length + 1; r++) {
      for (let c = 0; c < headers.length; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        if (c === 5 || c === 6 || c === 8) cell.z = '#,##0;[Red]-#,##0';
        else if (c !== 0) { cell.t = 's'; cell.z = '@'; }
      }
    }
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'DanhSachNhaCungCap');
    const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
    XLSX.writeFile(workbook, `DanhSachNhaCungCap_${stamp}.xlsx`);
    showToast(`Đã xuất ${suppliers.length} nhà cung cấp theo bộ lọc hiện tại.`, 'success');
  } catch (error) {
    console.error('Supplier Excel export failed:', error);
    showToast('Không thể xuất Excel nhà cung cấp. Vui lòng thử lại.', 'danger');
  }
}

export function renderSuppliersTable() {
  const body = document.getElementById('suppliers-table-body');
  if (!body) return;
  const filters = supplierFilters();
  const error = supplierFilterError(filters);
  const activeCount = Number(filters.debt !== 'all') + Number(filters.min !== '') + Number(filters.max !== '')
    + Number(Boolean(filters.from || filters.to)) + Number(filters.sort !== 'debt-desc');
  const badge = document.getElementById('supplier-filter-count');
  if (badge) { badge.textContent = String(activeCount); badge.hidden = activeCount === 0; }
  document.getElementById('btn-open-supplier-filters')?.classList.toggle('is-active', activeCount > 0);
  const filtered = getFilteredSuppliers();
  const totals = supplierDirectoryTotals(filtered);
  const setText = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  setText('supplier-summary-count', totals.count);
  setText('supplier-summary-payable', formatCurrency(totals.payable));
  setText('supplier-summary-payable-count', totals.payableCount + ' nhà cung cấp còn nợ');
  setText('supplier-summary-advance', formatCurrency(totals.advance));
  setText('supplier-summary-purchase', formatCurrency(totals.purchase));
  setText('supplier-summary-paid', 'Đã thanh toán: ' + formatCurrency(totals.paid));
  setText('supplier-filter-error', error);
  const pageSize = Number(document.getElementById('supplier-page-size')?.value || 20);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.suppliersPage = Math.min(pages, Math.max(1, Number(state.suppliersPage) || 1));
  const offset = (state.suppliersPage - 1) * pageSize;
  setText('supplier-result-count', 'Hiển thị ' + (filtered.length ? offset + 1 : 0) + '–' + Math.min(offset + pageSize, filtered.length) + ' / ' + filtered.length + ' nhà cung cấp');
  const footer = document.getElementById('suppliers-table-totals');
  if (footer) footer.innerHTML = '<tr><td colspan="2">Tổng theo bộ lọc · ' + totals.count + ' nhà cung cấp</td><td class="supplier-money">' + formatCurrency(totals.purchase) + '</td><td class="supplier-money">' + formatCurrency(totals.paid) + '</td><td class="supplier-money">' + formatCurrency(totals.debt) + '</td><td colspan="2">Công nợ ròng</td></tr>';
  const pager = document.getElementById('suppliers-pagination');
  if (pager) {
    pager.innerHTML = '<div class="supplier-pagination"><button type="button" class="btn btn-secondary btn-sm" id="suppliers-prev-page" ' + (state.suppliersPage === 1 ? 'disabled' : '') + '>Trước</button><span>Trang <strong>' + state.suppliersPage + '</strong> / ' + pages + '</span><button type="button" class="btn btn-secondary btn-sm" id="suppliers-next-page" ' + (state.suppliersPage === pages ? 'disabled' : '') + '>Sau</button></div>';
    document.getElementById('suppliers-prev-page')?.addEventListener('click', () => { state.suppliersPage--; renderSuppliersTable(); });
    document.getElementById('suppliers-next-page')?.addEventListener('click', () => { state.suppliersPage++; renderSuppliersTable(); });
  }
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7" class="supplier-empty">' + (error || 'Không có nhà cung cấp phù hợp. Hãy thử đổi hoặc xóa bộ lọc.') + '</td></tr>';
    return;
  }
  body.innerHTML = filtered.slice(offset, offset + pageSize).map(s => {
    const index = state.suppliers.findIndex(item => item.id === s.id);
    const debt = toNumber(s.debt);
    const status = debt > 0 ? 'Còn phải trả' : debt < 0 ? 'Đã trả trước' : 'Đã tất toán';
    const tone = debt > 0 ? 'payable' : debt < 0 ? 'advance' : 'settled';
    return '<tr><td><strong class="supplier-name">' + escapeSupplierHtml(s.name) + '</strong><span class="supplier-code">' + escapeSupplierHtml(s.code || s.id) + '</span></td>' +
      '<td><span>' + escapeSupplierHtml(s.phone || 'Chưa có SĐT') + '</span><small class="supplier-address">' + escapeSupplierHtml(s.address || 'Chưa có địa chỉ') + '</small></td>' +
      '<td class="supplier-money">' + formatCurrency(toNumber(s.totalPurchase)) + '</td><td class="supplier-money">' + formatCurrency(toNumber(s.totalPaid)) + '</td>' +
      '<td class="supplier-money"><strong class="supplier-debt-' + tone + '">' + formatCurrency(debt) + '</strong><span class="supplier-status ' + tone + '">' + status + '</span></td>' +
      '<td><span>' + supplierDateLabel(s.lastPurchaseAt) + '</span><small class="supplier-address">Chi: ' + supplierDateLabel(s.lastPaymentAt) + '</small></td>' +
      '<td><div class="supplier-actions"><button type="button" class="btn btn-secondary btn-sm supplier-detail-btn" data-index="' + index + '" aria-label="Chi tiết ' + escapeSupplierHtml(s.name) + '" aria-expanded="false">Chi tiết</button>' +
      '<button type="button" class="btn btn-secondary btn-sm supplier-history-btn" data-index="' + index + '">Công nợ</button>' +
      '<button type="button" class="btn btn-secondary btn-sm edit-supplier-btn" data-index="' + index + '" aria-label="Sửa ' + escapeSupplierHtml(s.name) + '"><i data-lucide="edit-2"></i></button>' +
      '<button type="button" class="btn btn-secondary btn-sm delete-supplier-btn" data-supplier-id="' + escapeSupplierHtml(s.id) + '" aria-label="Xóa nhà cung cấp ' + escapeSupplierHtml(s.name) + '" title="Xóa nhà cung cấp" ' + (deletingSuppliers.has(s.id) ? 'disabled' : '') + '><i data-lucide="x" aria-hidden="true"></i></button></div></td></tr>' +
      '<tr id="supplier-details-' + index + '" class="supplier-detail-row" hidden><td colspan="7"><div class="supplier-detail-grid"><div><small>NỢ ĐẦU KỲ</small><strong>' + formatCurrency(toNumber(s.openingDebt)) + '</strong></div><div><small>NGÀY TẠO HỒ SƠ</small><strong>' + supplierDateLabel(s.createdAt) + '</strong></div><div><small>CẬP NHẬT GẦN NHẤT</small><strong>' + supplierDateLabel(s.updatedAt) + '</strong></div><div class="supplier-detail-notes"><small>GHI CHÚ</small><span>' + escapeSupplierHtml(s.notes || 'Chưa có ghi chú') + '</span></div></div></td></tr>';
  }).join('');
  document.querySelectorAll('.supplier-detail-btn').forEach(btn => btn.addEventListener('click', () => {
    const row = document.getElementById('supplier-details-' + btn.dataset.index);
    if (!row) return;
    row.hidden = !row.hidden; btn.setAttribute('aria-expanded', String(!row.hidden));
  }));
  document.querySelectorAll('.edit-supplier-btn').forEach(btn => btn.addEventListener('click', () => openEditSupplierModal(Number(btn.dataset.index))));
  document.querySelectorAll('.supplier-history-btn').forEach(btn => btn.addEventListener('click', () => openSupplierDebtHistory(state.suppliers[Number(btn.dataset.index)])));
  document.querySelectorAll('.delete-supplier-btn').forEach(btn => btn.addEventListener('click', () => handleDeleteSupplier(btn.dataset.supplierId, btn)));
  safeCreateIcons();
}

export function populateSupplierDatalist() {
  const datalist = document.getElementById('payment-recipient-list');
  if (!datalist) return;

  datalist.innerHTML = state.suppliers.map(s => {
    return `<option value="${escapeSupplierHtml(s.name)} — ${escapeSupplierHtml(s.code)}" data-supplier-id="${s.id}">${s.phone || 'N/A'}</option>`;
  }).join('');
}

export function setupSupplierManagement() {
  const reportBtn=document.getElementById('btn-open-supplier-debt-report');
  if(reportBtn)reportBtn.onclick=openSupplierPeriodReport;
  const exportBtn = document.getElementById('btn-export-suppliers-excel');
  if (exportBtn) exportBtn.onclick = exportSuppliersExcel;
  const btnOpenAdd = document.getElementById('btn-open-add-supplier-modal');
  const modal = document.getElementById('supplier-modal');
  const form = document.getElementById('supplier-form');
  const btnClose = document.getElementById('btn-close-supplier-modal');
  const btnCancel = document.getElementById('btn-cancel-supplier-modal');
  const searchInput = document.getElementById('supplier-search-input');
  const filterDialog = document.getElementById('supplier-filter-dialog');
  const filterTrigger = document.getElementById('btn-open-supplier-filters');
  filterTrigger?.addEventListener('click', () => { if (!filterDialog.open) filterDialog.showModal(); });
  const closeFilters = () => filterDialog?.close();
  document.getElementById('btn-close-supplier-filters')?.addEventListener('click', closeFilters);
  const applyFilters = () => {
    const error = supplierFilterError(supplierFilters());
    if (error) {
      renderSuppliersTable();
      document.getElementById(error.toLowerCase().includes('ngày') ? 'supplier-date-from' : 'supplier-debt-min')?.focus();
      return;
    }
    closeFilters();
  };
  document.getElementById('btn-apply-supplier-filters')?.addEventListener('click', applyFilters);
  filterDialog?.addEventListener('click', event => {
    if (event.target !== filterDialog) return;
    const rect = filterDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeFilters();
  });
  filterDialog?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); applyFilters(); }
  });


  if (btnOpenAdd && modal) {
    btnOpenAdd.addEventListener('click', () => {
      document.getElementById('supplier-modal-title').innerText = 'Thêm nhà cung cấp';
      form.reset();
      document.getElementById('supplier-id').value = '';
      document.getElementById('supplier-debt').disabled = false;
      
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
        id: id || null,
        code,
        name,
        phone,
        address,
        openingDebt: debt,
        notes
      };

      const saved = await dbSaveSupplier(supplierData);
      if (!saved) return;
      closeModal();
      renderSuppliersTable();
      populateSupplierDatalist();
      showToast(id ? 'Cập nhật nhà cung cấp thành công!' : 'Thêm nhà cung cấp thành công!');
      return;

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

  ['supplier-debt-filter','supplier-date-field','supplier-date-from','supplier-date-to','supplier-sort','supplier-page-size'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => { state.suppliersPage = 1; renderSuppliersTable(); });
  });
  ['supplier-debt-min','supplier-debt-max'].forEach(id => document.getElementById(id)?.addEventListener('input', () => { state.suppliersPage = 1; renderSuppliersTable(); }));
  document.getElementById('btn-clear-supplier-filters')?.addEventListener('click', () => {
    for (const id of ['supplier-search-input','supplier-debt-min','supplier-debt-max','supplier-date-from','supplier-date-to']) document.getElementById(id).value = '';
    document.getElementById('supplier-debt-filter').value = 'all';
    document.getElementById('supplier-date-field').value = 'createdAt';
    document.getElementById('supplier-date-preset').value = 'all';
    document.getElementById('supplier-sort').value = 'debt-desc';
    state.suppliersPage = 1; renderSuppliersTable();
  });
  document.getElementById('supplier-date-preset')?.addEventListener('change', event => {
    if (event.target.value === 'custom') return;
    const range = supplierDateRange(event.target.value);
    document.getElementById('supplier-date-from').value = range.from;
    document.getElementById('supplier-date-to').value = range.to;
    state.suppliersPage = 1; renderSuppliersTable();
  });
  ['supplier-date-from','supplier-date-to'].forEach(id => document.getElementById(id)?.addEventListener('input', () => {
    document.getElementById('supplier-date-preset').value = 'custom'; state.suppliersPage = 1; renderSuppliersTable();
  }));
  document.getElementById('btn-refresh-suppliers')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await ensurePanelCloudData('suppliers-panel', { force: true }); }
    finally { button.disabled = false; }
  });

  // Khởi tạo datalist cho phiếu chi ban đầu
  populateSupplierDatalist();

  // Excel Import for Suppliers
  const openImportBtn = document.getElementById('btn-open-supplier-excel-modal');
  if (openImportBtn) openImportBtn.onclick = openSupplierExcelModal;
  
  const closeImportBtn = document.getElementById('btn-close-supplier-excel-modal');
  if (closeImportBtn) closeImportBtn.onclick = closeSupplierExcelModal;
  
  const cancelImportBtn = document.getElementById('btn-cancel-supplier-excel');
  if (cancelImportBtn) cancelImportBtn.onclick = closeSupplierExcelModal;
  
  const fileInput = document.getElementById('supplier-excel-file-input');
  const browseBtn = document.getElementById('btn-browse-supplier-excel');
  const dropzone = document.getElementById('supplier-excel-dropzone');
  
  if (browseBtn && fileInput) {
    browseBtn.onclick = (e) => {
      e.stopPropagation();
      if (isSelectingFile) return;
      isSelectingFile = true;
      fileInput.click();
    };
  }
  if (dropzone && fileInput) {
    dropzone.onclick = (e) => {
      // Tránh kích hoạt click 2 lần khi nhấp trúng nút browseBtn hoặc bản thân fileInput
      if (e.target === browseBtn || browseBtn.contains(e.target) || e.target === fileInput) {
        return;
      }
      e.stopPropagation();
      if (isSelectingFile) return;
      isSelectingFile = true;
      fileInput.click();
    };
  }
  if (fileInput) {
    fileInput.onclick = (e) => {
      e.stopPropagation();
    };
    
    const resetLock = () => {
      isSelectingFile = false;
    };
    
    fileInput.onchange = (e) => {
      resetLock();
      if (e.target.files.length > 0) {
        handleSupplierExcelFile(e.target.files[0]);
      }
    };
    fileInput.oncancel = resetLock;
  }
  
  if (dropzone) {
    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    };
    dropzone.ondragleave = () => {
      dropzone.classList.remove('dragover');
    };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleSupplierExcelFile(e.dataTransfer.files[0]);
      }
    };
  }
  
  const submitImportBtn = document.getElementById('btn-save-supplier-excel-submit');
  if (submitImportBtn) {
    submitImportBtn.onclick = processSupplierExcelImport;
  }
  
  const downloadTemplateBtn = document.getElementById('btn-download-supplier-excel-template');
  if (downloadTemplateBtn) {
    downloadTemplateBtn.addEventListener('click', downloadSupplierExcelTemplate);
  }
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
  document.getElementById('supplier-debt').disabled = true;
  document.getElementById('supplier-notes').value = s.notes || '';

  modal.classList.add('active');
}

async function handleDeleteSupplier(supplierId, button) {
  const s = state.suppliers.find(supplier => supplier.id === supplierId);
  if (!s || deletingSuppliers.has(supplierId)) return;
  if (toNumber(s.debt) !== 0) {
    showToast('Nhà cung cấp còn số dư công nợ. Hãy đối chiếu và tất toán trước khi xóa.', 'warning');
    return;
  }
  if (!confirm(`Xóa nhà cung cấp "${s.name}" khỏi danh sách? Lịch sử mua hàng và công nợ đã lưu vẫn được giữ.`)) return;
  deletingSuppliers.add(supplierId);
  button.disabled = true;
  try {
    const deactivated = await dbDeleteSupplier(supplierId, 'Xóa khỏi danh sách nhà cung cấp');
    if (!deactivated) return;
    showToast('Đã xóa nhà cung cấp khỏi danh sách.', 'success');
    renderSuppliersTable();
    populateSupplierDatalist();
  } finally {
    deletingSuppliers.delete(supplierId);
    button.disabled = false;
  }
}

// --- Excel Import & Template Helpers for Suppliers ---
let supplierExcelImportData = [];
let isSelectingFile = false;
let supplierExcelFileRequest = 0;

export function downloadSupplierExcelTemplate() {
  const headers = [[
    "Mã nhà cung cấp", "Tên nhà cung cấp", "Email", "Điện thoại", "Địa chỉ"
  ]];
  
  const sampleRows = [
    ['NCC001', 'Công ty Cổ phần ABS JAPAN', 'ctyabs@lendon.com', '0886037878', 'Tiên Kha - Phúc Thịnh - Hà Nội'],
    ['NCC002', 'Công ty TNHH Bao Bì Nam Hải', '', '0904947217', 'Phúc Thuận - Thái Nguyên']
  ];

  const sheetData = headers.concat(sampleRows);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  
  ws['!cols'] = [
    { wch: 20 }, { wch: 40 }, { wch: 25 }, { wch: 15 }, { wch: 45 }
  ];
  
  XLSX.utils.book_append_sheet(wb, ws, "Danh Sach Nha Cung Cap");
  XLSX.writeFile(wb, "Mau_Danh_Sach_Nha_Cung_Cap.xlsx");
  showToast("Đã tải xuống file Excel mẫu nhà cung cấp thành công!");
}

export function openSupplierExcelModal() {
  const modal = document.getElementById('supplier-excel-modal');
  if (modal) {
    modal.classList.add('active');
    
    // Reset UI
    supplierExcelFileRequest++;
    resetSupplierReportPreview();
    supplierExcelImportData = [];
    document.getElementById('supplier-excel-file-input').value = '';
    document.getElementById('supplier-excel-preview-container').style.display = 'none';
    const submitBtn = document.getElementById('btn-save-supplier-excel-submit');
    if (submitBtn) {
      submitBtn.setAttribute('disabled', 'true');
      submitBtn.disabled = true;
    }
    const dropzone = document.getElementById('supplier-excel-dropzone');
    if (dropzone) dropzone.className = 'upload-dropzone';
  }
}

export function closeSupplierExcelModal() {
  const modal = document.getElementById('supplier-excel-modal');
  if (modal) modal.classList.remove('active');
}

function handleSupplierExcelFile(file) {
  if (!file) return;
  const request=++supplierExcelFileRequest;
  resetSupplierReportPreview();
  supplierExcelImportData=[];
  document.getElementById('btn-save-supplier-excel-submit').disabled=true;
  document.getElementById('supplier-excel-preview-container').style.display='none';
  
  const reader = new FileReader();
  reader.onload = function(e) {
    if(request!==supplierExcelFileRequest)return;
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      if (previewSupplierReport(rows,file.name)) return;
      
      if (rows.length === 0) {
        showToast("Tập tin Excel trống!", "danger");
        return;
      }
      
      const headers = rows[0].map(h => (h || '').toString().trim());
      
      // Map columns
      const colMap = {
        code: headers.findIndex(h => h.toLowerCase().includes('mã nhà cung cấp') || h.toLowerCase().includes('ma ncc') || h.toLowerCase() === 'mã' || h.toLowerCase() === 'code'),
        name: headers.findIndex(h => h.toLowerCase().includes('tên nhà cung cấp') || h.toLowerCase().includes('ten ncc') || h.toLowerCase() === 'tên' || h.toLowerCase() === 'name'),
        email: headers.findIndex(h => h.toLowerCase() === 'email' || h.toLowerCase().includes('thư điện tử')),
        phone: headers.findIndex(h => h.toLowerCase().includes('điện thoại') || h.toLowerCase().includes('sđt') || h.toLowerCase().includes('phone') || h.toLowerCase().includes('di động')),
        address: headers.findIndex(h => h.toLowerCase().includes('địa chỉ') || h.toLowerCase().includes('dia chi') || h.toLowerCase() === 'address')
      };
      
      // Fallback map if columns are not matched (try to find by position)
      if (colMap.name === -1) {
        colMap.code = 0;
        colMap.name = 1;
        colMap.email = 2;
        colMap.phone = 3;
        colMap.address = 4;
      }
      
      // Re-verify name column
      if (colMap.name === -1 || !headers[colMap.name]) {
        showToast("Tập tin không có cột tên nhà cung cấp hợp lệ!", "danger");
        return;
      }
      
      supplierExcelImportData = [];
      const previewRows = [];
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        
        let name = colMap.name !== -1 && row[colMap.name] ? row[colMap.name].toString().trim() : '';
        if (!name) continue; // skip rows without name
        
        let code = colMap.code !== -1 && row[colMap.code] ? row[colMap.code].toString().trim() : '';
        let email = colMap.email !== -1 && row[colMap.email] ? row[colMap.email].toString().trim() : '';
        let phone = colMap.phone !== -1 && row[colMap.phone] ? row[colMap.phone].toString().trim() : '';
        let address = colMap.address !== -1 && row[colMap.address] ? row[colMap.address].toString().trim() : '';
        
        // Auto-generate code if empty
        if (!code) {
          const nextNum = state.suppliers.length + supplierExcelImportData.length + 1;
          code = 'NCC' + String(nextNum).padStart(3, '0');
        }
        
        // Build notes: if email exists, save email to notes
        let notesList = [];
        if (email) notesList.push(`Email: ${email}`);
        notesList.push('Imported from Excel');
        const notes = notesList.join(' | ');
        
        const supplierObj = {
          id: 'supplier-' + Date.now() + '-' + i + '-' + Math.floor(Math.random() * 1000),
          code: code,
          name: name,
          phone: phone,
          address: address,
          debt: 0,
          notes: notes
        };
        
        supplierExcelImportData.push(supplierObj);
        if (previewRows.length < 5) {
          previewRows.push({ ...supplierObj, email: email });
        }
      }
      
      if (supplierExcelImportData.length === 0) {
        showToast("Không tìm thấy dòng dữ liệu hợp lệ trong file!", "warning");
        return;
      }
      
      // Render bảng preview
      const previewBody = document.getElementById('supplier-excel-preview-table-body');
      if (previewBody) {
        previewBody.innerHTML = previewRows.map((s, idx) => `
          <tr>
            <td style="text-align: center;">${idx + 1}</td>
            <td style="font-weight: 600; color: #fff;">${s.code}</td>
            <td style="font-weight: bold; color: #22c55e;">${s.name}</td>
            <td>${s.email || '<span style="color: var(--text-muted);">-</span>'}</td>
            <td>${s.phone || '<span style="color: var(--text-muted);">-</span>'}</td>
            <td>${s.address || '<span style="color: var(--text-muted);">-</span>'}</td>
          </tr>
        `).join('');
      }
      
      const summaryEl = document.getElementById('supplier-excel-preview-summary');
      if (summaryEl) {
        summaryEl.innerText = `Hiển thị 5 trên tổng số ${supplierExcelImportData.length} nhà cung cấp đọc được từ tệp.`;
      }
      
      const container = document.getElementById('supplier-excel-preview-container');
      if (container) container.style.display = 'block';
      
      const submitBtn = document.getElementById('btn-save-supplier-excel-submit');
      if (submitBtn) {
        submitBtn.removeAttribute('disabled');
        submitBtn.disabled = false;
      }
      
      const dropzone = document.getElementById('supplier-excel-dropzone');
      if (dropzone) dropzone.className = 'upload-dropzone success-uploaded';
      
      showToast(`Đọc tệp thành công! Tìm thấy ${supplierExcelImportData.length} nhà cung cấp.`, "success");
    } catch(err) {
      console.error(err);
      showToast("Lỗi đọc tệp Excel: " + err.message, "danger");
    } finally {
      const el = document.getElementById('supplier-excel-file-input');
      if (el) el.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processSupplierExcelImport() {
  if (await processSupplierReportImport(async () => {
    await ensurePanelCloudData('goods-panel',{force:true,domains:['suppliers','purchases']});
    closeSupplierExcelModal(); renderSuppliersTable(); populateSupplierDatalist();
  })) return;
  if (supplierExcelImportData.length === 0) return;
  
  const modeVal = document.querySelector('input[name="supplier-import-mode"]:checked');
  const mode = modeVal ? modeVal.value : 'merge';
  if (mode === 'overwrite') {
    showToast('Không hỗ trợ ghi đè/xóa hàng loạt nhà cung cấp. Hãy dùng chế độ gộp.', 'warning');
    return;
  }
  
  try {
    const authoritativeResult = await dbSaveSuppliersBulk(supplierExcelImportData);
    if (!authoritativeResult) return;
    closeSupplierExcelModal();
    renderSuppliersTable();
    populateSupplierDatalist();
    renderAll();
    showToast(`Đã nhập thành công ${authoritativeResult.saved} nhà cung cấp!`, 'success');
    return;
    showToast("Đang lưu nhà cung cấp vào hệ thống...", "info");
    
    if (mode === 'overwrite') {
      if (confirm("Chế độ ghi đè sẽ xóa toàn bộ nhà cung cấp hiện tại. Bạn chắc chắn muốn tiếp tục?")) {
        // Clear all suppliers first
        // delete from cloud
        for (const s of state.suppliers) {
          await dbDeleteSupplier(s.id);
        }
        state.suppliers = [];
      } else {
        return;
      }
    }
    
    for (const s of supplierExcelImportData) {
      // Check duplicate code if merging
      if (mode === 'merge') {
        const dupIdx = state.suppliers.findIndex(os => os.code.toLowerCase() === s.code.toLowerCase());
        if (dupIdx > -1) {
          // Update existing keeping old ID and debt
          s.id = state.suppliers[dupIdx].id;
          s.debt = state.suppliers[dupIdx].debt;
          
          // merge notes if needed
          if (state.suppliers[dupIdx].notes && !s.notes.includes(state.suppliers[dupIdx].notes)) {
            s.notes = state.suppliers[dupIdx].notes + ' | ' + s.notes;
          }
          
          state.suppliers[dupIdx] = s;
        } else {
          state.suppliers.push(s);
        }
      } else {
        // overwrite mode: just push
        state.suppliers.push(s);
      }
    }
    
    // Save suppliers to cloud in one batch
    const bulkSaved = await dbSaveSuppliersBulk(supplierExcelImportData);
    if (!bulkSaved) return;
    
    closeSupplierExcelModal();
    
    renderSuppliersTable();
    populateSupplierDatalist();
    renderAll();
    
    showToast(`Đã nhập thành công ${supplierExcelImportData.length} nhà cung cấp!`, "success");
  } catch (err) {
    console.error(err);
    showToast("Lỗi khi nhập danh sách nhà cung cấp: " + err.message, "danger");
  }
}
