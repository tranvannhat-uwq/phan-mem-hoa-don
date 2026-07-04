import { state } from '../state.js';
import { showToast, formatCurrency, formatNumber, formatPhoneNumber, safeCreateIcons, formatDateTime, getColorPercentFromCode } from '../utils.js';
import { dbSaveOrder, dbSaveCustomer, dbDeleteOrder } from '../services/supabase.js';
import { renderAll, switchTab } from '../main.js';
import { populatePricelistsDropdowns } from './pricelists.js';

let currentOrderToPrint = null;

export function getActiveInvoiceDiscount(brand) {
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (!plSelect) return 0;
  const plVal = plSelect.value;
  
  if (plVal === 'retail') {
    return 0; // manual
  }
  
  if (plVal === 'custom') {
    if (state.activeCustomerId) {
      const customer = state.customers.find(c => c.id === state.activeCustomerId);
      if (customer && customer.brandDiscounts) {
        return customer.brandDiscounts[brand] !== undefined ? customer.brandDiscounts[brand] : 0;
      }
    }
    return 0;
  }
  
  const pl = state.pricelists.find(p => p.id === plVal);
  if (pl && pl.brandDiscounts) {
    return pl.brandDiscounts[brand] !== undefined ? pl.brandDiscounts[brand] : 0;
  }
  
  return 0;
}

export function applyActivePriceListToInvoice() {
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (!plSelect) return;
  const plVal = plSelect.value;
  
  if (plVal === 'custom' && !state.activeCustomerId) {
    showToast('Vui lòng chọn khách hàng để dùng chiết khấu riêng!', 'warning');
    plSelect.value = '';
    applyActivePriceListToInvoice();
    return;
  }
  
  state.invoiceItems.forEach(item => {
    item.discountPercent = getActiveInvoiceDiscount(item.brand);
  });
  
  const label = document.getElementById('invoice-pricelist-source-lbl');
  if (label) {
    if (plVal === '') {
      label.innerText = 'Chưa chọn';
      label.style.background = 'rgba(156, 163, 175, 0.1)';
      label.style.color = '#9ca3af';
    } else if (plVal === 'retail') {
      label.innerText = 'Nhập tay';
      label.style.background = 'rgba(16, 185, 129, 0.1)';
      label.style.color = '#10b981';
    } else if (plVal === 'custom') {
      label.innerText = 'CK Đại lý';
      label.style.background = 'rgba(59, 130, 246, 0.1)';
      label.style.color = '#60a5fa';
    } else {
      const pl = state.pricelists.find(p => p.id === plVal);
      label.innerText = pl ? pl.name : 'Bảng giá';
      label.style.background = 'rgba(245, 158, 11, 0.1)';
      label.style.color = '#f59e0b';
    }
  }
  
  renderInvoiceTable();
}

