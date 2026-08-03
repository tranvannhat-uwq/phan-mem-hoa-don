import { state } from '../state.js';
import { COMPANY_SUPABASE_URL, COMPANY_SUPABASE_KEY, defaultProducts } from '../config.js';
import { showToast, updateDbStatusUI, isSameUser, getRevenueAttributes, getBrandById } from '../utils.js';
import { rawMaterialsSeed } from '../components/goods_seed.js';
import { normalizePriceListType, filterPriceListsForUser, canUserViewPriceList } from '../domain/pricing.js';
import { collectAllPages } from '../domain/pagination.js';

export let supabaseClient = null;
export let isCloudActive = false;

function removeStorageKeysByPrefix(storage, prefixes) {
  if (!storage) return;
  for (let i = storage.length - 1; i >= 0; i -= 1) {
    const key = storage.key(i);
    if (key && prefixes.some(prefix => key.startsWith(prefix))) {
      storage.removeItem(key);
    }
  }
}

export function clearSupabaseAuthStorage() {
  const authKeyPrefixes = ['sb-', 'supabase.auth.token'];
  removeStorageKeysByPrefix(localStorage, authKeyPrefixes);
  removeStorageKeysByPrefix(sessionStorage, authKeyPrefixes);
}

// Tên các bảng trên cơ sở dữ liệu (tự động điều chỉnh dựa trên sự tồn tại của tiền tố wl_)
export let tableProductsName = 'products';
export let tableOrdersName = 'orders';
export let tableDraftOrdersName = 'draft_orders';
export let tableCustomersName = 'customers';
export let tablePricelistsName = 'pricelists';
export let tablePriceListItemsName = 'price_list_items';
// Authorization profiles linked to Supabase Auth. Never query legacy users.password.
export let tableUsersName = 'profiles';
export let tableBrandsName = 'brands';
export let tableCashbookTransactionsName = 'cashbook_transactions';
export let tableStartingBalancesName = 'starting_balances';
export let tableRawMaterialsName = 'raw_materials';
export let tableSemiFinishedName = 'semi_finished';
export let tableRecipesName = 'recipes';
export let tableProductionLogsName = 'production_logs';
export let tableFinishedGoodsStockName = 'finished_goods_stock';
export let tableSalesReturnsName = 'sales_returns';
export let tableSalesReturnItemsName = 'sales_return_items';
export let tableOrderItemsName = 'order_items';
export let tableCustomerDebtTransactionsName = 'customer_debt_transactions';
export let tableCustomerAssignmentsName = 'customer_assignments';
export let tableCommissionRulesName = 'commission_rules';
export let tableCommissionTransactionsName = 'commission_transactions';


export function setCloudActive(active) {
  isCloudActive = active;
}

// Tải dữ liệu dự phòng từ LocalStorage khi mất kết nối mạng
export function loadLocalStorageBackup() {
  const storedProducts = localStorage.getItem('billing_system_products');
  const storedOrders = localStorage.getItem('billing_system_orders');
  
  if (storedProducts && JSON.parse(storedProducts).length > 0) {
    state.products = JSON.parse(storedProducts);
  } else {
    state.products = [...defaultProducts];
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  }
  
  if (storedOrders) {
    state.savedOrders = JSON.parse(storedOrders);
  } else {
    state.savedOrders = [];
    localStorage.setItem('billing_system_orders', JSON.stringify(state.savedOrders));
  }

  const storedCustomers = localStorage.getItem('billing_system_customers');
  if (storedCustomers && JSON.parse(storedCustomers).length > 0) {
    state.customers = JSON.parse(storedCustomers);
  } else {
    state.customers = [];
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  }

  const storedSuppliers = localStorage.getItem('billing_system_suppliers');
  if (storedSuppliers && JSON.parse(storedSuppliers).length > 0) {
    state.suppliers = JSON.parse(storedSuppliers);
  } else {
    state.suppliers = [
      { id: 'supplier-abs', code: 'NCC001', name: 'CÔNG TY CỔ PHẦN ABS JAPAN', phone: '088.603.7878', address: 'Tiên Kha - Phúc Thịnh - Hà Nội', debt: 0, notes: 'Nhà máy cung cấp sơn chính hãng Nano10*' }
    ];
    localStorage.setItem('billing_system_suppliers', JSON.stringify(state.suppliers));
  }

  // Identity and role are never restored from browser-controlled storage.
  localStorage.removeItem('billing_system_users');
  state.users = [];

  // Price-list data is permission-sensitive and must never survive a user
  // switch in browser storage. Keep only non-secret bootstrap lists in memory.
  localStorage.removeItem('billing_system_pricelists');
  localStorage.removeItem('billing_system_price_list_items');
  state.pricelists = [
      {
        id: 'pl-02',
        name: 'Bảng giá 02',
        brandDiscounts: {
          'Nano10*': 74.7,
          'Hatacco nano': 0,
          'mutsutec': 0,
          'tdkaw': 0,
          'cova': 0,
          'festivanano': 0
        }
      },
      {
        id: 'pl-03',
        name: 'Bảng giá 03',
        brandDiscounts: {
          'Nano10*': 76,
          'Hatacco nano': 0,
          'mutsutec': 0,
          'tdkaw': 0,
          'cova': 0,
          'festivanano': 0
        }
      }
  ];
  state.allPricelists = [...state.pricelists];
  state.priceListItems = [];
  state.allPriceListItems = [];

  const storedBrands = localStorage.getItem('billing_system_brands');
  if (storedBrands) {
    state.brands = JSON.parse(storedBrands);
  } else {
    state.brands = [
      { name: 'COVA NANO', companyName: 'Công ty Cổ phần ABS JAPAN (Miền Bắc)', companyId: 'ABS_NORTH', logoFilename: 'absjapan.png' },
      { name: 'FESTIVA NANO', companyName: 'Công ty Cổ phần EMP Hoa Kỳ', companyId: 'EMP_USA', logoFilename: 'festiva.png' },
      { name: 'HATACCO NANO', companyName: 'Công ty Cổ phần EMP Hoa Kỳ', companyId: 'EMP_USA', logoFilename: 'hatacco.png' },
      { name: 'MUTSUTEC NANO', companyName: 'Công ty Cổ phần ABS JAPAN (Miền Bắc)', companyId: 'ABS_NORTH', logoFilename: 'absjapan.png' },
      { name: 'NANO10 MB', companyName: 'Công ty Cổ phần ABS JAPAN (Miền Bắc)', companyId: 'ABS_NORTH', logoFilename: 'absjapan.png' },
      { name: 'NANO10 MN', companyName: 'Công ty Cổ phần ABS JAPAN - Chi nhánh Miền Nam', companyId: 'ABS_SOUTH', logoFilename: 'absjapan.png' },
      { name: 'TDKAW NANO', companyName: 'Công ty Cổ phần ABS JAPAN (Miền Bắc)', companyId: 'ABS_NORTH', logoFilename: 'absjapan.png' }
    ];
    localStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
  }

  const storedRaw = localStorage.getItem('billing_system_raw_materials');
  if (storedRaw && JSON.parse(storedRaw).length > 0) {
    state.rawMaterials = JSON.parse(storedRaw);
  } else {
    state.rawMaterials = [...rawMaterialsSeed];
    localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));
  }

  const storedSemi = localStorage.getItem('billing_system_semi_finished');
  if (storedSemi) {
    state.semiFinished = JSON.parse(storedSemi);
  } else {
    state.semiFinished = [];
    localStorage.setItem('billing_system_semi_finished', JSON.stringify([]));
  }

  const storedRecipes = localStorage.getItem('billing_system_recipes');
  if (storedRecipes) {
    state.recipes = JSON.parse(storedRecipes);
  } else {
    state.recipes = [];
    localStorage.setItem('billing_system_recipes', JSON.stringify([]));
  }

  const storedLogs = localStorage.getItem('billing_system_production_logs');
  if (storedLogs) {
    state.productionLogs = JSON.parse(storedLogs);
  } else {
    state.productionLogs = [];
    localStorage.setItem('billing_system_production_logs', JSON.stringify([]));
  }

  const storedFgs = localStorage.getItem('billing_system_finished_goods_stock');
  if (storedFgs) {
    state.finishedGoodsStock = JSON.parse(storedFgs);
  } else {
    state.finishedGoodsStock = [];
    localStorage.setItem('billing_system_finished_goods_stock', JSON.stringify([]));
  }
}

// Kết nối đến Supabase
export async function connectSupabase(url, key, verbose = true) {
  try {
    if (typeof supabase === 'undefined') {
      throw new Error('Thư viện Supabase chưa được tải (vui lòng kiểm tra kết nối mạng).');
    }
    const client = supabase.createClient(url, key);
    const { data: { session: connectionSession } } = await client.auth.getSession();
    
    // Kiểm tra cấu trúc bảng để gán tiền tố wl_ nếu có (Kiểm tra bảng gốc trước để tránh ném lỗi 404 vào Console trình duyệt)
    if (connectionSession?.user) {
    let { error: testNormalErr } = await client.from('products').select('code').limit(1);
    if (!testNormalErr) {
      tableProductsName = 'products';
      tableOrdersName = 'orders';
      tableDraftOrdersName = 'draft_orders';
      tableCustomersName = 'customers';
      tablePricelistsName = 'pricelists';
      tablePriceListItemsName = 'price_list_items';
      tableUsersName = 'profiles';
      tableBrandsName = 'brands';
      tableCashbookTransactionsName = 'cashbook_transactions';
      tableStartingBalancesName = 'starting_balances';
      tableRawMaterialsName = 'raw_materials';
      tableSemiFinishedName = 'semi_finished';
      tableRecipesName = 'recipes';
      tableProductionLogsName = 'production_logs';
      tableFinishedGoodsStockName = 'finished_goods_stock';
      tableSalesReturnsName = 'sales_returns';
      tableSalesReturnItemsName = 'sales_return_items';
      tableOrderItemsName = 'order_items';
    } else {
      let { error: testWlErr } = await client.from('wl_products').select('code').limit(1);
      if (!testWlErr) {
        tableProductsName = 'wl_products';
        tableOrdersName = 'wl_orders';
        tableDraftOrdersName = 'wl_draft_orders';
        tableCustomersName = 'wl_customers';
        tablePricelistsName = 'wl_pricelists';
        tablePriceListItemsName = 'wl_price_list_items';
        tableUsersName = 'profiles';
        tableBrandsName = 'wl_brands';
        tableCashbookTransactionsName = 'wl_cashbook_transactions';
        tableStartingBalancesName = 'wl_starting_balances';
        tableRawMaterialsName = 'wl_raw_materials';
        tableSemiFinishedName = 'wl_semi_finished';
        tableRecipesName = 'wl_recipes';
        tableProductionLogsName = 'wl_production_logs';
        tableFinishedGoodsStockName = 'wl_finished_goods_stock';
        tableSalesReturnsName = 'wl_sales_returns';
        tableSalesReturnItemsName = 'wl_sales_return_items';
        tableOrderItemsName = 'wl_order_items';
      } else {
        tableProductsName = 'products';
        tableOrdersName = 'orders';
        tableDraftOrdersName = 'draft_orders';
        tableCustomersName = 'customers';
        tablePricelistsName = 'pricelists';
        tablePriceListItemsName = 'price_list_items';
        tableUsersName = 'profiles';
        tableBrandsName = 'brands';
        tableCashbookTransactionsName = 'cashbook_transactions';
        tableStartingBalancesName = 'starting_balances';
        tableRawMaterialsName = 'raw_materials';
        tableSemiFinishedName = 'semi_finished';
        tableRecipesName = 'recipes';
        tableProductionLogsName = 'production_logs';
        tableFinishedGoodsStockName = 'finished_goods_stock';
        tableSalesReturnsName = 'sales_returns';
        tableSalesReturnItemsName = 'sales_return_items';
        tableOrderItemsName = 'order_items';
      }
    }
    
    }
    supabaseClient = client;
    isCloudActive = true;
    
    localStorage.setItem('billing_supabase_url', url);
    localStorage.setItem('billing_supabase_key', key);
    
    const dbUrlInput = document.getElementById('db-url');
    const dbKeyInput = document.getElementById('db-anon-key');
    if (dbUrlInput) dbUrlInput.value = url;
    if (dbKeyInput) dbKeyInput.value = key;
    
    const disconnectBtn = document.getElementById('btn-disconnect-db');
    const syncSection = document.getElementById('sync-section');
    const backupSection = document.getElementById('backup-section');
    if (disconnectBtn) disconnectBtn.style.display = 'inline-flex';
    if (syncSection) syncSection.style.display = 'block';
    if (backupSection) backupSection.style.display = 'block';
    
    updateDbStatusUI('cloud');
    
    if (connectionSession?.user) {
      try {
        await fetchCloudData();
      } catch (cloudErr) {
        console.warn('Lỗi tải dữ liệu đám mây, chuyển về dùng LocalStorage backup:', cloudErr);
        loadLocalStorageBackup();
      }
    }
    
    if (verbose) {
      showToast('Kết nối cơ sở dữ liệu đám mây Supabase thành công!');
    }
    return true;
  } catch(err) {
    console.error('Supabase connection error:', err);
    if (verbose) {
      let errMsg = 'Kiểm tra lại URL hoặc API Key';
      if (err) {
        errMsg = err.message || err.details || JSON.stringify(err);
      }
      showToast('Lỗi kết nối Supabase: ' + errMsg, 'danger');
    }
    return false;
  }
}

// Ngắt kết nối đám mây
export function disconnectSupabase() {
  localStorage.removeItem('billing_supabase_url');
  localStorage.removeItem('billing_supabase_key');
  clearSupabaseAuthStorage();
  
  supabaseClient = null;
  isCloudActive = false;
  
  const form = document.getElementById('supabase-config-form');
  const disconnectBtn = document.getElementById('btn-disconnect-db');
  const syncSection = document.getElementById('sync-section');
  const backupSection = document.getElementById('backup-section');
  
  if (form) form.reset();
  if (disconnectBtn) disconnectBtn.style.display = 'none';
  if (syncSection) syncSection.style.display = 'none';
  if (backupSection) backupSection.style.display = 'none';
  
  updateDbStatusUI('local');
  showToast('Đã ngắt kết nối đám mây, chuyển về LocalStorage cục bộ.', 'warning');
}

// Kết nối lại
export async function retrySupabaseConnection() {
  const savedUrl = localStorage.getItem('billing_supabase_url');
  const savedKey = localStorage.getItem('billing_supabase_key');
  if (!savedUrl || !savedKey) {
    showToast('Chưa có thông tin cấu hình Cloud. Vui lòng cấu hình trong phần Cấu hình Cloud.', 'warning');
    return false;
  }
  
  updateDbStatusUI('connecting', 'Đang kết nối lại...');
  const connected = await connectSupabase(savedUrl, savedKey, true);
  if (!connected) {
    updateDbStatusUI('local_failed');
  }
  return connected;
}

// Hàm phụ trợ tải toàn bộ dữ liệu (bỏ giới hạn mặc định 1000 dòng của PostgREST)
async function fetchFullTableData(tableName) {
  const pageSize = 1000;
  return collectAllPages((offset, end) => supabaseClient
      .from(tableName)
      .select('*', { count: 'exact' })
      .range(offset, end), pageSize);
}

