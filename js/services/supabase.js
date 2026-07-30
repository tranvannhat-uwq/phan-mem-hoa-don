import { state } from '../state.js';
import { COMPANY_SUPABASE_URL, COMPANY_SUPABASE_KEY, defaultProducts } from '../config.js';
import { showToast, updateDbStatusUI, isSameUser, getRevenueAttributes, getBrandById } from '../utils.js';
import { rawMaterialsSeed } from '../components/goods_seed.js';
import { normalizePriceListType, filterPriceListsForUser, canUserViewPriceList } from '../domain/pricing.js';

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
export let tableUsersName = 'users';
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

  const storedUsers = localStorage.getItem('billing_system_users');
  if (storedUsers) {
    const rawList = JSON.parse(storedUsers).filter(u => u.username !== 'sale1' && u.username !== 'sale2');
    const uniqueUsers = [];
    rawList.forEach(u => {
      const isOldAbs = u.username === 'abs_japan' || u.username === 'abs-japan' || u.username === 'absjapan';
      if (isOldAbs) {
        const hasNewAbs = rawList.some(ru => ru.username === 'ctyabs@lendon.com');
        if (hasNewAbs) return;
      }
      const isDup = uniqueUsers.some(uu => isSameUser(uu.username, u.username) || uu.displayName === u.displayName);
      if (!isDup) {
        uniqueUsers.push(u);
      }
    });
    state.users = uniqueUsers;
    localStorage.setItem('billing_system_users', JSON.stringify(state.users));
  } else {
    state.users = [
      { id: 'u-admin', username: 'admin', password: '1307', displayName: 'Administrator', role: 'admin' },
      { id: 'u-nhat', username: 'nhat', password: '1307', displayName: 'Trần Văn Nhật', role: 'admin' },
      { id: 'u-ketoan', username: 'ketoan', password: 'ketoan123', displayName: 'Kế toán Công ty', role: 'accounting' },
      { id: 'u-abs-japan', username: 'ctyabs@lendon.com', password: '', displayName: 'ABS JAPAN (Công ty)', role: 'sale', isExternal: true },
      { id: 'u-emp-hoa-ky', username: 'emp_hoa_ky', password: '', displayName: 'EMP Hoa Kỳ (Công ty)', role: 'sale', isExternal: true }
    ];
    localStorage.setItem('billing_system_users', JSON.stringify(state.users));
  }

  const storedPricelists = localStorage.getItem('billing_system_pricelists');
  if (storedPricelists) {
    state.pricelists = JSON.parse(storedPricelists);
  } else {
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
    localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
  }

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
    
    // Kiểm tra cấu trúc bảng để gán tiền tố wl_ nếu có (Kiểm tra bảng gốc trước để tránh ném lỗi 404 vào Console trình duyệt)
    let { error: testNormalErr } = await client.from('products').select('code').limit(1);
    if (!testNormalErr) {
      tableProductsName = 'products';
      tableOrdersName = 'orders';
      tableDraftOrdersName = 'draft_orders';
      tableCustomersName = 'customers';
      tablePricelistsName = 'pricelists';
      tablePriceListItemsName = 'price_list_items';
      tableUsersName = 'users';
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
        tableUsersName = 'wl_users';
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
        tableUsersName = 'users';
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
    
    try {
      await fetchCloudData();
    } catch (cloudErr) {
      console.warn('Lỗi tải dữ liệu đám mây, chuyển về dùng LocalStorage backup:', cloudErr);
      loadLocalStorageBackup();
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
  let allData = [];
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;
  
  while (hasMore) {
    const { data, error } = await supabaseClient
      .from(tableName)
      .select('*')
      .range(page * pageSize, (page + 1) * pageSize - 1);
      
    if (error) throw error;
    
    if (data && data.length > 0) {
      allData = allData.concat(data);
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    } else {
      hasMore = false;
    }
  }
  return allData;
}

function normalizeProductRow(row, localProducts = []) {
  const local = localProducts.find(lp => lp.id === row.id || (lp.code === row.code && lp.brand === row.brand));
  return {
    id: row.id || null,
    code: row.code,
    baseProductId: row.base_product_id || row.parent_product_id || row.baseProductId || null,
    parentProductId: row.parent_product_id || row.base_product_id || row.parentProductId || null,
    name: row.name,
    brand: row.brand || (local ? local.brand : 'Nano10*'),
    brandId: row.brand_id || (local ? local.brandId : null),
    group: row.product_group || row.group || (local ? local.group : ''),
    packageType: row.package_type || row.packageType || '',
    packageWeight: row.package_weight || row.packageWeight || '',
    packageWeightUnit: row.package_weight_unit || row.packageWeightUnit || row.unit || (local ? local.packageWeightUnit : 'kg'),
    displaySpecification: row.display_specification || row.displaySpecification || '',
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
            date: order.created_at,
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
        const { data: customerPage, error: customerPageError } = await supabaseClient.rpc(
          'rpc_get_customers_paginated',
          { p_search: '', p_managed_by: null, p_limit: 10000, p_offset: 0 }
        );
        const customerData = !customerPageError && customerPage && Array.isArray(customerPage.data)
          ? customerPage.data
          : await fetchFullTableData(tableCustomersName);
        const localCust = JSON.parse(localStorage.getItem('billing_system_customers') || '[]');

        if (customerData && customerData.length > 0) {
          state.customers = customerData.map(cust => ({
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
            lastOrderAt: cust.last_order_at || null,
            lastPaymentAt: cust.last_payment_at || null,
            createdAt: cust.created_at || null,
            updatedAt: cust.updated_at || null,
            notes: cust.notes || '',
            pricelistId: cust.pricelist_id || '',
            defaultPriceListId: cust.default_price_list_id || cust.pricelist_id || '',
            customerGroupId: cust.customer_group_id || '',
            managedBy: cust.managed_by || '',
            debtHistory: typeof cust.debt_history === 'string' ? JSON.parse(cust.debt_history) : (cust.debt_history || [])
          }));
        } else if (localCust.length > 0) {
          state.customers = localCust;
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
        state.pricelists = filterPriceListsForUser(mappedPricelists, state.currentUser);
        localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));

        try {
          const { data: itemData, error: itemErr } = await supabaseClient
            .from(tablePriceListItemsName)
            .select('*');
          if (itemErr) throw itemErr;
          const visiblePriceListIds = new Set(state.pricelists.map(priceList => priceList.id));
          state.priceListItems = (itemData || [])
          .filter(item => visiblePriceListIds.has(item.price_list_id))
          .map(item => ({
            id: item.id || `${item.price_list_id}:${item.product_id}`,
            priceListId: item.price_list_id,
            productId: item.product_id,
            price: parseFloat(item.price || 0),
            isOverride: item.is_override !== false,
            sourceType: item.source_type || 'manual',
            createdAt: item.created_at || '',
            updatedAt: item.updated_at || '',
            updatedBy: item.updated_by || ''
          }));
          localStorage.setItem('billing_system_price_list_items', JSON.stringify(state.priceListItems));
        } catch (itemErr) {
          console.warn("Could not load price_list_items, using local fallback:", itemErr.message);
          const visiblePriceListIds = new Set(state.pricelists.map(priceList => priceList.id));
          state.priceListItems = JSON.parse(localStorage.getItem('billing_system_price_list_items') || '[]')
            .filter(item => visiblePriceListIds.has(item.priceListId));
        }
      } catch (plErr) {
        console.warn("Could not load pricelists from Supabase, using local fallback:", plErr.message);
        state.pricelists = filterPriceListsForUser(JSON.parse(localStorage.getItem('billing_system_pricelists') || '[]'), state.currentUser);
        const visiblePriceListIds = new Set(state.pricelists.map(priceList => priceList.id));
        state.priceListItems = JSON.parse(localStorage.getItem('billing_system_price_list_items') || '[]')
          .filter(item => visiblePriceListIds.has(item.priceListId));
      }
    };

    const fetchUsers = async () => {
      try {
        const { data: userData, error: userErr } = await supabaseClient
          .from(tableUsersName)
          .select('*');

        if (userErr) throw userErr;

        const defaultUsers = [
          { id: 'u-admin', username: 'admin', password: '1307', displayName: 'Administrator', role: 'admin' },
          { id: 'u-nhat', username: 'nhat', password: '1307', displayName: 'Trần Văn Nhật', role: 'admin' },
          { id: 'u-ketoan', username: 'ketoan', password: 'ketoan123', displayName: 'Kế toán Công ty', role: 'accounting' },
          { id: 'u-abs-japan', username: 'ctyabs@lendon.com', password: '', displayName: 'ABS JAPAN (Công ty)', role: 'sale', isExternal: true },
          { id: 'u-emp-hoa-ky', username: 'emp_hoa_ky', password: '', displayName: 'EMP Hoa Kỳ (Công ty)', role: 'sale', isExternal: true }
        ];

        const cloudUsers = (userData || []).map(u => {
          let pwd = u.password;
          if (!pwd || pwd === '') {
            const def = defaultUsers.find(du => isSameUser(du.username, u.username));
            if (def) pwd = def.password;
          }
          return {
            id: u.id,
            username: u.username,
            password: pwd,
            displayName: u.display_name,
            role: u.role || 'sale',
            companyId: u.company_id || u.companyId || 'ABS_NORTH',
            isExternal: u.is_external || false
          };
        });

        const merged = [...cloudUsers];
        if (cloudUsers.length === 0) {
          defaultUsers.forEach(def => {
            const defClean = (def.username || '').toLowerCase().trim();
            const hasUser = merged.some(u => (u.username || '').toLowerCase().trim() === defClean);
            if (!hasUser) {
              merged.push(def);
            }
          });
        }
        
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
        localStorage.setItem('billing_system_users', JSON.stringify(state.users));
      } catch (uErr) {
        console.warn("Could not load users from Supabase, using local fallback:", uErr.message);
        state.users = JSON.parse(localStorage.getItem('billing_system_users') || '[]');
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
              date: t.date || t.transaction_date,
              type: t.type || (t.direction === 'out' ? 'chi' : 'thu'),
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
              supplierId: t.supplier_id || (supplierMeta ? supplierMeta[1] : null),
              orderId: t.order_id || null,
              salesReturnId: t.sales_return_id || null,
              employeeId: t.employee_id || null
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
            notes: s.notes || ''
          }));
          localStorage.setItem('billing_system_suppliers', JSON.stringify(state.suppliers));
        }
        console.log("[SUPPLIERS] STATE:", state.suppliers?.length || 0);
      } catch (err) {
        console.warn("Could not load suppliers from Supabase:", err.message);
        const stored = localStorage.getItem('billing_system_suppliers');
        if (stored) {
          state.suppliers = JSON.parse(stored);
        } else {
          state.suppliers = [];
          localStorage.setItem('billing_system_suppliers', JSON.stringify([]));
        }
        console.log("[SUPPLIERS] STATE Fallback:", state.suppliers?.length || 0);
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
                productName: i.product_name,
                quantity: parseFloat(i.quantity || 0),
                importPrice: parseFloat(i.import_price || 0),
                discountType: i.discount_type,
                discountValue: parseFloat(i.discount_value || 0),
                refundPrice: parseFloat(i.refund_price || 0),
                subtotal: parseFloat(i.subtotal || 0),
                packageType: i.package_type
              });
              itemsMap.set(i.return_id, arr);
            });
          }
          
          state.salesReturns = returnsData.map(r => ({
            id: r.id,
            saleId: r.sale_id,
            customerId: r.customer_id,
            createdBy: r.created_by,
            createdAt: r.created_at,
            reason: r.reason,
            totalRefund: parseFloat(r.total_refund || 0),
            status: r.status,
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
      fetchRawMaterials(),
      fetchSemiFinished(),
      fetchRecipes(),
      fetchProductionLogs(),
      fetchFinishedGoodsStock(),
      fetchSalesReturns()
    ]);

  } catch(err) {
    console.error('Error fetching cloud data:', err);
    showToast('Lỗi đồng bộ dữ liệu đám mây!', 'danger');
  }
}