export function renderInvoiceTable() {
  const tableBody = document.getElementById('invoice-items-body');
  if (!tableBody) return;
  
  if (state.invoiceItems.length === 0) {
    tableBody.innerHTML = `
      <tr id="invoice-empty-row">
        <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Chưa chọn sản phẩm nào. Tìm kiếm sản phẩm ở trên để thêm vào hóa đơn.
        </td>
      </tr>
    `;
    calculateInvoiceTotals();
    return;
  }
  
  // Read readonly mode
  const saveBtn = document.getElementById('btn-save-order');
  const isReadOnly = saveBtn && saveBtn.style.display === 'none';

  tableBody.innerHTML = state.invoiceItems.map((item, index) => {
    const p = item.product;
    
    // Tạo dropdown quy cách đóng gói dựa trên giá tiền cấu hình (> 0)
    const activePackages = [];
    if (p.priceThung > 0) activePackages.push({ value: 'Thung', label: `Thùng (${formatCurrency(p.priceThung)})` });
    if (p.priceLon > 0) activePackages.push({ value: 'Lon', label: `Lon (${formatCurrency(p.priceLon)})` });
    if (p.priceHop > 0) activePackages.push({ value: 'Hop', label: `Hộp (${formatCurrency(p.priceHop)})` });
    if (p.priceBao > 0) activePackages.push({ value: 'Bao', label: `Bao (${formatCurrency(p.priceBao)})` });
    if (p.priceTui > 0) activePackages.push({ value: 'Tui', label: `Túi (${formatCurrency(p.priceTui)})` });
    
    // Trường hợp sản phẩm không có quy cách nào thiết lập giá (>0), mặc định dùng Thùng
    if (activePackages.length === 0) {
      activePackages.push({ value: 'Thung', label: 'Thùng (0 ₫)' });
    }

    const packageOptions = activePackages.map(opt => `
      <option value="${opt.value}" ${item.package === opt.value ? 'selected' : ''}>${opt.label}</option>
    `).join('');

    const subTotal = item.quantity * item.price * (1 - item.discountPercent / 100);
    
    const disabledAttr = isReadOnly ? 'disabled' : '';

    // Kiểm tra sản phẩm sơn lót hoặc bột bả
    const nameLower = p.name.toLowerCase();
    const isPrimerOrPutty = nameLower.includes('lót') || nameLower.includes('bả');
    if (isPrimerOrPutty) {
      item.colorCode = '';
      item.colorPercent = 0;
    }

    return `
      <tr class="invoice-item-row" data-index="${index}">
        <td style="font-weight: 600; color: #fff;">${p.code}</td>
        <td>
          <div class="flex flex-col gap-1">
            <span style="font-weight: 500; font-size: 0.85rem;">${p.name}</span>
            <div class="flex gap-2 items-center" style="margin-top: 2px;">
              <span class="suggestion-brand-badge" style="font-size: 0.65rem; padding: 1px 6px; border-radius: 4px; background: rgba(59, 130, 246, 0.12); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.25);">${item.brand}</span>
            </div>
          </div>
        </td>
        <td style="text-align: center; position: relative;">
          <input type="text" class="form-control-inline item-color-code" value="${isPrimerOrPutty ? '' : item.colorCode}" placeholder="${isPrimerOrPutty ? 'Không dùng' : 'Nhập mã'}" style="width: 100%; text-align: center;" ${isReadOnly || isPrimerOrPutty ? 'disabled' : ''}>
          <div style="position: absolute; bottom: 2px; left: 0; right: 0; font-size: 0.65rem; color: var(--text-muted); font-weight: 600; text-align: center; line-height: 1; pointer-events: none;">
            ${isPrimerOrPutty ? '<span style="color: var(--text-muted); font-weight: normal;">N/A</span>' : `+<span class="item-color-percent-lbl" style="color: var(--color-primary); font-weight: 700;">${item.colorPercent}</span>% màu`}
          </div>
        </td>
        <td>
          <select class="form-control-inline item-package-select" style="width: 100%; font-size: 0.8rem;" ${disabledAttr}>
            ${packageOptions}
          </select>
        </td>
        <td style="text-align: center;">
          <input type="number" class="form-control-inline item-quantity" value="${item.quantity}" min="1" style="width: 55px; text-align: center; font-weight: 600;" ${disabledAttr}>
        </td>
        <td style="text-align: center;">
          <input type="number" class="form-control-inline item-discount" value="${item.discountPercent}" min="0" max="100" step="any" style="width: 55px; text-align: center;" ${disabledAttr}>
        </td>
        <td>
          <input type="text" class="form-control-inline item-notes" value="${item.notes}" placeholder="VD: Màu pha đậm..." style="width: 100%; font-size: 0.75rem;" ${disabledAttr}>
        </td>
        <td style="text-align: right; font-weight: 600; color: #fff; font-size: 0.9rem;">
          ${formatCurrency(subTotal)}
        </td>
        <td style="text-align: center;">
          <button class="btn btn-danger btn-xs btn-circle btn-remove-invoice-item" data-index="${index}" title="Xóa dòng" ${disabledAttr}>
            <i data-lucide="x" style="width: 12px; height: 12px;"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
  
  // Trình hỗ trợ cập nhật cục bộ Thành tiền của dòng để tránh vẽ lại toàn bộ bảng (gây mất focus và mất sự kiện click chốt đơn)
  const updateRowSubtotal = (row, idx) => {
    const item = state.invoiceItems[idx];
    const subTotal = Math.round(item.quantity * item.price * (1 - item.discountPercent / 100));
    // Cột Thành tiền là cột thứ 8 (chỉ số index là 7)
    if (row && row.cells && row.cells[7]) {
      row.cells[7].innerText = formatCurrency(subTotal);
    }
  };

  // Gán sự kiện cho các ô nhập liệu trong bảng
  document.querySelectorAll('.item-color-code').forEach(input => {
    input.addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      const colorCode = e.target.value.trim().toUpperCase();
      state.invoiceItems[idx].colorCode = colorCode;
      
      const colorPct = getColorPercentFromCode(colorCode);
      state.invoiceItems[idx].colorPercent = colorPct;
      
      // Cập nhật nhãn màu cộng thêm trên dòng
      const pctLbl = row.querySelector('.item-color-percent-lbl');
      if (pctLbl) pctLbl.innerText = colorPct;
      
      // Tính lại đơn giá có bao gồm tiền màu cộng thêm
      recalculateItemPriceWithColorMarkup(idx);
      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-package-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      const pkg = e.target.value;
      state.invoiceItems[idx].package = pkg;
      
      recalculateItemPriceWithColorMarkup(idx);
      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-quantity').forEach(input => {
    input.addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      let qty = parseInt(e.target.value);
      if (isNaN(qty) || qty < 1) qty = 1;
      e.target.value = qty; // Cập nhật lại giá trị hiển thị trên ô nhập
      state.invoiceItems[idx].quantity = qty;
      
      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-discount').forEach(input => {
    input.addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      let disc = parseFloat(e.target.value);
      if (isNaN(disc) || disc < 0) disc = 0;
      if (disc > 100) disc = 100;
      e.target.value = disc; // Cập nhật lại giá trị hiển thị trên ô nhập
      state.invoiceItems[idx].discountPercent = disc;
      
      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-notes').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.closest('tr').getAttribute('data-index'));
      state.invoiceItems[idx].notes = e.target.value;
    });
  });

  document.querySelectorAll('.btn-remove-invoice-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(btn.getAttribute('data-index'));
      state.invoiceItems.splice(idx, 1);
      renderInvoiceTable();
    });
  });

  calculateInvoiceTotals();
  safeCreateIcons();
}

function recalculateItemPriceWithColorMarkup(index) {
  const item = state.invoiceItems[index];
  const p = item.product;
  
  // Lấy đơn giá gốc theo quy cách đóng gói được chọn
  let basePrice = 0;
  if (item.package === 'Thung') basePrice = p.priceThung || p.price || 0;
  else if (item.package === 'Lon') basePrice = p.priceLon || 0;
  else if (item.package === 'Hop') basePrice = p.priceHop || 0;
  else if (item.package === 'Bao') basePrice = p.priceBao || 0;
  else if (item.package === 'Tui') basePrice = p.priceTui || 0;
  
  // Cộng thêm phần trăm tiền màu nếu có và làm tròn số nguyên cho công nợ/tiền hàng chuẩn VND
  const markupMultiplier = 1 + (item.colorPercent / 100);
  item.price = Math.round(basePrice * markupMultiplier);
}

export function calculateInvoiceTotals() {
  let totalQty = 0;
  let totalMarket = 0;
  let totalPayable = 0;
  
  state.invoiceItems.forEach(item => {
    const originalPrice = item.price; 
    const qty = item.quantity;
    const disc = item.discountPercent;
    
    // Làm tròn các giá trị tiền tệ về số nguyên VND
    const originalSubtotal = Math.round(qty * originalPrice);
    const discountedSubtotal = Math.round(originalSubtotal * (1 - disc / 100));
    
    totalQty += qty;
    totalMarket += originalSubtotal;
    totalPayable += discountedSubtotal;
  });
  
  const totalDiscount = Math.round(totalMarket - totalPayable);
  
  // Tính chiết khấu hỗ trợ vận chuyển (3%) nếu khách hàng có hoặc checkbox bật
  let shippingDiscount = 0;
  const shipCheck = document.getElementById('invoice-shipping-support');
  const isShippingActive = shipCheck ? shipCheck.checked : false;
  
  if (isShippingActive && totalPayable > 0) {
    shippingDiscount = Math.round(totalPayable * 0.03);
    totalPayable -= shippingDiscount;
  }

  // Cập nhật lên UI với đúng ID trong index.html
  const qtyEl = document.getElementById('summary-total-qty');
  const marketEl = document.getElementById('summary-market-total');
  const discountEl = document.getElementById('summary-discount-total');
  const shippingRow = document.getElementById('summary-shipping-discount-row');
  const shippingValEl = document.getElementById('summary-shipping-discount-total');
  const payableEl = document.getElementById('summary-final-total');
  const savingBadge = document.getElementById('summary-saving-badge');
  const crossedMarket = document.getElementById('summary-final-market-crossed');

  if (qtyEl) qtyEl.innerText = totalQty;
  if (marketEl) marketEl.innerText = formatCurrency(totalMarket);
  if (discountEl) discountEl.innerText = `-${formatCurrency(totalDiscount)}`;
  if (payableEl) payableEl.innerText = formatCurrency(totalPayable);
  
  if (shippingRow && shippingValEl) {
    if (shippingDiscount > 0) {
      shippingRow.style.display = 'flex';
      shippingValEl.innerText = `-${formatCurrency(shippingDiscount)}`;
    } else {
      shippingRow.style.display = 'none';
    }
  }

  const totalCombinedDiscount = totalDiscount + shippingDiscount;
  if (savingBadge && crossedMarket) {
    if (totalMarket > 0 && totalCombinedDiscount > 0) {
      const savingPercent = ((totalCombinedDiscount / totalMarket) * 100).toFixed(0);
      savingBadge.innerText = `Tiết kiệm được ${savingPercent}%`;
      savingBadge.style.display = 'inline-block';
      
      crossedMarket.innerText = formatCurrency(totalMarket);
      crossedMarket.style.display = 'inline';
    } else {
      savingBadge.style.display = 'none';
      crossedMarket.style.display = 'none';
    }
  }
}

export async function addProductToInvoice() {
  const searchInput = document.getElementById('invoice-product-search');
  const codeVal = searchInput.value.trim().toUpperCase();
  const brandVal = searchInput.getAttribute('data-selected-brand');
  
  if (!codeVal) return;
  
  // Tìm kiếm sản phẩm
  let product = null;
  if (brandVal) {
    product = state.products.find(p => p.code === codeVal && p.brand === brandVal);
  } else {
    product = state.products.find(p => p.code === codeVal);
  }
  
  if (!product) {
    showToast(`Không tìm thấy sản phẩm với mã "${codeVal}"!`, 'danger');
    return;
  }
  
  // Xác định quy cách đóng gói mặc định (cái đầu tiên có giá > 0)
  let defaultPackage = 'Thung';
  if (product.priceThung > 0) defaultPackage = 'Thung';
  else if (product.priceLon > 0) defaultPackage = 'Lon';
  else if (product.priceHop > 0) defaultPackage = 'Hop';
  else if (product.priceBao > 0) defaultPackage = 'Bao';
  else if (product.priceTui > 0) defaultPackage = 'Tui';

  // Lấy đơn giá gốc
  let price = product.priceThung || product.price || 0;
  if (defaultPackage === 'Lon') price = product.priceLon || 0;
  else if (defaultPackage === 'Hop') price = product.priceHop || 0;
  else if (defaultPackage === 'Bao') price = product.priceBao || 0;
  else if (defaultPackage === 'Tui') price = product.priceTui || 0;

  // Lấy tỷ lệ chiết khấu hãng sơn theo bảng giá đã chọn
  const discountPercent = getActiveInvoiceDiscount(product.brand);

  const item = {
    product,
    brand: product.brand || 'Nano10*',
    package: defaultPackage,
    colorCode: '',
    colorPercent: 0,
    quantity: 1,
    discountPercent,
    price,
    notes: ''
  };

  // Luôn thêm sản phẩm thành dòng mới độc lập, không cộng dồn
  state.invoiceItems.push(item);
  showToast(`Đã thêm ${product.name} vào hóa đơn.`);

  // Clear ô tìm kiếm
  searchInput.value = '';
  searchInput.removeAttribute('data-selected-brand');
  
  renderInvoiceTable();
  searchInput.focus();
}

export function compileActiveOrder() {
  if (state.invoiceItems.length === 0) {
    showToast('Vui lòng chọn ít nhất một sản phẩm vào hóa đơn!', 'danger');
    return null;
  }
  
  let customerName = 'Khách hàng vãng lai';
  let phone = 'N/A';
  let address = 'N/A';
  let custId = null;
  
  if (state.isQuickCustomerMode) {
    const qName = document.getElementById('quick-cust-name').value.trim();
    if (!qName) {
      showToast('Vui lòng nhập tên khách hàng mới!', 'danger');
      return null;
    }
    customerName = qName;
    phone = document.getElementById('quick-cust-phone').value.trim() || 'N/A';
    address = document.getElementById('quick-cust-address').value.trim() || 'N/A';
    custId = state.activeCustomerId || null;
  } else if (state.activeCustomerId) {
    const cust = state.customers.find(c => c.id === state.activeCustomerId);
    if (cust) {
      custId = cust.id;
      customerName = cust.name;
      phone = cust.phone || 'N/A';
      address = cust.address || 'N/A';
    }
  } else {
    const searchInput = document.getElementById('invoice-customer-search');
    if (searchInput && searchInput.value.trim() !== '') {
      customerName = searchInput.value.trim();
    } else {
      showToast('Vui lòng chọn khách hàng hoặc nhập thông tin chế độ "Khách lẻ" trước khi chốt đơn!', 'danger');
      return null;
    }
  }

  // Tính các con số và làm tròn số nguyên VND để lưu trữ và hiển thị sạch sẽ
  let totalMarket = 0;
  let totalPayable = 0;
  state.invoiceItems.forEach(item => {
    const originalSubtotal = Math.round(item.quantity * item.price);
    const discountedSubtotal = Math.round(originalSubtotal * (1 - item.discountPercent / 100));
    totalMarket += originalSubtotal;
    totalPayable += discountedSubtotal;
  });
  
  const totalDiscount = Math.round(totalMarket - totalPayable);
  
  let shippingSupport = false;
  let shippingDiscount = 0;
  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck && shipCheck.checked && totalPayable > 0) {
    shippingSupport = true;
    shippingDiscount = Math.round(totalPayable * 0.03);
    totalPayable -= shippingDiscount;
  }

  const plSelect = document.getElementById('invoice-pricelist-select');
  const pricelistId = plSelect ? plSelect.value : 'retail';

  // Lấy ID đơn hàng đang chỉnh sửa (nếu là sửa đơn nháp)
  const saveBtn = document.getElementById('btn-save-order');
  const editOrderId = saveBtn ? saveBtn.getAttribute('data-edit-order-id') : null;
  
  const orderId = editOrderId || `HD-${Date.now().toString().slice(-6)}`;
  const orderDate = new Date().toISOString();

  // Đóng gói các dòng hoá đơn để lưu (giản lược đối tượng tránh đệ quy sâu)
  const itemsToSave = state.invoiceItems.map(item => ({
    brand: item.brand,
    productCode: item.product.code,
    productName: item.product.name,
    package: item.package,
    colorCode: item.colorCode || '',
    colorPercent: item.colorPercent || 0,
    quantity: item.quantity,
    discountPercent: item.discountPercent,
    price: item.price,
    notes: item.notes || ''
  }));

  const order = {
    id: orderId,
    customerId: custId,
    customerName,
    notes: document.getElementById('invoice-notes').value.trim(),
    items: itemsToSave,
    date: orderDate,
    totalMarket,
    totalDiscount,
    shippingSupport,
    shippingDiscount,
    totalPayable,
    pricelistId,
    createdBy: state.currentUser ? state.currentUser.username : 'admin'
  };

  return order;
}

export async function saveActiveOrder(status = 'settled') {
  let customerId = state.activeCustomerId || null;
  
  // Xử lý tạo nhanh khách hàng mới nếu ở chế độ thêm nhanh
  if (state.isQuickCustomerMode) {
    const qName = document.getElementById('quick-cust-name').value.trim();
    if (!qName) {
      showToast('Vui lòng nhập tên khách hàng mới!', 'danger');
      return null;
    }
    
    let nextNum = 1;
    if (state.customers.length > 0) {
      const nums = state.customers.map(c => {
        const match = c.code.match(/\d+/);
        return match ? parseInt(match[0]) : 0;
      }).filter(Boolean);
      if (nums.length > 0) {
        nextNum = Math.max(...nums) + 1;
      }
    }
    const qCode = `KH-${nextNum.toString().padStart(3, '0')}`;
    const qPhone = document.getElementById('quick-cust-phone').value.trim();
    const qAddress = document.getElementById('quick-cust-address').value.trim();
    const qAssignedBrand = document.getElementById('quick-cust-assigned-brand').value;
    
    if (!qAssignedBrand) {
      showToast('Vui lòng chọn nhãn đại lý độc quyền!', 'warning');
      return null;
    }
    
    const qShippingSupport = document.getElementById('quick-cust-shipping-support').checked;
    
    const plSelect = document.getElementById('invoice-pricelist-select');
    const qPricelistId = plSelect && plSelect.value ? plSelect.value : 'custom';
    
    const newCustId = `cust-${Date.now()}`;
    const newCustomer = {
      id: newCustId,
      code: qCode,
      name: qName,
      phone: qPhone,
      address: qAddress,
      assignedBrand: qAssignedBrand,
      brandDiscounts: {},
      shippingSupport: qShippingSupport,
      debt: 0,
      totalTransaction: 0,
      notes: 'Thêm nhanh từ màn hình lên đơn',
      pricelistId: qPricelistId,
      managedBy: state.currentUser ? state.currentUser.username : 'nhat'
    };
    
    const custSaved = await dbSaveCustomer(newCustomer);
    if (!custSaved) {
      showToast('Không thể tạo thông tin khách hàng mới. Vui lòng thử lại!', 'danger');
      return null;
    }
    state.activeCustomerId = newCustId;
    customerId = newCustId;
    
    state.customers.push(newCustomer);
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  }

  const order = compileActiveOrder();
  if (!order) return null;
  
  if (status === 'settled' && state.currentUser && state.currentUser.role === 'sale') {
    showToast('Nhân viên kinh doanh không có quyền thực hiện thanh toán!', 'danger');
    return null;
  }
  
  order.status = status;

  // Lấy ID đơn sửa nếu có
  const saveBtn = document.getElementById('btn-save-order');
  const editOrderId = saveBtn ? saveBtn.getAttribute('data-edit-order-id') : null;

  showToast('Đang lưu hóa đơn...', 'info');

  // Nếu là đơn sửa, kiểm tra trạng thái cũ để chuyển bảng nếu cần
  if (editOrderId) {
    const oldOrder = state.savedOrders.find(o => o.id === editOrderId);
    const oldStatus = oldOrder ? oldOrder.status : null;
    
    state.savedOrders = state.savedOrders.filter(o => o.id !== editOrderId);

    // Nếu đơn cũ là nháp và đơn mới là chốt chính thức, cần xóa bản ghi cũ ở bảng draft_orders
    if (oldStatus === 'draft' && status === 'settled') {
      await dbDeleteOrder(editOrderId, 'draft');
    }
  }

  const saved = await dbSaveOrder(order);
  if (saved) {
    if (status === 'draft') {
      showToast(`Đã lưu đơn nháp ${order.id} thành công!`);
    } else {
      showToast(`Đã thanh toán và lưu đơn hàng ${order.id} thành công!`);
      
      // Cập nhật công nợ và tổng giao dịch nếu chốt đơn (settled) và có khách hàng liên kết (làm tròn số nguyên)
      if (order.customerId) {
        const cust = state.customers.find(c => c.id === order.customerId);
        if (cust) {
          cust.debt = Math.round((cust.debt || 0) + order.totalPayable);
          cust.totalTransaction = Math.round((cust.totalTransaction || 0) + order.totalPayable);
          
          // Ghi nhận biến động công nợ do mua hàng
          if (!cust.debtHistory) cust.debtHistory = [];
          cust.debtHistory.push({
            id: order.id,
            date: order.date,
            type: 'charge',
            amount: order.totalPayable,
            notes: `Mua hàng (Hóa đơn ${order.id})`,
            debtAfter: cust.debt
          });
          
          await dbSaveCustomer(cust);
        }
      }
    }
    
    // Lưu local
    state.savedOrders.unshift(order);
    localStorage.setItem('billing_system_orders', JSON.stringify(state.savedOrders));

    resetInvoiceBuilder();
    renderAll();
    
    return order;
  }
  return null;
}

export function resetInvoiceCustomer() {
  state.activeCustomerId = '';
  state.activeCustomerBrand = 'Tất cả';
  
  const idInput = document.getElementById('invoice-customer-id');
  if (idInput) idInput.value = '';
  
  const searchInput = document.getElementById('invoice-customer-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.removeAttribute('disabled');
  }
  
  // Khôi phục ô ghi chú hóa đơn
  const notesInput = document.getElementById('invoice-notes');
  if (notesInput) notesInput.value = '';
  
  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) infoCard.style.display = 'none';
  
  const clearCustBtn = document.getElementById('btn-clear-invoice-customer');
  if (clearCustBtn) clearCustBtn.style.display = 'none';
  
  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck) shipCheck.checked = false;
  
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    plSelect.value = '';
    plSelect.disabled = false;
  }
  
  const plGroup = document.getElementById('invoice-pricelist-group');
  if (plGroup) plGroup.style.display = 'block';
  
  applyActivePriceListToInvoice();
}

export function resetInvoiceBuilder() {
  state.invoiceItems = [];
  document.getElementById('invoice-notes').value = '';
  document.getElementById('invoice-product-search').value = '';
  
  // Khôi phục nút và tiêu đề panel về trạng thái Tạo hóa đơn mới
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const panelTitle = document.querySelector('#invoice-panel .panel-title');
  
  if (saveBtn) {
    saveBtn.style.display = 'inline-flex';
    saveBtn.innerHTML = `<i data-lucide="check-square"></i> Thanh toán & Chốt đơn`;
    saveBtn.removeAttribute('data-edit-order-id');
  }
  if (draftBtn) {
    draftBtn.style.display = 'inline-flex';
    draftBtn.innerHTML = `<i data-lucide="file-text"></i> Lưu đơn nháp`;
  }
  if (panelTitle) panelTitle.innerHTML = `<i data-lucide="shopping-bag"></i> Chọn sản phẩm vào hóa đơn`;

  if (state.isQuickCustomerMode) {
    disableQuickCustomerMode();
  } else {
    resetInvoiceCustomer();
  }
  renderInvoiceTable();
}

export function enableQuickCustomerMode() {
  state.isQuickCustomerMode = true;
  
  // Hide search and show quick add fields
  const searchGroup = document.getElementById('invoice-customer-search-group');
  if (searchGroup) searchGroup.style.display = 'none';
  
  const toggleContainer = document.getElementById('invoice-quick-customer-toggle-container');
  if (toggleContainer) toggleContainer.style.display = 'none';
  
  const quickFields = document.getElementById('invoice-quick-customer-fields');
  if (quickFields) {
    quickFields.style.display = 'flex';
    // Pre-fill name with whatever is in search input
    const searchInput = document.getElementById('invoice-customer-search');
    const quickNameInput = document.getElementById('quick-cust-name');
    if (searchInput && quickNameInput) {
      quickNameInput.value = searchInput.value.trim();
    }
  }
  
  // Hide info card
  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) infoCard.style.display = 'none';
  
  // Update state active customer to represent quick customer
  state.activeCustomerId = '';
  const quickBrandSelect = document.getElementById('quick-cust-assigned-brand');
  state.activeCustomerBrand = quickBrandSelect ? quickBrandSelect.value : 'Tất cả';
  
  // Reset invoice item discounts to 0 since new customer has no predefined discounts
  state.invoiceItems.forEach(item => {
    item.discountPercent = 0;
  });
  
  // Move the price list selector inside quick customer fields (above the shipping support container)
  const plGroup = document.getElementById('invoice-pricelist-group');
  const shipContainer = document.getElementById('quick-cust-shipping-support-container');
  if (plGroup && quickFields && shipContainer) {
    quickFields.insertBefore(plGroup, shipContainer);
  }
  
  renderInvoiceTable();
}

export function disableQuickCustomerMode() {
  state.isQuickCustomerMode = false;
  
  // Show search and hide quick add fields
  const searchGroup = document.getElementById('invoice-customer-search-group');
  if (searchGroup) searchGroup.style.display = 'block';
  
  const toggleContainer = document.getElementById('invoice-quick-customer-toggle-container');
  if (toggleContainer) toggleContainer.style.display = 'block';
  
  const quickFields = document.getElementById('invoice-quick-customer-fields');
  if (quickFields) quickFields.style.display = 'none';
  
  // Clear inputs
  const qName = document.getElementById('quick-cust-name');
  if (qName) qName.value = '';
  const qPhone = document.getElementById('quick-cust-phone');
  if (qPhone) qPhone.value = '';
  const qAddr = document.getElementById('quick-cust-address');
  if (qAddr) qAddr.value = '';
  const qBrand = document.getElementById('quick-cust-assigned-brand');
  if (qBrand) qBrand.value = 'Tất cả';
  const qShip = document.getElementById('quick-cust-shipping-support');
  if (qShip) qShip.checked = false;
  
  // Restore the price list selector back to the placeholder
  const placeholder = document.getElementById('invoice-pricelist-placeholder');
  const plGroup = document.getElementById('invoice-pricelist-group');
  if (placeholder && plGroup) {
    placeholder.appendChild(plGroup);
  }
  
  resetInvoiceCustomer();
}

export function handleQuickCustomerBrandChange(newBrand) {
  if (newBrand && newBrand !== 'Tất cả') {
    const invalidItems = state.invoiceItems.filter(item => item.brand !== newBrand);
    if (invalidItems.length > 0) {
      const ok = confirm(`Khách hàng mới này được chỉ định nhãn sơn "${newBrand}". Chọn nhãn này sẽ loại bỏ ${invalidItems.length} sản phẩm khác nhãn sơn hiện có trong đơn hàng. Bạn có đồng ý không?`);
      if (!ok) {
        const quickBrandSelect = document.getElementById('quick-cust-assigned-brand');
        if (quickBrandSelect) quickBrandSelect.value = state.activeCustomerBrand;
        return;
      } else {
        state.invoiceItems = state.invoiceItems.filter(item => item.brand === newBrand);
      }
    }
  }
  state.activeCustomerBrand = newBrand;
  
  // For quick customer, they have no preset brandDiscounts, so brand discounts default to 0.
  state.invoiceItems.forEach(item => {
    item.discountPercent = 0;
  });
  
  renderInvoiceTable();
}

export async function renderAndPrintOrder(order, type = 'retail') {
  // Cập nhật tiêu đề hóa đơn và kích thước logo theo loại bản in
  const titleEl = document.querySelector('#print-invoice-template h1');
  const printLogoImg = document.querySelector('.print-logo-container img');
  const printLogoSvg = document.getElementById('print-logo-svg');
  const printLogoContainer = document.querySelector('.print-logo-container');
  const printHeader = document.querySelector('.print-header');
  if (printHeader) {
    printHeader.style.display = type === 'warehouse' ? 'flex' : 'none';
  }
  
  if (titleEl) {
    if (type === 'warehouse') {
      titleEl.innerText = 'PHIẾU XUẤT KHO';
    } else {
      titleEl.innerText = 'HÓA ĐƠN BÁN HÀNG';
    }
  }

  if (type === 'warehouse') {
    if (printLogoImg) {
      printLogoImg.style.maxHeight = '205px';
      printLogoImg.style.maxWidth = '450px';
    }
    if (printLogoSvg) {
      printLogoSvg.setAttribute('width', '170');
      printLogoSvg.setAttribute('height', '170');
    }
    if (printLogoContainer) {
      printLogoContainer.style.minWidth = '190px';
    }
  } else {
    if (printLogoImg) {
      printLogoImg.style.maxHeight = '55px';
      printLogoImg.style.maxWidth = '150px';
    }
    if (printLogoSvg) {
      printLogoSvg.setAttribute('width', '45');
      printLogoSvg.setAttribute('height', '45');
    }
    if (printLogoContainer) {
      printLogoContainer.style.minWidth = '150px';
    }
  }

  document.getElementById('print-invoice-id').innerText = order.id;
  document.getElementById('print-invoice-date').innerText = formatDateTime(order.date);
  document.getElementById('print-customer-name').innerText = order.customerName;
  
  // Tổng hợp ghi chú đơn hàng và ghi chú mặc định của khách hàng
  let combinedNotes = order.notes || '';
  if (order.customerId) {
    const cust = state.customers.find(c => c.id === order.customerId);
    if (cust && cust.notes) {
      if (combinedNotes) {
        if (!combinedNotes.includes(cust.notes)) {
          combinedNotes = `${cust.notes} | ${combinedNotes}`;
        }
      } else {
        combinedNotes = cust.notes;
      }
    }
  }
  const notesEl = document.getElementById('print-invoice-notes');
  if (notesEl) notesEl.innerText = combinedNotes || 'N/A';
  
  // Điền nhãn sơn và cập nhật thông tin nhà phân phối / công ty tương ứng
  const firstItem = order.items[0];
  let brandName = 'N/A';
  if (firstItem) {
    brandName = firstItem.brand || (firstItem.product && firstItem.product.brand) || 'N/A';
  }
  document.getElementById('print-order-brand').innerText = brandName;

  // 1. Tìm cấu hình hãng sơn tương ứng trong danh sách state.brands
  let brandConfig = state.brands ? state.brands.find(b => b.name.toLowerCase() === brandName.toLowerCase()) : null;
  if (!brandConfig && state.brands) {
    brandConfig = state.brands.find(b => brandName.toLowerCase().includes(b.name.toLowerCase()) || b.name.toLowerCase().includes(brandName.toLowerCase()));
  }

  // Cấu hình mặc định (fallback) nếu hoàn toàn không tìm thấy hãng sơn trong bảng dữ liệu
  const defaultBrandConfig = {
    name: brandName,
    companyName: 'CÔNG TY CỔ PHẦN ABS JAPAN',
    logoFilename: 'absjapan.png',
    hotline: '088.603.7878 - 0961.030.923',
    cskh: '0868.055.866',
    email: 'nhamaysonnano@gmail.com',
    addressMain: 'Tiên Kha - Phúc Thịnh - Hà Nội',
    addressFactory: 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên',
    addressBusiness: '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh'
  };

  const config = brandConfig || defaultBrandConfig;
  const logoSrc = config.logoFilename;

  let logoPromise = Promise.resolve();
  if (printLogoImg) {
    logoPromise = new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      printLogoImg.onload = () => {
        printLogoImg.style.display = 'block';
        if (printLogoSvg) printLogoSvg.style.display = 'none';
        done();
      };

      printLogoImg.onerror = () => {
        printLogoImg.style.display = 'none';
        if (printLogoSvg) printLogoSvg.style.display = 'block';
        done();
      };

      printLogoImg.src = logoSrc;

      // Nếu ảnh đã được cache và load xong từ trước
      if (printLogoImg.complete && printLogoImg.naturalWidth !== 0) {
        printLogoImg.style.display = 'block';
        if (printLogoSvg) printLogoSvg.style.display = 'none';
        done();
      }

      // Giới hạn thời gian tối đa 800ms để in luôn nếu mạng quá chậm
      setTimeout(done, 800);
    });
  }

  await logoPromise;

  // Điền các trường thông tin chi tiết của công ty lên hóa đơn
  const companyAddressMainEl = document.getElementById('print-company-address-main');
  if (companyAddressMainEl) companyAddressMainEl.innerText = config.addressMain;

  const companyAddressFactoryEl = document.getElementById('print-company-address-factory');
  if (companyAddressFactoryEl) companyAddressFactoryEl.innerText = config.addressFactory;

  const companyCskhEl = document.getElementById('print-company-cskh');
  if (companyCskhEl) companyCskhEl.innerText = config.cskh;

  const companyEmailEl = document.getElementById('print-company-email');
  if (companyEmailEl) companyEmailEl.innerText = config.email;

  const companyLargeEl = document.getElementById('print-company-name-large');
  if (companyLargeEl) companyLargeEl.innerText = config.companyName;

  const sellerNameEl = document.getElementById('print-seller-name');
  if (sellerNameEl) sellerNameEl.innerText = config.companyName;

  const hotlineEl = document.getElementById('print-company-hotline');
  if (hotlineEl) hotlineEl.innerText = config.hotline;

  const sellerHotlineEl = document.getElementById('print-seller-hotline');
  if (sellerHotlineEl) sellerHotlineEl.innerText = config.hotline;

  const ddkdEl = document.getElementById('print-company-ddkd');
  if (ddkdEl) {
    if (config.addressBusiness && config.addressBusiness.trim() !== '') {
      ddkdEl.style.display = 'block';
      const companyAddressBusinessEl = document.getElementById('print-company-address-business');
      if (companyAddressBusinessEl) companyAddressBusinessEl.innerText = config.addressBusiness;
    } else {
      ddkdEl.style.display = 'none';
    }
  }

  const extraInfo = document.getElementById('print-customer-info-extra');
  if (order.customerId) {
    const cust = state.customers.find(c => c.id === order.customerId);
    if (cust) {
      extraInfo.innerHTML = `
        <p style="margin: 0; margin-top: 4px;"><strong>Địa chỉ:</strong> ${cust.address || 'N/A'}</p>
        <p style="margin: 0; margin-top: 4px;"><strong>Số điện thoại:</strong> ${formatPhoneNumber(cust.phone)}</p>
      `;
    } else {
      extraInfo.innerHTML = '';
    }
  } else {
    extraInfo.innerHTML = '';
  }

  const table = document.getElementById('print-invoice-table');
  
  if (type === 'warehouse') {
    // Tính tổng số lượng quy cách
    const totals = {};
    let totalQty = 0;
    order.items.forEach(item => {
      let pkg = item.package;
      if (pkg === 'Thung') pkg = 'Thùng';
      else if (pkg === 'Lon') pkg = 'Lon';
      else if (pkg === 'Hop') pkg = 'Hộp';
      else if (pkg === 'Bao') pkg = 'Bao';
      else if (pkg === 'Tui') pkg = 'Túi';
      
      const qty = parseInt(item.quantity) || 0;
      totalQty += qty;
      if (qty > 0) {
        totals[pkg] = (totals[pkg] || 0) + qty;
      }
    });
    
    const totalParts = Object.entries(totals).map(([pkg, qty]) => `${qty} ${pkg}`);
    const totalsText = totalParts.length > 0 ? totalParts.join(', ') : '0';

    // Hoá đơn cho nhân viên kho (Ẩn giá tiền, thêm Mã màu, thu nhỏ Tên SP/Khối lượng/SL, tăng kích thước Mã hàng và Ghi chú)
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width: 5%;">STT</th>
          <th style="width: 14%;">Mã hàng</th>
          <th style="width: 30%;">Tên sản phẩm</th>
          <th style="width: 10%; text-align: center;">Mã màu</th>
          <th style="width: 10%; text-align: center;">Khối lượng</th>
          <th style="width: 6%; text-align: center;">SL</th>
          <th style="width: 25%;">Ghi chú</th>
        </tr>
      </thead>
      <tbody>
        ${order.items.map((item, idx) => {
          const itemBrand = item.brand || (item.product && item.product.brand);
          const p = state.products.find(prod => prod.code === item.productCode && prod.brand === itemBrand);
          
          let weight = 'N/A';
          if (p) {
            if (item.package === 'Thung') weight = p.weightThung || 'N/A';
            else if (item.package === 'Lon') weight = p.weightLon || 'N/A';
            else if (item.package === 'Hop') weight = p.weightHop || 'N/A';
            else if (item.package === 'Bao') weight = p.weightBao || 'N/A';
            else if (item.package === 'Tui') weight = p.weightTui || 'N/A';
          }
          
          return `
            <tr>
              <td style="text-align: center;">${idx + 1}</td>
              <td style="font-weight: bold; font-size: 14pt;">${item.productCode}</td>
              <td>${item.productName}</td>
              <td style="text-align: center; font-weight: bold; font-size: 14pt;">${item.colorCode || ''}</td>
              <td style="text-align: center;">${weight}</td>
              <td style="text-align: center; font-weight: bold; font-size: 14pt;">${item.quantity}</td>
              <td style="font-size: 13pt; font-weight: 500;">${item.notes || ''}</td>
            </tr>
          `;
        }).join('')}
        <tr style="background-color: #f5f5f5; font-weight: bold;">
          <td colspan="5" style="text-align: right; padding-right: 15px; font-size: 13pt;">Tổng cộng:</td>
          <td style="text-align: center; font-size: 14pt; color: #000;">${totalQty}</td>
          <td style="font-size: 13pt; color: #000;">${totalsText}</td>
        </tr>
      </tbody>
    `;
    
    // Ẩn tổng tiền thanh toán trên hóa đơn kho
    document.querySelector('.print-summary').style.display = 'none';
  } else if (type === 'agent') {
    // Hoá đơn cho đại lý, đối tác (Ẩn tỷ lệ % chiết khấu, thêm cột Mã màu riêng biệt, thu nhỏ Mã hàng và SL)
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width: 5%;">STT</th>
          <th style="width: 10%;">Mã hàng</th>
          <th style="width: 30%;">Tên sản phẩm</th>
          <th style="width: 15%; text-align: center;">Mã màu</th>
          <th style="width: 10%;">Đơn vị (kg)</th>
          <th style="width: 5%; text-align: center;">SL</th>
          <th style="width: 12%; text-align: right;">Đơn giá (đ)</th>
          <th style="width: 13%; text-align: right;">Thành tiền (đ)</th>
        </tr>
      </thead>
      <tbody>
        ${order.items.map((item, idx) => {
          const discountedPrice = Math.round(item.price * (1 - item.discountPercent / 100));
          const subTotal = Math.round(item.quantity * discountedPrice);
          
          // Lấy khối lượng sản phẩm tương ứng với quy cách đóng gói
          const p = state.products.find(prod => prod.code === item.productCode);
          let weight = '';
          if (p) {
            if (item.package === 'Thung') weight = p.weightThung;
            else if (item.package === 'Lon') weight = p.weightLon;
            else if (item.package === 'Hop') weight = p.weightHop;
            else if (item.package === 'Bao') weight = p.weightBao;
            else if (item.package === 'Tui') weight = p.weightTui;
          }
          
          let packageDisplay = item.package;
          let prefix = '';
          if (packageDisplay === 'Thung') prefix = 'T';
          else if (packageDisplay === 'Lon') prefix = 'L';
          else if (packageDisplay === 'Hop') prefix = 'H';
          else if (packageDisplay === 'Bao') prefix = 'B';
          else if (packageDisplay === 'Tui') prefix = 'T';
          
          if (weight && weight !== 'N/A') {
            let formattedWeight = weight.replace(/\s+/g, '').toLowerCase();
            formattedWeight = formattedWeight.replace(/kg$/, '').replace(/l$/, '');
            if (formattedWeight.endsWith('.0')) {
              formattedWeight = formattedWeight.slice(0, -2);
            }
            packageDisplay = `${prefix}${formattedWeight}`;
          } else {
            if (packageDisplay === 'Thung') packageDisplay = 'Thùng';
            else if (packageDisplay === 'Lon') packageDisplay = 'Lon';
            else if (packageDisplay === 'Hop') packageDisplay = 'Hộp';
            else if (packageDisplay === 'Bao') packageDisplay = 'Bao';
            else if (packageDisplay === 'Tui') packageDisplay = 'Túi';
          }
          
          return `
            <tr>
              <td style="text-align: center;">${idx + 1}</td>
              <td style="font-weight: bold;">${item.productCode}</td>
              <td>${item.productName}</td>
              <td style="text-align: center; font-weight: bold;">
                ${item.colorCode || ''}
                ${item.colorPercent > 0 ? `<div style="font-size: 8pt; font-weight: bold; margin-top: 2px;">(+${item.colorPercent}% màu)</div>` : ''}
              </td>
              <td style="text-align: center;">${packageDisplay}</td>
              <td style="text-align: center;">${item.quantity}</td>
              <td style="text-align: right;">${formatNumber(discountedPrice)}</td>
              <td style="text-align: right; font-weight: bold;">${formatNumber(subTotal)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    `;
    
    // Ẩn chi tiết dòng % giảm giá, chỉ hiện tổng thanh toán cuối cùng
    document.querySelector('.print-summary').style.display = 'block';
    document.getElementById('print-total-market').parentElement.style.display = 'none';
    document.getElementById('print-total-discount').parentElement.style.display = 'none';
  } else {
    // Hoá đơn khách lẻ (Hiển thị chi tiết đầy đủ)
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width: 5%;">STT</th>
          <th style="width: 15%;">Mã hàng</th>
          <th style="width: 30%;">Tên sản phẩm (kèm màu sắc)</th>
          <th style="width: 10%;">Đơn vị (kg)</th>
          <th style="width: 7%; text-align: center;">SL</th>
          <th style="width: 12%; text-align: right;">Giá niêm yết (đ)</th>
          <th style="width: 8%; text-align: center;">% CK</th>
          <th style="width: 13%; text-align: right;">Thành tiền (đ)</th>
        </tr>
      </thead>
      <tbody>
        ${order.items.map((item, idx) => {
          const colorPctText = item.colorPercent > 0 ? `, +${item.colorPercent}% màu` : '';
          const colorSuffix = item.colorCode ? ` (Màu: <strong>${item.colorCode}${colorPctText}</strong>)` : '';
          const subTotal = Math.round(item.quantity * item.price * (1 - item.discountPercent / 100));
          
          // Lấy khối lượng sản phẩm tương ứng với quy cách đóng gói
          const p = state.products.find(prod => prod.code === item.productCode);
          let weight = '';
          if (p) {
            if (item.package === 'Thung') weight = p.weightThung;
            else if (item.package === 'Lon') weight = p.weightLon;
            else if (item.package === 'Hop') weight = p.weightHop;
            else if (item.package === 'Bao') weight = p.weightBao;
            else if (item.package === 'Tui') weight = p.weightTui;
          }
          
          let packageDisplay = item.package;
          let prefix = '';
          if (packageDisplay === 'Thung') prefix = 'T';
          else if (packageDisplay === 'Lon') prefix = 'L';
          else if (packageDisplay === 'Hop') prefix = 'H';
          else if (packageDisplay === 'Bao') prefix = 'B';
          else if (packageDisplay === 'Tui') prefix = 'T';
          
          if (weight && weight !== 'N/A') {
            let formattedWeight = weight.replace(/\s+/g, '').toLowerCase();
            formattedWeight = formattedWeight.replace(/kg$/, '').replace(/l$/, '');
            if (formattedWeight.endsWith('.0')) {
              formattedWeight = formattedWeight.slice(0, -2);
            }
            packageDisplay = `${prefix}${formattedWeight}`;
          } else {
            if (packageDisplay === 'Thung') packageDisplay = 'Thùng';
            else if (packageDisplay === 'Lon') packageDisplay = 'Lon';
            else if (packageDisplay === 'Hop') packageDisplay = 'Hộp';
            else if (packageDisplay === 'Bao') packageDisplay = 'Bao';
            else if (packageDisplay === 'Tui') packageDisplay = 'Túi';
          }
          
          return `
            <tr>
              <td style="text-align: center;">${idx + 1}</td>
              <td style="font-weight: bold;">${item.productCode}</td>
              <td>${item.productName}${colorSuffix}</td>
              <td style="text-align: center;">${packageDisplay}</td>
              <td style="text-align: center;">${item.quantity}</td>
              <td style="text-align: right;">${formatNumber(Math.round(item.price))}</td>
              <td style="text-align: center;">${item.discountPercent}%</td>
              <td style="text-align: right; font-weight: bold;">${formatNumber(subTotal)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    `;
    
    // Hiện đầy đủ các dòng tổng tiền niêm yết, chiết khấu
    document.querySelector('.print-summary').style.display = 'block';
    document.getElementById('print-total-market').parentElement.style.display = 'flex';
    document.getElementById('print-total-discount').parentElement.style.display = 'flex';
    
    document.getElementById('print-total-market').innerText = formatCurrency(order.totalMarket);
    document.getElementById('print-total-discount').innerText = '-' + formatCurrency(order.totalDiscount);
  }

  // Hỗ trợ vận chuyển chung
  const printShipRow = document.getElementById('print-shipping-discount-row');
  if (order.shippingSupport && order.shippingDiscount > 0 && type !== 'warehouse') {
    if (printShipRow) {
      printShipRow.style.display = 'flex';
      document.getElementById('print-shipping-discount').innerText = '-' + formatCurrency(order.shippingDiscount);
    }
  } else {
    if (printShipRow) printShipRow.style.display = 'none';
  }

  // Tổng thanh toán
  if (type !== 'warehouse') {
    document.getElementById('print-total-payable').innerText = formatCurrency(order.totalPayable);
  }

  // Gán nhãn ký tên khách hàng và dựng các cột chữ ký
  const sigsEl = document.querySelector('.print-signatures');
  if (sigsEl) {
    if (type === 'warehouse') {
      sigsEl.innerHTML = `
        <div class="print-sig-col" style="width: 30%;">
          <p><strong>Người lập phiếu</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 30%;">
          <p><strong>Thủ kho</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, đóng dấu xuất kho)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 30%;">
          <p><strong>Người nhận hàng</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">${order.customerName}</p>
        </div>
      `;
    } else {
      sigsEl.innerHTML = `
        <div class="print-sig-col" style="width: 45%;">
          <p><strong>Người lập hóa đơn</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 45%;">
          <p><strong>Người nhận hàng</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
          <p id="print-customer-sign-name" style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">${order.customerName}</p>
        </div>
      `;
    }
  }

  // Gọi lệnh in của trình duyệt
  window.print();
}

export function openPrintTypeModal(order) {
  currentOrderToPrint = order;
  const modal = document.getElementById('print-type-modal');
  if (modal) modal.classList.add('active');
}

export function setupPrintTypeModal() {
  const modal = document.getElementById('print-type-modal');
  const closeBtn = document.getElementById('btn-close-print-type-modal');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  document.getElementById('btn-print-type-retail').addEventListener('click', () => {
    if (currentOrderToPrint) {
      renderAndPrintOrder(currentOrderToPrint, 'retail');
      modal.classList.remove('active');
    }
  });
  
  document.getElementById('btn-print-type-agent').addEventListener('click', () => {
    if (currentOrderToPrint) {
      renderAndPrintOrder(currentOrderToPrint, 'agent');
      modal.classList.remove('active');
    }
  });
  
  document.getElementById('btn-print-type-warehouse').addEventListener('click', () => {
    if (currentOrderToPrint) {
      if (state.currentUser && state.currentUser.role === 'sale') {
        showToast('Nhân viên kinh doanh không có quyền in hóa đơn kho!', 'danger');
        return;
      }
      renderAndPrintOrder(currentOrderToPrint, 'warehouse');
      modal.classList.remove('active');
    }
  });
}

export function setupInvoiceCreator() {
  const searchInput = document.getElementById('invoice-product-search');
  const suggestionsList = document.getElementById('invoice-product-suggestions');
  const addBtn = document.getElementById('btn-add-to-invoice-table');
  const resetBtn = document.getElementById('btn-reset-order');
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const printBtn = document.getElementById('btn-print-order');

  if (searchInput) {
    searchInput.addEventListener('focus', () => {
      if (!state.activeCustomerId && !state.isQuickCustomerMode) {
        searchInput.blur();
        showToast('Vui lòng tìm và chọn khách hàng trước khi chọn sản phẩm!', 'warning');
      }
    });

    searchInput.addEventListener('input', () => {
      if (!state.activeCustomerId && !state.isQuickCustomerMode) {
        searchInput.value = '';
        suggestionsList.style.display = 'none';
        showToast('Vui lòng tìm và chọn khách hàng trước khi chọn sản phẩm!', 'warning');
        return;
      }

      searchInput.removeAttribute('data-selected-brand');
      const val = searchInput.value.trim().toLowerCase();
      if (val === '') {
        suggestionsList.style.display = 'none';
        return;
      }

      const valNormalized = val.replace(/[^a-z0-9]/g, '');
      let matches = state.products.filter(p => {
        const codeNormalized = p.code.toLowerCase().replace(/[^a-z0-9]/g, '');
        return (valNormalized !== '' && codeNormalized.includes(valNormalized)) ||
               p.code.toLowerCase().includes(val) || 
               p.name.toLowerCase().includes(val);
      });

      if (state.activeCustomerBrand && state.activeCustomerBrand !== 'Tất cả') {
        matches = matches.filter(p => p.brand === state.activeCustomerBrand);
      }

      matches.sort((a, b) => {
        const brandA = (a.brand || '').toLowerCase();
        const brandB = (b.brand || '').toLowerCase();
        if (brandA < brandB) return -1;
        if (brandA > brandB) return 1;
        
        const codeA = (a.code || '').toLowerCase();
        const codeB = (b.code || '').toLowerCase();
        if (codeA < codeB) return -1;
        if (codeA > codeB) return 1;
        return 0;
      });

      if (matches.length === 0) {
        suggestionsList.innerHTML = `<li class="suggestion-item" style="color: var(--text-muted); cursor: default;">Không tìm thấy sản phẩm</li>`;
      } else {
        suggestionsList.innerHTML = matches.map(p => `
          <li class="suggestion-item" data-code="${p.code}" data-brand="${p.brand || 'Nano10*'}" style="text-align: left; display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <div class="suggestion-info" style="text-align: left; align-items: flex-start; display: flex; flex-direction: column;">
              <span class="suggestion-code" style="font-weight: 600; color: #fff; font-size: 0.8rem;">${p.code}</span>
              <span class="suggestion-name" style="color: var(--text-secondary); font-size: 0.85rem;">${p.name}</span>
            </div>
            <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4);">${p.brand || 'Nano10*'}</span>
          </li>
        `).join('');
      }
      suggestionsList.style.display = 'block';

      document.querySelectorAll('.suggestion-item[data-code]').forEach(item => {
        item.addEventListener('click', () => {
          searchInput.value = item.getAttribute('data-code');
          searchInput.setAttribute('data-selected-brand', item.getAttribute('data-brand'));
          suggestionsList.style.display = 'none';
          addProductToInvoice();
        });
      });
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addProductToInvoice();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (searchInput && suggestionsList && !searchInput.contains(e.target) && !suggestionsList.contains(e.target)) {
      suggestionsList.style.display = 'none';
    }
  });

  if (addBtn) addBtn.addEventListener('click', addProductToInvoice);

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const hasItems = state.invoiceItems.length > 0;
      const hasCustomer = state.activeCustomerId !== '' || state.isQuickCustomerMode;
      const hasNotes = document.getElementById('invoice-notes') && document.getElementById('invoice-notes').value.trim() !== '';
      
      if (hasItems || hasCustomer || hasNotes) {
        if (confirm('Bạn có chắc chắn muốn làm mới toàn bộ đơn hàng đang lập không?')) {
          resetInvoiceBuilder();
        }
      } else {
        showToast('Đơn hàng hiện tại đã trống!', 'info');
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const order = await saveActiveOrder('settled');
      if (order) {
        switchTab('history-panel');
      }
    });
  }

  if (draftBtn) {
    draftBtn.addEventListener('click', async () => {
      const order = await saveActiveOrder('draft');
      if (order) {
        switchTab('history-panel');
      }
    });
  }

  if (printBtn) {
    printBtn.addEventListener('click', () => {
      const order = compileActiveOrder();
      if (order) {
        openPrintTypeModal(order);
      }
    });
  }

  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck) {
    shipCheck.addEventListener('change', () => {
      calculateInvoiceTotals();
    });
  }

  // Sự kiện tìm kiếm khách hàng trong invoice panel
  setupInvoiceCustomerSearch();

  // Quick Customer Mode Listeners
  const quickToggleBtn = document.getElementById('btn-quick-customer-toggle');
  if (quickToggleBtn) {
    quickToggleBtn.addEventListener('click', enableQuickCustomerMode);
  }

  const quickCancelBtn = document.getElementById('btn-quick-customer-cancel');
  if (quickCancelBtn) {
    quickCancelBtn.addEventListener('click', disableQuickCustomerMode);
  }

  const quickBrandSelect = document.getElementById('quick-cust-assigned-brand');
  if (quickBrandSelect) {
    quickBrandSelect.addEventListener('change', () => {
      handleQuickCustomerBrandChange(quickBrandSelect.value);
    });
  }

  const quickShipCheck = document.getElementById('quick-cust-shipping-support');
  if (quickShipCheck) {
    quickShipCheck.addEventListener('change', () => {
      if (shipCheck) {
        shipCheck.checked = quickShipCheck.checked;
      }
      calculateInvoiceTotals();
    });
  }

  const invoicePlSelect = document.getElementById('invoice-pricelist-select');
  if (invoicePlSelect) {
    invoicePlSelect.addEventListener('change', () => {
      applyActivePriceListToInvoice();
    });
  }
}

function setupInvoiceCustomerSearch() {
  const custSearchInput = document.getElementById('invoice-customer-search');
  const infoCard = document.getElementById('invoice-customer-info-card');
  const clearBtn = document.getElementById('btn-clear-invoice-customer');

  if (!custSearchInput) return;

  // Lắng nghe sự kiện để tìm kiếm gợi ý khách hàng giống như tìm sản phẩm
  const suggestions = document.createElement('ul');
  suggestions.className = 'suggestions-list';
  suggestions.id = 'invoice-customer-suggestions';
  suggestions.style.display = 'none';
  custSearchInput.parentNode.appendChild(suggestions);

  custSearchInput.addEventListener('input', () => {
    if (state.isQuickCustomerMode) return; // Không cần gợi ý ở chế độ khách lẻ
    
    const val = custSearchInput.value.trim().toLowerCase();
    if (val === '') {
      suggestions.style.display = 'none';
      return;
    }

    const matches = state.customers.filter(c => {
      if (state.currentUser && state.currentUser.role === 'sale') {
        const cManager = c.managedBy ? (c.managedBy.includes('@') ? c.managedBy.split('@')[0] : c.managedBy) : '';
        const currentUserUname = state.currentUser.username ? (state.currentUser.username.includes('@') ? state.currentUser.username.split('@')[0] : state.currentUser.username) : '';
        if (cManager !== currentUserUname) return false;
      }
      return c.code.toLowerCase().includes(val) || c.name.toLowerCase().includes(val) || (c.phone && c.phone.includes(val));
    });

    if (matches.length === 0) {
      suggestions.innerHTML = `<li class="suggestion-item" style="color: var(--text-muted); cursor: default;">Không tìm thấy khách hàng</li>`;
    } else {
      suggestions.innerHTML = matches.map(c => `
        <li class="suggestion-item select-cust-suggestion" data-id="${c.id}" style="text-align: left; display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <div class="suggestion-info">
            <span style="font-weight: 600; color: #fff;">${c.name} (${c.code})</span>
            <span style="font-size: 0.75rem; color: var(--text-secondary); display: block; margin-top: 2px;">SĐT: ${c.phone || 'N/A'} • Nợ: ${formatCurrency(c.debt)}</span>
          </div>
        </li>
      `).join('');
    }
    suggestions.style.display = 'block';

    document.querySelectorAll('.select-cust-suggestion').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        const customer = state.customers.find(c => c.id === id);
        if (customer) {
          selectInvoiceCustomer(customer);
        }
        suggestions.style.display = 'none';
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!custSearchInput.contains(e.target) && !suggestions.contains(e.target)) {
      suggestions.style.display = 'none';
    }
  });

  setupPrintTypeModal();
}

function selectInvoiceCustomer(customer) {
  state.activeCustomerId = customer.id;
  state.activeCustomerBrand = customer.assignedBrand;
  
  document.getElementById('invoice-customer-id').value = customer.id;
  document.getElementById('invoice-customer-search').value = customer.name;
  document.getElementById('invoice-customer-search').setAttribute('disabled', 'true');
  
  // Tự động điền ghi chú mặc định của khách hàng vào ô nhập ghi chú hóa đơn
  const notesInput = document.getElementById('invoice-notes');
  if (notesInput) {
    notesInput.value = customer.notes || '';
  }
  
  const clearBtn = document.getElementById('btn-clear-invoice-customer');
  if (clearBtn) clearBtn.style.display = 'inline-flex';
  
  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) {
    infoCard.style.display = 'block';
    document.getElementById('selected-customer-name-lbl').innerText = customer.name;
    document.getElementById('selected-customer-phone-lbl').innerText = customer.phone || 'N/A';
    document.getElementById('selected-customer-address-lbl').innerText = customer.address || 'N/A';
    document.getElementById('selected-customer-brand-lbl').innerText = customer.assignedBrand;
    document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(customer.debt);
  }

  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck) {
    shipCheck.checked = customer.shippingSupport || false;
  }

  // Tự động gán bảng giá mặc định của đại lý
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    plSelect.value = customer.pricelistId || 'custom';
    plSelect.disabled = true; // Khóa lại, không cho sale thay đổi bảng giá của đại lý tùy ý
  }
  
  applyActivePriceListToInvoice();
  showToast(`Đã chọn khách hàng "${customer.name}". Tự động áp chiết khấu theo bảng giá.`);
}

// Lắng nghe sự kiện để đồng bộ render bảng khi load đơn nháp từ module history
document.addEventListener('loadDraftOrder', (e) => {
  const { order, isReadOnly } = e.detail;
  renderInvoiceTable();
});
