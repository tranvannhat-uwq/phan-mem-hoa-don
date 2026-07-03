import { state } from '../state.js';
import { COMPANY_SUPABASE_URL, COMPANY_SUPABASE_KEY } from '../config.js';
import { showToast, updateDbStatusUI } from '../utils.js';

export let supabaseClient = null;
export let isCloudActive = false;

// Tên các bảng trên cơ sở dữ liệu (tự động điều chỉnh dựa trên sự tồn tại của tiền tố wl_)
export let tableProductsName = 'products';
export let tableOrdersName = 'orders';
export let tableDraftOrdersName = 'draft_orders';
export let tableCustomersName = 'customers';
export let tablePricelistsName = 'pricelists';
export let tableUsersName = 'users';

export function setCloudActive(active) {
  isCloudActive = active;
}

// Kết nối đến Supabase
export async function connectSupabase(url, key, verbose = true) {
  try {
    if (typeof supabase === 'undefined') {
      throw new Error('Thư viện Supabase chưa được tải (vui lòng kiểm tra kết nối mạng).');
    }
    const client = supabase.createClient(url, key);
    
    // Kiểm tra cấu trúc bảng để gán tiền tố wl_ nếu có
    let { error: testWlErr } = await client.from('wl_products').select('code').limit(1);
    if (testWlErr && (testWlErr.code === '42P01' || (testWlErr.message && (testWlErr.message.includes('not find') || testWlErr.message.includes('does not exist'))))) {
      // wl_products không tồn tại, sử dụng tên bảng gốc
      tableProductsName = 'products';
      tableOrdersName = 'orders';
      tableDraftOrdersName = 'draft_orders';
      tableCustomersName = 'customers';
      tablePricelistsName = 'pricelists';
      tableUsersName = 'users';
    } else {
      tableProductsName = 'wl_products';
      tableOrdersName = 'wl_orders';
      tableDraftOrdersName = 'wl_draft_orders';
      tableCustomersName = 'wl_customers';
      tablePricelistsName = 'wl_pricelists';
      tableUsersName = 'wl_users';
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
    
    await fetchCloudData();
    
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

// Tải toàn bộ dữ liệu từ Supabase về State
export async function fetchCloudData() {
  if (!supabaseClient) return;
  try {
    // 1. Fetch Products
    const { data: prodData, error: prodErr } = await supabaseClient
      .from(tableProductsName)
      .select('*')
      .order('code', { ascending: true });
      
    if (prodErr) throw prodErr;
    
    const localProducts = JSON.parse(localStorage.getItem('billing_system_products') || '[]');
    state.products = (prodData || []).map(row => {
      const local = localProducts.find(lp => lp.code === row.code);
      return {
        code: row.code,
        name: row.name,
        brand: row.brand !== undefined && row.brand !== null ? row.brand : (local ? local.brand : 'Nano10*'),
        priceThung: row.price_thung !== undefined && row.price_thung !== null ? row.price_thung : (local && local.priceThung !== undefined ? local.priceThung : (row.price !== undefined ? row.price : 0)),
        priceLon: row.price_lon !== undefined && row.price_lon !== null ? row.price_lon : (local && local.priceLon !== undefined ? local.priceLon : 0),
        priceHop: row.price_hop !== undefined && row.price_hop !== null ? row.price_hop : (local && local.priceHop !== undefined ? local.priceHop : 0),
        priceBao: row.price_bao !== undefined && row.price_bao !== null ? row.price_bao : (local && local.priceBao !== undefined ? local.priceBao : 0),
        priceTui: row.price_tui !== undefined && row.price_tui !== null ? row.price_tui : (local && local.priceTui !== undefined ? local.priceTui : 0),
        weightThung: row.weight_thung !== undefined && row.weight_thung !== null ? row.weight_thung : (local && local.weightThung !== undefined ? local.weightThung : ''),
        weightBao: row.weight_bao !== undefined && row.weight_bao !== null ? row.weight_bao : (local && local.weightBao !== undefined ? local.weightBao : ''),
        weightLon: row.weight_lon !== undefined && row.weight_lon !== null ? row.weight_lon : (local && local.weightLon !== undefined ? local.weightLon : ''),
        weightHop: row.weight_hop !== undefined && row.weight_hop !== null ? row.weight_hop : (local && local.weightHop !== undefined ? local.weightHop : ''),
        weightTui: row.weight_tui !== undefined && row.weight_tui !== null ? row.weight_tui : (local && local.weightTui !== undefined ? local.weightTui : '')
      };
    });
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
    
    // 2. Fetch Orders (bao gồm đơn chốt và đơn nháp từ 2 bảng riêng biệt)
    // Tự động xóa đơn nháp cũ hơn 2 ngày trên cloud trước khi tải dữ liệu
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

    const [ordersResult, draftsResult] = await Promise.all([
      supabaseClient.from(tableOrdersName).select('*'),
      supabaseClient.from(tableDraftOrdersName).select('*')
    ]);
      
    if (ordersResult.error) throw ordersResult.error;
    if (draftsResult.error) throw draftsResult.error;
    
    const rawOrders = ordersResult.data || [];
    const rawDrafts = draftsResult.data || [];

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
        shippingSupport: order.shipping_support || false,
        shippingDiscount: parseFloat(order.shipping_discount || 0),
        totalPayable: parseFloat(order.total_payable || 0),
        pricelistId: order.pricelist_id || 'retail',
        createdBy: order.created_by || 'admin',
        status: status
      };
    };

    const mappedOrders = rawOrders.map(o => mapOrderRow(o, false));
    const mappedDrafts = rawDrafts.map(o => mapOrderRow(o, true));

    state.savedOrders = [...mappedOrders, ...mappedDrafts].sort((a, b) => new Date(b.date) - new Date(a.date));

    // 3. Fetch Customers
    try {
      const { data: customerData, error: customerErr } = await supabaseClient
        .from(tableCustomersName)
        .select('*');

      if (customerErr) throw customerErr;

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
        notes: cust.notes || '',
        pricelistId: cust.pricelist_id || 'custom',
        managedBy: cust.managed_by || 'nhat',
        debtHistory: typeof cust.debt_history === 'string' ? JSON.parse(cust.debt_history) : (cust.debt_history || [])
      }));
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
    } catch (custErr) {
      console.warn("Could not load customers from Supabase:", custErr.message);
    }

    // 4. Fetch Price Lists
    try {
      const { data: plData, error: plErr } = await supabaseClient
        .from(tablePricelistsName)
        .select('*');

      if (plErr) throw plErr;

      state.pricelists = (plData || []).map(pl => ({
        id: pl.id,
        name: pl.name,
        brandDiscounts: typeof pl.brand_discounts === 'string' ? JSON.parse(pl.brand_discounts) : (pl.brand_discounts || {})
      }));
      localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
    } catch (plErr) {
      console.warn("Could not load pricelists from Supabase:", plErr.message);
    }

    // 5. Fetch Users
    try {
      const { data: userData, error: userErr } = await supabaseClient
        .from(tableUsersName)
        .select('*');

      if (userErr) throw userErr;

      state.users = (userData || []).map(u => ({
        id: u.id,
        username: u.username,
        password: u.password,
        displayName: u.display_name,
        role: u.role || 'sale'
      }));
      localStorage.setItem('billing_system_users', JSON.stringify(state.users));
    } catch (uErr) {
      console.warn("Could not load users from Supabase:", uErr.message);
    }
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
  
  if (localProducts.length === 0 && localOrders.length === 0 && localCustomers.length === 0 && localPricelists.length === 0 && localUsers.length === 0) {
    showToast('Không tìm thấy dữ liệu LocalStorage nào để đồng bộ!', 'warning');
    return false;
  }
  
  try {
    updateDbStatusUI('connecting');
    
    // 1. Sync Products
    if (localProducts.length > 0) {
      const dbRows = localProducts.map(p => ({
        code: p.code,
        name: p.name,
        brand: p.brand || '',
        price: p.priceThung || p.priceBao || p.priceLon || p.priceHop || p.priceTui || 0,
        price_thung: p.priceThung || 0,
        price_lon: p.priceLon || 0,
        price_hop: p.priceHop || 0,
        price_bao: p.priceBao || 0,
        price_tui: p.priceTui || 0
      }));
      
      let { error } = await supabaseClient
        .from(tableProductsName)
        .upsert(dbRows, { onConflict: 'code,brand' });
        
      if (error) throw error;
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
        shipping_support: o.shippingSupport || false,
        shipping_discount: o.shippingDiscount || 0,
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
        shipping_support: o.shippingSupport || false,
        shipping_discount: o.shippingDiscount || 0,
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
        pricelist_id: c.pricelistId || 'custom',
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
        name: pl.name,
        brand_discounts: pl.brandDiscounts
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
        display_name: u.displayName,
        role: u.role
      }));
      
      const { error } = await supabaseClient
        .from(tableUsersName)
        .upsert(dbRows, { onConflict: 'id' });
        
      if (error) throw error;
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
      const dbRow = {
        code: product.code,
        name: product.name,
        brand: product.brand || '',
        price: product.priceThung || product.priceBao || product.priceLon || product.priceHop || product.priceTui || 0,
        price_thung: product.priceThung || 0,
        price_lon: product.priceLon || 0,
        price_hop: product.priceHop || 0,
        price_bao: product.priceBao || 0,
        price_tui: product.priceTui || 0,
        weight_thung: product.weightThung || '',
        weight_bao: product.weightBao || '',
        weight_lon: product.weightLon || '',
        weight_hop: product.weightHop || '',
        weight_tui: product.weightTui || ''
      };
      
      let { error } = await supabaseClient
        .from(tableProductsName)
        .upsert(dbRow, { onConflict: 'code,brand' });
        
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