function parseDebtHistory(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function mapCustomerDebtTransaction(row) {
  const debtChange = Number(row.debt_change || 0);
  const typeMap = {
    order: 'charge', payment: 'payment', payment_cancel: 'payment_cancel',
    order_cancel: 'order_cancel', return: 'return', return_cancel: 'return_cancel', adjust: 'adjust'
  };
  return {
    id: row.id,
    customerId: row.customer_id,
    type: typeMap[row.transaction_type] || 'adjust',
    transactionType: row.transaction_type || 'adjust',
    amount: Number(row.amount ?? Math.abs(debtChange)),
    debtChange,
    debtBefore: Number(row.balance_before || 0),
    debtAfter: Number(row.balance_after || 0),
    date: row.transaction_date || row.created_at,
    note: row.description || '',
    notes: row.description || '',
    orderId: row.order_id || null,
    salesReturnId: row.sales_return_id || null,
    cashbookTransactionId: row.cashbook_transaction_id || null,
    reversalOfId: row.reversal_of_id || null
  };
}

async function hydrateCustomerDebtHistory(customers) {
  if (!Array.isArray(customers) || customers.length === 0) return customers;
  const rows = await fetchFullTableData(tableCustomerDebtTransactionsName);
  const byCustomer = new Map();
  (rows || []).forEach(row => {
    const key = String(row.customer_id || '');
    if (!key) return;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(mapCustomerDebtTransaction(row));
  });
  customers.forEach(customer => {
    const merged = new Map();
    parseDebtHistory(customer.debtHistory).forEach(item => {
      const key = String(item?.id || `legacy:${item?.date || ''}:${item?.type || ''}:${item?.amount || 0}`);
      merged.set(key, item);
    });
    (byCustomer.get(String(customer.id)) || []).forEach(item => merged.set(String(item.id), item));
    customer.debtHistory = [...merged.values()];
  });
  return customers;
}

async function fetchCustomerDebtRows(customerId) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseClient
      .from(tableCustomerDebtTransactionsName)
      .select('*')
      .eq('customer_id', customerId)
      .order('transaction_date', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function mapCashbookTransaction(t) {
  const rawNote = t.note || '';
  const supplierMeta = rawNote.match(/__supplierId=([^\s]+)/);
  return {
    id: t.id, cloudId: t.id, date: t.date || t.transaction_date,
    type: t.type || (t.direction === 'out' ? 'chi' : 'thu'),
    direction: t.direction || (t.type === 'chi' ? 'out' : 'in'),
    transactionType: t.transaction_type || null,
    category: t.category || t.transaction_type,
    partner: t.partner, value: parseFloat(t.value || 0),
    method: t.method || t.payment_method || 'cash', accounting: t.accounting,
    status: t.status, creator: t.creator || t.created_by,
    note: rawNote.replace(/\s*__supplierId=[^\s]+/g, '').trim(),
    starred: t.starred, customerId: t.customer_id || null,
    debtImpact: t.transaction_type === 'customer_payment',
    supplierId: t.supplier_id || (supplierMeta ? supplierMeta[1] : null),
    orderId: t.order_id || null, salesReturnId: t.sales_return_id || null,
    employeeId: t.employee_id || null, reversalOfId: t.reversal_of_id || null,
    cancelledAt: t.cancelled_at || null, cancellationReason: t.cancellation_reason || ''
  };
}

function isMissingSchemaCacheRelationError(error, relationName) {
  const message = String(error?.message || '');
  return error?.code === 'PGRST205' &&
    message.includes(`'${relationName}'`) &&
    message.toLowerCase().includes('schema cache');
}

function handleOptionalProductGroupsError(error) {
  if (isMissingSchemaCacheRelationError(error, 'public.product_groups') || isMissingSchemaCacheRelationError(error, 'product_groups')) {
    console.warn('Skipping product_groups sync because the table is not available in Supabase schema cache:', error.message);
    return true;
  }
  if (error?.code === '42501' && String(error?.message || '').includes('row-level security policy') && String(error?.message || '').includes('product_groups')) {
    console.warn('Skipping product_groups sync because Supabase RLS denied access:', error.message);
    return true;
  }
  return false;
}

const optionalProductSchemaColumns = new Set([
  'variant_code',
  'product_group_id',
  'base_code',
  'base_product_id',
  'parent_product_id',
  'brand_id',
  'packaging_name',
  'weight_or_volume',
  'unit_name',
  'conversion_quantity',
  'barcode',
  'purchase_price',
  'product_group',
  'is_legacy'
]);
const unavailableProductSchemaColumns = new Set();

function getMissingSchemaCacheColumnName(error, tableName) {
  const message = String(error?.message || '');
  if (error?.code !== 'PGRST204' || !message.toLowerCase().includes('schema cache')) return null;
  if (tableName && !message.includes(`'${tableName}'`)) return null;
  const match = message.match(/Could not find the '([^']+)' column/i);
  return match?.[1] || null;
}

function stripUnavailableProductColumns(row) {
  const clone = { ...row };
  unavailableProductSchemaColumns.forEach(column => delete clone[column]);
  return clone;
}

async function runProductWriteWithSchemaFallback(writeFactory) {
  for (let attempt = 0; attempt < optionalProductSchemaColumns.size + 1; attempt += 1) {
    const { error } = await writeFactory(stripUnavailableProductColumns);
    if (!error) return { error: null };

    const missingColumn = getMissingSchemaCacheColumnName(error, tableProductsName);
    if (!missingColumn || !optionalProductSchemaColumns.has(missingColumn) || unavailableProductSchemaColumns.has(missingColumn)) {
      return { error };
    }

    unavailableProductSchemaColumns.add(missingColumn);
    console.warn(`Retrying product save without unavailable Supabase column "${missingColumn}".`);
  }
  return { error: new Error('Supabase products schema is missing too many optional columns.') };
}

function normalizeProductRow(row, localProducts = []) {
  const local = localProducts.find(lp => lp.id === row.id || (lp.code === row.code && lp.brand === row.brand));
  return {
    id: row.id || null,
    code: row.code,
    variantCode: row.variant_code || row.code,
    productGroupId: row.product_group_id || row.base_product_id || row.parent_product_id || null,
    baseCode: row.base_code || '',
    baseProductId: row.base_product_id || row.parent_product_id || row.baseProductId || null,
    parentProductId: row.parent_product_id || row.base_product_id || row.parentProductId || null,
    name: row.name,
    brand: row.brand || (local ? local.brand : 'Nano10*'),
    brandId: row.brand_id || (local ? local.brandId : null),
    group: row.product_group || row.group || (local ? local.group : ''),
    packageType: row.package_type || row.packageType || '',
    packagingName: row.packaging_name || row.package_type || row.packageType || '',
    packageWeight: row.package_weight || row.packageWeight || '',
    weightOrVolume: row.weight_or_volume ?? row.package_weight ?? row.packageWeight ?? '',
    packageWeightUnit: row.package_weight_unit || row.packageWeightUnit || row.unit || (local ? local.packageWeightUnit : 'kg'),
    unitName: row.unit_name || row.package_weight_unit || row.packageWeightUnit || row.unit || 'kg',
    displaySpecification: row.display_specification || row.displaySpecification || '',
    conversionQuantity: Number(row.conversion_quantity || 1),
    barcode: row.barcode || '',
    purchasePrice: Number(row.purchase_price || 0),
    categoryId: row.category_id || null,
    description: row.description || '',
    isActive: row.is_active !== false,
    isLegacy: row.is_legacy === true,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}

// Tải toàn bộ dữ liệu từ Supabase về State
export async function fetchCloudData() {
  if (!supabaseClient) return;
  try {
    // Luồng tải dữ liệu lõi (nếu lỗi sẽ dừng và báo lỗi toàn cục)
    const fetchProducts = async () => {
      try {
        const { data: prodData, error: prodErr } = await supabaseClient
          .from(tableProductsName)
          .select('*')
          .order('code', { ascending: true });
          
        if (prodErr) throw prodErr;
        
        const localProducts = JSON.parse(localStorage.getItem('billing_system_products') || '[]');
        state.products = (prodData || []).map(row => normalizeProductRow(row, localProducts));
        localStorage.setItem('billing_system_products', JSON.stringify(state.products));
      } catch (prodErr) {
        console.warn("Could not load products from Supabase, fallback to local:", prodErr.message);
        state.products = JSON.parse(localStorage.getItem('billing_system_products') || '[]');
      }
    };

    const fetchOrders = async () => {
      try {
        try {
          const twoDaysAgo = new Date();
          twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
          await supabaseClient
            .from(tableDraftOrdersName)
            .delete()
            .lt('created_at', twoDaysAgo.toISOString());
        } catch (cleanErr) {
          console.warn("Could not auto-cleanup old drafts on Cloud:", cleanErr.message);
        }

        const [{ data: orderPage, error: orderPageError }, rawDrafts] = await Promise.all([
          supabaseClient.rpc('rpc_get_orders_paginated', {
            p_search: '',
            p_status: null,
            p_customer_id: null,
            p_limit: 10000,
            p_offset: 0
          }),
          fetchFullTableData(tableDraftOrdersName)
        ]);
        const rawOrders = !orderPageError && orderPage && Array.isArray(orderPage.data)
          ? orderPage.data
          : await fetchFullTableData(tableOrdersName);

        const mapOrderRow = (order, isDraft) => {
          let status = isDraft ? 'draft' : (order.status || 'settled');
          let notes = order.notes || '';
          return {
            id: order.id,
            customerId: order.customer_id || null,
            customerName: order.customer_name,
            notes: notes,
            items: typeof order.items === 'string' ? JSON.parse(order.items) : order.items,
            date: order.order_date || order.created_at,
            pricingVersion: order.pricing_version || order.pricingVersion || '',
            totalMarket: parseFloat(order.total_market || 0),
            totalDiscount: parseFloat(order.total_discount || 0),
            subtotal: parseFloat(order.subtotal !== undefined ? order.subtotal : (order.total_payable || 0)),
            discountValue: parseFloat(order.discount_value !== undefined ? order.discount_value : (order.discountValue || 0)),
            discountType: order.discount_type || order.discountType || 'amount',
            discountAmount: parseFloat(order.discount_amount !== undefined ? order.discount_amount : (order.discountAmount || 0)),
            otherFeeValue: parseFloat(order.other_fee_value !== undefined ? order.other_fee_value : (order.otherFeeValue || 0)),
            otherFeeType: order.other_fee_type || order.otherFeeType || 'amount',
            otherFeeAmount: parseFloat(order.other_fee_amount !== undefined ? order.other_fee_amount : (order.otherFeeAmount || 0)),
            shippingFeeValue: parseFloat(order.shipping_fee_value !== undefined ? order.shipping_fee_value : (order.shippingFeeValue || 0)),
            shippingFeeAmount: parseFloat(order.shipping_fee_amount !== undefined ? order.shipping_fee_amount : (order.shippingFeeAmount || 0)),
            totalPayable: parseFloat(order.total_payable || 0),
            returnedAmount: parseFloat(order.returned_amount || 0),
            netRevenue: parseFloat(order.net_revenue || order.total_payable || 0),
            paidAmount: parseFloat(order.paid_amount !== undefined ? order.paid_amount : (order.other_fee_amount || 0)),
            amountDue: Math.max(
              0,
              parseFloat(order.total_payable || 0) -
              parseFloat(order.paid_amount !== undefined ? order.paid_amount : (order.other_fee_amount || 0)) +
              parseFloat(order.shipping_fee_amount !== undefined ? order.shipping_fee_amount : (order.shippingFeeAmount || 0))
            ),
            pricelistId: order.pricelist_id || 'retail',
            createdBy: order.created_by || 'admin',
            companyId: order.company_id || order.companyId || 'ABS_NORTH',
            status: status
          };
        };

        const mappedOrders = rawOrders.map(o => mapOrderRow(o, false));
        const mappedDrafts = rawDrafts.map(o => mapOrderRow(o, true));

        const combined = [...mappedOrders, ...mappedDrafts].sort((a, b) => new Date(b.date) - new Date(a.date));
        state.savedOrders = combined;
        localStorage.setItem('billing_system_orders', JSON.stringify(state.savedOrders));
      } catch (ordErr) {
        console.warn("Could not load orders from Supabase, fallback to local:", ordErr.message);
        state.savedOrders = JSON.parse(localStorage.getItem('billing_system_orders') || '[]');
      }
    };

    // Các luồng tải phụ trợ (lỗi từng bảng sẽ được bắt riêng biệt để tránh hỏng cả ứng dụng)
    const fetchCustomers = async () => {
      try {
        // The paginated RPC intentionally caps one call at 500 rows. The
        // customer screen filters client-side, so load every RLS-visible page.
        const customerData = await fetchFullTableData(tableCustomersName);
        // A successful empty Cloud response is authoritative (for example
        // after the guarded business-data reset). Local data is used only in
        // the catch branch when the Cloud request actually fails.
        state.customers = (customerData || []).map(cust => ({
            id: cust.id,
            code: cust.code,
            name: cust.name,
            phone: cust.phone,
            address: cust.address,
            assignedBrand: cust.assigned_brand || 'Tất cả',
            brandDiscounts: typeof cust.brand_discounts === 'string' ? JSON.parse(cust.brand_discounts) : (cust.brand_discounts || {}),
            shippingSupport: cust.shipping_support || false,
            debt: parseFloat(cust.debt || 0),
            totalTransaction: parseFloat(cust.total_transaction || 0),
            totalReturn: parseFloat(cust.total_return || 0),
            netRevenue: parseFloat(cust.net_revenue || 0),
            importedDebtBaseline: parseFloat(cust.imported_debt_baseline || 0),
            importedTotalTransactionBaseline: parseFloat(cust.imported_total_transaction_baseline || 0),
            importedTotalReturnBaseline: parseFloat(cust.imported_total_return_baseline || 0),
            importedNetRevenueBaseline: parseFloat(cust.imported_net_revenue_baseline || 0),
            importedLastOrderAtBaseline: cust.imported_last_order_at_baseline || null,
            importedCreatedAtBaseline: cust.imported_created_at_baseline || null,
            financialBaselineImportedAt: cust.financial_baseline_imported_at || null,
            lastOrderAt: cust.last_order_at || null,
            lastPaymentAt: cust.last_payment_at || null,
            createdAt: cust.created_at || null,
            updatedAt: cust.updated_at || null,
            notes: cust.notes || '',
            pricelistId: cust.pricelist_id || '',
            defaultPriceListId: cust.default_price_list_id || cust.pricelist_id || '',
            customerGroupId: cust.customer_group_id || '',
            managedBy: cust.managed_by || '',
            debtHistory: parseDebtHistory(cust.debt_history)
          }));
        if (state.customers.length > 0) {
          await hydrateCustomerDebtHistory(state.customers);
        }
        if (state.activeCustomerId && !state.customers.some(customer => customer.id === state.activeCustomerId)) {
          state.activeCustomerId = null;
        }
        localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      } catch (custErr) {
        console.warn("Could not load customers from Supabase, using local fallback:", custErr.message);
        state.customers = JSON.parse(localStorage.getItem('billing_system_customers') || '[]');
      }
    };

    const fetchPricelists = async () => {
      try {
        const { data: plData, error: plErr } = await supabaseClient
          .from(tablePricelistsName)
          .select('*');

        if (plErr) throw plErr;

        const mappedPricelists = (plData || []).map(pl => ({
            id: pl.id,
            code: pl.code || '',
            name: pl.name,
            type: normalizePriceListType(pl.price_list_type || pl.type, pl.customer_id),
            customerId: pl.customer_id || null,
            customerGroupId: pl.customer_group_id || null,
            parentPriceListId: pl.parent_price_list_id || null,
            effectiveFrom: pl.effective_from || '',
            effectiveTo: pl.effective_to || '',
            isActive: pl.is_active !== false,
            isAvailableForSales: pl.is_available_for_sales === true,
            displayOrder: Number(pl.display_order || 0),
            createdAt: pl.created_at || '',
            updatedAt: pl.updated_at || '',
            brandDiscounts: typeof pl.brand_discounts === 'string' ? JSON.parse(pl.brand_discounts) : (pl.brand_discounts || {})
          }));
        state.allPricelists = mappedPricelists;
        state.pricelists = filterPriceListsForUser(mappedPricelists, state.currentUser);

        try {
          const itemData = await fetchFullTableData(tablePriceListItemsName);
          const visiblePriceListIds = new Set(state.pricelists.map(priceList => priceList.id));
          state.allPriceListItems = (itemData || []).map(item => ({
            id: item.id || `${item.price_list_id}:${item.product_id}`,
            priceListId: item.price_list_id,
            productId: item.variant_id || item.product_id,
            variantId: item.variant_id || item.product_id,
            price: parseFloat(item.price || 0),
            isOverride: item.is_override !== false,
            sourceType: item.source_type || 'manual',
            createdAt: item.created_at || '',
            updatedAt: item.updated_at || '',
            updatedBy: item.updated_by || ''
          }));
          state.priceListItems = state.allPriceListItems
          .filter(item => visiblePriceListIds.has(item.priceListId));
        } catch (itemErr) {
          console.warn("Could not load authorized price_list_items:", itemErr.message);
          state.priceListItems = [];
          state.allPriceListItems = [];
        }
      } catch (plErr) {
        console.warn("Could not load authorized pricelists from Supabase:", plErr.message);
        state.pricelists = [];
        state.allPricelists = [];
        state.priceListItems = [];
        state.allPriceListItems = [];
      }
    };

    const fetchUsers = async () => {
      try {
        const { data: userData, error: userErr } = await supabaseClient
          .from(tableUsersName)
          .select('*');

        if (userErr) throw userErr;

        const cloudUsers = (userData || []).map(u => {
          return {
            id: u.id,
            authUserId: u.auth_user_id || null,
            username: u.username,
            displayName: u.display_name,
            role: u.role || 'sale',
            companyId: u.company_id || u.companyId || 'ABS_NORTH',
            isExternal: u.is_external || false,
            isActive: u.is_active !== false
          };
        });

        const merged = [...cloudUsers];
        
        const uniqueUsers = [];
        merged.forEach(u => {
          const isOldAbs = u.username === 'abs_japan' || u.username === 'abs-japan' || u.username === 'absjapan';
          if (isOldAbs) {
            const hasNewAbs = merged.some(ru => ru.username === 'ctyabs@lendon.com');
            if (hasNewAbs) return;
          }
          const isDup = uniqueUsers.some(uu => isSameUser(uu.username, u.username) || uu.displayName === u.displayName);
          if (!isDup) {
            uniqueUsers.push(u);
          }
        });

        state.users = uniqueUsers;
      } catch (uErr) {
        console.warn("Could not load authenticated profiles from Supabase:", uErr.message);
        state.users = [];
      }
    };

    const fetchBrands = async () => {
      try {
        const { data: brandData, error: brandErr } = await supabaseClient
          .from(tableBrandsName)
          .select('*')
          .order('name', { ascending: true });

        if (brandErr) throw brandErr;

        const localBrands = JSON.parse(localStorage.getItem('billing_system_brands') || '[]');
        let sourceData = (brandData && brandData.length > 0) ? brandData : localBrands;

        const uniqueBrands = [];
        const seenIds = new Set();
        const seenNames = new Set();
        (sourceData || []).forEach(b => {
          const bId = b.id || ('brand_' + String(b.name).toLowerCase().replace(/[^a-z0-9]/g, ''));
          const normName = String(b.name).toLowerCase();
          if (!seenIds.has(bId) && !seenNames.has(normName)) {
            seenIds.add(bId);
            seenNames.add(normName);
            uniqueBrands.push({
              id: bId,
              name: b.name,
              companyId: b.company_id || b.companyId || null,
              companyName: b.company_name || b.companyName || 'Dùng chung',
              logoFilename: b.logo_filename || b.logoFilename || '',
              hotline: b.hotline || '',
              cskh: b.cskh || '',
              email: b.email || '',
              addressMain: b.address_main || b.addressMain || '',
              addressFactory: b.address_factory || b.addressFactory || '',
              addressBusiness: b.address_business || b.addressBusiness || null
            });
          }
        });

        state.brands = uniqueBrands;
        localStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
      } catch (brandErr) {
        console.warn("Could not load brands from Supabase:", brandErr.message);
        state.brands = JSON.parse(localStorage.getItem('billing_system_brands') || '[]');
      }
    };

    const fetchCashbook = async () => {
      try {
        const { data: txData, error: txErr } = await supabaseClient
          .from(tableCashbookTransactionsName)
          .select('*')
          .order('date', { ascending: false });

        if (txErr) throw txErr;

        const cloudTxs = (txData || []).map(t => {
            const rawNote = t.note || '';
            const supplierMeta = rawNote.match(/__supplierId=([^\s]+)/);
            const cleanNote = rawNote.replace(/\s*__supplierId=[^\s]+/g, '').trim();
            return {
              id: t.id,
              cloudId: t.id,
              date: t.date || t.transaction_date,
              type: t.type || (t.direction === 'out' ? 'chi' : 'thu'),
              direction: t.direction || (t.type === 'chi' ? 'out' : 'in'),
              transactionType: t.transaction_type || null,
              category: t.category || t.transaction_type,
              partner: t.partner,
              value: parseFloat(t.value || 0),
              method: t.method || t.payment_method || 'cash',
              accounting: t.accounting,
              status: t.status,
              creator: t.creator || t.created_by,
              note: cleanNote,
              starred: t.starred,
              customerId: t.customer_id || null,
              debtImpact: t.transaction_type === 'customer_payment',
              supplierId: t.supplier_id || (supplierMeta ? supplierMeta[1] : null),
              orderId: t.order_id || null,
              salesReturnId: t.sales_return_id || null,
              employeeId: t.employee_id || null,
              reversalOfId: t.reversal_of_id || null,
              cancelledAt: t.cancelled_at || null,
              cancellationReason: t.cancellation_reason || ''
            };
          }).filter(t => !(t.note && t.note.startsWith('Thu tiá»n hÃ ng cho hÃ³a Ä‘Æ¡n')));
        localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify(cloudTxs));
      } catch (txErr) {
        console.warn("Could not load cashbook transactions from Supabase:", txErr.message);
      }
    };

    const fetchStartingBalances = async () => {
      try {
        const { data: balData, error: balErr } = await supabaseClient
          .from(tableStartingBalancesName)
          .select('*')
          .eq('id', 'current_balances')
          .maybeSingle();

        if (balErr) throw balErr;

        const cloudBal = {
          cash: parseFloat(balData?.cash || 0),
          bank: parseFloat(balData?.bank || 0),
          wallet: parseFloat(balData?.wallet || 0)
        };
        localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify(cloudBal));
      } catch (balErr) {
        console.warn("Could not load starting balances from Supabase:", balErr.message);
      }
    };
    const fetchSuppliers = async () => {
      try {
        const tableName = tableProductsName.startsWith('wl_') ? 'wl_suppliers' : 'suppliers';
        const { data, error } = await supabaseClient
          .from(tableName)
          .select('*')
          .order('name', { ascending: true });
        if (error) throw error;
        console.log("[SUPPLIERS] API:", data?.length || 0);
        if (data) {
          state.suppliers = data.map(s => ({
            id: s.id,
            code: s.code,
            name: s.name,
            phone: s.phone,
            address: s.address,
            debt: parseFloat(s.debt || 0),
            openingDebt: parseFloat(s.opening_debt || 0),
            totalPurchase: parseFloat(s.total_purchase || 0),
            totalPaid: parseFloat(s.total_paid || 0),
            notes: s.notes || '',
            isActive: s.is_active !== false
          })).filter(s => s.isActive);
        }
        console.log("[SUPPLIERS] STATE:", state.suppliers?.length || 0);
      } catch (err) {
        console.warn("Could not load suppliers from Supabase:", err.message);
        state.suppliers = [];
      }
    };
    const fetchPurchases = async () => {
      try {
        const [purchaseResult, itemResult, paymentResult] = await Promise.all([
          supabaseClient.from('purchases').select('*').order('purchase_date', { ascending: false }),
          supabaseClient.from('purchase_items').select('*').order('line_number', { ascending: true }),
          supabaseClient.from('purchase_payments').select('*').order('created_at', { ascending: true })
        ]);
        if (purchaseResult.error) throw purchaseResult.error;
        if (itemResult.error) throw itemResult.error;
        if (paymentResult.error) throw paymentResult.error;
        const itemsByPurchase = new Map();
        (itemResult.data || []).forEach(item => {
          const list = itemsByPurchase.get(item.purchase_id) || [];
          list.push({
            id: item.id,
            lineNumber: item.line_number,
            code: item.item_code,
            name: item.item_name,
            unit: item.unit || '',
            quantity: Number(item.quantity || 0),
            unitPrice: Number(item.unit_price || 0),
            lineTotal: Number(item.line_total || 0)
          });
          itemsByPurchase.set(item.purchase_id, list);
        });
        const paymentsByPurchase = new Map();
        (paymentResult.data || []).forEach(payment => {
          if (!payment.purchase_id) return;
          const list = paymentsByPurchase.get(payment.purchase_id) || [];
          list.push({
            id: payment.id,
            amount: Number(payment.amount || 0),
            paymentMethod: payment.payment_method || 'cash',
            cashbookTransactionId: payment.cashbook_transaction_id || null,
            status: payment.status,
            notes: payment.notes || '',
            createdBy: payment.created_by,
            createdAt: payment.created_at,
            cancelledAt: payment.cancelled_at,
            cancellationReason: payment.cancellation_reason || ''
          });
          paymentsByPurchase.set(payment.purchase_id, list);
        });
        state.purchases = (purchaseResult.data || []).map(purchase => {
          const supplier = state.suppliers.find(s => String(s.id) === String(purchase.supplier_id));
          return {
            id: purchase.id,
            code: purchase.code,
            supplierId: purchase.supplier_id,
            supplierName: supplier?.name || '',
            supplierCode: supplier?.code || '',
            invoiceNumber: purchase.invoice_number || '',
            purchaseDate: purchase.purchase_date,
            date: purchase.purchase_date,
            status: purchase.status,
            totalAmount: Number(purchase.total_amount || 0),
            totalPayable: Number(purchase.total_amount || 0),
            paidAmount: Number(purchase.paid_amount || 0),
            balanceDue: Number(purchase.balance_due || 0),
            paymentMethod: purchase.payment_method || 'cash',
            notes: purchase.notes || '',
            createdBy: purchase.created_by,
            cancelledBy: purchase.cancelled_by,
            cancelledAt: purchase.cancelled_at,
            cancellationReason: purchase.cancellation_reason || '',
            items: itemsByPurchase.get(purchase.id) || [],
            payments: paymentsByPurchase.get(purchase.id) || []
          };
        });
      } catch (err) {
        console.warn('Could not load authoritative purchases from Supabase:', err.message || err);
        state.purchases = [];
      }
    };
    const fetchRawMaterials = async () => {
      try {
        const data = await fetchFullTableData(tableRawMaterialsName);
        if (data && data.length > 0) {
          state.rawMaterials = data.map(r => ({
            id: r.id,
            code: r.code,
            name: r.name,
            unit: r.unit || 'kg',
            importPrice: parseFloat(r.import_price || 0),
            quantity: parseFloat(r.quantity || 0),
            notes: r.notes || ''
          }));
          localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));
        } else {
          state.rawMaterials = [...rawMaterialsSeed];
          localStorage.setItem('billing_system_raw_materials', JSON.stringify(state.rawMaterials));
        }
      } catch (err) {
        console.warn("Could not load raw materials from Supabase, using local:", err.message);
        state.rawMaterials = JSON.parse(localStorage.getItem('billing_system_raw_materials') || '[]');
      }
    };
    const fetchSemiFinished = async () => {
      try {
        const data = await fetchFullTableData(tableSemiFinishedName);
        if (data) {
          state.semiFinished = data.map(s => ({
            id: s.id,
            code: s.code,
            name: s.name,
            unit: s.unit || 'kg',
            quantity: parseFloat(s.quantity || 0),
            notes: s.notes || ''
          }));
          localStorage.setItem('billing_system_semi_finished', JSON.stringify(state.semiFinished));
        }
      } catch (err) {
        console.warn("Could not load semi finished from Supabase, using local:", err.message);
        state.semiFinished = JSON.parse(localStorage.getItem('billing_system_semi_finished') || '[]');
      }
    };
    const fetchRecipes = async () => {
      try {
        const data = await fetchFullTableData(tableRecipesName);
        if (data) {
          state.recipes = data.map(r => ({
            id: r.id,
            name: r.name,
            semiFinishedId: r.semi_finished_id,
            outputQuantity: parseFloat(r.output_quantity || 1),
            ingredients: typeof r.ingredients === 'string' ? JSON.parse(r.ingredients) : (r.ingredients || []),
            notes: r.notes || ''
          }));
          localStorage.setItem('billing_system_recipes', JSON.stringify(state.recipes));
        }
      } catch (err) {
        console.warn("Could not load recipes from Supabase, using local:", err.message);
        state.recipes = JSON.parse(localStorage.getItem('billing_system_recipes') || '[]');
      }
    };
    const fetchProductionLogs = async () => {
      try {
        const data = await fetchFullTableData(tableProductionLogsName);
        if (data) {
          state.productionLogs = data.map(l => ({
            id: l.id,
            recipeId: l.recipe_id,
            recipeName: l.recipe_name,
            semiFinishedName: l.semi_finished_name,
            quantity: parseFloat(l.quantity || 0),
            rawMaterialsUsed: typeof l.raw_materials_used === 'string' ? JSON.parse(l.raw_materials_used) : (l.raw_materials_used || []),
            createdBy: l.created_by || 'admin',
            date: l.created_at
          }));
          localStorage.setItem('billing_system_production_logs', JSON.stringify(state.productionLogs));
        }
      } catch (err) {
        console.warn("Could not load production logs from Supabase, using local:", err.message);
        state.productionLogs = JSON.parse(localStorage.getItem('billing_system_production_logs') || '[]');
      }
    };
    const fetchFinishedGoodsStock = async () => {
      try {
        const data = await fetchFullTableData(tableFinishedGoodsStockName);
        if (data) {
          state.finishedGoodsStock = data.map(s => ({
            productCode: s.product_code,
            brand: s.brand,
            packageType: s.package_type,
            quantity: parseFloat(s.quantity || 0)
          }));
          localStorage.setItem('billing_system_finished_goods_stock', JSON.stringify(state.finishedGoodsStock));
        }
      } catch (err) {
        console.warn("Could not load finished goods stock from Supabase, using local:", err.message);
        state.finishedGoodsStock = JSON.parse(localStorage.getItem('billing_system_finished_goods_stock') || '[]');
      }
    };

    const fetchSalesReturns = async () => {
      try {
        const returnsData = await fetchFullTableData(tableSalesReturnsName);
        const itemsData = await fetchFullTableData(tableSalesReturnItemsName);
        if (returnsData) {
          const itemsMap = new Map();
          if (itemsData) {
            itemsData.forEach(i => {
              const arr = itemsMap.get(i.return_id) || [];
              arr.push({
                id: i.id,
                returnId: i.return_id,
                saleItemId: i.sale_item_id,
                productId: i.product_id,
                variantId: i.variant_id || null,
                variantCode: i.variant_code_snapshot || i.product_id,
                productName: i.product_name,
                quantity: parseFloat(i.quantity || 0),
                importPrice: parseFloat(i.import_price || 0),
                discountType: i.discount_type,
                discountValue: parseFloat(i.discount_value || 0),
                refundPrice: parseFloat(i.refund_price || 0),
                subtotal: parseFloat(i.subtotal || 0),
                packageType: i.packaging_name_snapshot || i.package_type,
                packagingName: i.packaging_name_snapshot || i.package_type,
                specificationSnapshot: i.specification_snapshot || ''
              });
              itemsMap.set(i.return_id, arr);
            });
          }
          
          state.salesReturns = returnsData.map(r => ({
            id: r.id,
            saleId: r.sale_id,
            orderId: r.order_id || r.sale_id,
            customerId: r.customer_id,
            customerName: state.customers.find(customer => customer.id === r.customer_id)?.name || '',
            salespersonId: r.salesperson_id || null,
            createdBy: r.created_by,
            createdAt: r.created_at,
            returnDate: r.return_date || r.created_at,
            reason: r.reason,
            totalRefund: parseFloat(r.total_refund ?? r.total_return_amount ?? 0),
            debtReductionAmount: parseFloat(r.debt_reduction_amount || 0),
            refundAmount: parseFloat(r.refund_amount || 0),
            refundCashbookId: r.refund_cashbook_transaction_id || null,
            status: r.status,
            cancelledAt: r.cancelled_at || null,
            cancellationReason: r.cancellation_reason || '',
            items: itemsMap.get(r.id) || []
          }));
          saveSalesReturns(state.salesReturns);
        }
      } catch (err) {
        console.warn("Could not load sales returns from Supabase, using local:", err.message);
        state.salesReturns = getSalesReturns();
      }
    };

    // Tải song song tất cả các bảng dữ liệu bằng Promise.all để tăng tốc độ phản hồi tối đa
    await Promise.all([
      fetchProducts(),
      fetchOrders(),
      fetchCustomers(),
      fetchPricelists(),
      fetchUsers(),
      fetchBrands(),
      fetchCashbook(),
      fetchStartingBalances(),
      fetchSuppliers(),
      fetchPurchases(),
      fetchSalesReturns()
    ]);

    state.purchases = (state.purchases || []).map(purchase => {
      const supplier = state.suppliers.find(item => String(item.id) === String(purchase.supplierId));
      return {
        ...purchase,
        supplierName: purchase.supplierName || supplier?.name || '',
        supplierCode: purchase.supplierCode || supplier?.code || ''
      };
    });

    // Returns load in parallel with customers/orders; enrich display-only names
    // after every authoritative collection has completed.
    state.salesReturns = (state.salesReturns || []).map(ret => {
      const sourceOrder = state.savedOrders.find(order => String(order.id) === String(ret.saleId));
      const customer = state.customers.find(item => String(item.id) === String(ret.customerId));
      const creator = state.users.find(user =>
        String(user.authUserId || user.auth_user_id || user.id) === String(ret.createdBy)
        || isSameUser(user.username, ret.createdBy)
      );
      return {
        ...ret,
        customerName: ret.customerName || customer?.name || sourceOrder?.customerName || '',
        creatorName: ret.creatorName || creator?.displayName || ret.createdBy
      };
    });
    saveSalesReturns(state.salesReturns);

  } catch(err) {
    console.error('Error fetching cloud data:', err);
    showToast('Lỗi đồng bộ dữ liệu đám mây!', 'danger');
  }
}

