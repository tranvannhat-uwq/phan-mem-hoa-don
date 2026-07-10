import { state } from '../state.js';
import { showToast, formatDateTime, safeCreateIcons } from '../utils.js';
import {
  dbSaveRawMaterial,
  dbDeleteRawMaterial,
  dbSaveSemiFinished,
  dbDeleteSemiFinished,
  dbSaveRecipe,
  dbDeleteRecipe,
  dbSaveProductionLog,
  dbSaveFinishedGoodsStock
} from '../services/supabase.js';
import { renderAll } from '../main.js';

// --- TRÌNH VẼ GIAO DIỆN (RENDERERS) ---

export function renderGoodsPanel() {
  const panel = document.getElementById('goods-panel');
  if (!panel || !panel.classList.contains('active')) return;

  renderRawMaterials();
  renderSemiFinished();
  renderFinishedGoodsStock();
  renderRecipes();
  renderProductionLogs();
  populateProductionRecipeDropdown();
  populateBrandFilter();
}

// 1. Vẽ bảng Nguyên liệu
function renderRawMaterials() {
  const tbody = document.getElementById('raw-materials-table-body');
  if (!tbody) return;

  const searchVal = document.getElementById('raw-search-input').value.toLowerCase().trim();
  const filtered = state.rawMaterials.filter(r => 
    r.code.toLowerCase().includes(searchVal) || r.name.toLowerCase().includes(searchVal)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không có nguyên liệu nào.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((r, idx) => `
    <tr>
      <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
      <td style="font-weight: 600; color: #fff;">${r.code}</td>
      <td style="font-weight: 500;">${r.name}</td>
      <td><span class="suggestion-brand-badge" style="background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.15);">${r.unit}</span></td>
      <td style="text-align: right; font-weight: 600; color: var(--color-primary);">${r.quantity.toLocaleString('vi-VN')}</td>
      <td style="color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${r.notes || ''}">${r.notes || '-'}</td>
      <td style="text-align: center;">
        <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
          <button class="btn btn-secondary btn-sm btn-circle edit-raw-btn" data-id="${r.id}" title="Sửa">
            <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
          </button>
          <button class="btn btn-danger btn-sm btn-circle delete-raw-btn" data-id="${r.id}" title="Xóa">
            <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');

  // Gán sự kiện cho nút Sửa/Xóa nguyên liệu
  tbody.querySelectorAll('.edit-raw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      openRawMaterialModal(id);
    });
  });

  tbody.querySelectorAll('.delete-raw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      deleteRawMaterial(id);
    });
  });

  safeCreateIcons();
}

// 2. Vẽ bảng Bán thành phẩm
function renderSemiFinished() {
  const tbody = document.getElementById('semi-finished-table-body');
  if (!tbody) return;

  const searchVal = document.getElementById('semi-search-input').value.toLowerCase().trim();
  const filtered = state.semiFinished.filter(s => 
    s.code.toLowerCase().includes(searchVal) || s.name.toLowerCase().includes(searchVal)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không có bán thành phẩm nào.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((s, idx) => `
    <tr>
      <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
      <td style="font-weight: 600; color: #fff;">${s.code}</td>
      <td style="font-weight: 500;">${s.name}</td>
      <td><span class="suggestion-brand-badge" style="background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.15);">${s.unit}</span></td>
      <td style="text-align: right; font-weight: 600; color: #10b981;">${s.quantity.toLocaleString('vi-VN')}</td>
      <td style="color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${s.notes || ''}">${s.notes || '-'}</td>
      <td style="text-align: center;">
        <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
          <button class="btn btn-secondary btn-sm btn-circle edit-semi-btn" data-id="${s.id}" title="Sửa">
            <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
          </button>
          <button class="btn btn-danger btn-sm btn-circle delete-semi-btn" data-id="${s.id}" title="Xóa">
            <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.edit-semi-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      openSemiFinishedModal(id);
    });
  });

  tbody.querySelectorAll('.delete-semi-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      deleteSemiFinished(id);
    });
  });

  safeCreateIcons();
}