export async function dbDeleteProduct(code, brand) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableProductsName)
        .delete()
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
export async function dbSaveCustomer(customer) {
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        assigned_brand: customer.assignedBrand,
        brand_discounts: customer.brandDiscounts,
        shipping_support: customer.shippingSupport || false,
        debt: customer.debt,
        total_transaction: customer.totalTransaction,
        notes: customer.notes,
        pricelist_id: customer.pricelistId || 'custom',
        managed_by: customer.managedBy || 'nhat',
        debt_history: customer.debtHistory || []
      };
      
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
  if (isCloudActive && supabaseClient) {
    try {
      const dbRow = {
        id: pricelist.id,
        name: pricelist.name,
        brand_discounts: pricelist.brandDiscounts
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

export async function dbDeletePricelist(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tablePricelistsName)
        .delete()
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
  if (isCloudActive && supabaseClient) {
    try {
      const targetTable = order.status === 'draft' ? tableDraftOrdersName : tableOrdersName;
      const dbRow = {
        id: order.id,
        customer_id: order.customerId || null,
        customer_name: order.customerName,
        notes: order.notes,
        items: order.items,
        total_market: order.totalMarket,
        total_discount: order.totalDiscount,
        shipping_support: order.shippingSupport || false,
        shipping_discount: order.shippingDiscount || 0,
        total_payable: order.totalPayable,
        created_at: order.date,
        pricelist_id: order.pricelistId || 'retail',
        created_by: order.createdBy || 'admin',
        status: order.status || 'settled'
      };
      
      let { error } = await supabaseClient
        .from(targetTable)
        .upsert(dbRow, { onConflict: 'id' });
        
      if (error) throw error;
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
  try {
    const savedUrl = localStorage.getItem('billing_supabase_url') || COMPANY_SUPABASE_URL;
    const savedKey = localStorage.getItem('billing_supabase_key') || COMPANY_SUPABASE_KEY;
    
    // Sử dụng client phụ để tránh làm mất session đăng nhập hiện tại của Admin
    const tempClient = supabase.createClient(savedUrl, savedKey, {
      auth: { persistSession: false }
    });

    const email = user.username.includes('@') ? user.username : `${user.username}@weblendon.com`;

    if (isNew) {
      const { data, error } = await tempClient.auth.signUp({
        email: email,
        password: user.password,
        options: {
          data: {
            displayName: user.displayName,
            role: user.role
          }
        }
      });
      if (error) throw error;
      if (data && data.user) {
        user.id = data.user.id; // Gán ID dạng UUID của Supabase Auth
      }
    }
    return true;
  } catch (err) {
    console.error('Auth registration error:', err);
    showToast('Lỗi đăng ký tài khoản trên Cloud: ' + err.message, 'danger');
    return false;
  }
}

export async function dbSaveUser(user) {
  if (isCloudActive && supabaseClient) {
    try {
      const isNew = !state.users.some(u => u.id === user.id);
      
      // Nếu thêm tài khoản mới, tạo trên Supabase Auth trước
      if (isNew) {
        const authSuccess = await authRegisterOrUpdateUser(user, true);
        if (!authSuccess) return false;
      }
      
      const dbRow = {
        id: user.id,
        username: user.username,
        password: user.password,
        display_name: user.displayName,
        role: user.role
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