// Đồng bộ an toàn: Supabase là nguồn dữ liệu duy nhất. Khi chưa có outbox,
// version và conflict resolution, không được phát lại cache trình duyệt lên DB.
export async function syncLocalToCloud() {
  if (!isCloudActive || !supabaseClient) {
    showToast('Không thể tải dữ liệu vì chưa kết nối Supabase.', 'warning');
    return false;
  }
  try {
    updateDbStatusUI('connecting', 'Đang tải dữ liệu mới nhất từ Cloud...');
    await fetchCloudData();
    updateDbStatusUI('cloud');
    showToast('Đã tải lại dữ liệu mới nhất từ Cloud. Cache trình duyệt không được ghi ngược lên database.', 'success');
    return true;
  } catch (error) {
    console.error('Cloud refresh failed:', error);
    updateDbStatusUI('local_failed');
    showToast('Không thể tải lại dữ liệu Cloud. Không có dữ liệu nào bị ghi hoặc thay đổi.', 'danger');
    return false;
  }
}

// Kept temporarily for reference while old installations are upgraded. It is
// intentionally not exported or called because it predates safe conflict handling.
async function legacyLocalUploadDisabled() {
  if (!isCloudActive || !supabaseClient) {
    showToast('Vui lòng kết nối với Supabase trước!', 'warning');
    return false;
  }
  
  const localProducts = JSON.parse(localStorage.getItem('billing_system_products') || '[]');
  const localOrders = JSON.parse(localStorage.getItem('billing_system_orders') || '[]');
  const localCustomers = JSON.parse(localStorage.getItem('billing_system_customers') || '[]');
  const localPricelists = [];
  const localBrands = JSON.parse(localStorage.getItem('billing_system_brands') || '[]');
  const localTxs = JSON.parse(localStorage.getItem('billing_system_cashbook_transactions') || '[]');
  const localBalances = JSON.parse(localStorage.getItem('billing_system_cashbook_start_balances') || 'null');
  const localSuppliers = JSON.parse(localStorage.getItem('billing_system_suppliers') || '[]');
  // Inventory and production are outside the final project scope. Legacy local
  // data is preserved, but this sync path must never upload or depend on it.
  const localRaw = [];
  const localSemi = [];
  const localRecipes = [];
  const localLogs = [];
  const localFgs = [];
  
  if (localProducts.length === 0 && localOrders.length === 0 && localCustomers.length === 0 && localBrands.length === 0 && localTxs.length === 0 && !localBalances && localSuppliers.length === 0 && localRaw.length === 0 && localSemi.length === 0 && localRecipes.length === 0 && localLogs.length === 0 && localFgs.length === 0) {
    showToast('Không tìm thấy dữ liệu LocalStorage nào để đồng bộ!', 'warning');
    return false;
  }
  
  try {
    updateDbStatusUI('connecting');
    
    // 1. Sync Products
    if (localProducts.length > 0) {
      const { data: existingProducts, error: existingProductsError } = await supabaseClient
        .from(tableProductsName)
        .select('id,code,brand');
      if (existingProductsError) throw existingProductsError;

      const productKey = product => `${String(product.code || '').trim().toUpperCase()}\u0000${String(product.brand || '').trim().toLowerCase()}`;
      const existingById = new Map((existingProducts || []).map(product => [product.id, product]));
      const existingByKey = new Map((existingProducts || []).map(product => [productKey(product), product]));

      const dbRows = localProducts
        .filter(p => p.id && p.packageType)
        .map(p => {
          const existing = existingById.get(p.id) || existingByKey.get(productKey(p));
          if (existing?.id) p.id = existing.id;
          return {
            id: p.id,
            code: p.code,
            name: p.name,
            brand: p.brand || '',
            brand_id: p.brandId || null,
            base_product_id: p.baseProductId || p.parentProductId || null,
            parent_product_id: p.parentProductId || p.baseProductId || null,
            package_type: p.packageType,
            package_weight: p.packageWeight || null,
            package_weight_unit: p.packageWeightUnit || 'kg',
            display_specification: p.displaySpecification || '',
            product_group: p.group || null,
            is_active: p.isActive !== false,
            is_legacy: p.isLegacy === true,
            updated_at: new Date().toISOString()
          };
        });
      
      const { error } = dbRows.length > 0
        ? await supabaseClient.from(tableProductsName).upsert(dbRows, { onConflict: 'id' })
        : { error: null };
        
      if (error) throw error;
      localStorage.setItem('billing_system_products', JSON.stringify(localProducts));
    }
    
    // 2. Sync Orders
    if (localOrders.length > 0) {
      const draftRows = localOrders.filter(o => o.status === 'draft').map(o => ({
        id: o.id,
        customer_id: o.customerId || null,
        customer_name: o.customerName,
        notes: o.notes,
        items: o.items,
        total_market: o.totalMarket,
        total_discount: o.totalDiscount,
        subtotal: o.subtotal !== undefined ? o.subtotal : o.totalPayable,
        discount_value: o.discountValue || 0,
        discount_type: o.discountType || 'amount',
        discount_amount: o.discountAmount || 0,
        other_fee_value: o.otherFeeValue || 0,
        other_fee_type: o.otherFeeType || 'amount',
        other_fee_amount: o.otherFeeAmount || 0,
        total_payable: o.totalPayable,
        created_at: o.date,
        pricelist_id: o.pricelistId || 'retail',
        created_by: o.createdBy || 'admin',
        status: 'draft'
      }));
      
      if (draftRows.length > 0) {
        let { error } = await supabaseClient
          .from(tableDraftOrdersName)
          .upsert(draftRows, { onConflict: 'id' });
        if (error) throw error;
      }
    }

    // 3. Sync Customers
    if (localCustomers.length > 0) {
      const dbRows = localCustomers.map(c => ({
        id: c.id,
        code: c.code,
        name: c.name,
        phone: c.phone,
        address: c.address,
        assigned_brand: c.assignedBrand,
        brand_discounts: c.brandDiscounts,
        shipping_support: c.shippingSupport || false,
        notes: c.notes,
        pricelist_id: c.pricelistId || null,
        default_price_list_id: resolveCustomerDefaultPriceListId(c),
        managed_by: c.managedBy || 'nhat'
      }));
      
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .upsert(dbRows, { onConflict: 'id' });
        
      if (error) throw error;
    }

    // Price lists, profiles, and roles are never synchronized from localStorage.

    // 6. Sync Brands
    if (localBrands.length > 0) {
      const dbRows = localBrands.map(b => ({
        id: b.id || ('brand_' + String(b.name).toLowerCase().replace(/[^a-z0-9]/g, '')),
        name: b.name,
        company_id: b.companyId || null,
        company_name: b.companyName || 'Dùng chung',
        logo_filename: b.logoFilename || '',
        hotline: b.hotline || '',
        cskh: b.cskh || '',
        email: b.email || '',
        address_main: b.addressMain || '',
        address_factory: b.addressFactory || '',
        address_business: b.addressBusiness || null
      }));
      
      const { error } = await supabaseClient
        .from(tableBrandsName)
        .upsert(dbRows, { onConflict: 'name' });
        
      if (error) throw error;
    }

    // Finalized orders, customer balances, cashbook entries and opening balances
    // are authoritative on the database. Never replay browser cache into them.
    
    // 9. Sync Suppliers
    if (localSuppliers.length > 0) {
      try {
        const tableName = tableProductsName.startsWith('wl_') ? 'wl_suppliers' : 'suppliers';
        const dbRows = localSuppliers.map(s => ({
          id: s.id,
          code: s.code,
          name: s.name,
          phone: s.phone,
          address: s.address,
          debt: parseFloat(s.debt || 0),
          notes: s.notes || ''
        }));
        const { error } = await supabaseClient
          .from(tableName)
          .upsert(dbRows, { onConflict: 'id' });
        if (error) throw error;
      } catch (err) {
        console.warn("Could not sync suppliers to cloud:", err.message);
      }
    }
    
    // 10. Sync Raw Materials
    if (localRaw.length > 0) {
      try {
        const dbRows = localRaw.map(r => ({
          id: r.id,
          code: r.code,
          name: r.name,
          unit: r.unit || 'kg',
          import_price: parseFloat(r.importPrice || 0),
          quantity: parseFloat(r.quantity || 0),
          notes: r.notes || ''
        }));
        await supabaseClient.from(tableRawMaterialsName).upsert(dbRows, { onConflict: 'id' });
      } catch (err) {
        console.warn("Could not sync raw materials:", err.message);
      }
    }

    // 11. Sync Semi Finished
    if (localSemi.length > 0) {
      try {
        const dbRows = localSemi.map(s => ({
          id: s.id,
          code: s.code,
          name: s.name,
          unit: s.unit || 'kg',
          quantity: parseFloat(s.quantity || 0),
          notes: s.notes || ''
        }));
        await supabaseClient.from(tableSemiFinishedName).upsert(dbRows, { onConflict: 'id' });
      } catch (err) {
        console.warn("Could not sync semi finished:", err.message);
      }
    }

    // 12. Sync Recipes
    if (localRecipes.length > 0) {
      try {
        const dbRows = localRecipes.map(r => ({
          id: r.id,
          name: r.name,
          semi_finished_id: r.semiFinishedId,
          output_quantity: parseFloat(r.outputQuantity || 1),
          ingredients: r.ingredients || [],
          notes: r.notes || ''
        }));
        await supabaseClient.from(tableRecipesName).upsert(dbRows, { onConflict: 'id' });
      } catch (err) {
        console.warn("Could not sync recipes:", err.message);
      }
    }

    // 13. Sync Production Logs
    if (localLogs.length > 0) {
      try {
        const dbRows = localLogs.map(l => ({
          id: l.id,
          recipe_id: l.recipeId,
          recipe_name: l.recipeName,
          semi_finished_name: l.semiFinishedName,
          quantity: parseFloat(l.quantity || 0),
          raw_materials_used: l.rawMaterialsUsed || [],
          created_by: l.createdBy || 'admin',
          created_at: l.date || new Date().toISOString()
        }));
        await supabaseClient.from(tableProductionLogsName).upsert(dbRows, { onConflict: 'id' });
      } catch (err) {
        console.warn("Could not sync production logs:", err.message);
      }
    }

    // 14. Sync Finished Goods Stock
    if (localFgs.length > 0) {
      try {
        const dbRows = localFgs.map(s => ({
          product_code: s.productCode,
          brand: s.brand,
          package_type: s.packageType,
          quantity: parseFloat(s.quantity || 0),
          updated_at: new Date().toISOString()
        }));
        await supabaseClient.from(tableFinishedGoodsStockName).upsert(dbRows, { onConflict: 'product_code,brand,package_type' });
      } catch (err) {
        console.warn("Could not sync finished goods stock:", err.message);
      }
    }
    
    await fetchCloudData();
    updateDbStatusUI('cloud');
    showToast(
      (localTxs.length > 0 || localBalances || localOrders.some(order => order.status !== 'draft'))
        ? 'Đã đồng bộ danh mục và đơn nháp. Dữ liệu tài chính local không được ghi đè lên Cloud.'
        : 'Đồng bộ dữ liệu lên đám mây thành công!',
      'success'
    );
    return true;
  } catch(err) {
    console.error('Migration failed:', err);
    showToast('Lỗi đồng bộ dữ liệu: ' + err.message, 'danger');
    updateDbStatusUI('cloud');
    return false;
  }
}