// 3. Vẽ bảng Tồn kho Thành phẩm
function renderFinishedGoodsStock() {
  const tbody = document.getElementById('finished-goods-stock-table-body');
  if (!tbody) return;

  const searchVal = document.getElementById('finished-stock-search-input').value.toLowerCase().trim();
  const brandFilter = document.getElementById('finished-stock-brand-filter').value;

  const filtered = state.products.filter(p => {
    const matchesSearch = p.code.toLowerCase().includes(searchVal) || p.name.toLowerCase().includes(searchVal);
    const matchesBrand = brandFilter === '' || p.brand === brandFilter;
    return matchesSearch && matchesBrand;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không tìm thấy sản phẩm thành phẩm nào.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((p, idx) => {
    // Tìm số lượng tồn kho theo quy cách từ state.finishedGoodsStock
    const getQty = (pack) => {
      const found = state.finishedGoodsStock.find(s => s.productCode === p.code && s.brand === p.brand && s.packageType === pack);
      return found ? found.quantity : 0;
    };

    const thungStock = getQty('thung');
    const lonStock = getQty('lon');
    const hopStock = getQty('hop');
    const baoStock = getQty('bao');
    const tuiStock = getQty('tui');

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
        <td style="font-weight: 600; color: #fff;">${p.code}</td>
        <td style="font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 200px;" title="${p.name}">${p.name}</td>
        <td><span class="suggestion-brand-badge">${p.brand || 'Nano10*'}</span></td>
        <td style="text-align: right; font-weight: 500; color: ${thungStock > 0 ? '#fff' : 'var(--text-muted)'};">${thungStock.toLocaleString('vi-VN')}</td>
        <td style="text-align: right; font-weight: 500; color: ${lonStock > 0 ? '#fff' : 'var(--text-muted)'};">${lonStock.toLocaleString('vi-VN')}</td>
        <td style="text-align: right; font-weight: 500; color: ${hopStock > 0 ? '#fff' : 'var(--text-muted)'};">${hopStock.toLocaleString('vi-VN')}</td>
        <td style="text-align: right; font-weight: 500; color: ${baoStock > 0 ? '#fff' : 'var(--text-muted)'};">${baoStock.toLocaleString('vi-VN')}</td>
        <td style="text-align: right; font-weight: 500; color: ${tuiStock > 0 ? '#fff' : 'var(--text-muted)'};">${tuiStock.toLocaleString('vi-VN')}</td>
        <td style="text-align: center;">
          <button class="btn btn-secondary btn-sm adjust-finished-btn" data-code="${p.code}" data-brand="${p.brand}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 0.25rem;">
            <i data-lucide="sliders" style="width:12px; height:12px;"></i> Điều chỉnh
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.adjust-finished-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code');
      const brand = btn.getAttribute('data-brand');
      openFinishedStockAdjustModal(code, brand);
    });
  });

  safeCreateIcons();
}

// Điền hãng sơn vào bộ lọc hãng tồn thành phẩm
function populateBrandFilter() {
  const filter = document.getElementById('finished-stock-brand-filter');
  if (!filter) return;
  const currentVal = filter.value;
  const uniqueBrands = [...new Set(state.products.map(p => p.brand).filter(Boolean))];
  
  filter.innerHTML = `
    <option value="">-- Tất cả hãng sơn --</option>
    ${uniqueBrands.map(b => `<option value="${b}">${b}</option>`).join('')}
  `;
  filter.value = currentVal;
}

// 4. Vẽ bảng Công thức sản xuất
function renderRecipes() {
  const tbody = document.getElementById('recipes-table-body');
  if (!tbody) return;

  const searchVal = document.getElementById('recipe-search-input').value.toLowerCase().trim();
  const filtered = state.recipes.filter(r => 
    r.name.toLowerCase().includes(searchVal)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không có công thức nào.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((r, idx) => {
    const semi = state.semiFinished.find(s => s.id === r.semiFinishedId);
    const semiName = semi ? semi.name : 'Chưa xác định';
    const semiUnit = semi ? semi.unit : 'kg';

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${idx + 1}</td>
        <td style="font-weight: 600; color: #fff;">${r.name}</td>
        <td>${semiName}</td>
        <td style="text-align: right; font-weight: 500;">${r.outputQuantity} ${semiUnit}</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.3rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-recipe-btn" data-id="${r.id}" title="Sửa công thức">
              <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-recipe-btn" data-id="${r.id}" title="Xóa công thức">
              <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.edit-recipe-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      openRecipeModal(id);
    });
  });

  tbody.querySelectorAll('.delete-recipe-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      deleteRecipe(id);
    });
  });

  safeCreateIcons();
}