// Đồng bộ dữ liệu Local lên Cloud
export async function syncLocalToCloud() {
  if (!isCloudActive || !supabaseClient) {
    showToast('Vui lòng kết nối với Supabase trước!', 'warning');
    return false;
  }
  
  const localProducts = JSON.parse(localStorage.getItem('billing_system_products') || '[]');
  const localOrders = JSON.parse(localStorage.getItem('billing_system_orders') || '[]');
  const localCustomers = JSON.parse(localStorage.getItem('billing_system_customers') || '[]');
  const localPricelists = JSON.parse(localStorage.getItem('billing_system_pricelists') || '[]');
  const localUsers = JSON.parse(localStorage.getItem('billing_system_users') || '[]');
  const localBrands = JSON.parse(localStorage.getItem('billing_system_brands') || '[]');
  const localTxs = JSON.parse(localStorage.getItem('billing_system_cashbook_transactions') || '[]');
  const localBalances = JSON.parse(localStorage.getItem('billing_system_cashbook_start_balances') || 'null');
  const localSuppliers = JSON.parse(localStorage.getItem('billing_system_suppliers') || '[]');
  const localRaw = JSON.parse(localStorage.getItem('billing_system_raw_materials') || '[]');
  const localSemi = JSON.parse(localStorage.getItem('billing_system_semi_finished') || '[]');
  const localRecipes = JSON.parse(localStorage.getItem('billing_system_recipes') || '[]');
  const localLogs = JSON.parse(localStorage.getItem('billing_system_production_logs') || '[]');
  const localFgs = JSON.parse(localStorage.getItem('billing_system_finished_goods_stock') || '[]');
  
  if (localProducts.length === 0 && localOrders.length === 0 && localCustomers.length === 0 && localPricelists.length === 0 && localUsers.length === 0 && localBrands.length === 0 && localTxs.length === 0 && !localBalances && localSuppliers.length === 0 && localRaw.length === 0 && localSemi.length === 0 && localRecipes.length === 0 && localLogs.length === 0 && localFgs.length === 0) {
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
      const settledRows = localOrders.filter(o => o.status !== 'draft').map(o => ({
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
        status: o.status || 'settled'
      }));

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
      
      if (settledRows.length > 0) {
        let { error } = await supabaseClient
          .from(tableOrdersName)
          .upsert(settledRows, { onConflict: 'id' });
        if (error) throw error;
      }

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
        debt: c.debt,
        total_transaction: c.totalTransaction,
        notes: c.notes,
        pricelist_id: c.pricelistId || null,
        default_price_list_id: c.defaultPriceListId || c.pricelistId || null,
        managed_by: c.managedBy || 'nhat',
        debt_history: c.debtHistory || []
      }));
      
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .upsert(dbRows, { onConflict: 'id' });
        
      if (error) throw error;
    }

    // 4. Sync Price Lists
    if (localPricelists.length > 0) {
      const dbRows = localPricelists.map(pl => ({
        id: pl.id,
        code: pl.code || null,
        name: pl.name,
        type: normalizePriceListType(pl.type, pl.customerId),
        customer_id: pl.customerId || null,
        customer_group_id: pl.customerGroupId || null,
        parent_price_list_id: pl.parentPriceListId || null,
        effective_from: pl.effectiveFrom || null,
        effective_to: pl.effectiveTo || null,
        is_active: pl.isActive !== false,
        display_order: Number(pl.displayOrder || 0),
        brand_discounts: pl.brandDiscounts || {}
      }));
      
      const { error } = await supabaseClient
        .from(tablePricelistsName)
        .upsert(dbRows, { onConflict: 'id' });
        
      if (error) throw error;
    }

    // 5. Sync Users
    if (localUsers.length > 0) {
      const dbRows = localUsers.map(u => ({
        id: u.id,
        username: u.username,
        password: u.password || '',
        display_name: u.displayName || u.username,
        role: u.role || 'sale',
        company_id: u.companyId || 'ABS_NORTH',
        is_external: u.isExternal || false
      }));
      
      const { error } = await supabaseClient
        .from(tableUsersName)
        .upsert(dbRows, { onConflict: 'id' });
        
      if (error) throw error;
    }

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

    // 7. Sync Cashbook Transactions
    if (localTxs.length > 0) {
      const dbRows = localTxs.map(t => ({
        id: t.id,
        date: t.date,
        type: t.type,
        category: t.category,
        partner: t.partner,
        value: t.value,
        method: t.method,
        accounting: t.accounting,
        status: t.status,
        creator: t.creator,
        note: t.note,
        starred: t.starred
      }));
      
      const { error } = await supabaseClient
        .from(tableCashbookTransactionsName)
        .upsert(dbRows, { onConflict: 'id' });
        
      if (error) throw error;
    }

    // 8. Sync Starting Balances
    if (localBalances) {
      const dbRow = {
        id: 'current_balances',
        cash: localBalances.cash || 0,
        bank: localBalances.bank || 0,
        wallet: localBalances.wallet || 0,
        updated_at: new Date().toISOString()
      };
      
      const { error } = await supabaseClient
        .from(tableStartingBalancesName)
        .upsert(dbRow, { onConflict: 'id' });
        
    }
    
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
    showToast('Đồng bộ dữ liệu lên đám mây thành công!');
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
        base_product_id: product.baseProductId || product.parentProductId || null,
        parent_product_id: product.parentProductId || product.baseProductId || null,
        name: product.name,
        brand: product.brand || '',
        brand_id: product.brandId || ('brand_' + String(product.brand).toLowerCase().replace(/[^a-z0-9]/g, '')),
        package_type: product.packageType || '',
        package_weight: product.packageWeight === '' ? null : product.packageWeight,
        package_weight_unit: product.packageWeightUnit || 'kg',
        display_specification: product.displaySpecification || '',
        product_group: product.group || null,
        is_active: product.isActive !== false,
        is_legacy: product.isLegacy === true,
        updated_at: new Date().toISOString()
      };

      let error = null;
      if (existingRow?.id) {
        const { id: _preservedId, ...changes } = dbRow;
        ({ error } = await supabaseClient
          .from(tableProductsName)
          .update(changes)
          .eq('id', existingRow.id));
      } else {
        ({ error } = await supabaseClient
          .from(tableProductsName)
          .insert(dbRow));
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
        base_product_id: product.baseProductId || product.parentProductId || null,
        parent_product_id: product.parentProductId || product.baseProductId || null,
        name: product.name,
        brand: product.brand || '',
        brand_id: product.brandId || ('brand_' + String(product.brand).toLowerCase().replace(/[^a-z0-9]/g, '')),
        package_type: product.packageType || '',
        package_weight: product.packageWeight === '' ? null : product.packageWeight,
        package_weight_unit: product.packageWeightUnit || 'kg',
        display_specification: product.displaySpecification || '',
        product_group: product.group || null,
        is_active: product.isActive !== false,
        is_legacy: product.isLegacy === true,
        updated_at: new Date().toISOString()
      });
    });

    const rows = [...rowsByKey.values()];
    const chunkSize = 200;
    for (let index = 0; index < rows.length; index += chunkSize) {
      const { error } = await supabaseClient
        .from(tableProductsName)
        .upsert(rows.slice(index, index + chunkSize), { onConflict: 'id' });
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
    created_by: customer.createdBy || customer.created_by || null,
    assigned_brand: customer.assignedBrand,
    assigned_brand_id: customer.assignedBrandId || null,
    brand_discounts: customer.brandDiscounts,
    shipping_support: customer.shippingSupport || false,
    debt: customer.debt,
    total_transaction: customer.totalTransaction,
    total_return: customer.totalReturn || customer.total_return || 0,
    net_revenue: customer.netRevenue || customer.net_revenue || 0,
    last_order_at: customer.lastOrderAt || customer.last_order_at || null,
    last_payment_at: customer.lastPaymentAt || customer.last_payment_at || null,
    notes: customer.notes,
    pricelist_id: customer.pricelistId === undefined ? null : customer.pricelistId,
    default_price_list_id: customer.defaultPriceListId || customer.pricelistId || null,
    managed_by: customer.managedBy === undefined ? null : customer.managedBy,
    debt_history: customer.debtHistory || [],
    created_at: customer.createdAt || customer.created_at || new Date().toISOString(),
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

export async function dbSaveCustomersBulk(customers) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRows = customers.map(customer => mapCustomerToDbRow(customer));
      const chunkSize = 200;

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
        lastOrderAt: cust.last_order_at || null,
        lastPaymentAt: cust.last_payment_at || null,
        notes: cust.notes || '',
        pricelistId: cust.pricelist_id || '',
        defaultPriceListId: cust.default_price_list_id || cust.pricelist_id || '',
        managedBy: cust.managed_by || '',
        debtHistory: typeof cust.debt_history === 'string' ? JSON.parse(cust.debt_history) : (cust.debt_history || []),
        createdAt: cust.created_at || null,
        updatedAt: cust.updated_at || null,
        deletedAt: cust.deleted_at || null
      }));
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      return true;
    } catch (err) {
      console.error("Error fetching customers:", err);
      return false;
    }
  }
  return false;
}