// --- Thao tác CSDL chi tiết (Sản phẩm) ---
export async function dbSaveProduct(product) {
  if (isCloudActive && supabaseClient) {
    try {
      let existingRow = null;

      if (product.id) {
        const { data, error } = await supabaseClient
          .from(tableProductsName)
          .select('id')
          .eq('id', product.id)
          .maybeSingle();
        if (error) throw error;
        existingRow = data;
      }

      if (!existingRow) {
        const { data, error } = await supabaseClient
          .from(tableProductsName)
          .select('id')
          .eq('code', product.code)
          .eq('brand', product.brand || '')
          .maybeSingle();
        if (error) throw error;
        existingRow = data;
      }

      if (existingRow?.id) {
        // Keep the primary key because price-list rows and order history reference it.
        product.id = existingRow.id;
      }

      const dbRow = {
        id: product.id,
        code: product.code,
        variant_code: product.variantCode || product.code,
        product_group_id: product.productGroupId || product.baseProductId || product.parentProductId || null,
        base_code: product.baseCode || null,
        base_product_id: product.baseProductId || product.parentProductId || null,
        parent_product_id: product.parentProductId || product.baseProductId || null,
        name: product.name,
        brand: product.brand || '',
        brand_id: product.brandId || ('brand_' + String(product.brand).toLowerCase().replace(/[^a-z0-9]/g, '')),
        package_type: product.packageType || '',
        packaging_name: product.packagingName || product.packageType || '',
        package_weight: product.packageWeight === '' ? null : product.packageWeight,
        weight_or_volume: product.weightOrVolume === '' ? (product.packageWeight === '' ? null : product.packageWeight) : product.weightOrVolume,
        package_weight_unit: product.packageWeightUnit || 'kg',
        unit_name: product.unitName || product.packageWeightUnit || 'kg',
        display_specification: product.displaySpecification || '',
        conversion_quantity: Number(product.conversionQuantity || 1),
        barcode: product.barcode || null,
        purchase_price: Number(product.purchasePrice || 0),
        product_group: product.group || null,
        is_active: product.isActive !== false,
        is_legacy: product.isLegacy === true,
        updated_at: new Date().toISOString()
      };

      if (dbRow.product_group_id && product.baseCode) {
        const hasOtherActiveVariant = (state.products || []).some(candidate =>
          candidate.id !== product.id &&
          (candidate.productGroupId || candidate.baseProductId || candidate.parentProductId) === dbRow.product_group_id &&
          candidate.isActive !== false
        );
        const { error: groupError } = await supabaseClient
          .from('product_groups')
          .upsert({
            id: dbRow.product_group_id,
            base_code: product.baseCode,
            product_name: product.name,
            brand_id: product.brandId || null,
            brand_name: product.brand || '',
            category_id: product.categoryId || null,
            description: product.description || null,
            is_active: product.isActive !== false || hasOtherActiveVariant,
            updated_at: new Date().toISOString()
          }, { onConflict: 'id' });
        if (groupError && !handleOptionalProductGroupsError(groupError)) throw groupError;
      }

      let error = null;
      if (existingRow?.id) {
        const { id: _preservedId, ...changes } = dbRow;
        ({ error } = await runProductWriteWithSchemaFallback(stripUnavailableColumns =>
          supabaseClient
            .from(tableProductsName)
            .update(stripUnavailableColumns(changes))
            .eq('id', existingRow.id)
        ));
      } else {
        ({ error } = await runProductWriteWithSchemaFallback(stripUnavailableColumns =>
          supabaseClient
            .from(tableProductsName)
            .insert(stripUnavailableColumns(dbRow))
        ));
      }

      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu sản phẩm lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbSaveProductsBulk(products) {
  if (!Array.isArray(products) || products.length === 0) return true;
  if (!isCloudActive || !supabaseClient) return true;

  try {
    const { data: existingProducts, error: fetchError } = await supabaseClient
      .from(tableProductsName)
      .select('id,code,brand');
    if (fetchError) throw fetchError;

    const productKey = product => `${String(product.code || '').trim().toUpperCase()}\u0000${String(product.brand || '').trim().toLowerCase()}`;
    const existingById = new Map((existingProducts || []).map(product => [product.id, product]));
    const existingByKey = new Map((existingProducts || []).map(product => [productKey(product), product]));
    const rowsByKey = new Map();
    const resolvedIdByKey = new Map();

    products.forEach(product => {
      const key = productKey(product);
      const existing = existingById.get(product.id) || existingByKey.get(key);
      if (existing?.id) product.id = existing.id;
      else if (resolvedIdByKey.has(key)) product.id = resolvedIdByKey.get(key);
      resolvedIdByKey.set(key, product.id);

      rowsByKey.set(key, {
        id: product.id,
        code: product.code,
        variant_code: product.variantCode || product.code,
        product_group_id: product.productGroupId || product.baseProductId || product.parentProductId || null,
        base_code: product.baseCode || null,
        base_product_id: product.baseProductId || product.parentProductId || null,
        parent_product_id: product.parentProductId || product.baseProductId || null,
        name: product.name,
        brand: product.brand || '',
        brand_id: product.brandId || ('brand_' + String(product.brand).toLowerCase().replace(/[^a-z0-9]/g, '')),
        package_type: product.packageType || '',
        packaging_name: product.packagingName || product.packageType || '',
        package_weight: product.packageWeight === '' ? null : product.packageWeight,
        weight_or_volume: product.weightOrVolume === '' ? (product.packageWeight === '' ? null : product.packageWeight) : product.weightOrVolume,
        package_weight_unit: product.packageWeightUnit || 'kg',
        unit_name: product.unitName || product.packageWeightUnit || 'kg',
        display_specification: product.displaySpecification || '',
        conversion_quantity: Number(product.conversionQuantity || 1),
        barcode: product.barcode || null,
        purchase_price: Number(product.purchasePrice || 0),
        product_group: product.group || null,
        is_active: product.isActive !== false,
        is_legacy: product.isLegacy === true,
        updated_at: new Date().toISOString()
      });
    });

    const rows = [...rowsByKey.values()];
    const savedVariantIds = new Set(products.map(product => product.id).filter(Boolean));
    const groupsById = new Map();
    products
      .filter(product => product.productGroupId && product.baseCode)
      .forEach(product => {
        const current = groupsById.get(product.productGroupId);
        groupsById.set(product.productGroupId, {
          id: product.productGroupId,
          base_code: product.baseCode,
          product_name: product.name,
          brand_id: product.brandId || current?.brand_id || null,
          brand_name: product.brand || '',
          category_id: product.categoryId || current?.category_id || null,
          description: product.description || current?.description || null,
          is_active: Boolean(current?.is_active) ||
            product.isActive !== false ||
            (state.products || []).some(candidate =>
              !savedVariantIds.has(candidate.id) &&
              (candidate.productGroupId || candidate.baseProductId || candidate.parentProductId) === product.productGroupId &&
              candidate.isActive !== false
            ),
          updated_at: new Date().toISOString()
        });
      });
    const groupRows = [...groupsById.values()];
    if (groupRows.length > 0) {
      const { error: groupError } = await supabaseClient
        .from('product_groups')
        .upsert(groupRows, { onConflict: 'id' });
      if (groupError && !handleOptionalProductGroupsError(groupError)) throw groupError;
    }

    const chunkSize = 200;
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize);
      const { error } = await runProductWriteWithSchemaFallback(stripUnavailableColumns =>
        supabaseClient
          .from(tableProductsName)
          .upsert(chunk.map(stripUnavailableColumns), { onConflict: 'id' })
      );
      if (error) throw error;
    }

    return true;
  } catch (err) {
    console.error(err);
    showToast('Không thể nhập danh sách sản phẩm lên đám mây: ' + err.message, 'danger');
    return false;
  }
}

export async function dbRenameBrandProducts(brandId, oldName, newName) {
  if (!isCloudActive || !supabaseClient) return true;

  try {
    const changes = {
      brand: newName,
      brand_id: brandId || null,
      updated_at: new Date().toISOString()
    };

    if (brandId) {
      const { error } = await supabaseClient
        .from(tableProductsName)
        .update(changes)
        .eq('brand_id', brandId);
      if (error) throw error;
    }

    if (oldName) {
      const { error } = await supabaseClient
        .from(tableProductsName)
        .update(changes)
        .ilike('brand', oldName);
      if (error) throw error;
    }

    return true;
  } catch (err) {
    console.error(err);
    showToast('Đã đổi tên hãng nhưng chưa thể cập nhật các sản phẩm trên đám mây: ' + err.message, 'danger');
    return false;
  }
}

export async function dbDeleteProduct(code, brand) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableProductsName)
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('code', code)
        .eq('brand', brand || '');
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa sản phẩm trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