// 5. Vẽ bảng Nhật ký sản xuất
function renderProductionLogs() {
  const tbody = document.getElementById('production-logs-table-body');
  if (!tbody) return;

  if (state.productionLogs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Chưa thực hiện lệnh sản xuất nào.
        </td>
      </tr>
    `;
    return;
  }

  // Sắp xếp nhật ký mới nhất lên trước
  const sortedLogs = [...state.productionLogs].sort((a, b) => new Date(b.date) - new Date(a.date));

  tbody.innerHTML = sortedLogs.map(l => {
    return `
      <tr>
        <td style="color: var(--text-secondary);">${formatDateTime(l.date)}</td>
        <td style="font-weight: 600; color: #fff;">${l.recipeName}</td>
        <td style="font-weight: 500;">${l.semiFinishedName}</td>
        <td style="text-align: right; font-weight: 600; color: var(--color-secondary);">${l.quantity.toLocaleString('vi-VN')} kg</td>
        <td style="color: var(--text-muted);">${l.createdBy}</td>
      </tr>
    `;
  }).join('');
}

// Điền các công thức vào dropdown Lập lệnh sản xuất
function populateProductionRecipeDropdown() {
  const select = document.getElementById('prod-select-recipe');
  if (!select) return;
  const currentVal = select.value;

  select.innerHTML = `
    <option value="">-- Chọn công thức để sản xuất --</option>
    ${state.recipes.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
  `;
  select.value = currentVal;
}


// --- XỬ LÝ LỆNH TƯƠNG TÁC (ACTIONS & MODALS) ---

// 1. Quản lý Nguyên liệu (Raw Materials)
function openRawMaterialModal(id = '') {
  const modal = document.getElementById('raw-material-modal');
  const title = document.getElementById('raw-material-modal-title');
  const form = document.getElementById('raw-material-form');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();

  if (id) {
    title.innerText = 'Cập nhật nguyên liệu';
    const item = state.rawMaterials.find(r => r.id === id);
    if (item) {
      document.getElementById('raw-id').value = item.id;
      document.getElementById('raw-code').value = item.code;
      document.getElementById('raw-code').disabled = true; // Không cho sửa mã
      document.getElementById('raw-name').value = item.name;
      document.getElementById('raw-unit').value = item.unit;
      document.getElementById('raw-quantity').value = item.quantity;
      document.getElementById('raw-notes').value = item.notes || '';
    }
  } else {
    title.innerText = 'Thêm nguyên liệu mới';
    document.getElementById('raw-id').value = '';
    document.getElementById('raw-code').disabled = false;
  }
}

async function deleteRawMaterial(id) {
  const item = state.rawMaterials.find(r => r.id === id);
  if (!item) return;

  if (confirm(`Bạn chắc chắn muốn xóa nguyên liệu "${item.name}" (${item.code})?`)) {
    state.rawMaterials = state.rawMaterials.filter(r => r.id !== id);
    localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));
    await dbDeleteRawMaterial(id);
    showToast('Đã xóa nguyên liệu thành công.');
    renderAll();
  }
}

// 2. Quản lý Bán thành phẩm (Semi-finished)
function openSemiFinishedModal(id = '') {
  const modal = document.getElementById('semi-finished-modal');
  const title = document.getElementById('semi-finished-modal-title');
  const form = document.getElementById('semi-finished-form');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();

  if (id) {
    title.innerText = 'Cập nhật bán thành phẩm';
    const item = state.semiFinished.find(s => s.id === id);
    if (item) {
      document.getElementById('semi-id').value = item.id;
      document.getElementById('semi-code').value = item.code;
      document.getElementById('semi-code').disabled = true;
      document.getElementById('semi-name').value = item.name;
      document.getElementById('semi-unit').value = item.unit;
      document.getElementById('semi-quantity').value = item.quantity;
      document.getElementById('semi-notes').value = item.notes || '';
    }
  } else {
    title.innerText = 'Thêm bán thành phẩm mới';
    document.getElementById('semi-id').value = '';
    document.getElementById('semi-code').disabled = false;
  }
}

async function deleteSemiFinished(id) {
  const item = state.semiFinished.find(s => s.id === id);
  if (!item) return;

  if (confirm(`Bạn chắc chắn muốn xóa bán thành phẩm "${item.name}" (${item.code})?`)) {
    state.semiFinished = state.semiFinished.filter(s => s.id !== id);
    localStorage.setItem('billing_system_semi_finished', JSON.stringify(state.semiFinished));
    await dbDeleteSemiFinished(id);
    showToast('Đã xóa bán thành phẩm thành công.');
    renderAll();
  }
}

// 3. Quản lý Công thức (Recipes) & Ingredients Rows
function openRecipeModal(id = '') {
  const modal = document.getElementById('recipe-modal');
  const title = document.getElementById('recipe-modal-title');
  const form = document.getElementById('recipe-form');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();

  // Populate Bán thành phẩm dropdown
  const btpSelect = document.getElementById('recipe-semi-finished-id');
  btpSelect.innerHTML = `<option value="">-- Chọn bán thành phẩm đầu ra --</option>` +
    state.semiFinished.map(s => `<option value="${s.id}">${s.name} (${s.unit})</option>`).join('');

  const container = document.getElementById('recipe-ingredients-rows-container');
  container.innerHTML = '';

  if (id) {
    title.innerText = 'Cập nhật công thức sản xuất';
    const item = state.recipes.find(r => r.id === id);
    if (item) {
      document.getElementById('recipe-id').value = item.id;
      document.getElementById('recipe-name').value = item.name;
      document.getElementById('recipe-semi-finished-id').value = item.semiFinishedId;
      document.getElementById('recipe-output-quantity').value = item.outputQuantity;
      document.getElementById('recipe-notes').value = item.notes || '';

      // Tải lại các dòng thành phần nguyên liệu
      if (item.ingredients && item.ingredients.length > 0) {
        item.ingredients.forEach(ing => {
          addIngredientRow(ing.rawMaterialId, ing.quantity);
        });
      }
    }
  } else {
    title.innerText = 'Tạo công thức sản xuất mới';
    document.getElementById('recipe-id').value = '';
    // Thêm sẵn 2 dòng nguyên vật liệu trống để điền
    addIngredientRow();
    addIngredientRow();
  }
}

// Thêm một dòng chọn nguyên vật liệu trong công thức
function addIngredientRow(selectedId = '', quantityVal = '') {
  const container = document.getElementById('recipe-ingredients-rows-container');
  if (!container) return;

  const rowDiv = document.createElement('div');
  rowDiv.className = 'ingredient-row';
  rowDiv.style = 'display: grid; grid-template-columns: 2.2fr 1fr 40px; gap: 0.5rem; align-items: center;';

  const select = document.createElement('select');
  select.className = 'form-control ingredient-select';
  select.required = true;
  select.innerHTML = `<option value="">-- Chọn nguyên liệu --</option>` +
    state.rawMaterials.map(r => `<option value="${r.id}">${r.name} (${r.unit})</option>`).join('');
  if (selectedId) select.value = selectedId;

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'form-control ingredient-qty-input';
  input.placeholder = 'Định mức';
  input.min = '0.0001';
  input.step = 'any';
  input.required = true;
  if (quantityVal !== '') input.value = quantityVal;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-danger btn-circle btn-sm';
  deleteBtn.innerHTML = `<i data-lucide="trash" style="width: 13px; height: 13px;"></i>`;
  deleteBtn.addEventListener('click', () => {
    rowDiv.remove();
  });

  rowDiv.appendChild(select);
  rowDiv.appendChild(input);
  rowDiv.appendChild(deleteBtn);
  container.appendChild(rowDiv);
  safeCreateIcons();
}

async function deleteRecipe(id) {
  const item = state.recipes.find(r => r.id === id);
  if (!item) return;

  if (confirm(`Bạn chắc chắn muốn xóa công thức "${item.name}"?`)) {
    state.recipes = state.recipes.filter(r => r.id !== id);
    localStorage.setItem('billing_system_recipes', JSON.stringify(state.recipes));
    await dbDeleteRecipe(id);
    showToast('Đã xóa công thức sản xuất thành công.');
    renderAll();
  }
}

// 4. Điều chỉnh Tồn kho Thành phẩm
function openFinishedStockAdjustModal(productCode, brand) {
  const modal = document.getElementById('finished-stock-adjust-modal');
  const form = document.getElementById('finished-stock-adjust-form');
  if (!modal) return;
  modal.classList.add('active');
  form.reset();

  const product = state.products.find(p => p.code === productCode && p.brand === brand);
  if (!product) return;

  document.getElementById('adjust-prod-name-lbl').innerText = product.name;
  document.getElementById('adjust-prod-code-lbl').innerText = product.code;
  document.getElementById('adjust-prod-brand-lbl').innerText = product.brand;

  // Điền dữ liệu tồn kho hiện tại vào form
  const getQty = (pack) => {
    const found = state.finishedGoodsStock.find(s => s.productCode === productCode && s.brand === brand && s.packageType === pack);
    return found ? found.quantity : '';
  };

  const inputs = form.querySelectorAll('.adjust-qty-input');
  inputs.forEach(input => {
    const pack = input.getAttribute('data-pack');
    input.value = getQty(pack);
  });
}


// --- TÍNH TOÁN VÀ ĐIỀU PHỐI ĐỊNH MỨC SẢN XUẤT LIVE ---

function handleRecipeChangeForProduction() {
  const recipeId = document.getElementById('prod-select-recipe').value;
  const qtyInput = document.getElementById('prod-run-quantity');
  const calcBox = document.getElementById('production-calc-results');
  const unitLabel = document.getElementById('prod-run-unit-label');

  if (!recipeId) {
    qtyInput.value = '';
    qtyInput.disabled = true;
    calcBox.style.display = 'none';
    unitLabel.innerText = '';
    return;
  }

  const recipe = state.recipes.find(r => r.id === recipeId);
  const semi = state.semiFinished.find(s => s.id === recipe.semiFinishedId);
  
  unitLabel.innerText = `(${semi ? semi.unit : 'kg'})`;
  qtyInput.disabled = false;
  qtyInput.placeholder = `Sản lượng chuẩn định mức của công thức là: ${recipe.outputQuantity} ${semi ? semi.unit : 'kg'}`;
  
  calculateProductionNeeds();
}

function calculateProductionNeeds() {
  const recipeId = document.getElementById('prod-select-recipe').value;
  const runQtyVal = parseFloat(document.getElementById('prod-run-quantity').value);
  const calcBox = document.getElementById('production-calc-results');
  const tbody = document.getElementById('production-calc-table-body');
  const executeBtn = document.getElementById('btn-execute-production');

  if (!recipeId || isNaN(runQtyVal) || runQtyVal <= 0) {
    calcBox.style.display = 'none';
    executeBtn.disabled = true;
    return;
  }

  const recipe = state.recipes.find(r => r.id === recipeId);
  if (!recipe || !recipe.ingredients || recipe.ingredients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted)">Công thức này chưa được định nghĩa nguyên vật liệu!</td></tr>`;
    calcBox.style.display = 'block';
    executeBtn.disabled = true;
    return;
  }

  // Tỉ lệ sản xuất
  const ratio = runQtyVal / recipe.outputQuantity;
  let hasShortage = false;

  tbody.innerHTML = recipe.ingredients.map(ing => {
    const raw = state.rawMaterials.find(r => r.id === ing.rawMaterialId);
    const rawName = raw ? raw.name : 'Nguyên liệu không tồn tại';
    const rawUnit = raw ? raw.unit : 'kg';
    const stockQty = raw ? raw.quantity : 0;
    const requiredQty = ing.quantity * ratio;

    const isSufficient = stockQty >= requiredQty;
    if (!isSufficient) hasShortage = true;

    return `
      <tr>
        <td style="font-weight: 500;">${rawName}</td>
        <td style="text-align: right; font-weight: 600;">${requiredQty.toLocaleString('vi-VN', {maximumFractionDigits: 4})} ${rawUnit}</td>
        <td style="text-align: right; font-weight: 600; color: var(--text-secondary);">${stockQty.toLocaleString('vi-VN')} ${rawUnit}</td>
        <td style="text-align: right;">
          ${isSufficient 
            ? `<span style="font-size:0.7rem; padding:2px 8px; border-radius:4px; background:rgba(34,197,94,0.12); color:#22c55e; border:1px solid rgba(34,197,94,0.25);">Đủ</span>`
            : `<span style="font-size:0.7rem; padding:2px 8px; border-radius:4px; background:rgba(239,68,68,0.12); color:#ef4444; border:1px solid rgba(239,68,68,0.25);">Thiếu ${(requiredQty - stockQty).toLocaleString('vi-VN', {maximumFractionDigits: 4})} ${rawUnit}</span>`
          }
        </td>
      </tr>
    `;
  }).join('');

  calcBox.style.display = 'block';
  // Vô hiệu hóa nút sản xuất nếu thiếu nguyên liệu
  executeBtn.disabled = hasShortage;
}


function handleRecipeExcelImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(worksheet);

      if (json.length === 0) {
        showToast("Tệp Excel không có dữ liệu!", "warning");
        return;
      }

      // 1. Phân tích các cột
      // Ta cần tìm: Mã hàng (Mã nguyên liệu), Tên hàng thành phần (Tên nguyên liệu), Số lượng (Định mức)
      let codeKey = '';
      let nameKey = '';
      let qtyKey = '';

      const sampleRow = json[0];
      const keys = Object.keys(sampleRow);

      const normalizeStr = (str) => {
        if (!str) return '';
        return str.toString().toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Bỏ dấu tiếng Việt
          .replace(/[^a-z0-9]/g, ''); // Bỏ ký tự đặc biệt
      };

      keys.forEach(k => {
        const norm = normalizeStr(k);
        if (norm.includes('mahang') || norm.includes('manlieu') || norm.includes('manguyenlieu') || norm === 'ma' || norm === 'code') {
          codeKey = k;
        } else if (norm.includes('tenhangthanhphan') || norm.includes('tenhang') || norm.includes('tennlieu') || norm.includes('tennguyenlieu') || norm === 'ten' || norm === 'name') {
          nameKey = k;
        } else if (norm.includes('soluong') || norm.includes('sudung') || norm.includes('khoiluong') || norm.includes('dinhmuc') || norm === 'qty' || norm === 'quantity') {
          qtyKey = k;
        }
      });

      // Fallback nếu không đoán được cột định mức / lượng
      if (!qtyKey) {
        for (const k of keys) {
          const val = parseFloat(sampleRow[k]);
          if (!isNaN(val) && val > 0 && val <= 1000) {
            qtyKey = k;
            break;
          }
        }
      }
      
      if (!nameKey) {
        for (const k of keys) {
          if (typeof sampleRow[k] === 'string' && sampleRow[k].length > 2) {
            nameKey = k;
            break;
          }
        }
      }
      
      if (!codeKey && nameKey) {
        codeKey = nameKey;
      }

      if (!qtyKey || !nameKey) {
        showToast("Không nhận diện được cột Tên nguyên liệu hoặc Số lượng/Định mức trong file Excel!", "danger");
        return;
      }

      // 2. Duyệt qua các dòng và trích xuất
      let importedCount = 0;
      let newRawCreated = 0;
      const ingredientsToLoad = [];
      const saveRawPromises = [];

      for (let i = 0; i < json.length; i++) {
        const row = json[i];
        let name = row[nameKey] ? row[nameKey].toString().trim() : '';
        let code = row[codeKey] ? row[codeKey].toString().trim() : '';
        const qty = parseFloat(row[qtyKey]);

        if (!name && !code) continue;
        if (isNaN(qty) || qty <= 0) continue;

        // Trích xuất đơn vị tính từ tên (ví dụ: "Bột đá (kg)" -> tên "Bột đá", ĐVT "kg")
        let unit = 'kg';
        const unitRegex = /\(([^)]+)\)$/;
        const match = name.match(unitRegex);
        if (match) {
          unit = match[1].trim();
          name = name.replace(unitRegex, '').trim();
        }

        if (!code) code = name;

        // Tìm nguyên liệu trong state
        let rawMaterial = state.rawMaterials.find(r => 
          r.code.toLowerCase() === code.toLowerCase() || 
          r.name.toLowerCase() === name.toLowerCase()
        );

        if (!rawMaterial) {
          // Tạo mới nguyên liệu tự động nếu chưa tồn tại
          const newId = `raw-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
          rawMaterial = {
            id: newId,
            code: code.toUpperCase(),
            name: name,
            unit: unit,
            quantity: 0,
            notes: 'Tạo tự động khi nhập Excel công thức'
          };
          state.rawMaterials.push(rawMaterial);
          saveRawPromises.push(dbSaveRawMaterial(rawMaterial));
          newRawCreated++;
        }

        ingredientsToLoad.push({
          rawMaterialId: rawMaterial.id,
          quantity: qty
        });
        importedCount++;
      }

      if (ingredientsToLoad.length === 0) {
        showToast("Không tìm thấy thành phần nguyên vật liệu hợp lệ trong tệp!", "warning");
        return;
      }

      // Lưu nguyên vật liệu mới
      if (newRawCreated > 0) {
        localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));
        await Promise.all(saveRawPromises);
      }

      // Đưa các dòng vào modal nhập công thức
      const container = document.getElementById('recipe-ingredients-rows-container');
      container.innerHTML = ''; // xóa sạch dòng trống cũ

      ingredientsToLoad.forEach(ing => {
        addIngredientRow(ing.rawMaterialId, ing.quantity);
      });

      // Tự động cộng tổng sản lượng định mức chuẩn
      const totalQty = ingredientsToLoad.reduce((sum, ing) => sum + ing.quantity, 0);
      // Đảm bảo làm tròn số đẹp
      const roundedTotal = Math.round((totalQty + Number.EPSILON) * 10000) / 10000;
      document.getElementById('recipe-output-quantity').value = roundedTotal;

      // Reset thẻ input file
      event.target.value = '';

      showToast(`Nhập công thức thành công! Đã nạp ${importedCount} dòng (Tạo mới ${newRawCreated} nguyên liệu).`);
      
      // Vẽ lại bảng nguyên liệu bên ngoài tab Kiểm kho
      renderAll();
    } catch (err) {
      console.error(err);
      showToast("Lỗi đọc tệp Excel: " + err.message, "danger");
    }
  };
  reader.readAsArrayBuffer(file);
}

// --- THIẾT LẬP HÀNH VI CHUNG (LISTENERS & INITIALIZATION) ---

export function setupGoodsPanel() {
  // 1. Chuyển đổi Sub-tabs lớn (Kiểm kho <-> Sản xuất)
  const tabBtns = document.querySelectorAll('.goods-main-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetId = btn.getAttribute('data-sub-target');
      document.querySelectorAll('.goods-sub-panel').forEach(p => {
        if (p.id === targetId) {
          p.classList.add('active');
          p.style.display = 'block';
        } else {
          p.classList.remove('active');
          p.style.display = 'none';
        }
      });
      renderGoodsPanel();
    });
  });

  // 2. Chuyển đổi Inner-tabs nhỏ của Kiểm kho (Nguyên liệu, Bán thành phẩm, Thành phẩm)
  const innerBtns = document.querySelectorAll('.inner-tab-btn');
  innerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      innerBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetId = btn.getAttribute('data-inner-target');
      document.querySelectorAll('.inventory-tab-content').forEach(p => {
        if (p.id === targetId) {
          p.classList.add('active');
          p.style.display = 'block';
        } else {
          p.classList.remove('active');
          p.style.display = 'none';
        }
      });

      // Điều khiển hiển thị các nút thao tác tương ứng ở góc trên bên phải
      const rawBtn = document.getElementById('btn-add-raw-material-modal');
      const semiBtn = document.getElementById('btn-add-semi-finished-modal');
      
      if (targetId === 'inv-raw-tab') {
        rawBtn.style.display = 'inline-flex';
        semiBtn.style.display = 'none';
      } else if (targetId === 'inv-semi-tab') {
        rawBtn.style.display = 'none';
        semiBtn.style.display = 'inline-flex';
      } else {
        rawBtn.style.display = 'none';
        semiBtn.style.display = 'none';
      }

      renderGoodsPanel();
    });
  });

  // 3. Đăng ký mở modal thêm Nguyên liệu / Bán thành phẩm / Công thức
  document.getElementById('btn-add-raw-material-modal')?.addEventListener('click', () => openRawMaterialModal());
  document.getElementById('btn-add-semi-finished-modal')?.addEventListener('click', () => openSemiFinishedModal());
  document.getElementById('btn-add-recipe-modal')?.addEventListener('click', () => openRecipeModal());

  // 4. Modal Close listeners
  const modalCloseMappings = [
    { btn: 'btn-close-raw-material-modal', modal: 'raw-material-modal' },
    { btn: 'btn-cancel-raw-material-modal', modal: 'raw-material-modal' },
    { btn: 'btn-close-semi-finished-modal', modal: 'semi-finished-modal' },
    { btn: 'btn-cancel-semi-finished-modal', modal: 'semi-finished-modal' },
    { btn: 'btn-close-recipe-modal', modal: 'recipe-modal' },
    { btn: 'btn-cancel-recipe-modal', modal: 'recipe-modal' },
    { btn: 'btn-close-finished-stock-modal', modal: 'finished-stock-adjust-modal' },
    { btn: 'btn-cancel-finished-stock-modal', modal: 'finished-stock-adjust-modal' }
  ];

  modalCloseMappings.forEach(mapping => {
    document.getElementById(mapping.btn)?.addEventListener('click', () => {
      document.getElementById(mapping.modal)?.classList.remove('active');
    });
  });

  // 5. Thêm dòng nguyên liệu trong modal công thức
  document.getElementById('btn-recipe-add-ingredient-row')?.addEventListener('click', () => addIngredientRow());

  // Nhập công thức từ tệp Excel
  document.getElementById('btn-recipe-import-excel')?.addEventListener('click', () => {
    document.getElementById('recipe-excel-file-input')?.click();
  });
  document.getElementById('recipe-excel-file-input')?.addEventListener('change', handleRecipeExcelImport);

  // 6. Xử lý lưu Nguyên liệu (Form Submit)
  document.getElementById('raw-material-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idInput = document.getElementById('raw-id').value;
    const code = document.getElementById('raw-code').value.trim().toUpperCase();
    const name = document.getElementById('raw-name').value.trim();
    const unit = document.getElementById('raw-unit').value.trim();
    const quantity = parseFloat(document.getElementById('raw-quantity').value) || 0;
    const notes = document.getElementById('raw-notes').value.trim();

    if (idInput) {
      // Edit mode
      const idx = state.rawMaterials.findIndex(r => r.id === idInput);
      if (idx !== -1) {
        state.rawMaterials[idx] = { ...state.rawMaterials[idx], name, unit, quantity, notes };
        localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));
        await dbSaveRawMaterial(state.rawMaterials[idx]);
        showToast('Cập nhật nguyên liệu thành công.');
      }
    } else {
      // Add mode - kiểm tra trùng mã
      if (state.rawMaterials.some(r => r.code === code)) {
        showToast(`Mã nguyên liệu "${code}" đã tồn tại!`, 'danger');
        return;
      }
      const newItem = { id: `raw-${Date.now()}`, code, name, unit, quantity, notes };
      state.rawMaterials.push(newItem);
      localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));
      await dbSaveRawMaterial(newItem);
      showToast('Thêm nguyên liệu mới thành công.');
    }

    document.getElementById('raw-material-modal').classList.remove('active');
    renderAll();
  });

  // 7. Xử lý lưu Bán thành phẩm (Form Submit)
  document.getElementById('semi-finished-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idInput = document.getElementById('semi-id').value;
    const code = document.getElementById('semi-code').value.trim().toUpperCase();
    const name = document.getElementById('semi-name').value.trim();
    const unit = document.getElementById('semi-unit').value.trim();
    const quantity = parseFloat(document.getElementById('semi-quantity').value) || 0;
    const notes = document.getElementById('semi-notes').value.trim();

    if (idInput) {
      const idx = state.semiFinished.findIndex(s => s.id === idInput);
      if (idx !== -1) {
        state.semiFinished[idx] = { ...state.semiFinished[idx], name, unit, quantity, notes };
        localStorage.setItem('billing_system_semi_finished', JSON.stringify(state.semiFinished));
        await dbSaveSemiFinished(state.semiFinished[idx]);
        showToast('Cập nhật bán thành phẩm thành công.');
      }
    } else {
      if (state.semiFinished.some(s => s.code === code)) {
        showToast(`Mã bán thành phẩm "${code}" đã tồn tại!`, 'danger');
        return;
      }
      const newItem = { id: `semi-${Date.now()}`, code, name, unit, quantity, notes };
      state.semiFinished.push(newItem);
      localStorage.setItem('billing_system_semi_finished', JSON.stringify(state.semiFinished));
      await dbSaveSemiFinished(newItem);
      showToast('Thêm bán thành phẩm mới thành công.');
    }

    document.getElementById('semi-finished-modal').classList.remove('active');
    renderAll();
  });

  // 8. Xử lý lưu Công thức (Form Submit)
  document.getElementById('recipe-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idInput = document.getElementById('recipe-id').value;
    const name = document.getElementById('recipe-name').value.trim();
    const semiFinishedId = document.getElementById('recipe-semi-finished-id').value;
    const outputQuantity = parseFloat(document.getElementById('recipe-output-quantity').value) || 1;
    const notes = document.getElementById('recipe-notes').value.trim();

    // Thu thập các dòng nguyên vật liệu định mức
    const ingredientRows = document.querySelectorAll('#recipe-ingredients-rows-container .ingredient-row');
    const ingredients = [];
    let valid = true;

    ingredientRows.forEach(row => {
      const rawMaterialId = row.querySelector('.ingredient-select').value;
      const quantity = parseFloat(row.querySelector('.ingredient-qty-input').value);

      if (!rawMaterialId || isNaN(quantity) || quantity <= 0) {
        valid = false;
        return;
      }
      
      // Kiểm tra xem nguyên liệu này đã được chọn ở dòng trước chưa
      if (ingredients.some(ing => ing.rawMaterialId === rawMaterialId)) {
        showToast('Không được chọn trùng nguyên vật liệu trong cùng một công thức!', 'danger');
        valid = false;
        return;
      }

      ingredients.push({ rawMaterialId, quantity });
    });

    if (!valid) {
      if (ingredients.length === 0) showToast('Hãy cấu hình ít nhất một dòng nguyên vật liệu hợp lệ!', 'danger');
      return;
    }

    if (idInput) {
      const idx = state.recipes.findIndex(r => r.id === idInput);
      if (idx !== -1) {
        state.recipes[idx] = { ...state.recipes[idx], name, semiFinishedId, outputQuantity, ingredients, notes };
        localStorage.setItem('billing_system_recipes', JSON.stringify(state.recipes));
        await dbSaveRecipe(state.recipes[idx]);
        showToast('Cập nhật công thức sản xuất thành công.');
      }
    } else {
      const newItem = { id: `recipe-${Date.now()}`, name, semiFinishedId, outputQuantity, ingredients, notes };
      state.recipes.push(newItem);
      localStorage.setItem('billing_system_recipes', JSON.stringify(state.recipes));
      await dbSaveRecipe(newItem);
      showToast('Tạo công thức sản xuất thành công.');
    }

    document.getElementById('recipe-modal').classList.remove('active');
    renderAll();
  });

  // 9. Xử lý lưu Điều chỉnh tồn kho Thành phẩm nhanh (Form Submit)
  document.getElementById('finished-stock-adjust-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const productCode = document.getElementById('adjust-prod-code-lbl').innerText;
    const brand = document.getElementById('adjust-prod-brand-lbl').innerText;
    const inputs = e.target.querySelectorAll('.adjust-qty-input');

    const promises = [];
    inputs.forEach(input => {
      const pack = input.getAttribute('data-pack');
      const quantityVal = input.value !== '' ? parseFloat(input.value) : 0;

      const idx = state.finishedGoodsStock.findIndex(s => s.productCode === productCode && s.brand === brand && s.packageType === pack);
      if (idx !== -1) {
        state.finishedGoodsStock[idx].quantity = quantityVal;
        promises.push(dbSaveFinishedGoodsStock(state.finishedGoodsStock[idx]));
      } else {
        const newItem = { productCode, brand, packageType: pack, quantity: quantityVal };
        state.finishedGoodsStock.push(newItem);
        promises.push(dbSaveFinishedGoodsStock(newItem));
      }
    });

    localStorage.setItem('billing_system_finished_goods_stock', JSON.stringify(state.finishedGoodsStock));
    await Promise.all(promises);
    showToast('Điều chỉnh tồn kho thành phẩm thành công.');
    document.getElementById('finished-stock-adjust-modal').classList.remove('active');
    renderAll();
  });

  // 10. Lắng nghe thay đổi Lập lệnh sản xuất
  document.getElementById('prod-select-recipe')?.addEventListener('change', handleRecipeChangeForProduction);
  document.getElementById('prod-run-quantity')?.addEventListener('input', calculateProductionNeeds);

  // 11. Xác nhận Sản xuất (Thực thi lệnh khấu hao kho)
  document.getElementById('btn-execute-production')?.addEventListener('click', async () => {
    const recipeId = document.getElementById('prod-select-recipe').value;
    const runQtyVal = parseFloat(document.getElementById('prod-run-quantity').value);

    if (!recipeId || isNaN(runQtyVal) || runQtyVal <= 0) return;

    const recipe = state.recipes.find(r => r.id === recipeId);
    if (!recipe) return;

    const semi = state.semiFinished.find(s => s.id === recipe.semiFinishedId);
    if (!semi) {
      showToast('Bán thành phẩm cần sản xuất không hợp lệ!', 'danger');
      return;
    }

    const ratio = runQtyVal / recipe.outputQuantity;
    
    // Kiểm tra lần cuối
    let hasShortage = false;
    recipe.ingredients.forEach(ing => {
      const raw = state.rawMaterials.find(r => r.id === ing.rawMaterialId);
      const req = ing.quantity * ratio;
      if (!raw || raw.quantity < req) hasShortage = true;
    });

    if (hasShortage) {
      showToast('Không đủ nguyên vật liệu để sản xuất! Vui lòng kiểm tra lại.', 'danger');
      return;
    }

    // Tiến hành khấu trừ nguyên liệu
    const saveRawPromises = [];
    recipe.ingredients.forEach(ing => {
      const rawIdx = state.rawMaterials.findIndex(r => r.id === ing.rawMaterialId);
      if (rawIdx !== -1) {
        state.rawMaterials[rawIdx].quantity = Math.max(0, state.rawMaterials[rawIdx].quantity - (ing.quantity * ratio));
        saveRawPromises.push(dbSaveRawMaterial(state.rawMaterials[rawIdx]));
      }
    });
    localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));

    // Cộng tồn kho Bán thành phẩm
    const semiIdx = state.semiFinished.findIndex(s => s.id === recipe.semiFinishedId);
    if (semiIdx !== -1) {
      state.semiFinished[semiIdx].quantity += runQtyVal;
      await dbSaveSemiFinished(state.semiFinished[semiIdx]);
    }
    localStorage.setItem('billing_system_semi_finished', JSON.stringify(state.semiFinished));

    // Lưu Nhật ký sản xuất
    const userDisplayName = state.currentUser ? state.currentUser.displayName : 'Administrator';
    
    const usedRawMaterials = recipe.ingredients.map(ing => {
      const raw = state.rawMaterials.find(r => r.id === ing.rawMaterialId);
      return {
        rawMaterialId: ing.rawMaterialId,
        rawMaterialName: raw ? raw.name : 'Unknown',
        quantityUsed: ing.quantity * ratio
      };
    });

    const newLog = {
      id: `plog-${Date.now()}`,
      recipeId: recipe.id,
      recipeName: recipe.name,
      semiFinishedName: semi.name,
      quantity: runQtyVal,
      rawMaterialsUsed: usedRawMaterials,
      createdBy: userDisplayName,
      date: new Date().toISOString()
    };

    state.productionLogs.push(newLog);
    localStorage.setItem('billing_system_production_logs', JSON.stringify(state.productionLogs));
    await dbSaveProductionLog(newLog);

    await Promise.all(saveRawPromises);

    showToast(`Đã sản xuất thành công ${runQtyVal} ${semi.unit} BTP "${semi.name}". Kho nguyên liệu đã tự động khấu trừ.`);
    
    // Reset form
    document.getElementById('prod-select-recipe').value = '';
    document.getElementById('prod-run-quantity').value = '';
    document.getElementById('prod-run-quantity').disabled = true;
    document.getElementById('production-calc-results').style.display = 'none';

    renderAll();
  });

  // 12. Tìm kiếm trong các bảng nguyên liệu / BTP / Thành phẩm / Công thức
  document.getElementById('raw-search-input')?.addEventListener('input', renderRawMaterials);
  document.getElementById('semi-search-input')?.addEventListener('input', renderSemiFinished);
  document.getElementById('finished-stock-search-input')?.addEventListener('input', renderFinishedGoodsStock);
  document.getElementById('finished-stock-brand-filter')?.addEventListener('change', renderFinishedGoodsStock);
  document.getElementById('recipe-search-input')?.addEventListener('input', renderRecipes);
}