export async function dbDeleteAllCustomers() {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .delete()
        .neq('id', '');
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa danh sách khách hàng trên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
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
        price: Number(item.price),
        is_override: true,
        source_type: item.sourceType || 'manual',
        updated_at: new Date().toISOString(),
        updated_by: item.updatedBy || (state.currentUser ? state.currentUser.username : 'admin')
      }));
      const { error } = await supabaseClient
        .from(tablePriceListItemsName)
        .upsert(dbRows, { onConflict: 'price_list_id,product_id' });
      if (error) throw error;
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
        created_by: order.createdBy || 'admin',
        created_at: order.date || order.createdAt || new Date().toISOString(),
        pricelist_id: order.pricelistId || 'retail'
      };

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
        
      if (error) throw error;

      // Đồng bộ chi tiết mặt hàng đơn vào bảng order_items nếu có
      if (order.status !== 'draft' && order.items && Array.isArray(order.items) && order.items.length > 0) {
        const itemRows = order.items.map((item, idx) => ({
          id: item.id || `${order.id}-item-${idx}`,
          order_id: order.id,
          product_id: item.productId || item.productCode || item.code || null,
          brand_id: item.brandId || item.brand || null,
          product_code_snapshot: item.productCode || item.code || '',
          product_name_snapshot: item.productName || item.name || '',
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
        const { error } = await supabaseClient
          .from(tableOrdersName)
          .delete()
          .eq('id', id);
        if (error) throw error;
      } else {
        // Thử xóa ở cả 2 bảng nếu không chỉ rõ trạng thái
        await supabaseClient.from(tableDraftOrdersName).delete().eq('id', id);
        await supabaseClient.from(tableOrdersName).delete().eq('id', id);
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
      const { error: err1 } = await supabaseClient
        .from(tableOrdersName)
        .delete()
        .neq('id', 'temp_id_none');
      if (err1) throw err1;

      const { error: err2 } = await supabaseClient
        .from(tableDraftOrdersName)
        .delete()
        .neq('id', 'temp_id_none');
      if (err2) throw err2;
        
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
  if (!isCloudActive || !supabaseClient) return true;
  if (user.isExternal) return true; // skip external reps from auth registration
  try {
    const savedUrl = localStorage.getItem('billing_supabase_url') || COMPANY_SUPABASE_URL;
    const savedKey = localStorage.getItem('billing_supabase_key') || COMPANY_SUPABASE_KEY;
    
    const email = user.username.includes('@') ? user.username : `${user.username}@lendon.com`;

    if (isNew) {
      // Sử dụng client phụ để tránh làm mất session đăng nhập hiện tại của Admin
      const tempClient = supabase.createClient(savedUrl, savedKey, {
        auth: { persistSession: false }
      });

      const { data, error } = await tempClient.auth.signUp({
        email: email,
        password: user.password,
        options: {
          data: {
            displayName: user.displayName,
            role: user.role,
            username: user.username
          }
        }
      });
      if (error) throw error;
      if (data && data.user) {
        user.id = data.user.id; // Gán ID dạng UUID của Supabase Auth
      }
    } else {
      // Chỉnh sửa tài khoản đã có: Chỉ cho phép cập nhật password và metadata cho chính tài khoản đang đăng nhập
      const { data: { user: authUser } } = await supabaseClient.auth.getUser();
      if (authUser && authUser.id === user.id) {
        const updateData = {
          data: {
            displayName: user.displayName,
            role: user.role
          }
        };
        if (user.password) {
          updateData.password = user.password;
        }
        const { error } = await supabaseClient.auth.updateUser(updateData);
        if (error) throw error;
      } else {
        console.warn("Chỉ có thể thay đổi thông tin xác thực cho chính tài khoản đang đăng nhập.");
      }
    }
    return true;
  } catch (err) {
    console.error('Auth registration/update error:', err);
    let errMsg = '';
    if (typeof err === 'object' && err !== null) {
      errMsg = err.message || err.error_description || JSON.stringify(err);
    } else {
      errMsg = String(err);
    }
    showToast('Lỗi đồng bộ tài khoản trên Cloud: ' + errMsg, 'danger');
    return false;
  }
}

export async function dbSaveUser(user) {
  if (isCloudActive && supabaseClient) {
    try {
      const oldId = user.id;
      const isLocalId = String(oldId).startsWith('u-');
      const isNew = !state.users.some(u => u.id === oldId) || isLocalId;
      
      // Đồng bộ thông tin xác thực lên Supabase Auth
      const authSuccess = await authRegisterOrUpdateUser(user, isNew);
      if (!authSuccess) return false;
      
      // Nếu trước đó là ID offline dạng u-..., ta cần xóa dòng cũ có ID này trong CSDL
      if (isNew && isLocalId && user.id !== oldId) {
        const { error: delErr } = await supabaseClient
          .from(tableUsersName)
          .delete()
          .eq('id', oldId);
        if (delErr) console.warn("Could not delete old offline user row:", delErr.message);
      }
      
      const dbRow = {
        id: user.id,
        username: user.username,
        password: user.password || '',
        display_name: user.displayName,
        role: user.role,
        is_external: user.isExternal || false
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
        .delete()
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
      const dbRow = {
        id: tx.id,
        date: tx.date || new Date().toISOString(),
        transaction_date: tx.date || tx.transactionDate || new Date().toISOString(),
        type: tx.type,
        transaction_type: tx.transactionType || tx.category || tx.type,
        direction: tx.direction || (tx.type === 'thu' ? 'in' : 'out'),
        payment_method: tx.paymentMethod || tx.method || 'cash',
        category: tx.category,
        partner: tx.partner,
        customer_id: tx.customerId || null,
        supplier_id: tx.supplierId || null,
        order_id: tx.orderId || null,
        sales_return_id: tx.salesReturnId || null,
        employee_id: tx.employeeId || null,
        value: parseFloat(tx.value || 0),
        method: tx.method || 'cash',
        accounting: tx.accounting !== undefined ? tx.accounting : true,
        status: tx.status || 'completed',
        creator: tx.creator,
        created_by: tx.createdBy || tx.creator || null,
        note: tx.note,
        starred: tx.starred || false
      };
      
      let { error } = await supabaseClient
        .from(tableCashbookTransactionsName)
        .upsert(dbRow, { onConflict: 'id' });

      if (error && /column|schema|cache|supplier_id|customer_id|transaction_date|payment_method|direction|transaction_type|created_by/i.test(error.message || '')) {
        const legacyRow = {
          id: dbRow.id,
          date: dbRow.date,
          type: dbRow.type,
          category: dbRow.category,
          partner: dbRow.partner,
          value: dbRow.value,
          method: dbRow.method,
          accounting: dbRow.accounting,
          status: dbRow.status,
          creator: dbRow.creator,
          note: tx.supplierId ? `${dbRow.note || ''} __supplierId=${tx.supplierId}`.trim() : dbRow.note,
          starred: dbRow.starred
        };
        const retry = await supabaseClient
          .from(tableCashbookTransactionsName)
          .upsert(legacyRow, { onConflict: 'id' });
        error = retry.error;
      }
        
      if (error) {
        console.warn('Lưu sổ quỹ lên Supabase cảnh báo (RLS):', error.message);
        return false;
      }
      return true;
    } catch(err) {
      console.warn('Lưu giao dịch Sổ quỹ lên đám mây bị tạm hoãn:', err.message || err);
      return false;
    }
  }
  return true;
}

export async function dbSaveStartingBalances(balances) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: 'current_balances',
        cash: balances.cash || 0,
        bank: balances.bank || 0,
        wallet: balances.wallet || 0,
        updated_at: new Date().toISOString()
      };
      
      const { error } = await supabaseClient
        .from(tableStartingBalancesName)
        .upsert(dbRow, { onConflict: 'id' });
        
      if (error) throw error;
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu Số dư đầu kỳ lên đám mây: ' + err.message, 'danger');
      return false;
    }
  }
  return true;
}