// --- Thao tác CSDL chi tiết (Khách hàng) ---
function resolveCustomerDefaultPriceListId(customer) {
  const candidate = customer.defaultPriceListId || customer.pricelistId || '';
  if (!candidate || candidate === 'custom' || candidate === 'retail') return null;

  const priceLists = state.pricelists || [];
  if (priceLists.length && !priceLists.some(priceList => priceList.id === candidate)) {
    return null;
  }

  return candidate;
}

// Profile-only whitelist. Financial balances are intentionally excluded and
// can only change through reviewed debt/payment/order RPCs.
function mapCustomerToDbRow(customer) {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.name,
    phone: customer.phone,
    phone2: customer.phone2 || null,
    email: customer.email || null,
    facebook: customer.facebook || null,
    birthday: customer.birthday || null,
    gender: customer.gender || null,
    avatar_url: customer.avatarUrl || customer.avatar_url || null,
    province: customer.province || null,
    ward: customer.ward || null,
    customer_group_id: customer.customerGroupId || customer.customer_group_id || null,
    company_name: customer.companyName || customer.company_name || null,
    tax_code: customer.taxCode || customer.tax_code || null,
    invoice_address: customer.invoiceAddress || customer.invoice_address || null,
    address: customer.address,
    status: customer.status || 'active',
    assigned_brand: customer.assignedBrand,
    assigned_brand_id: customer.assignedBrandId || null,
    brand_discounts: customer.brandDiscounts,
    shipping_support: customer.shippingSupport || false,
    notes: customer.notes,
    pricelist_id: customer.pricelistId === undefined ? null : customer.pricelistId,
    default_price_list_id: resolveCustomerDefaultPriceListId(customer),
    managed_by: customer.managedBy === undefined ? null : customer.managedBy,
    updated_at: new Date().toISOString(),
    deleted_at: customer.deletedAt || customer.deleted_at || null
  };
}

export async function dbSaveCustomer(customer) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = mapCustomerToDbRow(customer);
      
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .upsert(dbRow, { onConflict: 'id' });
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu khách hàng lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

// Quick customer creation is available from the order screen to every role,
// but it goes through a narrow server RPC instead of widening direct customer
// table writes. The database forces Sale users to own the new customer and
// ignores every financial field from the browser.
export async function dbCreateQuickCustomer(customer) {
  if (!isCloudActive || !supabaseClient) return true;

  try {
    const command = {
      id: customer.id,
      code: customer.code,
      name: customer.name,
      phone: customer.phone || '',
      address: customer.address || '',
      province: customer.brandDiscounts?.province || customer.province || '',
      assignedBrand: customer.assignedBrand || 'Tất cả',
      pricelistId: customer.pricelistId || null,
      managedBy: customer.managedBy || null,
      notes: customer.notes || 'Thêm nhanh từ màn hình lên đơn'
    };
    const { data, error } = await supabaseClient.rpc('rpc_create_quick_customer', {
      p_customer: command
    });
    if (error) throw error;
    if (!data?.success) throw new Error(data?.message || 'Máy chủ không tạo được khách hàng');
    return data.customer || true;
  } catch (err) {
    console.error(err);
    showToast('Không thể thêm nhanh khách hàng: ' + (err.message || 'Lỗi hệ thống'), 'danger');
    return false;
  }
}

export async function dbSaveCustomersBulk(customers) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRows = customers.map(customer => mapCustomerToDbRow(customer));
      const chunkSize = 200;

      if (dbRows.length > 0) {
        console.info('[Customer Excel Import] Customer profile upsert payload sample', {
          payload: dbRows[0],
          dateFields: 'created_at and last_order_at are sent through the reviewed baseline RPC'
        });
      }

      for (let offset = 0; offset < dbRows.length; offset += chunkSize) {
        const chunk = dbRows.slice(offset, offset + chunkSize);
        const { error } = await supabaseClient
          .from(tableCustomersName)
          .upsert(chunk, { onConflict: 'id' });

        if (error) throw error;
      }
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu danh sách khách hàng lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

// Customer profile fields and imported financial baselines use separate write
// boundaries. This RPC is Admin/Accounting-only and replaces only the previous
// imported contribution, so retrying the same file cannot double the totals.
export async function dbImportCustomerFinancialBaselines(customers) {
  if (!isCloudActive || !supabaseClient) {
    showToast('Cần kết nối Supabase để lưu số liệu đầu kỳ của khách hàng.', 'warning');
    return false;
  }

  try {
    const importedAt = new Date().toISOString();
    const rows = (customers || []).map(customer => {
      const presence = customer.importFieldPresence || {};
      return {
        id: customer.id,
        debt: presence.debt === false ? null : Number(customer.debt ?? 0),
        totalTransaction: presence.totalTransaction === false ? null : Number(customer.totalTransaction ?? 0),
        totalReturn: presence.totalReturn === false ? null : Number(customer.totalReturn ?? 0),
        netRevenue: presence.netRevenue === false ? null : Number(customer.netRevenue ?? 0),
        lastOrderAt: presence.lastOrderAt === false ? null : (customer.lastOrderAt || null),
        createdAt: presence.createdAt === false ? null : (customer.createdAt || null),
        importedAt: customer.salesBaselineImportedAt || importedAt
      };
    });
    if (rows.length > 0) {
      console.info('[Customer Excel Import] Supabase RPC payload sample', {
        rpc: 'rpc_import_customer_financial_baselines',
        databaseMapping: {
          createdAt: 'customers.created_at',
          lastOrderAt: 'customers.last_order_at',
          debt: 'customers.debt + customer_debt_transactions',
          totalTransaction: 'customers.total_transaction',
          totalReturn: 'customers.total_return',
          netRevenue: 'customers.net_revenue'
        },
        payload: rows[0]
      });
    }
    const chunkSize = 200;

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const batchNumber = Math.floor(offset / chunkSize) + 1;
      const { data, error } = await supabaseClient.rpc('rpc_import_customer_financial_baselines', {
        p_rows: chunk
      });
      if (error) {
        const batchError = new Error(`Batch ${batchNumber}, dòng ${offset + 2}-${offset + chunk.length + 1}: ${error.message}`);
        batchError.code = error.code;
        throw batchError;
      }
      if (!data?.success || Number(data.processed) !== Math.min(chunkSize, rows.length - offset)) {
        throw new Error(`Batch ${batchNumber}: Máy chủ không xác nhận đủ ${chunk.length} dòng số liệu đầu kỳ.`);
      }
    }
    return true;
  } catch (error) {
    console.error('Error importing customer financial baselines:', error);
    const migrationMissing = error?.code === 'PGRST202'
      || String(error?.message || '').includes('rpc_import_customer_financial_baselines');
    const variableConflict = /column reference ["']customer_id["'] is ambiguous/i
      .test(String(error?.message || ''));
    showToast(
      variableConflict
        ? 'Supabase đang dùng RPC nhập khách hàng bản cũ. Hãy chạy migration 0016 rồi nhập lại file; dữ liệu đầu kỳ chưa được cộng ở batch lỗi.'
        : migrationMissing
        ? 'Máy chủ chưa có bản nâng cấp nhập số liệu khách hàng (migration 0015). Chưa có số liệu tài chính nào bị ghi trực tiếp.'
        : `Không thể lưu số liệu đầu kỳ khách hàng: ${error.message}`,
      'danger'
    );
    return false;
  }
}

export async function dbFetchCustomers() {
  if (isCloudActive && supabaseClient) {
    try {
      const customerData = await fetchFullTableData(tableCustomersName);
      state.customers = (customerData || []).map(cust => ({
        id: cust.id,
        code: cust.code,
        name: cust.name,
        phone: cust.phone,
        phone2: cust.phone2 || '',
        email: cust.email || '',
        facebook: cust.facebook || '',
        birthday: cust.birthday || '',
        gender: cust.gender || '',
        avatarUrl: cust.avatar_url || '',
        province: cust.province || '',
        ward: cust.ward || '',
        customerGroupId: cust.customer_group_id || '',
        companyName: cust.company_name || '',
        taxCode: cust.tax_code || '',
        invoiceAddress: cust.invoice_address || '',
        address: cust.address,
        status: cust.status || 'active',
        createdBy: cust.created_by || '',
        assignedBrand: cust.assigned_brand || 'Tất cả',
        brandDiscounts: typeof cust.brand_discounts === 'string' ? JSON.parse(cust.brand_discounts) : (cust.brand_discounts || {}),
        shippingSupport: cust.shipping_support || false,
        debt: parseFloat(cust.debt || 0),
        totalTransaction: parseFloat(cust.total_transaction || 0),
        totalReturn: parseFloat(cust.total_return || 0),
        netRevenue: parseFloat(cust.net_revenue || 0),
        importedDebtBaseline: parseFloat(cust.imported_debt_baseline || 0),
        importedTotalTransactionBaseline: parseFloat(cust.imported_total_transaction_baseline || 0),
        importedTotalReturnBaseline: parseFloat(cust.imported_total_return_baseline || 0),
        importedNetRevenueBaseline: parseFloat(cust.imported_net_revenue_baseline || 0),
        importedLastOrderAtBaseline: cust.imported_last_order_at_baseline || null,
        importedCreatedAtBaseline: cust.imported_created_at_baseline || null,
        financialBaselineImportedAt: cust.financial_baseline_imported_at || null,
        lastOrderAt: cust.last_order_at || null,
        lastPaymentAt: cust.last_payment_at || null,
        notes: cust.notes || '',
        pricelistId: cust.pricelist_id || '',
        defaultPriceListId: cust.default_price_list_id || cust.pricelist_id || '',
        managedBy: cust.managed_by || '',
        debtHistory: parseDebtHistory(cust.debt_history),
        createdAt: cust.created_at || null,
        updatedAt: cust.updated_at || null,
        deletedAt: cust.deleted_at || null
      }));
      await hydrateCustomerDebtHistory(state.customers);
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      return true;
    } catch (err) {
      console.error("Error fetching customers:", err);
      return false;
    }
  }
  return false;
}

export async function dbFetchCashbookTransactions() {
  if (!isCloudActive || !supabaseClient) return false;
  try {
    const { data, error } = await supabaseClient
      .from(tableCashbookTransactionsName)
      .select('*')
      .order('date', { ascending: false });
    if (error) throw error;
    const transactions = (data || []).map(mapCashbookTransaction);
    localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify(transactions));
    return transactions;
  } catch (error) {
    console.error('Error fetching cashbook transactions:', error);
    return false;
  }
}

export async function dbRefreshCustomerFinancialState(customerId) {
  if (!isCloudActive || !supabaseClient || !customerId) return false;
  try {
    const [{ data: customerRow, error: customerError }, ledgerRows] = await Promise.all([
      supabaseClient
        .from(tableCustomersName)
        .select('id,debt,total_transaction,total_return,net_revenue,last_order_at,last_payment_at,updated_at')
        .eq('id', customerId)
        .single(),
      fetchCustomerDebtRows(customerId)
    ]);
    if (customerError) throw customerError;

    const customer = (state.customers || []).find(item => String(item.id) === String(customerId));
    if (!customer) return false;
    customer.debt = Number(customerRow.debt || 0);
    customer.totalTransaction = Number(customerRow.total_transaction || 0);
    customer.totalReturn = Number(customerRow.total_return || 0);
    customer.netRevenue = Number(customerRow.net_revenue || 0);
    customer.lastOrderAt = customerRow.last_order_at || null;
    customer.lastPaymentAt = customerRow.last_payment_at || null;
    customer.updatedAt = customerRow.updated_at || null;

    const merged = new Map();
    parseDebtHistory(customer.debtHistory).forEach(item => {
      const key = String(item?.id || `legacy:${item?.date || ''}:${item?.type || ''}:${item?.amount || 0}`);
      merged.set(key, item);
    });
    (ledgerRows || []).map(mapCustomerDebtTransaction).forEach(item => merged.set(String(item.id), item));
    customer.debtHistory = [...merged.values()];
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
    return customer;
  } catch (error) {
    console.error('Error refreshing customer financial state:', error);
    return false;
  }
}

export async function dbDeleteCustomer(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .delete()
        .eq('id', id);
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa khách hàng trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbDeleteCustomersBulk(customerIds) {
  if (!Array.isArray(customerIds) || customerIds.length === 0) return true;
  if (!['admin', 'accounting'].includes(state.currentUser?.role)) {
    showToast('Chỉ Admin hoặc Kế toán được ghi đè danh sách khách hàng.', 'danger');
    return false;
  }
  if (!isCloudActive || !supabaseClient) {
    showToast('Cần kết nối Supabase để ghi đè danh sách khách hàng.', 'danger');
    return false;
  }

  try {
    const uniqueIds = [...new Set(customerIds.map(id => String(id || '')).filter(Boolean))];
    const chunkSize = 200;
    for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
      const chunk = uniqueIds.slice(offset, offset + chunkSize);
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .delete()
        .in('id', chunk);
      if (error) throw error;
    }
    return true;
  } catch (error) {
    console.error('Customer overwrite cleanup failed:', error);
    showToast('Dữ liệu mới đã được lưu nhưng không thể xóa hết khách hàng cũ: ' + error.message, 'danger');
    return false;
  }
}