export async function dbSaveSupplier(supplier) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        phone: supplier.phone,
        address: supplier.address,
        debt: parseFloat(supplier.debt || 0),
        notes: supplier.notes || ''
      };
      const tableName = tableProductsName.startsWith('wl_') ? 'wl_suppliers' : 'suppliers';
      const { error } = await supabaseClient
        .from(tableName)
        .upsert(dbRow, { onConflict: 'id' });
      if (error) {
        console.warn("Could not save supplier to cloud table:", error.message);
      }
    } catch (err) {
      console.warn("Cloud save supplier failed:", err);
    }
  }
  return true;
}

export async function dbSaveSuppliersBulk(suppliers) {
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

export async function dbDeleteSupplier(supplierId) {
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
  saveSalesReturns(state.salesReturns);
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: ret.id,
        sale_id: ret.saleId || ret.orderId,
        order_id: ret.orderId || ret.saleId,
        customer_id: ret.customerId || null,
        salesperson_id: ret.salespersonId || ret.createdBy || null,
        total_return_amount: ret.totalRefund || ret.totalReturnAmount || 0,
        debt_reduction_amount: ret.debtReductionAmount || ret.totalRefund || 0,
        refund_amount: ret.refundAmount || 0,
        status: ret.status || 'completed',
        return_date: ret.returnDate || ret.createdAt || new Date().toISOString(),
        created_by: ret.createdBy,
        created_at: ret.createdAt || new Date().toISOString(),
        reason: ret.reason,
        total_refund: ret.totalRefund
      };
      await supabaseClient.from(tableSalesReturnsName).upsert(dbRow, { onConflict: 'id' });
      
      if (ret.items && ret.items.length > 0) {
        const itemRows = ret.items.map(i => ({
          id: i.id || `thitem_${ret.id}_${Math.random().toString(36).substr(2, 6)}`,
          return_id: ret.id,
          sale_item_id: i.saleItemId || null,
          product_id: i.productId || null,
          product_name: i.productName || '',
          quantity: i.quantity || 0,
          import_price: i.importPrice || 0,
          discount_type: i.discountType || 'percent',
          discount_value: i.discountValue || 0,
          refund_price: i.refundPrice || 0,
          subtotal: i.subtotal || 0,
          package_type: i.packageType || ''
        }));
        await supabaseClient.from(tableSalesReturnItemsName).upsert(itemRows, { onConflict: 'id' });
      }
      return true;
    } catch(err) {
      console.warn('Lưu phiếu trả hàng đám mây:', err.message || err);
      return false;
    }
  }
  return true;
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
      const { data, error } = await supabaseClient.rpc('rpc_confirm_order', { p_order: order });
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