// --- Thao tác CSDL chi tiết (Bảng giá) ---
export async function dbSavePricelist(pricelist) {
  if (state.currentUser?.role === 'sale') {
    showToast('TÃ i khoáº£n kinh doanh khÃ´ng cÃ³ quyá»n lÆ°u báº£ng giÃ¡.', 'danger');
    return false;
  }
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: pricelist.id,
        code: pricelist.code || null,
        name: pricelist.name,
        type: normalizePriceListType(pricelist.type, pricelist.customerId),
        price_list_type: normalizePriceListType(pricelist.type, pricelist.customerId),
        customer_id: pricelist.customerId || null,
        customer_group_id: pricelist.customerGroupId || null,
        parent_price_list_id: pricelist.parentPriceListId || null,
        effective_from: pricelist.effectiveFrom || null,
        effective_to: pricelist.effectiveTo || null,
        is_active: pricelist.isActive !== false,
        is_available_for_sales: pricelist.isAvailableForSales === true,
        display_order: Number(pricelist.displayOrder || 0),
        brand_discounts: pricelist.brandDiscounts || {},
        updated_at: new Date().toISOString()
      };
      
      const { error } = await supabaseClient
        .from(tablePricelistsName)
        .upsert(dbRow, { onConflict: 'id' });
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu bảng giá lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbSavePriceListItems(items) {
  if (state.currentUser?.role === 'sale') {
    showToast('TÃ i khoáº£n kinh doanh khÃ´ng cÃ³ quyá»n lÆ°u chi tiáº¿t báº£ng giÃ¡.', 'danger');
    return false;
  }
  if (isCloudActive && supabaseClient && items.length > 0) {
    try {
      const dbRows = items.map(item => ({
        id: item.id || `${item.priceListId}:${item.productId}`,
        price_list_id: item.priceListId,
        product_id: item.productId,
        variant_id: item.variantId || item.productId,
        price: Number(item.price),
        is_override: true,
        source_type: item.sourceType || 'manual',
        updated_at: new Date().toISOString(),
        updated_by: item.updatedBy || (state.currentUser ? state.currentUser.username : 'admin')
      }));
      const chunkSize = 200;
      for (let offset = 0; offset < dbRows.length; offset += chunkSize) {
        const chunk = dbRows.slice(offset, offset + chunkSize);
        let { error } = await supabaseClient
          .from(tablePriceListItemsName)
          .upsert(chunk, { onConflict: 'price_list_id,product_id' });

        if (error && /variant_id|schema cache|column/i.test(error.message || '')) {
          const legacyChunk = chunk.map(({ variant_id, ...row }) => row);
          const retry = await supabaseClient
            .from(tablePriceListItemsName)
            .upsert(legacyChunk, { onConflict: 'price_list_id,product_id' });
          error = retry.error;
        }

        if (error) throw error;
      }
      return true;
    } catch(err) {
      console.error(err);
      showToast('KhÃ´ng thá»ƒ lÆ°u chi tiáº¿t giÃ¡ lÃªn Ä‘Ã¡m mÃ¢y: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbDeletePriceListItem(priceListId, productId) {
  if (state.currentUser?.role === 'sale') {
    showToast('TÃ i khoáº£n kinh doanh khÃ´ng cÃ³ quyá»n xÃ³a giÃ¡.', 'danger');
    return false;
  }
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tablePriceListItemsName)
        .delete()
        .eq('price_list_id', priceListId)
        .eq('product_id', productId);
      if (error) throw error;
      return true;
    } catch (err) {
      console.error(err);
      showToast('Không thể xóa giá riêng: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbDeletePricelist(id) {
  if (state.currentUser?.role === 'sale') {
    showToast('TÃ i khoáº£n kinh doanh khÃ´ng cÃ³ quyá»n ngá»«ng báº£ng giÃ¡.', 'danger');
    return false;
  }
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tablePricelistsName)
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id);
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa bảng giá trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

// --- Thao tác CSDL chi tiết (Hóa đơn / Đơn hàng) ---
export async function dbSaveOrder(order) {
  if (state.currentUser?.role === 'sale') {
    const usedPriceListIds = new Set([
      order.pricelistId,
      ...(order.items || []).map(item => item.priceListId)
    ].filter(id => id && id !== 'retail'));
    const forbiddenId = [...usedPriceListIds].find(id => {
      const priceList = state.pricelists.find(item => item.id === id);
      return !priceList || !canUserViewPriceList(state.currentUser, priceList);
    });
    if (forbiddenId) {
      const error = new Error(`403: Price list ${forbiddenId} is not available for sales`);
      error.status = 403;
      console.error(error);
      showToast('403: Báº£ng giÃ¡ khÃ´ng Ä‘Æ°á»£c cáº¥p quyá»n cho kinh doanh.', 'danger');
      return false;
    }
  }
  if (isCloudActive && supabaseClient) {
    try {
      const targetTable = order.status === 'draft' ? tableDraftOrdersName : tableOrdersName;
      const commonRow = {
        id: order.id,
        idempotency_key: order.idempotencyKey || null,
        customer_id: order.customerId || null,
        customer_name: order.customerName,
        company_id: order.companyId || 'ABS_NORTH',
        notes: order.notes,
        items: order.items,
        total_market: order.totalMarket || 0,
        total_discount: order.totalDiscount || 0,
        subtotal: order.subtotal !== undefined ? order.subtotal : order.totalPayable,
        discount_value: order.discountValue || 0,
        discount_type: order.discountType || 'amount',
        discount_amount: order.discountAmount || order.totalDiscount || 0,
        other_fee_value: order.otherFeeValue || 0,
        other_fee_type: order.otherFeeType || 'amount',
        other_fee_amount: order.otherFeeAmount || 0,
        total_payable: order.totalPayable,
        status: order.status || 'settled',
        created_by: state.currentUser?.authUserId || null,
        created_at: order.date || order.createdAt || new Date().toISOString(),
        pricelist_id: order.pricelistId || 'retail'
      };

      // Older installations may not yet have the shipping columns on
      // draft_orders. A draft must remain savable during that transition.
      if (order.status !== 'draft') {
        commonRow.shipping_fee_value = order.shippingFeeValue || 0;
        commonRow.shipping_fee_amount = order.shippingFeeAmount || 0;
      }

      const dbRow = order.status === 'draft' ? commonRow : {
        ...commonRow,
        salesperson_id: order.salespersonId || order.createdBy || null,
        customer_manager_id: order.customerManagerId || order.managedBy || null,
        revenue_brand_id: order.revenueBrandId || null,
        total_amount: order.totalPayable || order.totalAmount || 0,
        paid_amount: order.paidAmount || 0,
        debt_amount: order.debtAmount || order.amountDue || (order.totalPayable - (order.paidAmount || 0)),
        returned_amount: order.returnedAmount || 0,
        net_revenue: order.netRevenue || (order.totalPayable - (order.returnedAmount || 0)),
        order_date: order.date || order.orderDate || new Date().toISOString(),
        confirmed_at: order.confirmedAt || (order.status === 'settled' ? (order.date || new Date().toISOString()) : null),
        updated_at: new Date().toISOString()
      };
      
      let { error } = await supabaseClient
        .from(targetTable)
        .upsert(dbRow, { onConflict: 'id' });

      if (error && order.status === 'draft' && /idempotency_key|schema cache|column/i.test(error.message || '')) {
        delete dbRow.idempotency_key;
        const retry = await supabaseClient.from(targetTable).upsert(dbRow, { onConflict: 'id' });
        error = retry.error;
      }
        
      if (error) throw error;

      // Đồng bộ chi tiết mặt hàng đơn vào bảng order_items nếu có
      if (order.status !== 'draft' && order.items && Array.isArray(order.items) && order.items.length > 0) {
        const itemRows = order.items.map((item, idx) => ({
          id: item.id || `${order.id}-item-${idx}`,
          order_id: order.id,
          product_id: item.variantId || item.productId || item.productCode || item.code || null,
          product_group_id: item.productGroupId || null,
          variant_id: item.variantId || item.productId || null,
          brand_id: item.brandId || item.brand || null,
          product_code_snapshot: item.productCode || item.code || '',
          variant_code_snapshot: item.variantCode || item.productCode || item.code || '',
          product_name_snapshot: item.productName || item.name || '',
          packaging_name_snapshot: item.packagingName || item.package || item.packageType || '',
          weight_or_volume_snapshot: item.weightOrVolumeSnapshot || item.specificationSnapshot || item.displaySpecification || '',
          specification_snapshot: item.specificationSnapshot || item.displaySpecification || item.package || item.packageType || '',
          unit_snapshot: item.packageWeightUnit || item.unit || item.package || item.packageType || '',
          price_list_name_snapshot: item.priceListNameSnapshot || order.priceListNameSnapshot || '',
          quantity: parseFloat(item.quantity || 0),
          unit_price: parseFloat(item.unitPrice || item.price || 0),
          final_unit_price: parseFloat(item.finalUnitPrice || item.salePrice || item.price || 0),
          price_list_id: item.priceListId || order.pricelistId || null,
          price_source: item.priceSource || '',
          price_selected_by: item.priceSelectedBy || order.priceSelectedBy || null,
          list_price: parseFloat(item.price || item.listPrice || 0),
          sale_price: parseFloat(item.salePrice || item.finalPrice || item.price || 0),
          discount_percent: parseFloat(item.discountPercent || item.discount || 0),
          discount_amount: parseFloat(item.discountAmount || 0),
          line_total: parseFloat(item.total || item.lineTotal || ((item.quantity || 0) * (item.price || 0) * (1 - (item.discountPercent || 0) / 100))),
          cost_price: parseFloat(item.costPrice || 0),
          profit_amount: parseFloat(item.profitAmount || 0),
          returned_quantity: parseFloat(item.returnedQuantity || 0),
          returned_amount: parseFloat(item.returnedAmount || 0),
          net_amount: parseFloat(item.netAmount || item.total || item.lineTotal || ((item.quantity || 0) * (item.price || 0) * (1 - (item.discountPercent || 0) / 100))),
          created_at: order.date || new Date().toISOString()
        }));
        const { error: itemError } = await supabaseClient
          .from(tableOrderItemsName)
          .upsert(itemRows, { onConflict: 'id' });
        if (itemError) throw itemError;
      }
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu hóa đơn lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbDeleteOrder(id, status = null) {
  if (isCloudActive && supabaseClient) {
    try {
      if (status === 'draft') {
        const { error } = await supabaseClient
          .from(tableDraftOrdersName)
          .delete()
          .eq('id', id);
        if (error) throw error;
      } else if (status === 'settled') {
        showToast('Đơn đã chốt không được xóa vật lý. Hủy/đảo giao dịch sẽ được bổ sung ở giai đoạn 2.', 'warning');
        return false;
      } else {
        // Unknown status is treated as draft-only. Finalized history is immutable.
        await supabaseClient.from(tableDraftOrdersName).delete().eq('id', id);
      }
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa hóa đơn trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbDeleteAllOrders() {
  if (isCloudActive && supabaseClient) {
    try {
      const { error: err2 } = await supabaseClient
        .from(tableDraftOrdersName)
        .delete()
        .neq('id', 'temp_id_none');
      if (err2) throw err2;
      showToast('Chỉ đơn nháp được xóa. Lịch sử đơn đã chốt được giữ nguyên.', 'warning');
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa lịch sử trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

// --- Thao tác CSDL chi tiết (Người dùng & Auth) ---
export async function authRegisterOrUpdateUser(user, isNew) {
  if (!isCloudActive || !supabaseClient) return false;
  if (isNew && !user.isExternal) {
    showToast('Hãy tạo tài khoản trong Supabase Auth trước. Website không tự tạo tài khoản hoặc tự gán role.', 'warning');
    return false;
  }
  return true;
}

export async function dbSaveUser(user) {
  if (isCloudActive && supabaseClient) {
    try {
      const isNew = !state.users.some(existing => existing.id === user.id);
      if (!(await authRegisterOrUpdateUser(user, isNew))) return false;
      const dbRow = {
        id: user.id,
        auth_user_id: user.authUserId || (/^[0-9a-f-]{36}$/i.test(String(user.id)) ? user.id : null),
        username: user.username,
        display_name: user.displayName,
        role: user.role,
        company_id: user.companyId || 'ABS_NORTH',
        is_external: user.isExternal || false,
        is_active: user.isActive !== false,
        updated_at: new Date().toISOString()
      };
      
      const { error } = await supabaseClient
        .from(tableUsersName)
        .upsert(dbRow, { onConflict: 'id' });
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu người dùng trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbDeleteUser(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableUsersName)
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id);
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa người dùng trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

// --- Thao tác CSDL chi tiết (Hãng sơn) ---
export async function dbSaveBrand(brand, oldName = null) {
  if (isCloudActive && supabaseClient) {
    try {
      const brandId = brand.id || ('brand_' + String(brand.name).toLowerCase().replace(/[^a-z0-9]/g, ''));
      const dbRow = {
        id: brandId,
        name: brand.name,
        company_id: brand.companyId || null,
        company_name: brand.companyName || 'Dùng chung',
        logo_filename: brand.logoFilename || '',
        hotline: brand.hotline || '',
        cskh: brand.cskh || '',
        email: brand.email || '',
        address_main: brand.addressMain || '',
        address_factory: brand.addressFactory || '',
        address_business: brand.addressBusiness || null
      };

      // Xóa các dòng cũ trên Cloud trùng ID hoặc Tên (bất kể chữ hoa/thường)
      if (brandId) {
        await supabaseClient.from(tableBrandsName).delete().eq('id', brandId);
      }
      if (oldName) {
        await supabaseClient.from(tableBrandsName).delete().ilike('name', oldName);
      }
      if (brand.name) {
        await supabaseClient.from(tableBrandsName).delete().ilike('name', brand.name);
      }
      
      const { error: upsertErr } = await supabaseClient
        .from(tableBrandsName)
        .upsert(dbRow);

      if (upsertErr) throw upsertErr;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu hãng sơn lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbDeleteBrand(name, id = null) {
  if (isCloudActive && supabaseClient) {
    try {
      if (id) {
        await supabaseClient.from(tableBrandsName).delete().eq('id', id);
      }
      if (name) {
        await supabaseClient.from(tableBrandsName).delete().ilike('name', name);
      }
      return true;
    } catch(err) {
      console.error(err);
      return false;
    }
  }
  return true;
}

// --- Thao tác CSDL chi tiết (Sổ quỹ & Số dư đầu kỳ) ---
export async function dbSaveCashbookTransaction(tx) {
  if (isCloudActive && supabaseClient) {
    try {
      if (tx.customerId) {
        throw new Error('Giao dịch công nợ phải dùng RPC nghiệp vụ riêng.');
      }
      const idempotencyKey = String(tx.idempotencyKey || `cashbook:${tx.id || ''}`).trim();
      const { data, error } = await supabaseClient.rpc('rpc_create_cashbook_transaction', {
        p_input: {
          idempotencyKey,
          externalReference: tx.id || '',
          transactionDate: tx.date || tx.transactionDate || new Date().toISOString(),
          type: tx.type,
          category: tx.category || '',
          partner: tx.partner || '',
          value: Number(tx.value || 0),
          method: tx.paymentMethod || tx.method || 'cash',
          accounting: tx.accounting !== false,
          note: tx.note || ''
        }
      });
      if (error) throw error;
      if (data?.transaction) Object.assign(tx, data.transaction);
      return data || { success: true };
    } catch(err) {
      console.warn('Không thể ghi giao dịch Sổ quỹ:', err.message || err);
      return false;
    }
  }
  showToast('Sổ quỹ chỉ được ghi khi đã kết nối và xác thực với Cloud.', 'danger');
  return false;
}

export async function dbSaveStartingBalances(balances) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_set_cashbook_starting_balances', {
        p_cash: Number(balances.cash || 0),
        p_bank: Number(balances.bank || 0),
        p_wallet: Number(balances.wallet || 0)
      });
      if (error) throw error;
      return data || { success: true };
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu Số dư đầu kỳ lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  showToast('Số dư đầu kỳ chỉ được ghi khi đã kết nối và xác thực với Cloud.', 'danger');
  return false;
}

export async function dbSaveSupplier(supplier) {
  if (!isCloudActive || !supabaseClient) {
    showToast('Nhà cung cấp chỉ được lưu khi đã kết nối Cloud.', 'danger');
    return false;
  }
  try {
    const { data, error } = await supabaseClient.rpc('rpc_save_supplier', {
      p_input: {
        id: supplier.id || null,
        code: supplier.code,
        name: supplier.name,
        phone: supplier.phone || '',
        address: supplier.address || '',
        openingDebt: Number(supplier.openingDebt ?? supplier.debt ?? 0),
        notes: supplier.notes || ''
      }
    });
    if (error) throw error;
    if (data?.supplier) applyCanonicalSupplier(data.supplier);
    return data || { success: true };
  } catch (err) {
    console.warn('Cloud supplier RPC failed:', err.message || err);
    showToast(err.message || 'Không thể lưu nhà cung cấp.', 'danger');
    return false;
  }
}

async function legacyDbSaveSuppliersBulk(suppliers) {
  if (isCloudActive && supabaseClient && suppliers.length > 0) {
    try {
      const dbRows = suppliers.map(supplier => ({
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        phone: supplier.phone,
        address: supplier.address,
        debt: parseFloat(supplier.debt || 0),
        notes: supplier.notes || ''
      }));
      const tableName = tableProductsName.startsWith('wl_') ? 'wl_suppliers' : 'suppliers';
      const { error } = await supabaseClient
        .from(tableName)
        .upsert(dbRows, { onConflict: 'id' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error(err);
      showToast('Không thể lưu danh sách nhà cung cấp lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

async function legacyDbDeleteSupplier(supplierId) {
  if (isCloudActive && supabaseClient) {
    try {
      const tableName = tableProductsName.startsWith('wl_') ? 'wl_suppliers' : 'suppliers';
      const { error } = await supabaseClient
        .from(tableName)
        .delete()
        .eq('id', supplierId);
      if (error) {
        console.warn("Could not delete supplier from cloud table:", error.message);
      }
    } catch (err) {
      console.warn("Cloud delete supplier failed:", err);
    }
  }
  return true;
}

// --- Thao tác CSDL chi tiết (Phân hệ Hàng hóa & Sản xuất) ---

export async function dbSaveSuppliersBulk(suppliers) {
  if (!Array.isArray(suppliers) || suppliers.length === 0) return { success: true, saved: 0 };
  let saved = 0;
  for (const supplier of suppliers) {
    const result = await dbSaveSupplier(supplier);
    if (!result) return false;
    saved += 1;
  }
  return { success: true, saved };
}

export async function dbDeleteSupplier(supplierId, reason = 'Ngừng sử dụng nhà cung cấp') {
  if (!isCloudActive || !supabaseClient) return false;
  try {
    const { data, error } = await supabaseClient.rpc('rpc_deactivate_supplier', {
      p_supplier_id: supplierId,
      p_reason: reason
    });
    if (error) throw error;
    state.suppliers = state.suppliers.filter(item => String(item.id) !== String(supplierId));
    return data || { success: true };
  } catch (err) {
    console.warn('Cloud supplier deactivation failed:', err.message || err);
    showToast(err.message || 'Không thể ngừng sử dụng nhà cung cấp.', 'danger');
    return false;
  }
}

function applyCanonicalSupplier(supplier) {
  if (!supplier) return;
  const normalized = {
    id: supplier.id,
    code: supplier.code,
    name: supplier.name,
    phone: supplier.phone || '',
    address: supplier.address || '',
    openingDebt: Number(supplier.openingDebt || 0),
    totalPurchase: Number(supplier.totalPurchase || 0),
    totalPaid: Number(supplier.totalPaid || 0),
    debt: Number(supplier.debt || 0),
    notes: supplier.notes || '',
    isActive: supplier.isActive !== false
  };
  const index = state.suppliers.findIndex(item => String(item.id) === String(normalized.id));
  if (normalized.isActive) {
    if (index >= 0) state.suppliers[index] = normalized;
    else state.suppliers.push(normalized);
  } else if (index >= 0) state.suppliers.splice(index, 1);
}

function applyCanonicalPurchase(purchase) {
  if (!purchase) return;
  const normalized = {
    ...purchase,
    date: purchase.purchaseDate,
    totalAmount: Number(purchase.totalAmount || 0),
    totalPayable: Number(purchase.totalAmount || 0),
    paidAmount: Number(purchase.paidAmount || 0),
    balanceDue: Number(purchase.balanceDue || 0),
    items: Array.isArray(purchase.items) ? purchase.items.map(item => ({
      ...item,
      quantity: Number(item.quantity || 0),
      unitPrice: Number(item.unitPrice || 0),
      price: Number(item.unitPrice || 0),
      lineTotal: Number(item.lineTotal || 0)
    })) : [],
    payments: Array.isArray(purchase.payments) ? purchase.payments : []
  };
  const index = state.purchases.findIndex(item => String(item.id) === String(normalized.id));
  if (index >= 0) state.purchases[index] = normalized;
  else state.purchases.unshift(normalized);
}

function applyPhase4Response(data) {
  if (data?.supplier) applyCanonicalSupplier(data.supplier);
  if (data?.purchase) applyCanonicalPurchase(data.purchase);
  return data;
}

export async function dbCreatePurchase(input) {
  if (!isCloudActive || !supabaseClient) {
    showToast('Phiếu mua chỉ được tạo khi đã kết nối Cloud.', 'danger');
    return false;
  }
  try {
    const { data, error } = await supabaseClient.rpc('rpc_create_purchase', {
      p_input: {
        supplierId: input.supplierId,
        invoiceNumber: input.invoiceNumber || '',
        purchaseDate: input.purchaseDate,
        paidAmount: Number(input.paidAmount || 0),
        paymentMethod: input.paymentMethod || 'cash',
        notes: input.notes || '',
        idempotencyKey: input.idempotencyKey,
        items: (input.items || []).map(item => ({
          code: item.code,
          name: item.name,
          unit: item.unit || '',
          quantity: Number(item.quantity || 0),
          unitPrice: Number(item.unitPrice ?? item.price ?? 0)
        }))
      }
    });
    if (error) throw error;
    return applyPhase4Response(data);
  } catch (err) {
    console.warn('Create purchase RPC failed:', err.message || err);
    showToast(err.message || 'Không thể tạo phiếu mua.', 'danger');
    return false;
  }
}

export async function dbRecordSupplierPayment(input) {
  if (!isCloudActive || !supabaseClient) return false;
  try {
    const { data, error } = await supabaseClient.rpc('rpc_record_supplier_payment', {
      p_input: {
        supplierId: input.supplierId,
        purchaseId: input.purchaseId || null,
        amount: Number(input.amount || 0),
        paymentMethod: input.paymentMethod || 'cash',
        notes: input.notes || '',
        idempotencyKey: input.idempotencyKey
      }
    });
    if (error) throw error;
    return applyPhase4Response(data);
  } catch (err) {
    console.warn('Supplier payment RPC failed:', err.message || err);
    showToast(err.message || 'Không thể ghi phiếu chi nhà cung cấp.', 'danger');
    return false;
  }
}

export async function dbCancelSupplierPayment(paymentId, reason) {
  if (!isCloudActive || !supabaseClient) return false;
  try {
    const { data, error } = await supabaseClient.rpc('rpc_cancel_supplier_payment', {
      p_payment_id: paymentId,
      p_reason: reason
    });
    if (error) throw error;
    return applyPhase4Response(data);
  } catch (err) {
    console.warn('Cancel supplier payment RPC failed:', err.message || err);
    showToast(err.message || 'Không thể hủy phiếu chi nhà cung cấp.', 'danger');
    return false;
  }
}

export async function dbCancelPurchase(purchaseId, reason) {
  if (!isCloudActive || !supabaseClient) return false;
  try {
    const { data, error } = await supabaseClient.rpc('rpc_cancel_purchase', {
      p_purchase_id: purchaseId,
      p_reason: reason
    });
    if (error) throw error;
    return applyPhase4Response(data);
  } catch (err) {
    console.warn('Cancel purchase RPC failed:', err.message || err);
    showToast(err.message || 'Không thể hủy phiếu mua.', 'danger');
    return false;
  }
}

export async function dbSaveRawMaterial(item) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: item.id,
        code: item.code,
        name: item.name,
        unit: item.unit || 'kg',
        import_price: parseFloat(item.importPrice || 0),
        quantity: parseFloat(item.quantity || 0),
        notes: item.notes || ''
      };
      const { error } = await supabaseClient
        .from(tableRawMaterialsName)
        .upsert(dbRow, { onConflict: 'id' });
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud save raw material failed, using local fallback:", err.message);
    }
  }
  return true;
}

export async function dbDeleteRawMaterial(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableRawMaterialsName)
        .delete()
        .eq('id', id);
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud delete raw material failed:", err.message);
    }
  }
  return true;
}

export async function dbSaveSemiFinished(item) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: item.id,
        code: item.code,
        name: item.name,
        unit: item.unit || 'kg',
        quantity: parseFloat(item.quantity || 0),
        notes: item.notes || ''
      };
      const { error } = await supabaseClient
        .from(tableSemiFinishedName)
        .upsert(dbRow, { onConflict: 'id' });
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud save semi finished failed, using local fallback:", err.message);
    }
  }
  return true;
}

export async function dbDeleteSemiFinished(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableSemiFinishedName)
        .delete()
        .eq('id', id);
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud delete semi finished failed:", err.message);
    }
  }
  return true;
}

export async function dbSaveRecipe(item) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: item.id,
        name: item.name,
        semi_finished_id: item.semiFinishedId,
        output_quantity: parseFloat(item.outputQuantity || 1),
        ingredients: item.ingredients || [],
        notes: item.notes || ''
      };
      const { error } = await supabaseClient
        .from(tableRecipesName)
        .upsert(dbRow, { onConflict: 'id' });
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud save recipe failed, using local fallback:", err.message);
    }
  }
  return true;
}

export async function dbDeleteRecipe(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableRecipesName)
        .delete()
        .eq('id', id);
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud delete recipe failed:", err.message);
    }
  }
  return true;
}

export async function dbSaveProductionLog(item) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: item.id,
        recipe_id: item.recipeId,
        recipe_name: item.recipeName,
        semi_finished_name: item.semiFinishedName,
        quantity: parseFloat(item.quantity || 0),
        raw_materials_used: item.rawMaterialsUsed || [],
        created_by: item.createdBy || 'admin',
        created_at: item.date || new Date().toISOString()
      };
      const { error } = await supabaseClient
        .from(tableProductionLogsName)
        .upsert(dbRow, { onConflict: 'id' });
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud save production log failed, using local fallback:", err.message);
    }
  }
  return true;
}

export async function dbSaveFinishedGoodsStock(item) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        product_code: item.productCode,
        brand: item.brand,
        package_type: item.packageType,
        quantity: parseFloat(item.quantity || 0),
        updated_at: new Date().toISOString()
      };
      const { error } = await supabaseClient
        .from(tableFinishedGoodsStockName)
        .upsert(dbRow, { onConflict: 'product_code,brand,package_type' });
      if (error) throw error;
    } catch (err) {
      console.warn("Cloud save finished goods stock failed, using local fallback:", err.message);
    }
  }
  return true;
}

export async function dbSaveRawMaterialsBulk(items) {
  if (isCloudActive && supabaseClient && items.length > 0) {
    try {
      const dbRows = items.map(item => ({
        id: item.id,
        code: item.code,
        name: item.name,
        unit: item.unit || 'kg',
        import_price: parseFloat(item.importPrice || 0),
        quantity: parseFloat(item.quantity || 0),
        notes: item.notes || ''
      }));
      const { error } = await supabaseClient
        .from(tableRawMaterialsName)
        .upsert(dbRows, { onConflict: 'id' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error(err);
      showToast('Không thể lưu danh sách nguyên liệu lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return false;
}

export async function dbDeleteAllRawMaterials() {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableRawMaterialsName)
        .delete()
        .neq('id', '');
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa danh sách nguyên liệu trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbSaveSemiFinishedBulk(items) {
  if (isCloudActive && supabaseClient && items.length > 0) {
    try {
      const dbRows = items.map(item => ({
        id: item.id,
        code: item.code,
        name: item.name,
        unit: item.unit || 'kg',
        quantity: parseFloat(item.quantity || 0),
        notes: item.notes || ''
      }));
      const { error } = await supabaseClient
        .from(tableSemiFinishedName)
        .upsert(dbRows, { onConflict: 'id' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error(err);
      showToast('Không thể lưu danh sách bán thành phẩm lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return false;
}

export async function dbDeleteAllSemiFinished() {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableSemiFinishedName)
        .delete()
        .neq('id', '');
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa danh sách bán thành phẩm trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export function getSalesReturns() {
  const stored = localStorage.getItem('billing_system_sales_returns');
  if (stored) {
    try { return JSON.parse(stored); } catch(e) { return []; }
  }
  return [];
}

export function saveSalesReturns(returns) {
  localStorage.setItem('billing_system_sales_returns', JSON.stringify(returns));
}

export async function dbSaveSalesReturn(ret) {
  void ret;
  showToast('Phiếu trả hàng chỉ được ghi bằng RPC nghiệp vụ có kiểm tra đơn gốc.', 'danger');
  return false;
}

export function backfillMultiCompanyAndRevenueData() {
  // 1. Backfill Brands ID & Deduplicate
  if (state.brands && state.brands.length > 0) {
    const uniqueBrands = [];
    const seenIds = new Set();
    state.brands.forEach(b => {
      if (!b.id && b.name) {
        b.id = 'brand_' + String(b.name).toLowerCase().replace(/[^a-z0-9]/g, '');
      }
      if (b.id && !seenIds.has(b.id)) {
        seenIds.add(b.id);
        uniqueBrands.push(b);
      }
    });
    state.brands = uniqueBrands;
    localStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
  }

  // 2. Clean Sweep & Normalize Product Brands
  if (state.products && state.products.length > 0) {
    let prodChanged = false;
    const normalizedProducts = [];
    state.products.forEach(p => {
      const canonical = getBrandById(p.brandId || p.brand);
      if (canonical) {
        if (p.brand !== canonical.name || p.brandId !== canonical.id) {
          p.brand = canonical.name;
          p.brandId = canonical.id;
          prodChanged = true;
          normalizedProducts.push(p);
        }
      }
    });
    if (prodChanged) {
      localStorage.setItem('billing_system_products', JSON.stringify(state.products));
      if (isCloudActive && supabaseClient) {
        Promise.all(normalizedProducts.map(p =>
          supabaseClient
            .from(tableProductsName)
            .update({
              brand: p.brand,
              brand_id: p.brandId,
              updated_at: new Date().toISOString()
            })
            .eq('id', p.id)
        )).then(results => {
          const failed = results.find(result => result.error);
          if (failed) console.error('Không thể đồng bộ lại hãng sơn cho một số sản phẩm:', failed.error);
        }).catch(error => {
          console.error('Không thể đồng bộ lại hãng sơn cho các sản phẩm:', error);
        });
      }
    }
  }

  // 3. Clean Sweep & Normalize Customer Brands
  if (state.customers && state.customers.length > 0) {
    let custChanged = false;
    state.customers.forEach(c => {
      if (c.assignedBrand && c.assignedBrand !== 'Tất cả') {
        const canonical = getBrandById(c.assignedBrandId || c.assignedBrand);
        if (canonical) {
          if (c.assignedBrand !== canonical.name || c.assignedBrandId !== canonical.id) {
            c.assignedBrand = canonical.name;
            c.assignedBrandId = canonical.id;
            custChanged = true;
          }
        }
      }
    });
    if (custChanged) {
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
    }
  }

  // 4. Backfill Orders & Items
  if (state.savedOrders && state.savedOrders.length > 0) {
    state.savedOrders.forEach(order => {
      if (!order.companyId) {
        const creator = (state.users || []).find(u => isSameUser(u.username, order.createdBy));
        order.companyId = creator ? (creator.companyId || creator.company_id || 'ABS_NORTH') : 'ABS_NORTH';
      }

      let customerAgencyBrand = 'Nano10*';
      if (order.customerId) {
        const cust = (state.customers || []).find(c => c.id === order.customerId);
        if (cust && cust.assignedBrand && cust.assignedBrand !== 'Tất cả') {
          customerAgencyBrand = cust.assignedBrand;
        }
      }

      if (order.items) {
        order.items.forEach(item => {
          if (!item.companyId) item.companyId = order.companyId;
          if (!item.productBrand) item.productBrand = item.brand || 'Nano10*';
          if (!item.agencyBrand) item.agencyBrand = customerAgencyBrand;
          if (!item.revenueBrand || !item.revenueCompany) {
            const revAttrs = getRevenueAttributes(item.productBrand, item.agencyBrand, order.companyId, state.brands);
            item.revenueBrand = revAttrs.revenueBrand;
            item.revenueCompany = revAttrs.revenueCompany;
          }
        });
      }
    });
  }

  if (state.salesReturns && state.salesReturns.length > 0) {
    state.salesReturns.forEach(ret => {
      if (!ret.companyId) {
        const creator = (state.users || []).find(u => isSameUser(u.username, ret.createdBy));
        ret.companyId = creator ? (creator.companyId || creator.company_id || 'ABS_NORTH') : 'ABS_NORTH';
      }

      let customerAgencyBrand = 'Nano10*';
      if (ret.customerId) {
        const cust = (state.customers || []).find(c => c.id === ret.customerId);
        if (cust && cust.assignedBrand && cust.assignedBrand !== 'Tất cả') {
          customerAgencyBrand = cust.assignedBrand;
        }
      }

      if (ret.items) {
        ret.items.forEach(item => {
          if (!item.companyId) item.companyId = ret.companyId;
          if (!item.productBrand) item.productBrand = item.brand || 'Nano10*';
          if (!item.agencyBrand) item.agencyBrand = customerAgencyBrand;
          if (!item.revenueBrand || !item.revenueCompany) {
            const revAttrs = getRevenueAttributes(item.productBrand, item.agencyBrand, ret.companyId, state.brands);
            item.revenueBrand = revAttrs.revenueBrand;
            item.revenueCompany = revAttrs.revenueCompany;
          }
        });
      }
    });
  }
}

// --- THỦ TỤC TRANSACTIONAL CSDL (DATABASE TRANSACTIONS) ---

export async function dbConfirmOrder(order) {
  if (state.currentUser?.role === 'sale') {
    const usedPriceListIds = new Set([
      order.pricelistId,
      ...(order.items || []).map(item => item.priceListId)
    ].filter(id => id && id !== 'retail'));
    const forbiddenId = [...usedPriceListIds].find(id => {
      const priceList = state.pricelists.find(item => item.id === id);
      return !priceList || !canUserViewPriceList(state.currentUser, priceList);
    });
    if (forbiddenId) {
      const error = new Error(`403: Price list ${forbiddenId} is not available for sales`);
      error.status = 403;
      console.error(error);
      showToast('403: Báº£ng giÃ¡ khÃ´ng Ä‘Æ°á»£c cáº¥p quyá»n cho kinh doanh.', 'danger');
      return false;
    }
  }
  if (isCloudActive && supabaseClient) {
    try {
      // The browser sends only business inputs. The database derives actors,
      // authorized prices, immutable snapshots and every persisted total.
      const command = {
        // Compatibility previews keep the current site usable while staging is
        // migrated. Migration 0006 deliberately ignores these monetary fields.
        id: order.id,
        idempotencyKey: order.idempotencyKey,
        draftId: order.draftId || null,
        customerId: order.customerId || null,
        customerName: order.customerName || '',
        date: order.date || new Date().toISOString(),
        notes: order.notes || '',
        pricelistId: order.pricelistId || null,
        discountType: order.discountType || 'amount',
        discountValue: Number(order.discountValue || 0),
        otherFeeType: order.otherFeeType || 'amount',
        otherFeeValue: Number(order.otherFeeValue || 0),
        shippingFeeValue: Number(order.shippingFeeValue || order.shippingFeeAmount || 0),
        shippingFeeAmount: Number(order.shippingFeeAmount || order.shippingFeeValue || 0),
        totalMarket: Number(order.totalMarket || 0),
        totalDiscount: Number(order.totalDiscount || 0),
        subtotal: Number(order.subtotal || 0),
        discountAmount: Number(order.discountAmount || 0),
        otherFeeAmount: Number(order.otherFeeAmount || 0),
        totalPayable: Number(order.totalPayable || 0),
        amountDue: Number(order.amountDue || 0),
        paidAmount: 0,
        items: (order.items || []).map(item => ({
          variantId: item.variantId || item.productId,
          quantity: Number(item.quantity),
          discountType: item.discountType || 'percent',
          discountValue: Number(item.discountValue ?? item.discountPercent ?? 0),
          discountPercent: Number(item.discountPercent || 0),
          price: Number(item.price || item.unitPrice || 0),
          unitPrice: Number(item.unitPrice || item.price || 0),
          listPrice: Number(item.listPrice || item.price || 0),
          finalUnitPrice: Number(item.finalUnitPrice || item.price || 0),
          priceListId: item.priceListId || order.pricelistId || null,
          productId: item.productId || item.variantId,
          colorCode: item.colorCode || '',
          colorPercent: Number(item.colorPercent || 0),
          notes: item.notes || ''
        }))
      };
      const { data, error } = await supabaseClient.rpc('rpc_confirm_order', { p_order: command });
      if (error) throw error;
      if (data && data.success === false) {
        throw new Error(data.message || 'Transaction chốt đơn không thành công');
      }
      return data || { success: true };
    } catch (err) {
      console.error('RPC confirm order error:', err);
      throw new Error('Không thể chốt đơn: ' + (err.message || 'Transaction thất bại'));
    }
  }
  return true;
}

export async function dbRecordCustomerPayment(customerId, amount, notes, paymentMethod = 'cash', idempotencyKey = '') {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_record_customer_payment', {
        p_customer_id: customerId,
        p_amount: amount,
        p_notes: notes || 'Thu tiền nợ',
        p_payment_method: paymentMethod || 'cash',
        p_idempotency_key: idempotencyKey || globalThis.crypto.randomUUID()
      });
      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      console.error('RPC customer payment error:', err);
      showToast('Lỗi ghi nhận thu tiền: ' + err.message, 'danger');
      return false;
    }
  }
  showToast('Thu nợ cần kết nối Cloud để bảo đảm transaction và ledger.', 'danger');
  return false;
}

export async function dbCancelCustomerPayment(cashbookId, _createdBy) {
  return dbCancelCashbookEntry(cashbookId, 'Hủy phiếu thu công nợ');
}

function getFinancialCancellationMessage(error, subject) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('không đủ quyền') || error?.code === '42501') {
    return `Bạn không có quyền ${subject}.`;
  }
  if (message.includes('thiếu') && message.includes('liên kết')) {
    return `Dữ liệu cũ thiếu liên kết cần thiết, chưa thể ${subject} an toàn.`;
  }
  if (message.includes('đã hủy') || message.includes('already')) {
    return `Giao dịch này đã được hủy trước đó.`;
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return `Không thể kết nối Cloud. Dữ liệu chưa thay đổi.`;
  }
  return `Không thể ${subject}. Dữ liệu chưa thay đổi; vui lòng thử lại.`;
}

export async function dbCancelCashbookEntry(cashbookId, reason = '') {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_cancel_cashbook_entry', {
        p_cashbook_id: cashbookId,
        p_reason: reason || 'Hủy phiếu sổ quỹ'
      });
      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      const missingCompatibilityRpc = err?.code === 'PGRST202'
        || (String(err?.message || '').includes('rpc_cancel_cashbook_entry')
          && String(err?.message || '').toLowerCase().includes('schema cache'));
      if (missingCompatibilityRpc) {
        // Rolling-upgrade bridge only. Old database signatures remain server-side
        // authorities; the browser still does not infer a financial operation type.
        const legacyGeneric = await supabaseClient.rpc('rpc_cancel_cashbook_transaction', {
          p_cashbook_id: cashbookId,
          p_reason: reason || 'Hủy phiếu sổ quỹ'
        });
        if (!legacyGeneric.error) return legacyGeneric.data || { success: true };
        const legacyCustomer = await supabaseClient.rpc('rpc_cancel_customer_payment', {
          p_cashbook_id: cashbookId
        });
        if (!legacyCustomer.error) return legacyCustomer.data || { success: true };
        console.error('Legacy cashbook cancellation unavailable before migration 0013:', legacyGeneric.error);
        showToast('Cơ sở dữ liệu chưa được cập nhật để hủy phiếu cũ. Dữ liệu chưa thay đổi.', 'danger');
        return false;
      }
      console.error('RPC cancel cashbook error:', err);
      showToast(getFinancialCancellationMessage(err, 'hủy phiếu sổ quỹ'), 'danger');
      return false;
    }
  }
  showToast('Không thể kết nối Cloud. Dữ liệu chưa thay đổi.', 'danger');
  return false;
}