export async function dbRecordCustomerPayment(customerId, amount, notes, createdBy) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_record_customer_payment', {
        p_customer_id: customerId,
        p_amount: amount,
        p_notes: notes || 'Thu tiền nợ',
        p_created_by: createdBy || 'admin'
      });
      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      console.error('RPC customer payment error:', err);
      showToast('Lỗi ghi nhận thu tiền: ' + err.message, 'danger');
      return false;
    }
  }
  return { success: true, new_debt: null };
}

export async function dbCancelCustomerPayment(cashbookId, createdBy) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_cancel_customer_payment', {
        p_cashbook_id: cashbookId,
        p_created_by: createdBy || 'admin'
      });
      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      console.error('RPC cancel customer payment error:', err);
      showToast('Lá»—i há»§y phiáº¿u thu: ' + err.message, 'danger');
      return false;
    }
  }
  return { success: true, new_debt: null };
}

export async function dbRecordSalesReturn(ret, items, orderStatus) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_record_sales_return', {
        p_return_id: ret.id,
        p_sale_id: ret.saleId || ret.orderId,
        p_customer_id: ret.customerId || null,
        p_total_refund: ret.totalRefund || 0,
        p_reason: ret.reason || '',
        p_created_by: ret.createdBy || 'admin',
        p_items: items || [],
        p_order_status: orderStatus || 'partially_returned'
      });
      if (error) {
        console.warn('RPC rpc_record_sales_return error, falling back:', error.message);
        return await dbSaveSalesReturn(ret);
      }
      return true;
    } catch (err) {
      console.warn('RPC sales return error:', err);
      return await dbSaveSalesReturn(ret);
    }
  }
  return true;
}

export async function dbAdjustCustomerDebt(customerId, newDebt, description, createdBy) {
  if (isCloudActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient.rpc('rpc_adjust_customer_debt', {
        p_customer_id: customerId,
        p_new_debt: newDebt,
        p_description: description || 'Điều chỉnh công nợ',
        p_created_by: createdBy || 'admin'
      });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('RPC adjust customer debt error:', err);
      return false;
    }
  }
  return true;
}

// --- BỘ LỌC VÀ PHÂN TRANG HIỆU NĂNG CAO (SERVER-SIDE PAGINATION & LAZY LOADING) ---

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