// Kept for older callers; classification now belongs to the database RPC.
export async function dbCancelCashbookTransaction(cashbookId, reason = '') {
  return dbCancelCashbookEntry(cashbookId, reason);
}

export async function dbSetCashbookStarred(cashbookId, starred) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_set_cashbook_starred', {
        p_cashbook_id: cashbookId,
        p_starred: Boolean(starred)
      });
      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      console.error('RPC cashbook starred error:', err);
      return false;
    }
  }
  return false;
}

export async function dbCancelOrder(orderId, reason) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_cancel_order', {
        p_order_id: orderId,
        p_reason: reason || ''
      });
      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      console.error('RPC cancel order error:', err);
      showToast(getFinancialCancellationMessage(err, 'hủy đơn'), 'danger');
      return false;
    }
  }
  return false;
}

export async function dbRecordSalesReturn(ret, items) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_record_sales_return', {
        p_input: {
          orderId: ret.saleId || ret.orderId,
          reason: ret.reason || '',
          paymentMethod: ret.paymentMethod || 'cash',
          idempotencyKey: ret.idempotencyKey,
          items: (items || []).map(item => ({
            saleItemId: item.saleItemId,
            quantity: Number(item.quantity || 0)
          }))
        }
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.message || 'Không thể ghi nhận phiếu trả hàng');
      return data || { success: true };
    } catch (err) {
      console.warn('RPC sales return error:', err);
      showToast('Không thể ghi nhận phiếu trả hàng. Dữ liệu chưa thay đổi để tránh lệch công nợ.', 'danger');
      return false;
    }
  }
  showToast('Trả hàng cần kết nối Cloud để bảo đảm transaction và giao dịch đảo.', 'danger');
  return false;
}

export async function dbCancelSalesReturn(returnId, reason) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_cancel_sales_return', {
        p_return_id: returnId,
        p_reason: reason || '',
      });
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.message || 'Không thể hủy phiếu trả hàng');
      return data || { success: true };
    } catch (err) {
      console.warn('RPC cancel sales return error:', err);
      showToast('Không thể hủy phiếu trả hàng. Dữ liệu chưa thay đổi để tránh lệch công nợ.', 'danger');
      return false;
    }
  }
  showToast('Hủy trả hàng cần kết nối Cloud để bảo đảm giao dịch đảo.', 'danger');
  return false;
}

export async function dbAdjustCustomerDebt(customerId, newDebt, description, _createdBy) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_adjust_customer_debt', {
        p_customer_id: customerId,
        p_new_debt: newDebt,
        p_description: description || 'Điều chỉnh công nợ',
      });
      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      console.error('RPC adjust customer debt error:', err);
      return false;
    }
  }
  showToast('Điều chỉnh công nợ cần kết nối Cloud.', 'danger');
  return false;
}

// --- BỘ LỌC VÀ PHÂN TRANG HIỆU NĂNG CAO (SERVER-SIDE PAGINATION & LAZY LOADING) ---

// Phase 5 summaries and payroll are authoritative database calculations.
export async function dbFetchPhase5Dashboard(filters = {}) {
  if (!isCloudActive || !supabaseClient) throw new Error('Cần kết nối Cloud để tải báo cáo chính xác.');
  const { data, error } = await supabaseClient.rpc('rpc_get_phase5_dashboard', { p_filters: filters });
  if (error) throw error;
  return data;
}

export async function dbFetchPhase5Report(input = {}) {
  if (!isCloudActive || !supabaseClient) throw new Error('Cần kết nối Cloud để tải báo cáo chính xác.');
  const { data, error } = await supabaseClient.rpc('rpc_get_phase5_report', { p_input: input });
  if (error) throw error;
  return data;
}

export async function dbFetchPayrollPeriod(period) {
  if (!isCloudActive || !supabaseClient) throw new Error('Cần kết nối Cloud để tính lương.');
  const { data, error } = await supabaseClient.rpc('rpc_get_payroll_period', { p_period: period });
  if (error) throw error;
  return data;
}

export async function dbSavePayrollAdjustment(input) {
  if (!isCloudActive || !supabaseClient) throw new Error('Cần kết nối Cloud để lưu điều chỉnh lương.');
  const { data, error } = await supabaseClient.rpc('rpc_save_payroll_adjustment', { p_input: input });
  if (error) throw error;
  return data;
}

export async function dbSetPayrollPeriodLock(period, lock, reason = null) {
  if (!isCloudActive || !supabaseClient) throw new Error('Cần kết nối Cloud để khóa kỳ lương.');
  const { data, error } = await supabaseClient.rpc('rpc_set_payroll_period_lock', {
    p_period: period,
    p_lock: Boolean(lock),
    p_reason: reason
  });
  if (error) throw error;
  return data;
}

export async function dbFetchCustomersPaginated(search = '', managedBy = null, limit = 50, offset = 0) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_get_customers_paginated', {
        p_search: search,
        p_managed_by: managedBy,
        p_limit: limit,
        p_offset: offset
      });
      if (error) throw error;
      return data;
    } catch (err) {
      console.warn('Lỗi tải dữ liệu khách hàng phân trang:', err);
      return { total: 0, data: [] };
    }
  }
  return { total: (state.customers || []).length, data: (state.customers || []).slice(offset, offset + limit) };
}

export async function dbFetchOrdersPaginated(search = '', status = null, customerId = null, limit = 50, offset = 0) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_get_orders_paginated', {
        p_search: search,
        p_status: status,
        p_customer_id: customerId,
        p_limit: limit,
        p_offset: offset
      });
      if (error) throw error;
      return data;
    } catch (err) {
      console.warn('Lỗi tải dữ liệu đơn hàng phân trang:', err);
      return { total: 0, data: [] };
    }
  }
  return { total: (state.savedOrders || []).length, data: (state.savedOrders || []).slice(offset, offset + limit) };
}

export async function dbFetchCustomerOrderHistory(customerId, startIso, endExclusiveIso, status = 'all') {
  return dbFetchCustomersOrderHistory([customerId], startIso, endExclusiveIso, status);
}

export async function dbFetchCustomersOrderHistory(customerIds, startIso, endExclusiveIso, status = 'all') {
  const idSet = new Set((customerIds || []).map(id => String(id)).filter(Boolean));
  const mapOrderRow = (order) => ({
    id: order.id,
    customerId: order.customer_id || order.customerId || null,
    customerName: order.customer_name || order.customerName || '',
    customerPhone: order.customer_phone || order.customerPhone || '',
    customerAddress: order.customer_address || order.customerAddress || '',
    notes: order.notes || '',
    items: typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []),
    date: order.order_date || order.created_at || order.date || order.createdAt,
    pricingVersion: order.pricing_version || order.pricingVersion || '',
    createdAt: order.created_at || order.createdAt || order.date,
    updatedAt: order.updated_at || order.updatedAt || order.created_at || order.date,
    totalMarket: parseFloat(order.total_market ?? order.totalMarket ?? 0),
    totalDiscount: parseFloat(order.total_discount ?? order.totalDiscount ?? 0),
    subtotal: parseFloat(order.subtotal ?? order.total_payable ?? order.totalPayable ?? 0),
    discountValue: parseFloat(order.discount_value ?? order.discountValue ?? 0),
    discountType: order.discount_type || order.discountType || 'amount',
    discountAmount: parseFloat(order.discount_amount ?? order.discountAmount ?? 0),
    otherFeeAmount: parseFloat(order.other_fee_amount ?? order.otherFeeAmount ?? 0),
    shippingFeeValue: parseFloat(order.shipping_fee_value ?? order.shippingFeeValue ?? 0),
    shippingFeeAmount: parseFloat(order.shipping_fee_amount ?? order.shippingFeeAmount ?? 0),
    totalPayable: parseFloat(order.total_payable ?? order.totalPayable ?? 0),
    paidAmount: parseFloat(order.paid_amount ?? order.paidAmount ?? order.other_fee_amount ?? order.otherFeeAmount ?? 0),
    amountDue: parseFloat(order.debt_amount ?? order.amountDue ?? Math.max(
      0,
      parseFloat(order.total_payable ?? order.totalPayable ?? 0) -
      parseFloat(order.paid_amount ?? order.paidAmount ?? 0) +
      parseFloat(order.shipping_fee_amount ?? order.shippingFeeAmount ?? 0)
    )),
    pricelistId: order.pricelist_id || order.pricelistId || 'retail',
    createdBy: order.created_by || order.createdBy || '',
    salespersonId: order.salesperson_id || order.salespersonId || order.created_by || order.createdBy || '',
    status: order.status || 'settled',
    companyId: order.company_id || order.companyId || 'ABS_NORTH'
  });

  if (idSet.size === 0) return [];

  if (isCloudActive && supabaseClient) {
    try {
      const pageSize = 1000;
      let from = 0;
      const allRows = [];
      while (true) {
        let query = supabaseClient
          .from(tableOrdersName)
          .select('*')
          .in('customer_id', Array.from(idSet))
          .gte('created_at', startIso)
          .lt('created_at', endExclusiveIso)
          .order('created_at', { ascending: true })
          .range(from, from + pageSize - 1);
        if (status === 'settled') query = query.in('status', ['settled', 'completed', 'complete', 'confirmed']);
        else if (status === 'cancelled') query = query.in('status', ['cancelled', 'canceled']);
        else if (status && status !== 'all') query = query.eq('status', status);
        else query = query.in('status', ['settled', 'completed', 'complete', 'confirmed', 'partially_returned', 'returned']);
        const { data, error } = await query;
        if (error) throw error;
        allRows.push(...(data || []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      return allRows.map(mapOrderRow);
    } catch (err) {
      console.warn('Loi tai lich su don hang khach hang tu Supabase, dung du lieu local:', err.message || err);
    }
  }

  const startTime = new Date(startIso).getTime();
  const endTime = new Date(endExclusiveIso).getTime();
  return (state.savedOrders || [])
    .filter(o => idSet.has(String(o.customerId || o.customer_id || '')))
    .filter(o => {
      if (!status || status === 'all') return true;
      const orderStatus = String(o.status || 'settled').toLowerCase();
      if (status === 'settled') return ['settled', 'completed', 'complete', 'confirmed'].includes(orderStatus);
      if (status === 'cancelled') return ['cancelled', 'canceled'].includes(orderStatus);
      return orderStatus === String(status).toLowerCase();
    })
    .filter(o => {
      const deleted = o.deletedAt || o.deleted_at || o.isDeleted;
      const st = String(o.status || 'settled').toLowerCase();
      if ((!status || status === 'all') && (deleted || st === 'draft' || st === 'cancelled' || st === 'canceled')) return false;
      const time = new Date(o.date || o.createdAt || o.created_at).getTime();
      return Number.isFinite(time) && time >= startTime && time < endTime;
    })
    .sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt))
    .map(mapOrderRow);
}
