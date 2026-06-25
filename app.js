// Safe icon renderer helper
function safeCreateIcons() {
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    try {
      lucide.createIcons();
    } catch (e) {
      console.error("Lucide icon generation failed:", e);
    }
  }
}

// Initialize Lucide icons on DOM loaded
document.addEventListener('DOMContentLoaded', () => {
  safeCreateIcons();
  initApp();
});

// Cấu hình kết nối Supabase dùng chung cho cả công ty (Nhập thông tin bên dưới để tự động đăng nhập)
const COMPANY_SUPABASE_URL = "https://coebrkerpcgwckkwxlfo.supabase.co"; 
const COMPANY_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvZWJya2VycGNnd2Nra3d4bGZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNTA2MDAsImV4cCI6MjA5NzcyNjYwMH0.3Y5ECisaADSefH8il1ECWGC1sd1Mh-PzWXM1CV2xTXw"; 

// App State
let state = {
  products: [],
  invoiceItems: [], // [{ product, brand, package, colorCode, colorPercent, quantity, discountPercent, price }]
  savedOrders: [],
  customers: [],
  pricelists: [],
  users: [],
  currentUser: null,
  activeCustomerId: '',
  activeCustomerBrand: 'Tất cả',
  currentTab: 'dashboard-panel',
  isQuickCustomerMode: false
};

// Supabase Global Client Reference
let supabaseClient = null;
let isCloudActive = false;
let tableProductsName = 'products';
let tableOrdersName = 'orders';
let tableCustomersName = 'customers';
let tablePricelistsName = 'pricelists';
let tableUsersName = 'users';

// Default Mock Products (Simplified to Code and Name)
const defaultProducts = [
  { code: 'SP001', name: 'Sơn bóng ngoại thất WeatherShield', brand: 'Nano10*', priceThung: 1250000, priceLon: 380000, priceHop: 120000, priceBao: 0, priceTui: 0 },
  { code: 'SP002', name: 'Sơn lót kháng kiềm Ultra Primer', brand: 'mutsutec', priceThung: 950000, priceLon: 290000, priceHop: 90000, priceBao: 0, priceTui: 0 },
  { code: 'SP003', name: 'Sơn phủ nội thất Nippon Odourless', brand: 'tdkaw', priceThung: 1100000, priceLon: 350000, priceHop: 110000, priceBao: 0, priceTui: 0 },
  { code: 'SP004', name: 'Sơn nhũ vàng kim loại cao cấp', brand: 'cova', priceThung: 650000, priceLon: 180000, priceHop: 60000, priceBao: 0, priceTui: 0 },
  { code: 'SP005', name: 'Sơn phủ chống thấm màu Waterblock', brand: 'festivanano', priceThung: 1450000, priceLon: 450000, priceHop: 140000, priceBao: 0, priceTui: 0 },
  { code: 'SP006', name: 'Bột bả tường cao cấp Nano10*', brand: 'Nano10*', priceThung: 0, priceLon: 0, priceHop: 0, priceBao: 280000, priceTui: 60000 },
  { code: 'SP007', name: 'Chống thấm chuyên dụng Sika Latex', brand: 'Hatacco nano', priceThung: 850000, priceLon: 250000, priceHop: 0, priceBao: 0, priceTui: 75000 }
];

// Excel Import Temporary Data Holder
let excelImportData = [];

// Formatting helper: Currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND'
  }).format(amount);
}

// Get color percent markup from color code suffix (P: 0%, T: 15%, D: 20%, A: 25%)
function getColorPercentFromCode(colorCode) {
  if (!colorCode) return 0;
  const lastChar = colorCode.trim().slice(-1).toUpperCase();
  if (lastChar === 'P') return 0;
  if (lastChar === 'T') return 15;
  if (lastChar === 'D') return 20;
  if (lastChar === 'A') return 25;
  return 0; // Default to 0%
}

// Formatting helper: Date
function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Format Date Only for Invoice
function formatDateOnly(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
}

// Toast Notifications
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'danger' ? 'toast-danger' : type === 'warning' ? 'toast-warning' : ''}`;
  
  let iconName = 'check-circle';
  if (type === 'danger') iconName = 'alert-triangle';
  if (type === 'warning') iconName = 'alert-circle';
  
  toast.innerHTML = `
    <i data-lucide="${iconName}"></i>
    <span>${message}</span>
  `;
  
  container.appendChild(toast);
  safeCreateIcons();
  
  // Fade out and remove
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 3000);
}

// Update DB Status Badge UI
function updateDbStatusUI(status, message = '') {
  const badge = document.getElementById('db-status-badge');
  badge.className = 'db-status-badge'; // reset
  badge.style.border = ''; // reset custom styles
  
  const savedUrl = localStorage.getItem('billing_supabase_url');
  const savedKey = localStorage.getItem('billing_supabase_key');
  
  if (status === 'cloud') {
    badge.classList.add('status-cloud');
    badge.innerHTML = `<i data-lucide="cloud" style="width:12px;height:12px;"></i> Đám mây (Supabase)`;
  } else if (status === 'connecting') {
    badge.classList.add('status-connecting');
    badge.innerHTML = `<i data-lucide="loader" style="width:12px;height:12px;animation:spin 1s linear infinite;"></i> ${message || 'Đang kết nối...'}`;
  } else if (status === 'local_failed' && savedUrl && savedKey) {
    badge.classList.add('status-local');
    badge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
    badge.innerHTML = `
      <i data-lucide="database" style="width:12px;height:12px;"></i> Cục bộ (Lỗi Cloud)
      <button id="btn-retry-connection" style="background: var(--color-primary); color: #fff; border: none; padding: 2px 8px; border-radius: 4px; margin-left: 8px; font-size: 0.75rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-weight: 500; font-family: var(--font-sans);">
        <i data-lucide="refresh-cw" style="width:10px;height:10px;"></i> Kết nối lại
      </button>
    `;
    setTimeout(() => {
      const retryBtn = document.getElementById('btn-retry-connection');
      if (retryBtn) {
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          retrySupabaseConnection();
        });
      }
    }, 50);
  } else {
    badge.classList.add('status-local');
    badge.innerHTML = `<i data-lucide="database" style="width:12px;height:12px;"></i> Cục bộ (LocalStorage)${message ? ` - ${message}` : ''}`;
  }
  safeCreateIcons();
}

// Quick reconnect helper
async function retrySupabaseConnection() {
  const savedUrl = localStorage.getItem('billing_supabase_url');
  const savedKey = localStorage.getItem('billing_supabase_key');
  if (!savedUrl || !savedKey) {
    showToast('Chưa có thông tin cấu hình Cloud. Vui lòng cấu hình trong phần Cấu hình Cloud.', 'warning');
    return;
  }
  
  updateDbStatusUI('connecting', 'Đang kết nối lại...');
  const connected = await connectSupabase(savedUrl, savedKey, true);
  if (connected) {
    renderAll();
  } else {
    updateDbStatusUI('local_failed');
  }
}

// Initialize Application
async function initApp() {
  // Set today's date in header
  const today = new Date();
  document.getElementById('current-date-lbl').innerText = today.toLocaleDateString('vi-VN');

  // Register Event Listeners
  setupNavigation();
  setupProductManagement();
  setupCustomerManagement();
  setupPricelistManagement();
  setupInvoiceCreator();
  setupHistoryPanel();
  setupDashboardQuickActions();
  setupExcelImportAndTemplate();
  setupSupabaseSettings();
  setupUserManagement();

  // Try to connect to Supabase on startup with automatic retries (handles startup network delay)
  const savedUrl = localStorage.getItem('billing_supabase_url') || COMPANY_SUPABASE_URL;
  const savedKey = localStorage.getItem('billing_supabase_key') || COMPANY_SUPABASE_KEY;
  
  if (savedUrl && savedKey) {
    let connected = false;
    const retries = 3;
    const delayMs = 3000;
    
    for (let i = 1; i <= retries; i++) {
      updateDbStatusUI('connecting', `Kết nối Cloud (Lần ${i}/${retries})...`);
      connected = await connectSupabase(savedUrl, savedKey, false);
      if (connected) break;
      
      if (i < retries) {
        await new Promise(resolve => setTimeout(resolve, delayMs)); // Wait 3s before retry
      }
    }
    
    if (!connected) {
      loadLocalStorageBackup();
      updateDbStatusUI('local_failed');
      showToast('Không thể kết nối Cloud sau 3 lần thử, đã chuyển về chế độ offline.', 'warning');
    }
  } else {
    loadLocalStorageBackup();
    updateDbStatusUI('local');
  }
  
  // Set up Login form submit listener
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

  // Set up Logout button listener
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  // Check auth session
  const isAuth = sessionStorage.getItem('billing_system_auth') === 'true';
  const username = sessionStorage.getItem('billing_system_username');
  
  if (isAuth && username) {
    const user = state.users.find(u => u.username === username);
    if (user) {
      state.currentUser = user;
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app-layout').classList.remove('auth-hidden');
      document.getElementById('user-info-header').style.display = 'flex';
      document.getElementById('btn-logout').style.display = 'inline-flex';
      document.getElementById('header-user-display').innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
      applyUserPermissions(user);
    } else {
      showLoginGate();
    }
  } else {
    showLoginGate();
  }

  // Initial renders
  populatePricelistsDropdowns();
  renderAll();
}

// Load data backup from LocalStorage
function loadLocalStorageBackup() {
  const storedProducts = localStorage.getItem('billing_system_products');
  const storedOrders = localStorage.getItem('billing_system_orders');
  
  if (storedProducts) {
    state.products = JSON.parse(storedProducts).map(p => ({
      code: p.code,
      name: p.name,
      brand: p.brand || 'Nano10*',
      priceThung: p.priceThung !== undefined ? p.priceThung : (p.price !== undefined ? p.price : 0),
      priceLon: p.priceLon !== undefined ? p.priceLon : 0,
      priceHop: p.priceHop !== undefined ? p.priceHop : 0,
      priceBao: p.priceBao !== undefined ? p.priceBao : 0,
      priceTui: p.priceTui !== undefined ? p.priceTui : 0
    }));
  } else {
    state.products = [...defaultProducts];
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
  }
  
  if (storedOrders) {
    state.savedOrders = JSON.parse(storedOrders).map(o => ({
      ...o,
      createdBy: o.createdBy || 'admin',
      status: o.status || 'settled'
    }));
  } else {
    state.savedOrders = [];
    localStorage.setItem('billing_system_orders', JSON.stringify(state.savedOrders));
  }

  const storedCustomers = localStorage.getItem('billing_system_customers');
  if (storedCustomers) {
    state.customers = JSON.parse(storedCustomers).map(c => ({
      ...c,
      pricelistId: c.pricelistId || 'custom',
      managedBy: c.managedBy || 'nhat'
    }));
  } else {
    state.customers = [];
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  }

  const storedUsers = localStorage.getItem('billing_system_users');
  if (storedUsers) {
    state.users = JSON.parse(storedUsers);
  } else {
    // Default offline fallback accounts
    state.users = [
      { id: 'u-admin', username: 'admin', password: '1307', displayName: 'Administrator', role: 'admin' },
      { id: 'u-nhat', username: 'nhat', password: '1307', displayName: 'Trần Văn Nhật', role: 'admin' },
      { id: 'u-ketoan', username: 'ketoan', password: 'ketoan123', displayName: 'Kế toán Công ty', role: 'accounting' },
      { id: 'u-sale1', username: 'sale1', password: '123', displayName: 'Sale Nguyễn Văn A', role: 'sale' },
      { id: 'u-sale2', username: 'sale2', password: '123', displayName: 'Sale Lê Văn B', role: 'sale' }
    ];
    localStorage.setItem('billing_system_users', JSON.stringify(state.users));
  }

  const storedPricelists = localStorage.getItem('billing_system_pricelists');
  if (storedPricelists) {
    state.pricelists = JSON.parse(storedPricelists);
  } else {
    // Generate default KiotViet-style pricelists
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
}

// Connect to Supabase
async function connectSupabase(url, key, verbose = true) {
  try {
    if (typeof supabase === 'undefined') {
      throw new Error('Thư viện Supabase chưa được tải (vui lòng kiểm tra kết nối mạng).');
    }
    const client = supabase.createClient(url, key);
    
    // Test wl_products first
    let { error: testWlErr } = await client.from('wl_products').select('code').limit(1);
    if (testWlErr && (testWlErr.code === '42P01' || (testWlErr.message && (testWlErr.message.includes('not find') || testWlErr.message.includes('does not exist'))))) {
      // wl_products doesn't exist, try products
      let { error: testProdErr } = await client.from('products').select('code').limit(1);
      if (testProdErr) {
        throw new Error('Không tìm thấy bảng wl_products hoặc products trong cơ sở dữ liệu Supabase của bạn. Vui lòng kiểm tra lại SQL.');
      }
      tableProductsName = 'products';
      tableOrdersName = 'orders';
      tableCustomersName = 'customers';
      tablePricelistsName = 'pricelists';
      tableUsersName = 'users';
      console.log('Using tables: products, orders, and customers');
    } else if (testWlErr) {
      throw testWlErr;
    } else {
      tableProductsName = 'wl_products';
      tableOrdersName = 'wl_orders';
      tableCustomersName = 'wl_customers';
      tablePricelistsName = 'wl_pricelists';
      tableUsersName = 'wl_users';
      console.log('Using tables: wl_products, wl_orders, and wl_customers');
    }
    
    supabaseClient = client;
    isCloudActive = true;
    
    localStorage.setItem('billing_supabase_url', url);
    localStorage.setItem('billing_supabase_key', key);
    
    document.getElementById('db-url').value = url;
    document.getElementById('db-anon-key').value = key;
    
    document.getElementById('btn-disconnect-db').style.display = 'inline-flex';
    document.getElementById('sync-section').style.display = 'block';
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
        if (typeof err === 'object') {
          errMsg = err.message || err.details || JSON.stringify(err);
        } else {
          errMsg = String(err);
        }
      }
      showToast('Lỗi kết nối Supabase: ' + errMsg, 'danger');
    }
    return false;
  }
}

// Fetch all products and orders from Supabase
async function fetchCloudData() {
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
        priceTui: row.price_tui !== undefined && row.price_tui !== null ? row.price_tui : (local && local.priceTui !== undefined ? local.priceTui : 0)
      };
    });
    
    // Save to local storage after fetching and merging
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
    
    // 2. Fetch Orders
    const { data: orderData, error: orderErr } = await supabaseClient
      .from(tableOrdersName)
      .select('*')
      .order('created_at', { ascending: false });
      
    if (orderErr) throw orderErr;
    
    state.savedOrders = (orderData || []).map(order => {
      let status = order.status;
      let notes = order.notes || '';
      if (!status && notes.startsWith('[DRAFT] ')) {
        status = 'draft';
        notes = notes.substring(8);
      }
      return {
        id: order.id,
        customerId: order.customer_id || null,
        customerName: order.customer_name,
        notes: notes,
        items: typeof order.items === 'string' ? JSON.parse(order.items) : order.items,
        date: order.created_at,
        totalMarket: parseFloat(order.total_market),
        totalDiscount: parseFloat(order.total_discount),
        shippingSupport: order.shipping_support || false,
        shippingDiscount: parseFloat(order.shipping_discount || 0),
        totalPayable: parseFloat(order.total_payable),
        pricelistId: order.pricelist_id || 'retail',
        createdBy: order.created_by || 'admin',
        status: status || 'settled'
      };
    });

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
        managedBy: cust.managed_by || 'nhat'
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

      // Seed default pricelists to Supabase if table is empty
      if (state.pricelists.length === 0) {
        state.pricelists = [
          {
            id: 'pl-02',
            name: 'Bảng giá 02',
            brandDiscounts: { 'Nano10*': 74.7, 'Hatacco nano': 0, 'mutsutec': 0, 'tdkaw': 0, 'cova': 0, 'festivanano': 0 }
          },
          {
            id: 'pl-03',
            name: 'Bảng giá 03',
            brandDiscounts: { 'Nano10*': 76, 'Hatacco nano': 0, 'mutsutec': 0, 'tdkaw': 0, 'cova': 0, 'festivanano': 0 }
          }
        ];
        for (const pl of state.pricelists) {
          await supabaseClient.from(tablePricelistsName).upsert({
            id: pl.id,
            name: pl.name,
            brand_discounts: pl.brandDiscounts
          });
        }
      }
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

      // Seed default users if empty on Supabase
      if (state.users.length === 0) {
        state.users = [
          { id: 'u-nhat', username: 'nhat', password: '1307', displayName: 'Trần Văn Nhật', role: 'admin' },
          { id: 'u-ketoan', username: 'ketoan', password: 'ketoan123', displayName: 'Kế toán Công ty', role: 'accounting' },
          { id: 'u-sale1', username: 'sale1', password: '123', displayName: 'Sale Nguyễn Văn A', role: 'sale' },
          { id: 'u-sale2', username: 'sale2', password: '123', displayName: 'Sale Lê Văn B', role: 'sale' }
        ];
        for (const u of state.users) {
          await supabaseClient.from(tableUsersName).upsert({
            id: u.id,
            username: u.username,
            password: u.password,
            display_name: u.displayName,
            role: u.role
          });
        }
      }
      localStorage.setItem('billing_system_users', JSON.stringify(state.users));
    } catch (uErr) {
      console.warn("Could not load users from Supabase:", uErr.message);
    }
    
  } catch(err) {
    console.error('Error fetching cloud data:', err);
    showToast('Lỗi đồng bộ dữ liệu đám mây!', 'danger');
  }
}

// Disconnect from Supabase Cloud
function disconnectSupabase() {
  localStorage.removeItem('billing_supabase_url');
  localStorage.removeItem('billing_supabase_key');
  
  supabaseClient = null;
  isCloudActive = false;
  
  document.getElementById('supabase-config-form').reset();
  document.getElementById('btn-disconnect-db').style.display = 'none';
  document.getElementById('sync-section').style.display = 'none';
  
  loadLocalStorageBackup();
  updateDbStatusUI('local');
  renderAll();
  showToast('Đã ngắt kết nối đám mây, chuyển về LocalStorage cục bộ.', 'warning');
}

// --- Data Operations ---
async function dbSaveProduct(product) {
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
        price_tui: product.priceTui || 0
      };
      
      let { error } = await supabaseClient
        .from(tableProductsName)
        .upsert(dbRow, { onConflict: 'code,brand' });
        
      if (error && (error.code === '42P10' || error.message.includes('constraint'))) {
        const fallbackRes = await supabaseClient
          .from(tableProductsName)
          .upsert(dbRow, { onConflict: 'code' });
        error = fallbackRes.error;
      }
        
      if (error) throw error;
      
      const idx = state.products.findIndex(p => p.code === product.code && p.brand === product.brand);
      if (idx > -1) state.products[idx] = product;
      else state.products.push(product);
      
      // Mirror to localStorage as a fallback backup cache
      localStorage.setItem('billing_system_products', JSON.stringify(state.products));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu lên đám mây: ' + (err.message || JSON.stringify(err)), 'danger');
      return false;
    }
  } else {
    const idx = state.products.findIndex(p => p.code === product.code && p.brand === product.brand);
    if (idx > -1) state.products[idx] = product;
    else state.products.push(product);
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
    return true;
  }
}

async function dbDeleteProduct(code, brand) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableProductsName)
        .delete()
        .eq('code', code)
        .eq('brand', brand || '');
        
      if (error) throw error;
      
      state.products = state.products.filter(p => !(p.code === code && p.brand === brand));
      // Mirror to localStorage
      localStorage.setItem('billing_system_products', JSON.stringify(state.products));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa trên đám mây: ' + err.message, 'danger');
      return false;
    }
  } else {
    state.products = state.products.filter(p => !(p.code === code && p.brand === brand));
    localStorage.setItem('billing_system_products', JSON.stringify(state.products));
    return true;
  }
}

async function dbSaveCustomer(customer) {
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
        managed_by: customer.managedBy || 'nhat'
      };
      
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .upsert(dbRow, { onConflict: 'id' });
        
      if (error) throw error;
      
      const idx = state.customers.findIndex(c => c.id === customer.id);
      if (idx !== -1) {
        state.customers[idx] = customer;
      } else {
        state.customers.push(customer);
      }
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu khách hàng lên đám mây: ' + err.message, 'danger');
      const idx = state.customers.findIndex(c => c.id === customer.id);
      if (idx !== -1) {
        state.customers[idx] = customer;
      } else {
        state.customers.push(customer);
      }
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      return true;
    }
  } else {
    const idx = state.customers.findIndex(c => c.id === customer.id);
    if (idx !== -1) {
      state.customers[idx] = customer;
    } else {
      state.customers.push(customer);
    }
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
    return true;
  }
}

async function dbDeleteCustomer(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableCustomersName)
        .delete()
        .eq('id', id);
        
      if (error) throw error;
      
      state.customers = state.customers.filter(c => c.id !== id);
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa khách hàng trên đám mây: ' + err.message, 'danger');
      return false;
    }
  } else {
    state.customers = state.customers.filter(c => c.id !== id);
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
    return true;
  }
}

async function dbSavePricelist(pricelist) {
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
      
      const idx = state.pricelists.findIndex(p => p.id === pricelist.id);
      if (idx !== -1) {
        state.pricelists[idx] = pricelist;
      } else {
        state.pricelists.push(pricelist);
      }
      localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu bảng giá lên đám mây: ' + err.message, 'danger');
      const idx = state.pricelists.findIndex(p => p.id === pricelist.id);
      if (idx !== -1) {
        state.pricelists[idx] = pricelist;
      } else {
        state.pricelists.push(pricelist);
      }
      localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
      return true;
    }
  } else {
    const idx = state.pricelists.findIndex(p => p.id === pricelist.id);
    if (idx !== -1) {
      state.pricelists[idx] = pricelist;
    } else {
      state.pricelists.push(pricelist);
    }
    localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
    return true;
  }
}

async function dbDeletePricelist(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tablePricelistsName)
        .delete()
        .eq('id', id);
        
      if (error) throw error;
      
      state.pricelists = state.pricelists.filter(p => p.id !== id);
      localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa bảng giá trên đám mây: ' + err.message, 'danger');
      return false;
    }
  } else {
    state.pricelists = state.pricelists.filter(p => p.id !== id);
    localStorage.setItem('billing_system_pricelists', JSON.stringify(state.pricelists));
    return true;
  }
}

async function dbSaveOrder(order) {
  if (isCloudActive && supabaseClient) {
    try {
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
        .from(tableOrdersName)
        .insert(dbRow);
        
      if (error) {
        if (error.message && (error.message.includes('status') || error.message.includes('column') || error.code === '42703')) {
          console.warn("Supabase orders table missing status column. Retrying without it.");
          delete dbRow.status;
          if (order.status === 'draft') {
            dbRow.notes = `[DRAFT] ${dbRow.notes || ''}`.trim();
          }
          const retryResult = await supabaseClient
            .from(tableOrdersName)
            .insert(dbRow);
          if (retryResult.error) throw retryResult.error;
        } else {
          throw error;
        }
      }
      
      state.savedOrders.unshift(order);
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu hóa đơn lên đám mây: ' + err.message, 'danger');
      return false;
    }
  } else {
    state.savedOrders.unshift(order);
    localStorage.setItem('billing_system_orders', JSON.stringify(state.savedOrders));
    return true;
  }
}

async function dbDeleteAllOrders() {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableOrdersName)
        .delete()
        .neq('id', 'temp_id_none');
        
      if (error) throw error;
      
      state.savedOrders = [];
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa lịch sử trên đám mây: ' + err.message, 'danger');
      return false;
    }
  } else {
    state.savedOrders = [];
    localStorage.setItem('billing_system_orders', JSON.stringify(state.savedOrders));
    return true;
  }
}

// Sync LocalStorage data to Supabase (Migration Tool)
async function syncLocalToCloud() {
  if (!isCloudActive || !supabaseClient) {
    showToast('Vui lòng kết nối với Supabase trước!', 'warning');
    return;
  }
  
  const localProducts = JSON.parse(localStorage.getItem('billing_system_products') || '[]');
  const localOrders = JSON.parse(localStorage.getItem('billing_system_orders') || '[]');
  const localCustomers = JSON.parse(localStorage.getItem('billing_system_customers') || '[]');
  const localPricelists = JSON.parse(localStorage.getItem('billing_system_pricelists') || '[]');
  const localUsers = JSON.parse(localStorage.getItem('billing_system_users') || '[]');
  
  if (localProducts.length === 0 && localOrders.length === 0 && localCustomers.length === 0 && localPricelists.length === 0 && localUsers.length === 0) {
    showToast('Không tìm thấy dữ liệu LocalStorage nào để đồng bộ!', 'warning');
    return;
  }
  
  try {
    updateDbStatusUI('connecting');
    let productsSynced = 0;
    let ordersSynced = 0;
    let customersSynced = 0;
    let pricelistsSynced = 0;
    
    // 1. Sync Products (in Batch)
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
      
      const { error } = await supabaseClient
        .from(tableProductsName)
        .upsert(dbRows, { onConflict: 'code' });
        
      if (error) {
        if (error.message && (error.message.includes('column') || error.message.includes('not exist') || error.code === '42703')) {
          console.warn('Supabase table missing brand/price_thung columns during sync. Falling back.');
          const fallbackRows = localProducts.map(p => ({
            code: p.code,
            name: p.name,
            price: p.priceThung || 0
          }));
          const { error: fallbackErr } = await supabaseClient
            .from(tableProductsName)
            .upsert(fallbackRows, { onConflict: 'code' });
          if (fallbackErr) throw fallbackErr;
          showToast('Đồng bộ sản phẩm thành công (không gồm hãng sơn/giá riêng biệt do thiếu cột ở Supabase).', 'warning');
        } else {
          throw error;
        }
      }
      productsSynced = localProducts.length;
    }
    
    // 2. Sync Orders
    if (localOrders.length > 0) {
      const dbRows = localOrders.map(o => ({
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
      
      let { error } = await supabaseClient
        .from(tableOrdersName)
        .upsert(dbRows, { onConflict: 'id' });
        
      if (error) {
        if (error.message && (error.message.includes('status') || error.message.includes('column') || error.code === '42703')) {
          console.warn("Supabase orders table missing status column during sync. Retrying fallback notes encoding.");
          const fallbackRows = localOrders.map(o => ({
            id: o.id,
            customer_id: o.customerId || null,
            customer_name: o.customerName,
            notes: o.status === 'draft' ? `[DRAFT] ${o.notes || ''}`.trim() : o.notes,
            items: o.items,
            total_market: o.totalMarket,
            total_discount: o.totalDiscount,
            shipping_support: o.shippingSupport || false,
            shipping_discount: o.shippingDiscount || 0,
            total_payable: o.totalPayable,
            created_at: o.date,
            pricelist_id: o.pricelistId || 'retail',
            created_by: o.createdBy || 'admin'
          }));
          const retryResult = await supabaseClient
            .from(tableOrdersName)
            .upsert(fallbackRows, { onConflict: 'id' });
          if (retryResult.error) throw retryResult.error;
        } else {
          throw error;
        }
      }
      ordersSynced = localOrders.length;
    }

    // 3. Sync Customers
    if (localCustomers.length > 0) {
      try {
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
          managed_by: c.managedBy || 'nhat'
        }));
        
        const { error } = await supabaseClient
          .from(tableCustomersName)
          .upsert(dbRows, { onConflict: 'id' });
          
        if (error) throw error;
        customersSynced = localCustomers.length;
      } catch (custErr) {
        console.warn("Could not sync customers to Supabase, table might not exist yet:", custErr.message);
      }
    }

    // 4. Sync Price Lists
    if (localPricelists.length > 0) {
      try {
        const dbRows = localPricelists.map(pl => ({
          id: pl.id,
          name: pl.name,
          brand_discounts: pl.brandDiscounts
        }));
        
        const { error } = await supabaseClient
          .from(tablePricelistsName)
          .upsert(dbRows, { onConflict: 'id' });
          
        if (error) throw error;
        pricelistsSynced = localPricelists.length;
      } catch (plErr) {
        console.warn("Could not sync pricelists to Supabase, table might not exist yet:", plErr.message);
      }
    }
    // 5. Sync Users
    let usersSynced = 0;
    if (localUsers.length > 0) {
      try {
        const dbRows = localUsers.map(u => ({
          id: u.id,
          username: u.username,
          password: u.password,
          display_name: u.displayName,
          role: u.role
        }));
        
        const { error } = await supabaseClient
          .from(tableUsersName)
          .upsert(dbRows, { onConflict: 'id' });
          
        if (error) throw error;
        usersSynced = localUsers.length;
      } catch (uErr) {
        console.warn("Could not sync users to Supabase, table might not exist yet:", uErr.message);
      }
    }
    
    await fetchCloudData();
    renderAll();
    
    showToast(`Đồng bộ thành công ${productsSynced} SP, ${ordersSynced} đơn hàng, ${customersSynced} khách hàng, ${pricelistsSynced} bảng giá và ${usersSynced} tài khoản lên Cloud!`);
  } catch(err) {
    console.error('Migration failed:', err);
    showToast('Lỗi đồng bộ dữ liệu: ' + err.message, 'danger');
    updateDbStatusUI('cloud');
  }
}

// --- Setup Settings Panel ---
function setupSupabaseSettings() {
  const form = document.getElementById('supabase-config-form');
  const disconnectBtn = document.getElementById('btn-disconnect-db');
  const syncBtn = document.getElementById('btn-sync-to-cloud');

  // Pre-populate input fields with saved keys from localStorage
  const savedUrl = localStorage.getItem('billing_supabase_url');
  const savedKey = localStorage.getItem('billing_supabase_key');
  if (savedUrl) {
    document.getElementById('db-url').value = savedUrl;
  }
  if (savedKey) {
    document.getElementById('db-anon-key').value = savedKey;
  }
  if (savedUrl && savedKey) {
    disconnectBtn.style.display = 'inline-flex';
    document.getElementById('sync-section').style.display = 'block';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('db-url').value.trim();
    const anonKey = document.getElementById('db-anon-key').value.trim();
    
    updateDbStatusUI('connecting');
    const success = await connectSupabase(url, anonKey, true);
    if (success) {
      renderAll();
    } else {
      if (isCloudActive) updateDbStatusUI('cloud');
      else updateDbStatusUI('local', 'Kết nối thất bại');
    }
  });

  disconnectBtn.addEventListener('click', disconnectSupabase);
  syncBtn.addEventListener('click', syncLocalToCloud);
}

// --- Product Management (CRUD) ---

// --- Rendering and Tabs ---
function renderAll() {
  updateDashboardStats();
  renderProductsTable();
  renderInvoiceTable();
  renderCustomersTable();
  populatePricelistsDropdowns();
  renderPricelistsTable();
  renderHistoryOrders();
  renderUsersTable();
  populateCustomerEmployeeFilter();
  safeCreateIcons();
}

function setupNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetPanel = link.getAttribute('data-target');
      switchTab(targetPanel);
      // Close sidebar on mobile after clicking a nav link
      closeMobileSidebar();
    });
  });

  // Hamburger menu toggle
  const hamburgerBtn = document.getElementById('hamburger-btn');
  const sidebarOverlay = document.getElementById('sidebar-overlay');

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', () => {
      toggleMobileSidebar();
    });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      closeMobileSidebar();
    });
  }

  // Auto-close sidebar when resizing to desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });
}

function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) {
      closeMobileSidebar();
    } else {
      sidebar.classList.add('open');
      overlay.classList.add('active');
    }
  }
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
}

function switchTab(panelId) {
  state.currentTab = panelId;
  
  document.querySelectorAll('.nav-link').forEach(l => {
    if (l.getAttribute('data-target') === panelId) {
      l.classList.add('active');
    } else {
      l.classList.remove('active');
    }
  });

  document.querySelectorAll('.panel').forEach(p => {
    if (p.id === panelId) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });

  const heading = document.getElementById('page-title-heading');
  if (panelId === 'dashboard-panel') heading.innerText = 'Tổng quan hệ thống';
  else if (panelId === 'products-panel') heading.innerText = 'Quản lý sản phẩm';
  else if (panelId === 'invoice-panel') heading.innerText = 'Lập hóa đơn bán hàng';
  else if (panelId === 'history-panel') heading.innerText = 'Lịch sử giao dịch';
  else if (panelId === 'customers-panel') heading.innerText = 'Danh sách khách hàng & Đại lý';
  else if (panelId === 'pricelists-panel') heading.innerText = 'Quản lý Bảng giá & Chiết khấu';
  else if (panelId === 'users-panel') heading.innerText = 'Quản lý tài khoản người dùng';
  else if (panelId === 'settings-panel') heading.innerText = 'Cấu hình đám mây';
  
  if (panelId === 'dashboard-panel') {
    updateDashboardStats();
  }
}

function updateDashboardStats() {
  let userOrders = state.savedOrders;
  let userCustomers = state.customers;

  if (state.currentUser && state.currentUser.role === 'sale') {
    userOrders = state.savedOrders.filter(o => o.createdBy === state.currentUser.username);
    userCustomers = state.customers.filter(c => c.managedBy === state.currentUser.username);
  }

  document.getElementById('stat-total-products').innerText = state.products.length;
  document.getElementById('stat-total-orders').innerText = userOrders.length;
  
  const totalRevenue = userOrders.reduce((sum, order) => sum + (order.totalPayable || 0), 0);
  document.getElementById('stat-total-revenue').innerText = formatCurrency(totalRevenue);
  
  let totalItemsCount = 0;
  let totalDiscountSum = 0;
  userOrders.forEach(order => {
    (order.items || []).forEach(item => {
      totalItemsCount += Number(item.quantity || 1);
      totalDiscountSum += Number(item.discountPercent || 0) * Number(item.quantity || 1);
    });
  });
  const avgDiscount = totalItemsCount > 0 
    ? (totalDiscountSum / totalItemsCount).toFixed(1) 
    : '0';
  document.getElementById('stat-avg-discount').innerText = `${avgDiscount}%`;

  const recentOrdersBody = document.getElementById('dashboard-recent-orders-body');
  if (userOrders.length === 0) {
    recentOrdersBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Chưa có đơn hàng nào được tạo
        </td>
      </tr>
    `;
    return;
  }

  const sortedOrders = [...userOrders]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  recentOrdersBody.innerHTML = sortedOrders.map(order => {
    const totalItems = (order.items || []).reduce((sum, item) => sum + Number(item.quantity), 0);
    return `
      <tr>
        <td style="font-weight:600; color: #fff;">${order.id}</td>
        <td>${formatDateTime(order.date)}</td>
        <td>${totalItems} sản phẩm</td>
        <td style="color: var(--color-primary); font-weight: 600;">${formatCurrency(order.totalPayable)}</td>
        <td>
          <button class="btn btn-secondary btn-sm btn-circle quick-print-btn" data-id="${order.id}" title="In đơn hàng">
            <i data-lucide="printer" style="width: 14px; height: 14px;"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.quick-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute('data-id');
      printOrderById(orderId);
    });
  });
  
  safeCreateIcons();
}

function setupDashboardQuickActions() {
  document.getElementById('btn-quick-order').addEventListener('click', () => {
    switchTab('invoice-panel');
  });
  
  document.getElementById('dash-btn-add-product').addEventListener('click', () => {
    switchTab('products-panel');
    openProductModal();
  });
  
  document.getElementById('dash-btn-new-order').addEventListener('click', () => {
    switchTab('invoice-panel');
  });

  document.getElementById('btn-view-all-history').addEventListener('click', () => {
    switchTab('history-panel');
  });


}

function setupProductManagement() {
  const addBtn = document.getElementById('btn-open-add-product-modal');
  addBtn.addEventListener('click', () => openProductModal());
  
  document.getElementById('btn-close-product-modal').addEventListener('click', closeProductModal);
  document.getElementById('btn-cancel-product').addEventListener('click', closeProductModal);
  
  const productForm = document.getElementById('product-form');
  productForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveProduct();
  });

  const brandSelect = document.getElementById('prod-brand');
  const customBrandGroup = document.getElementById('prod-brand-custom-group');
  brandSelect.addEventListener('change', () => {
    if (brandSelect.value === 'Khác') {
      customBrandGroup.style.display = 'block';
      document.getElementById('prod-brand-custom').setAttribute('required', 'true');
    } else {
      customBrandGroup.style.display = 'none';
      document.getElementById('prod-brand-custom').removeAttribute('required');
    }
  });

  // Inline table auto-save listeners via delegation
  const tableBody = document.getElementById('products-table-body');
  
  tableBody.addEventListener('change', async (e) => {
    const target = e.target;
    if (target.classList.contains('table-brand-select') && target.value !== 'Khác') {
      const idx = parseInt(target.getAttribute('data-index'));
      const product = state.products[idx];
      product.brand = target.value;
      await dbSaveProduct(product);
      showToast(`Đã gán hãng sơn "${product.brand}" cho sản phẩm ${product.code}!`);
    }
  });

  tableBody.addEventListener('blur', async (e) => {
    const target = e.target;
    if (target.classList.contains('table-price-thung') || target.classList.contains('table-price-lon') || target.classList.contains('table-price-hop') || target.classList.contains('table-price-bao') || target.classList.contains('table-price-tui')) {
      const idx = parseInt(target.getAttribute('data-index'));
      const product = state.products[idx];
      const val = parseFloat(target.value) || 0;
      
      let changed = false;
      if (target.classList.contains('table-price-thung') && product.priceThung !== val) {
        product.priceThung = val;
        changed = true;
      } else if (target.classList.contains('table-price-lon') && product.priceLon !== val) {
        product.priceLon = val;
        changed = true;
      } else if (target.classList.contains('table-price-hop') && product.priceHop !== val) {
        product.priceHop = val;
        changed = true;
      } else if (target.classList.contains('table-price-bao') && product.priceBao !== val) {
        product.priceBao = val;
        changed = true;
      } else if (target.classList.contains('table-price-tui') && product.priceTui !== val) {
        product.priceTui = val;
        changed = true;
      }
      
      if (changed) {
        await dbSaveProduct(product);
        showToast(`Đã cập nhật giá cho sản phẩm ${product.code}!`);
      }
    }
  }, true);

  document.getElementById('product-search-input').addEventListener('input', renderProductsTable);
  const brandFilter = document.getElementById('product-brand-filter');
  if (brandFilter) {
    brandFilter.addEventListener('change', renderProductsTable);
  }
}

function openProductModal(index = -1) {
  const modal = document.getElementById('product-modal');
  const title = document.getElementById('product-modal-title');
  const productForm = document.getElementById('product-form');
  const customBrandGroup = document.getElementById('prod-brand-custom-group');
  
  productForm.reset();
  customBrandGroup.style.display = 'none';
  document.getElementById('prod-brand-custom').removeAttribute('required');
  
  if (index === -1) {
    title.innerText = 'Thêm sản phẩm mới';
    document.getElementById('product-edit-index').value = '-1';
    document.getElementById('prod-code').disabled = false;
  } else {
    title.innerText = 'Chỉnh sửa sản phẩm';
    document.getElementById('product-edit-index').value = index;
    const prod = state.products[index];
    
    document.getElementById('prod-code').value = prod.code;
    document.getElementById('prod-code').disabled = true;
    document.getElementById('prod-name').value = prod.name;
    
    const knownBrands = ['Nano10*', 'mutsutec', 'tdkaw', 'cova', 'festivanano', 'Hatacco nano'];
    if (prod.brand && !knownBrands.includes(prod.brand)) {
      document.getElementById('prod-brand').value = 'Khác';
      customBrandGroup.style.display = 'block';
      document.getElementById('prod-brand-custom').value = prod.brand;
      document.getElementById('prod-brand-custom').setAttribute('required', 'true');
    } else {
      document.getElementById('prod-brand').value = prod.brand || 'Nano10*';
    }
    
    document.getElementById('prod-price-thung').value = prod.priceThung !== undefined ? prod.priceThung : 0;
    document.getElementById('prod-price-lon').value = prod.priceLon !== undefined ? prod.priceLon : 0;
    document.getElementById('prod-price-hop').value = prod.priceHop !== undefined ? prod.priceHop : 0;
    document.getElementById('prod-price-bao').value = prod.priceBao !== undefined ? prod.priceBao : 0;
    document.getElementById('prod-price-tui').value = prod.priceTui !== undefined ? prod.priceTui : 0;
  }
  
  modal.classList.add('active');
  safeCreateIcons();
}

function closeProductModal() {
  document.getElementById('product-modal').classList.remove('active');
}

async function saveProduct() {
  const index = parseInt(document.getElementById('product-edit-index').value);
  const code = document.getElementById('prod-code').value.trim().toUpperCase();
  const name = document.getElementById('prod-name').value.trim();
  
  const brandSelect = document.getElementById('prod-brand').value;
  let brand = brandSelect;
  if (brandSelect === 'Khác') {
    brand = document.getElementById('prod-brand-custom').value.trim();
  }
  const priceThung = parseFloat(document.getElementById('prod-price-thung').value) || 0;
  const priceLon = parseFloat(document.getElementById('prod-price-lon').value) || 0;
  const priceHop = parseFloat(document.getElementById('prod-price-hop').value) || 0;
  const priceBao = parseFloat(document.getElementById('prod-price-bao').value) || 0;
  const priceTui = parseFloat(document.getElementById('prod-price-tui').value) || 0;

  if (priceThung <= 0 && priceLon <= 0 && priceHop <= 0 && priceBao <= 0 && priceTui <= 0) {
    showToast('Vui lòng nhập ít nhất một mức giá lớn hơn 0 cho sản phẩm!', 'danger');
    return;
  }

  if (index === -1) {
    const exists = state.products.some(p => p.code === code && p.brand === brand);
    if (exists) {
      showToast(`Mã sản phẩm "${code}" thuộc hãng "${brand}" đã tồn tại!`, 'danger');
      return;
    }
  }

  const productData = { 
    code, 
    name, 
    brand, 
    priceThung,
    priceLon,
    priceHop,
    priceBao,
    priceTui
  };

  const saved = await dbSaveProduct(productData);
  if (saved) {
    if (index === -1) showToast('Thêm sản phẩm mới thành công!');
    else showToast('Cập nhật sản phẩm thành công!');
    
    closeProductModal();
    renderAll();
  }
}

async function deleteProduct(index) {
  const prod = state.products[index];
  if (confirm(`Bạn có chắc chắn muốn xóa sản phẩm "${prod.name}" (${prod.code})?`)) {
    const deleted = await dbDeleteProduct(prod.code, prod.brand);
    if (deleted) {
      renderAll();
      showToast('Xóa sản phẩm thành công!', 'warning');
    }
  }
}

function updateBrandFilterOptions() {
  const brandFilter = document.getElementById('product-brand-filter');
  if (!brandFilter) return;
  
  const currentVal = brandFilter.value;
  const brands = [...new Set(state.products.map(p => p.brand).filter(Boolean))];
  brands.sort();
  
  const existingOptions = Array.from(brandFilter.options).map(opt => opt.value).filter(val => val !== "");
  const isSame = brands.length === existingOptions.length && brands.every((val, index) => val === existingOptions[index]);
  
  if (!isSame) {
    brandFilter.innerHTML = `
      <option value="">-- Tất cả hãng sơn --</option>
      ${brands.map(b => `<option value="${b}" ${b === currentVal ? 'selected' : ''}>${b}</option>`).join('')}
    `;
    if (currentVal && !brands.includes(currentVal)) {
      brandFilter.value = "";
    }
  }
}

function renderProductsTable() {
  updateBrandFilterOptions();

  const tableBody = document.getElementById('products-table-body');
  const searchVal = document.getElementById('product-search-input').value.toLowerCase().trim();
  
  const brandFilter = document.getElementById('product-brand-filter');
  const selectedBrand = brandFilter ? brandFilter.value : "";

  let filtered = state.products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchVal) || p.code.toLowerCase().includes(searchVal);
    const matchesBrand = selectedBrand === "" || p.brand === selectedBrand;
    return matchesSearch && matchesBrand;
  });

  // Sắp xếp sản phẩm theo Hãng sơn (Brand), sau đó theo Mã SP (Code)
  filtered.sort((a, b) => {
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

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy sản phẩm phù hợp.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filtered.map((p, idx) => {
    const actualIndex = state.products.findIndex(prod => prod.code === p.code && prod.brand === p.brand);
    
    const knownBrands = ['Nano10*', 'mutsutec', 'tdkaw', 'cova', 'festivanano', 'Hatacco nano'];
    const currentBrand = p.brand || 'Nano10*';
    const brandOptions = [...knownBrands];
    if (currentBrand && !brandOptions.includes(currentBrand)) {
      brandOptions.push(currentBrand);
    }
    const brandSelectOptions = brandOptions.map(b => 
      `<option value="${b}" ${currentBrand === b ? 'selected' : ''}>${b}</option>`
    ).join('');

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted); font-weight: 500;">${idx + 1}</td>
        <td style="font-weight: 600; color: #fff;">${p.code}</td>
        <td style="font-weight: 500; font-size: 0.85rem; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${p.name}">${p.name}</td>
        <td>
          <select class="table-inline-select table-brand-select" data-index="${actualIndex}">
            ${brandSelectOptions}
            <option value="Khác">-- Tự nhập --</option>
          </select>
        </td>
        <td>
          <input type="number" class="table-inline-input table-price-thung" data-index="${actualIndex}" value="${p.priceThung || 0}" min="0">
        </td>
        <td>
          <input type="number" class="table-inline-input table-price-lon" data-index="${actualIndex}" value="${p.priceLon || 0}" min="0">
        </td>
        <td>
          <input type="number" class="table-inline-input table-price-hop" data-index="${actualIndex}" value="${p.priceHop || 0}" min="0">
        </td>
        <td>
          <input type="number" class="table-inline-input table-price-bao" data-index="${actualIndex}" value="${p.priceBao || 0}" min="0">
        </td>
        <td>
          <input type="number" class="table-inline-input table-price-tui" data-index="${actualIndex}" value="${p.priceTui || 0}" min="0">
        </td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center;">
            <button class="btn btn-danger btn-sm btn-circle delete-prod-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Handle "Khác" brand selection directly in table
  document.querySelectorAll('.table-brand-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      if (sel.value === 'Khác') {
        const custom = prompt('Nhập tên hãng sơn mới:');
        if (custom && custom.trim() !== '') {
          const idx = parseInt(sel.getAttribute('data-index'));
          const product = state.products[idx];
          product.brand = custom.trim();
          await dbSaveProduct(product);
          renderProductsTable();
          showToast(`Đã gán hãng sơn "${product.brand}" cho sản phẩm ${product.code}!`);
        } else {
          // Revert selection
          renderProductsTable();
        }
      }
    });
  });

  document.querySelectorAll('.delete-prod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      deleteProduct(idx);
    });
  });

  safeCreateIcons();
}


// --- Customer Management Panel Functions ---
function setupCustomerManagement() {
  const addBtn = document.getElementById('btn-open-add-customer-modal');
  const closeBtn = document.getElementById('btn-close-customer-modal');
  const cancelBtn = document.getElementById('btn-cancel-customer');
  const customerForm = document.getElementById('customer-form');
  const searchInput = document.getElementById('customer-search-input');
  
  if (addBtn) addBtn.addEventListener('click', () => openCustomerModal());
  if (closeBtn) closeBtn.addEventListener('click', closeCustomerModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeCustomerModal);
  
  if (customerForm) {
    customerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveCustomer();
    });
  }
  
  if (searchInput) {
    searchInput.addEventListener('input', renderCustomersTable);
  }
  
  const filterSelect = document.getElementById('customer-managed-filter');
  if (filterSelect) {
    filterSelect.addEventListener('change', renderCustomersTable);
  }
  
  const closePayDebtBtn = document.getElementById('btn-close-pay-debt-modal');
  const cancelPayDebtBtn = document.getElementById('btn-cancel-pay-debt');
  const payDebtForm = document.getElementById('pay-debt-form');
  
  if (closePayDebtBtn) closePayDebtBtn.addEventListener('click', closePayDebtModal);
  if (cancelPayDebtBtn) cancelPayDebtBtn.addEventListener('click', closePayDebtModal);
  if (payDebtForm) {
    payDebtForm.addEventListener('submit', handlePayDebtSubmit);
  }

  // Toggle brand discounts section display when default pricelist is changed
  const custPricelistSelect = document.getElementById('cust-pricelist');
  if (custPricelistSelect) {
    custPricelistSelect.addEventListener('change', () => {
      const discSection = document.getElementById('cust-brand-discounts-section');
      if (discSection) {
        discSection.style.display = custPricelistSelect.value === 'custom' ? 'block' : 'none';
      }
    });
  }
}

function openCustomerModal(index = -1) {
  const modal = document.getElementById('customer-modal');
  const title = document.getElementById('customer-modal-title');
  const form = document.getElementById('customer-form');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();
  
  // Populate pricelist dropdown
  const plSelect = document.getElementById('cust-pricelist');
  if (plSelect) {
    plSelect.innerHTML = `
      <option value="custom">Chiết khấu riêng (Tự thiết lập bên dưới)</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
    `;
  }
  
  document.querySelectorAll('.cust-brand-disc').forEach(input => input.value = 0);
  
  if (index === -1) {
    title.innerText = 'Thêm khách hàng mới';
    document.getElementById('customer-edit-index').value = '-1';
    document.getElementById('customer-edit-id').value = '';
    
    // Auto-generate code
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
    document.getElementById('cust-shipping-support').checked = false;
    document.getElementById('cust-code').value = `KH-${nextNum.toString().padStart(3, '0')}`;
    
    if (plSelect) plSelect.value = 'custom';
    const discSection = document.getElementById('cust-brand-discounts-section');
    if (discSection) discSection.style.display = 'block';
    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      mBySelect.value = state.currentUser ? state.currentUser.username : 'nhat';
    }
  } else {
    title.innerText = 'Chỉnh sửa khách hàng';
    const customer = state.customers[index];
    document.getElementById('customer-edit-index').value = index;
    document.getElementById('customer-edit-id').value = customer.id;
    
    document.getElementById('cust-code').value = customer.code;
    document.getElementById('cust-name').value = customer.name;
    document.getElementById('cust-phone').value = customer.phone || '';
    document.getElementById('cust-address').value = customer.address || '';
    document.getElementById('cust-assigned-brand').value = customer.assignedBrand || 'Tất cả';
    document.getElementById('cust-debt').value = customer.debt || 0;
    document.getElementById('cust-notes').value = customer.notes || '';
    document.getElementById('cust-shipping-support').checked = customer.shippingSupport || false;
    
    const cPlId = customer.pricelistId || 'custom';
    if (plSelect) plSelect.value = cPlId;
    
    const discSection = document.getElementById('cust-brand-discounts-section');
    if (discSection) {
      discSection.style.display = cPlId === 'custom' ? 'block' : 'none';
    }
    
    // Fill brand discounts
    document.querySelectorAll('.cust-brand-disc').forEach(input => {
      const brand = input.getAttribute('data-brand');
      input.value = (customer.brandDiscounts && customer.brandDiscounts[brand] !== undefined) ? customer.brandDiscounts[brand] : 0;
    });

    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      mBySelect.value = customer.managedBy || 'nhat';
    }
  }
}

function closeCustomerModal() {
  const modal = document.getElementById('customer-modal');
  if (modal) modal.classList.remove('active');
}

async function saveCustomer() {
  const index = parseInt(document.getElementById('customer-edit-index').value);
  const editId = document.getElementById('customer-edit-id').value;
  
  const code = document.getElementById('cust-code').value.trim().toUpperCase();
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const address = document.getElementById('cust-address').value.trim();
  const assignedBrand = document.getElementById('cust-assigned-brand').value;
  const debt = parseFloat(document.getElementById('cust-debt').value) || 0;
  const notes = document.getElementById('cust-notes').value.trim();
  const pricelistId = document.getElementById('cust-pricelist').value;
  
  let managedBy = 'nhat';
  if (state.currentUser) {
    if (state.currentUser.role === 'sale') {
      if (index === -1) {
        managedBy = state.currentUser.username;
      } else {
        managedBy = state.customers[index].managedBy || state.currentUser.username;
      }
    } else {
      managedBy = document.getElementById('cust-managed-by').value;
    }
  }
  
  // Validate duplicate code
  const duplicateCode = state.customers.some((c, idx) => c.code === code && idx !== index);
  if (duplicateCode) {
    showToast('Mã khách hàng đã tồn tại trên hệ thống!', 'danger');
    return;
  }
  
  const brandDiscounts = {};
  document.querySelectorAll('.cust-brand-disc').forEach(input => {
    const brand = input.getAttribute('data-brand');
    brandDiscounts[brand] = parseFloat(input.value) || 0;
  });
  
  const shippingSupport = document.getElementById('cust-shipping-support').checked;
  const customerId = index === -1 ? `cust-${Date.now()}` : editId;
  const customerData = {
    id: customerId,
    code,
    name,
    phone,
    address,
    assignedBrand,
    brandDiscounts,
    shippingSupport,
    debt,
    totalTransaction: index === -1 ? 0 : state.customers[index].totalTransaction || 0,
    notes,
    pricelistId,
    managedBy
  };
  
  const saved = await dbSaveCustomer(customerData);
  if (saved) {
    if (index === -1) showToast('Thêm khách hàng thành công!');
    else showToast('Cập nhật khách hàng thành công!');
    
    // If we updated the currently active customer on the invoice panel, refresh it
    if (state.activeCustomerId === customerId) {
      state.activeCustomerBrand = assignedBrand;
      document.getElementById('selected-customer-name-lbl').innerText = name;
      document.getElementById('selected-customer-phone-lbl').innerText = phone || 'N/A';
      document.getElementById('selected-customer-address-lbl').innerText = address || 'N/A';
      document.getElementById('selected-customer-brand-lbl').innerText = assignedBrand;
      document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(debt);
      
      const shipCheck = document.getElementById('invoice-shipping-support');
      if (shipCheck) {
        shipCheck.checked = shippingSupport;
      }
      
      // Update invoice pricelist select box
      const invoicePlSelect = document.getElementById('invoice-pricelist-select');
      if (invoicePlSelect) {
        invoicePlSelect.value = pricelistId;
      }
      
      // Update discounts for current items in builder based on active pricelist
      applyActivePriceListToInvoice();
    }
    
    closeCustomerModal();
    renderAll();
  }
}

async function deleteCustomer(index) {
  const cust = state.customers[index];
  if (confirm(`Bạn có chắc chắn muốn xóa khách hàng "${cust.name}" (${cust.code})?`)) {
    const deleted = await dbDeleteCustomer(cust.id);
    if (deleted) {
      if (state.activeCustomerId === cust.id) {
        resetInvoiceCustomer();
      }
      renderAll();
      showToast('Xóa khách hàng thành công!', 'warning');
    }
  }
}

function renderCustomersTable() {
  const tableBody = document.getElementById('customers-table-body');
  if (!tableBody) return;
  
  const searchVal = document.getElementById('customer-search-input').value.toLowerCase().trim();
  const filterSelect = document.getElementById('customer-managed-filter');
  const filterEmployee = filterSelect ? filterSelect.value : '';
  
  const filtered = state.customers.filter(c => {
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (c.managedBy !== state.currentUser.username) return false;
    } else if (filterEmployee) {
      if (c.managedBy !== filterEmployee) return false;
    }
    return c.code.toLowerCase().includes(searchVal) || 
           c.name.toLowerCase().includes(searchVal) || 
           (c.phone && c.phone.includes(searchVal));
  });
  
  // Calculate and display summary statistics for the filtered group of customers
  const totalDebt = filtered.reduce((sum, c) => sum + (parseFloat(c.debt) || 0), 0);
  const totalSales = filtered.reduce((sum, c) => sum + (parseFloat(c.totalTransaction) || 0), 0);
  
  const debtEl = document.getElementById('cust-summary-total-debt');
  const salesEl = document.getElementById('cust-summary-total-sales');
  if (debtEl) debtEl.innerText = formatCurrency(totalDebt);
  if (salesEl) salesEl.innerText = formatCurrency(totalSales);
  
  // Sort alphabetically by name
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  
  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy khách hàng nào.
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = filtered.map((c, idx) => {
    const actualIndex = state.customers.findIndex(cust => cust.id === c.id);
    
    let pricelistName = '';
    let tooltipTitle = '';
    const plId = c.pricelistId || 'custom';
    if (plId === 'custom') {
      const discSummary = [];
      if (c.brandDiscounts) {
        for (const [brand, pct] of Object.entries(c.brandDiscounts)) {
          if (pct > 0) {
            discSummary.push(`${brand}: ${pct}%`);
          }
        }
      }
      pricelistName = discSummary.length > 0 
        ? `CK riêng (${discSummary.join(', ')})` 
        : 'Chiết khấu riêng';
      tooltipTitle = discSummary.length > 0 ? discSummary.join('\n') : 'Chiết khấu riêng (Chưa cấu hình)';
    } else if (plId === 'retail') {
      pricelistName = 'Khách lẻ (Nhập tay)';
      tooltipTitle = 'Khách lẻ (Tự nhập chiết khấu khi tạo đơn)';
    } else {
      const pl = state.pricelists.find(p => p.id === plId);
      if (pl) {
        pricelistName = pl.name;
        const plDiscs = [];
        if (pl.brandDiscounts) {
          for (const [brand, pct] of Object.entries(pl.brandDiscounts)) {
            if (pct > 0) {
              plDiscs.push(`${brand}: ${pct}%`);
            }
          }
        }
        tooltipTitle = `${pl.name}:\n${plDiscs.length > 0 ? plDiscs.join('\n') : 'Không chiết khấu hãng'}`;
      } else {
        pricelistName = plId;
        tooltipTitle = plId;
      }
    }
    
    const shippingBadge = c.shippingSupport 
      ? `<span style="font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); margin-left: 0.35rem; display: inline-block; vertical-align: middle; font-weight: 600;">Hỗ trợ VC</span>` 
      : '';
    
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">${c.code}</td>
        <td style="font-weight: 500;">
          ${c.name}
          ${shippingBadge}
        </td>
        <td>${c.phone || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td style="font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${c.address || ''}">${c.address || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td>
          <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)'}; color: ${c.assignedBrand === 'Tất cả' ? '#10b981' : '#60a5fa'}; border: 1px solid ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)'};">${c.assignedBrand}</span>
        </td>
        <td style="font-size: 0.75rem; color: var(--text-secondary); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${tooltipTitle}">${pricelistName}</td>
        <td style="text-align: right; font-weight: 600; color: ${c.debt > 0 ? 'var(--color-danger)' : 'var(--text-muted)'};">${formatCurrency(c.debt)}</td>
        <td style="text-align: right; font-weight: 600; color: var(--color-primary);">${formatCurrency(c.totalTransaction)}</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-cust-btn" data-index="${actualIndex}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-primary btn-sm btn-circle pay-debt-btn" data-index="${actualIndex}" title="Thu nợ" style="background-color: var(--color-primary); color: #fff;">
              <i data-lucide="banknote" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-cust-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  document.querySelectorAll('.edit-cust-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openCustomerModal(idx);
    });
  });
  
  document.querySelectorAll('.pay-debt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openPayDebtModal(idx);
    });
  });
  
  document.querySelectorAll('.delete-cust-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      deleteCustomer(idx);
    });
  });
  
  safeCreateIcons();
}

// --- Price List Management Functions ---
function populatePricelistsDropdowns() {
  const select = document.getElementById('invoice-pricelist-select');
  if (select) {
    const currentVal = select.value;
    select.innerHTML = `
      <option value="retail">Nhập tay (Khách lẻ)</option>
      <option value="custom">Chiết khấu riêng của đại lý</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
    `;
    
    const exists = Array.from(select.options).some(opt => opt.value === currentVal);
    if (exists) {
      select.value = currentVal;
    } else {
      select.value = 'retail';
    }
  }

  // Also populate the customer edit modal dropdown if it exists in DOM
  const custPlSelect = document.getElementById('cust-pricelist');
  if (custPlSelect) {
    const currentCustPlVal = custPlSelect.value;
    custPlSelect.innerHTML = `
      <option value="custom">Chiết khấu riêng (Tự thiết lập bên dưới)</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
    `;
    const exists = Array.from(custPlSelect.options).some(opt => opt.value === currentCustPlVal);
    if (exists) {
      custPlSelect.value = currentCustPlVal;
    } else {
      custPlSelect.value = 'custom';
    }
  }
}

function renderPricelistsTable() {
  const tableBody = document.getElementById('pricelists-table-body');
  if (!tableBody) return;
  
  const searchInput = document.getElementById('pricelist-search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  const filtered = state.pricelists.filter(pl => pl.name.toLowerCase().includes(searchVal));
  
  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy bảng giá nào.
        </td>
      </tr>
    `;
    return;
  }
  
  // Sort alphabetically by name
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  
  tableBody.innerHTML = filtered.map((pl, idx) => {
    const actualIndex = state.pricelists.findIndex(p => p.id === pl.id);
    const getDisc = (brand) => (pl.brandDiscounts && pl.brandDiscounts[brand] !== undefined) ? pl.brandDiscounts[brand] : 0;
    
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">${pl.name}</td>
        <td style="text-align: center;">${getDisc('Nano10*')}%</td>
        <td style="text-align: center;">${getDisc('Hatacco nano')}%</td>
        <td style="text-align: center;">${getDisc('mutsutec')}%</td>
        <td style="text-align: center;">${getDisc('tdkaw')}%</td>
        <td style="text-align: center;">${getDisc('cova')}%</td>
        <td style="text-align: center;">${getDisc('festivanano')}%</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-pl-btn" data-index="${actualIndex}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-pl-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  document.querySelectorAll('.edit-pl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openPricelistModal(idx);
    });
  });
  
  document.querySelectorAll('.delete-pl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      deletePricelist(idx);
    });
  });
  
  safeCreateIcons();
}

function setupPricelistManagement() {
  const addBtn = document.getElementById('btn-open-add-pricelist-modal');
  const closeBtn = document.getElementById('btn-close-pricelist-modal');
  const cancelBtn = document.getElementById('btn-cancel-pricelist');
  const form = document.getElementById('pricelist-form');
  const searchInput = document.getElementById('pricelist-search-input');
  
  if (addBtn) addBtn.addEventListener('click', () => openPricelistModal(-1));
  if (closeBtn) closeBtn.addEventListener('click', closePricelistModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closePricelistModal);
  
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await savePricelist();
    });
  }
  
  if (searchInput) {
    searchInput.addEventListener('input', renderPricelistsTable);
  }
}

function openPricelistModal(index = -1) {
  const modal = document.getElementById('pricelist-modal');
  const title = document.getElementById('pricelist-modal-title');
  const form = document.getElementById('pricelist-form');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();
  
  document.querySelectorAll('.pl-brand-disc').forEach(input => input.value = 0);
  
  if (index === -1) {
    title.innerText = 'Thêm bảng giá mới';
    document.getElementById('pricelist-edit-index').value = '-1';
    document.getElementById('pricelist-edit-id').value = '';
  } else {
    title.innerText = 'Chỉnh sửa bảng giá';
    const pl = state.pricelists[index];
    document.getElementById('pricelist-edit-index').value = index;
    document.getElementById('pricelist-edit-id').value = pl.id;
    
    document.getElementById('pl-name').value = pl.name;
    
    document.querySelectorAll('.pl-brand-disc').forEach(input => {
      const brand = input.getAttribute('data-brand');
      input.value = (pl.brandDiscounts && pl.brandDiscounts[brand] !== undefined) ? pl.brandDiscounts[brand] : 0;
    });
  }
}

function closePricelistModal() {
  const modal = document.getElementById('pricelist-modal');
  if (modal) modal.classList.remove('active');
}

async function savePricelist() {
  const index = parseInt(document.getElementById('pricelist-edit-index').value);
  const editId = document.getElementById('pricelist-edit-id').value;
  const name = document.getElementById('pl-name').value.trim();
  
  // Validate name
  const duplicateName = state.pricelists.some((p, idx) => p.name.toLowerCase() === name.toLowerCase() && idx !== index);
  if (duplicateName) {
    showToast('Tên bảng giá đã tồn tại!', 'danger');
    return;
  }
  
  const brandDiscounts = {};
  document.querySelectorAll('.pl-brand-disc').forEach(input => {
    const brand = input.getAttribute('data-brand');
    brandDiscounts[brand] = parseFloat(input.value) || 0;
  });
  
  const pricelistId = index === -1 ? `pl-${Date.now()}` : editId;
  const pricelistData = {
    id: pricelistId,
    name,
    brandDiscounts
  };
  
  const saved = await dbSavePricelist(pricelistData);
  if (saved) {
    if (index === -1) showToast('Thêm bảng giá thành công!');
    else showToast('Cập nhật bảng giá thành công!');
    
    closePricelistModal();
    renderAll();
    
    // Update select values and recalculate active order
    populatePricelistsDropdowns();
    const plSelect = document.getElementById('invoice-pricelist-select');
    if (plSelect && plSelect.value === pricelistId) {
      applyActivePriceListToInvoice();
    }
  }
}

async function deletePricelist(index) {
  const pl = state.pricelists[index];
  if (confirm(`Bạn có chắc chắn muốn xóa bảng giá "${pl.name}"?`)) {
    const deleted = await dbDeletePricelist(pl.id);
    if (deleted) {
      renderAll();
      populatePricelistsDropdowns();
      
      const plSelect = document.getElementById('invoice-pricelist-select');
      if (plSelect && plSelect.value === pl.id) {
        plSelect.value = 'retail';
        applyActivePriceListToInvoice();
      }
      
      showToast('Xóa bảng giá thành công!', 'warning');
    }
  }
}

function getActiveInvoiceDiscount(brand) {
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (!plSelect) return 0;
  const plVal = plSelect.value;
  
  if (plVal === 'retail') {
    return 0; // manual input
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

function applyActivePriceListToInvoice() {
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (!plSelect) return;
  const plVal = plSelect.value;
  
  if (plVal === 'custom' && !state.activeCustomerId) {
    showToast('Vui lòng chọn khách hàng để dùng chiết khấu riêng!', 'warning');
    plSelect.value = 'retail';
    applyActivePriceListToInvoice();
    return;
  }
  
  // Update discounts of current products in draft
  state.invoiceItems.forEach(item => {
    item.discountPercent = getActiveInvoiceDiscount(item.brand);
  });
  
  // Update KiotViet style header source badge
  const label = document.getElementById('invoice-pricelist-source-lbl');
  if (label) {
    if (plVal === 'retail') {
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

// --- Invoice / Order Panel Functions ---
function setupInvoiceCreator() {
  const searchInput = document.getElementById('invoice-product-search');
  const suggestionsList = document.getElementById('invoice-product-suggestions');
  const addBtn = document.getElementById('btn-add-to-invoice-table');
  const resetBtn = document.getElementById('btn-reset-order');
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const printBtn = document.getElementById('btn-print-order');

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

    let matches = state.products.filter(p => 
      p.code.toLowerCase().includes(val) || p.name.toLowerCase().includes(val)
    );

    // Lọc theo nhãn sơn đại lý độc quyền của khách hàng
    if (state.activeCustomerBrand && state.activeCustomerBrand !== 'Tất cả') {
      matches = matches.filter(p => p.brand === state.activeCustomerBrand);
    }

    // Sắp xếp gợi ý theo Hãng sơn trước, sau đó theo Mã SP
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
            <span class="suggestion-code" style="font-weight: 600; color: #fff; font-size: 0.8rem; text-align: left;">${p.code}</span>
            <span class="suggestion-name" style="color: var(--text-secondary); text-align: left; font-size: 0.85rem;">${p.name}</span>
          </div>
          <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); white-space: nowrap; margin-left: 0.5rem; display: inline-block;">${p.brand || 'Nano10*'}</span>
        </li>
      `).join('');
    }
    suggestionsList.style.display = 'block';

    document.querySelectorAll('.suggestion-item[data-code]').forEach(item => {
      item.addEventListener('click', () => {
        searchInput.value = item.getAttribute('data-code');
        searchInput.setAttribute('data-selected-brand', item.getAttribute('data-brand'));
        suggestionsList.style.display = 'none';
        searchInput.focus();
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !suggestionsList.contains(e.target)) {
      suggestionsList.style.display = 'none';
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addProductToInvoice();
    }
  });

  addBtn.addEventListener('click', addProductToInvoice);

  resetBtn.addEventListener('click', () => {
    if (state.invoiceItems.length > 0 && confirm('Bạn có chắc muốn xóa tất cả sản phẩm đang lập trên hóa đơn?')) {
      resetInvoiceBuilder();
    }
  });

  saveBtn.addEventListener('click', async () => {
    const order = await saveActiveOrder('settled');
    if (order) {
      switchTab('history-panel');
    }
  });

  if (draftBtn) {
    draftBtn.addEventListener('click', async () => {
      const order = await saveActiveOrder('draft');
      if (order) {
        switchTab('history-panel');
      }
    });
  }

  printBtn.addEventListener('click', () => {
    const order = compileActiveOrder();
    if (order) {
      renderAndPrintOrder(order);
    }
  });

  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck) {
    shipCheck.addEventListener('change', () => {
      if (state.isQuickCustomerMode) {
        const quickShipCheck = document.getElementById('quick-cust-shipping-support');
        if (quickShipCheck) quickShipCheck.checked = shipCheck.checked;
      }
      calculateInvoiceTotals();
    });
  }

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

  const custSearch = document.getElementById('invoice-customer-search');
  const custSuggestions = document.getElementById('invoice-customer-suggestions');

  if (custSearch) {
    custSearch.addEventListener('input', () => {
      const val = custSearch.value.trim().toLowerCase();
      if (val === '') {
        custSuggestions.style.display = 'none';
        return;
      }
      
      const matches = state.customers.filter(c => {
        if (state.currentUser && state.currentUser.role === 'sale') {
          if (c.managedBy !== state.currentUser.username) return false;
        }
        return c.code.toLowerCase().includes(val) || 
               c.name.toLowerCase().includes(val) || 
               (c.phone && c.phone.includes(val));
      });
      
      if (matches.length === 0) {
        custSuggestions.innerHTML = `<li class="suggestion-item" style="color: var(--text-muted); cursor: default;">Không tìm thấy khách hàng</li>`;
      } else {
        custSuggestions.innerHTML = matches.map(c => `
          <li class="suggestion-item customer-suggestion-item" data-id="${c.id}" style="text-align: left; display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <div class="suggestion-info" style="text-align: left; align-items: flex-start; display: flex; flex-direction: column;">
              <span class="suggestion-code" style="font-weight: 600; color: #fff; font-size: 0.8rem;">${c.name}</span>
              <span class="suggestion-name" style="color: var(--text-secondary); font-size: 0.75rem;">SĐT: ${c.phone || 'N/A'} | Mã: ${c.code}</span>
            </div>
            <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)'}; color: ${c.assignedBrand === 'Tất cả' ? '#10b981' : '#60a5fa'}; border: 1px solid ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)'};">${c.assignedBrand}</span>
          </li>
        `).join('');
      }
      custSuggestions.style.display = 'block';
      
      document.querySelectorAll('.customer-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.getAttribute('data-id');
          selectInvoiceCustomer(id);
        });
      });
    });

    document.addEventListener('click', (e) => {
      if (!custSearch.contains(e.target) && !custSuggestions.contains(e.target)) {
        custSuggestions.style.display = 'none';
      }
    });
  }
}

function selectInvoiceCustomer(id) {
  const customer = state.customers.find(c => c.id === id);
  if (!customer) return;
  
  if (customer.assignedBrand && customer.assignedBrand !== 'Tất cả') {
    const invalidItems = state.invoiceItems.filter(item => item.brand !== customer.assignedBrand);
    if (invalidItems.length > 0) {
      const ok = confirm(`Khách hàng "${customer.name}" là đại lý nhãn sơn "${customer.assignedBrand}". Chọn khách hàng này sẽ loại bỏ ${invalidItems.length} sản phẩm khác nhãn sơn hiện có trong đơn hàng. Bạn có đồng ý không?`);
      if (!ok) {
        const activeCust = state.customers.find(c => c.id === state.activeCustomerId);
        document.getElementById('invoice-customer-search').value = activeCust ? activeCust.name : '';
        return;
      } else {
        state.invoiceItems = state.invoiceItems.filter(item => item.brand === customer.assignedBrand);
      }
    }
  }
  
  state.activeCustomerId = id;
  state.activeCustomerBrand = customer.assignedBrand;
  
  document.getElementById('invoice-customer-id').value = id;
  document.getElementById('invoice-customer-search').value = customer.name;
  
  document.getElementById('selected-customer-name-lbl').innerText = customer.name;
  document.getElementById('selected-customer-phone-lbl').innerText = customer.phone || 'N/A';
  document.getElementById('selected-customer-address-lbl').innerText = customer.address || 'N/A';
  document.getElementById('selected-customer-brand-lbl').innerText = customer.assignedBrand;
  document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(customer.debt || 0);
  document.getElementById('invoice-customer-info-card').style.display = 'block';
  
  // Set shipping support checkbox
  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck) {
    shipCheck.checked = customer.shippingSupport || false;
  }
  
  // Set default price list
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    if (customer.pricelistId) {
      plSelect.value = customer.pricelistId;
    } else {
      const isRetail = customer.assignedBrand === 'Tất cả' || customer.name.toLowerCase().includes('khách lẻ');
      plSelect.value = isRetail ? 'retail' : 'custom';
    }
  }
  
  applyActivePriceListToInvoice();
  showToast(`Đã chọn khách hàng "${customer.name}". Tự động áp chiết khấu theo bảng giá.`);
}

function resetInvoiceCustomer() {
  state.activeCustomerId = '';
  state.activeCustomerBrand = 'Tất cả';
  
  const idInput = document.getElementById('invoice-customer-id');
  if (idInput) idInput.value = '';
  
  const searchInput = document.getElementById('invoice-customer-search');
  if (searchInput) searchInput.value = '';
  
  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) infoCard.style.display = 'none';
  
  const shipCheck = document.getElementById('invoice-shipping-support');
  if (shipCheck) {
    shipCheck.checked = false;
  }
  
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    plSelect.value = 'retail';
  }
  
  applyActivePriceListToInvoice();
}

function resetInvoiceBuilder() {
  state.invoiceItems = [];
  document.getElementById('invoice-notes').value = '';
  document.getElementById('invoice-product-search').value = '';
  if (state.isQuickCustomerMode) {
    disableQuickCustomerMode();
  } else {
    resetInvoiceCustomer();
  }
  renderInvoiceTable();
  showToast('Đã làm mới bảng lên đơn!', 'warning');
}

function enableQuickCustomerMode() {
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
  
  renderInvoiceTable();
}

function disableQuickCustomerMode() {
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
  
  resetInvoiceCustomer();
}

function handleQuickCustomerBrandChange(newBrand) {
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

function addProductToInvoice() {
  if (!state.activeCustomerId && !state.isQuickCustomerMode) {
    showToast('Vui lòng tìm và chọn khách hàng trước khi thêm sản phẩm!', 'warning');
    return;
  }

  const searchInput = document.getElementById('invoice-product-search');
  const code = searchInput.value.trim().toUpperCase();
  
  if (code === '') {
    showToast('Vui lòng chọn hoặc nhập mã sản phẩm!', 'warning');
    return;
  }

  const selectedBrand = searchInput.getAttribute('data-selected-brand') || '';
  let product = null;
  if (selectedBrand) {
    product = state.products.find(p => p.code === code && p.brand === selectedBrand);
  } else {
    product = state.products.find(p => p.code === code);
  }

  if (!product) {
    showToast(`Không tìm thấy mã sản phẩm "${code}" trong danh mục!`, 'danger');
    return;
  }

  // Ràng buộc hãng sơn độc quyền của khách hàng khi nhập tay
  if (state.activeCustomerBrand && state.activeCustomerBrand !== 'Tất cả' && product.brand !== state.activeCustomerBrand) {
    showToast(`Khách hàng này là đại lý độc quyền nhãn "${state.activeCustomerBrand}". Không thể thêm sản phẩm nhãn "${product.brand}"!`, 'danger');
    return;
  }

  let defaultPackage = 'Thùng';
  let defaultPrice = product.priceThung || 0;
  if (defaultPrice === 0) {
    if ((product.priceBao || 0) > 0) {
      defaultPackage = 'Bao';
      defaultPrice = product.priceBao;
    } else if ((product.priceLon || 0) > 0) {
      defaultPackage = 'Lon';
      defaultPrice = product.priceLon;
    } else if ((product.priceHop || 0) > 0) {
      defaultPackage = 'Hộp';
      defaultPrice = product.priceHop;
    } else if ((product.priceTui || 0) > 0) {
      defaultPackage = 'Túi';
      defaultPrice = product.priceTui;
    }
  }

  const discountPercent = getActiveInvoiceDiscount(product.brand || 'Nano10*');

  state.invoiceItems.push({
    product: product,
    brand: product.brand || 'Nano10*',
    package: defaultPackage,
    colorCode: '',
    colorPercent: 0,
    quantity: 1,
    discountPercent: discountPercent,
    price: defaultPrice
  });
  showToast(`Đã thêm sản phẩm "${product.name}" vào hóa đơn!`);
  
  searchInput.value = '';
  renderInvoiceTable();
}

function isActiveCustomerRetail() {
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    return plSelect.value === 'retail';
  }
  if (state.isQuickCustomerMode) {
    const brand = document.getElementById('quick-cust-assigned-brand');
    const qName = document.getElementById('quick-cust-name');
    const brandVal = brand ? brand.value : 'Tất cả';
    const nameVal = qName ? qName.value.trim().toLowerCase() : '';
    return brandVal === 'Tất cả' || nameVal.includes('khách lẻ');
  }
  if (!state.activeCustomerId) return true;
  const cust = state.customers.find(c => c.id === state.activeCustomerId);
  if (!cust) return true;
  return cust.assignedBrand === 'Tất cả' || cust.name.toLowerCase().includes('khách lẻ');
}

function renderInvoiceTable() {
  const body = document.getElementById('invoice-items-body');
  
  if (state.invoiceItems.length === 0) {
    body.innerHTML = `
      <tr id="invoice-empty-row">
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Chưa chọn sản phẩm nào. Tìm kiếm sản phẩm ở trên để thêm vào hóa đơn.
        </td>
      </tr>
    `;
    calculateInvoiceTotals();
    return;
  }

  const isRetail = isActiveCustomerRetail();

  body.innerHTML = state.invoiceItems.map((item, idx) => {
    const marketPriceTotal = item.price * (1 + item.colorPercent / 100) * item.quantity;
    const discountAmount = marketPriceTotal * (item.discountPercent / 100);
    const finalPriceTotal = marketPriceTotal - discountAmount;

    const defaultPackages = ['Thùng', 'Lon', 'Hộp', 'Bao', 'Túi'];
    const currentPackage = item.package || 'Thùng';
    const packageOptions = [...defaultPackages];
    if (currentPackage && !packageOptions.includes(currentPackage)) {
      packageOptions.push(currentPackage);
    }
    const packageSelectOptions = packageOptions.map(pkg => 
      `<option value="${pkg}" ${currentPackage === pkg ? 'selected' : ''}>${pkg}</option>`
    ).join('');
    
    const discountColHtml = isRetail 
      ? `<input type="number" class="form-control item-discount-input" data-index="${idx}" value="${item.discountPercent}" min="0" max="100" step="any" style="width: 70px; padding: 0.15rem 0.35rem; font-size: 0.85rem; height: 24px; text-align: center; border-radius: 4px; background-color: rgba(17,24,39,0.8); border: 1px solid var(--border-color); color: var(--text-primary);">`
      : `${item.discountPercent}%`;

    return `
      <tr>
        <td style="font-weight:600; color: #fff; overflow: hidden; text-overflow: ellipsis;">${item.product.code}</td>
        <td>
          <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 0.35rem;" title="${item.product.name}">${item.product.name}</div>
          <div style="display: flex; gap: 0.35rem; align-items: center;">
            <span style="font-size: 0.75rem; color: var(--text-muted); white-space: nowrap;">Mã màu:</span>
            <input type="text" class="form-control item-color-input" data-index="${idx}" value="${item.colorCode}" placeholder="VD: 3508P" style="width: 90px; padding: 0.15rem 0.35rem; font-size: 0.75rem; height: 24px; text-align: center; border-radius: 4px; background-color: rgba(17,24,39,0.8); border: 1px solid var(--border-color); color: var(--text-primary);">
            <span style="font-size: 0.75rem; font-weight: 600; color: ${item.colorPercent > 0 ? 'var(--color-primary)' : 'var(--text-muted)'}; white-space: nowrap;" title="Tỷ lệ phụ thu màu (tự động: P: 0%, T: 15%, D: 20%, A: 25%)">
              +${item.colorPercent}%
            </span>
          </div>
        </td>
        <td>
          <select class="form-control item-package-select" data-index="${idx}" style="padding: 0.25rem; font-size: 0.8rem; width: 100%; border: 1px solid var(--border-color); background-color: rgba(17,24,39,0.8); color: var(--text-primary); border-radius: 6px;">
            ${packageSelectOptions}
          </select>
        </td>
        <td>
          <input type="number" class="form-control item-qty-input" data-index="${idx}" value="${item.quantity}" min="1" step="1" style="width: 100%; text-align: center; padding: 0.25rem; font-size: 0.85rem;">
        </td>
        <td style="text-align: center;">
          ${discountColHtml}
        </td>
        <td class="price-discounted" style="text-align: right; font-weight: 600; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${formatCurrency(finalPriceTotal)}
        </td>
        <td style="text-align: center;">
          <button class="btn btn-danger btn-sm btn-circle btn-remove-invoice-item" data-index="${idx}" title="Xóa">
            <i data-lucide="x" style="width: 14px; height: 14px;"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Register package select listener
  document.querySelectorAll('.item-package-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(sel.getAttribute('data-index'));
      const item = state.invoiceItems[idx];
      item.package = sel.value;
      
      const product = item.product;
      if (sel.value === 'Thùng') {
        item.price = product.priceThung !== undefined ? product.priceThung : 0;
      } else if (sel.value === 'Lon') {
        item.price = product.priceLon !== undefined ? product.priceLon : 0;
      } else if (sel.value === 'Hộp') {
        item.price = product.priceHop !== undefined ? product.priceHop : 0;
      } else if (sel.value === 'Bao') {
        item.price = product.priceBao !== undefined ? product.priceBao : 0;
      } else if (sel.value === 'Túi') {
        item.price = product.priceTui !== undefined ? product.priceTui : 0;
      }
      
      renderInvoiceTable();
      showToast(`Đã nạp đơn giá quy cách "${sel.value}" cho sản phẩm ${product.code}!`);
    });
  });

  // Register color code input listener (live local update)
  document.querySelectorAll('.item-color-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(input.getAttribute('data-index'));
      const val = input.value.trim();
      state.invoiceItems[idx].colorCode = val;
      state.invoiceItems[idx].colorPercent = getColorPercentFromCode(val);
      
      // Update color percent text locally in DOM
      const span = input.nextElementSibling;
      if (span) {
        span.innerText = `+${state.invoiceItems[idx].colorPercent}%`;
        span.style.color = state.invoiceItems[idx].colorPercent > 0 ? 'var(--color-primary)' : 'var(--text-muted)';
      }
      
      updateRowTotal(idx, input);
    });
  });

  // Register quantity input listener (live local update with blur correction)
  document.querySelectorAll('.item-qty-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(input.getAttribute('data-index'));
      const val = parseInt(input.value);
      state.invoiceItems[idx].quantity = isNaN(val) ? 0 : val;
      
      updateRowTotal(idx, input);
    });

    input.addEventListener('blur', (e) => {
      const idx = parseInt(input.getAttribute('data-index'));
      if (state.invoiceItems[idx].quantity < 1) {
        state.invoiceItems[idx].quantity = 1;
        input.value = 1;
      }
      updateRowTotal(idx, input);
    });
  });

  // Register price input listener (live local update)
  document.querySelectorAll('.item-price-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(input.getAttribute('data-index'));
      const val = parseFloat(input.value);
      state.invoiceItems[idx].price = isNaN(val) ? 0 : val;
      
      updateRowTotal(idx, input);
    });
  });

  // Register discount input listener for retail customers
  document.querySelectorAll('.item-discount-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(input.getAttribute('data-index'));
      const val = parseFloat(input.value);
      state.invoiceItems[idx].discountPercent = isNaN(val) ? 0 : val;
      
      updateRowTotal(idx, input);
    });
  });

  // Register remove button click listener
  document.querySelectorAll('.btn-remove-invoice-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      state.invoiceItems.splice(idx, 1);
      renderInvoiceTable();
      showToast('Đã xóa sản phẩm khỏi hóa đơn.', 'warning');
    });
  });

  calculateInvoiceTotals();
  safeCreateIcons();

  // Restore focus and cursor selection range using saved selector (mostly for initial loading or row adding)
  if (state.activeFocusedSelector) {
    const el = body.querySelector(state.activeFocusedSelector);
    if (el) {
      el.focus();
      if (state.activeSelectionStart !== undefined && state.activeSelectionStart !== null && el.type !== 'number') {
        try {
          el.setSelectionRange(state.activeSelectionStart, state.activeSelectionEnd);
        } catch (e) {
          // ignore
        }
      }
    }
    state.activeFocusedSelector = null;
    state.activeSelectionStart = null;
    state.activeSelectionEnd = null;
  }
}

function updateRowTotal(idx, el) {
  const item = state.invoiceItems[idx];
  const marketPriceTotal = item.price * (1 + item.colorPercent / 100) * item.quantity;
  const discountAmount = marketPriceTotal * (item.discountPercent / 100);
  const finalPriceTotal = marketPriceTotal - discountAmount;
  
  // Find the row containing the input element
  const row = el.closest('tr');
  if (row) {
    const priceTd = row.querySelector('.price-discounted');
    if (priceTd) {
      priceTd.innerText = formatCurrency(finalPriceTotal);
    }
  }
  
  // Update overall invoice totals
  calculateInvoiceTotals();
}

function calculateInvoiceTotals() {
  let totalQty = 0;
  let totalMarket = 0;
  let totalDiscount = 0;

  state.invoiceItems.forEach(item => {
    const qty = item.quantity;
    const price = item.price;
    const colorPct = item.colorPercent || 0;
    const discPct = item.discountPercent || 0;

    const marketSub = price * (1 + colorPct / 100) * qty;
    const discSub = marketSub * (discPct / 100);

    totalQty += qty;
    totalMarket += marketSub;
    totalDiscount += discSub;
  });

  const totalPayableBeforeShipping = totalMarket - totalDiscount;
  
  // Tính chiết khấu vận chuyển 3% nếu được chọn
  const shipCheck = document.getElementById('invoice-shipping-support');
  const isShippingSupport = shipCheck ? shipCheck.checked : false;
  
  let shippingDiscount = 0;
  if (isShippingSupport) {
    shippingDiscount = Math.round(totalPayableBeforeShipping * 0.03);
  }
  
  const finalPayable = totalPayableBeforeShipping - shippingDiscount;

  document.getElementById('summary-total-qty').innerText = totalQty;
  document.getElementById('summary-market-total').innerText = formatCurrency(totalMarket);
  document.getElementById('summary-discount-total').innerText = `-${formatCurrency(totalDiscount)}`;
  
  // Hiển thị/ẩn dòng chiết khấu vận chuyển
  const shipRow = document.getElementById('summary-shipping-discount-row');
  const shipVal = document.getElementById('summary-shipping-discount-total');
  if (shipRow && shipVal) {
    if (shippingDiscount > 0) {
      shipVal.innerText = `-${formatCurrency(shippingDiscount)}`;
      shipRow.style.display = 'flex';
    } else {
      shipRow.style.display = 'none';
    }
  }

  document.getElementById('summary-final-total').innerText = formatCurrency(finalPayable);

  const savingBadge = document.getElementById('summary-saving-badge');
  const crossedMarket = document.getElementById('summary-final-market-crossed');
  
  const totalCombinedDiscount = totalDiscount + shippingDiscount;
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

function compileActiveOrder() {
  if (state.invoiceItems.length === 0) {
    showToast('Hóa đơn chưa có sản phẩm nào! Vui lòng chọn sản phẩm.', 'danger');
    return null;
  }

  let customerId = state.activeCustomerId || null;
  let customerName = 'Khách hàng vãng lai';
  let customerPhone = '';
  let customerAddress = '';
  
  if (state.isQuickCustomerMode) {
    const qName = document.getElementById('quick-cust-name').value.trim();
    if (!qName) {
      showToast('Vui lòng nhập tên khách hàng mới!', 'danger');
      return null;
    }
    customerName = qName;
    customerPhone = document.getElementById('quick-cust-phone').value.trim();
    customerAddress = document.getElementById('quick-cust-address').value.trim();
  } else if (customerId) {
    const cust = state.customers.find(c => c.id === customerId);
    if (cust) {
      customerName = cust.name;
      customerPhone = cust.phone || '';
      customerAddress = cust.address || '';
    }
  } else {
    const searchInput = document.getElementById('invoice-customer-search');
    if (searchInput) {
      customerName = searchInput.value.trim() || 'Khách hàng vãng lai';
    }
  }

  const notes = document.getElementById('invoice-notes').value.trim() || 'Không có ghi chú';

  let totalMarket = 0;
  let totalDiscount = 0;
  let totalPayableBeforeShipping = 0;

  const itemsCopy = state.invoiceItems.map(item => {
    const itemDiscPercent = item.discountPercent || 0;
    const marketSub = item.price * (1 + item.colorPercent / 100) * item.quantity;
    const discSub = marketSub * (itemDiscPercent / 100);
    const payableSub = marketSub - discSub;

    totalMarket += marketSub;
    totalDiscount += discSub;
    totalPayableBeforeShipping += payableSub;

    return {
      product: { code: item.product.code, name: item.product.name },
      brand: item.brand,
      package: item.package,
      colorCode: item.colorCode,
      colorPercent: item.colorPercent,
      quantity: item.quantity,
      discountPercent: itemDiscPercent,
      price: item.price,
      marketSub,
      discSub,
      payableSub
    };
  });

  const shipCheck = document.getElementById('invoice-shipping-support');
  const isShippingSupport = shipCheck ? shipCheck.checked : false;
  
  let shippingDiscount = 0;
  if (isShippingSupport) {
    shippingDiscount = Math.round(totalPayableBeforeShipping * 0.03);
  }
  
  const finalPayable = totalPayableBeforeShipping - shippingDiscount;

  const plSelect = document.getElementById('invoice-pricelist-select');
  const pricelistId = plSelect ? plSelect.value : 'retail';

  const orderId = `HD-${Date.now().toString().slice(-6)}`;
  const createdBy = state.currentUser ? state.currentUser.username : 'admin';
  
  return {
    id: orderId,
    customerId,
    customerName,
    customerPhone,
    customerAddress,
    notes,
    items: itemsCopy,
    date: new Date().toISOString(),
    totalMarket,
    totalDiscount,
    shippingSupport: isShippingSupport,
    shippingDiscount,
    totalPayable: finalPayable,
    pricelistId,
    createdBy
  };
}

async function saveActiveOrder(status = 'settled') {
  let customerId = state.activeCustomerId || null;
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
    const qShippingSupport = document.getElementById('quick-cust-shipping-support').checked;
    
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
      pricelistId: 'custom',
      managedBy: state.currentUser ? state.currentUser.username : 'nhat'
    };
    
    const custSaved = await dbSaveCustomer(newCustomer);
    if (!custSaved) {
      showToast('Không thể tạo thông tin khách hàng mới. Vui lòng thử lại!', 'danger');
      return null;
    }
    state.activeCustomerId = newCustId;
    customerId = newCustId;
  }

  const order = compileActiveOrder();
  if (!order) return null;
  
  order.status = status;

  const saved = await dbSaveOrder(order);
  if (saved) {
    if (status === 'draft') {
      showToast(`Đã lưu đơn nháp ${order.id} thành công!`);
    } else {
      showToast(`Đã thanh toán và lưu đơn hàng ${order.id} thành công!`);
      
      // Update customer total transaction & debt for settled orders
      if (order.customerId) {
        const cust = state.customers.find(c => c.id === order.customerId);
        if (cust) {
          cust.totalTransaction = (cust.totalTransaction || 0) + order.totalPayable;
          cust.debt = (cust.debt || 0) + order.totalPayable;
          await dbSaveCustomer(cust);
        }
      }
    }
    
    state.invoiceItems = [];
    if (state.isQuickCustomerMode) {
      disableQuickCustomerMode();
    } else {
      resetInvoiceCustomer();
    }
    document.getElementById('invoice-notes').value = '';
    renderInvoiceTable();
    renderAll();
    
    return order;
  }
  return null;
}

function renderAndPrintOrder(order) {
  document.getElementById('print-invoice-id').innerText = order.id;
  document.getElementById('print-invoice-date').innerText = formatDateOnly(order.date);
  document.getElementById('print-customer-name').innerText = order.customerName;
  document.getElementById('print-customer-sign-name').innerText = order.customerName;
  document.getElementById('print-invoice-notes').innerText = order.notes;

  const uniqueBrands = [...new Set(order.items.map(item => item.brand).filter(Boolean))];
  const brandsText = uniqueBrands.length > 0 ? uniqueBrands.join(', ') : 'N/A';
  const printOrderBrandEl = document.getElementById('print-order-brand');
  if (printOrderBrandEl) {
    printOrderBrandEl.innerText = brandsText;
  }

  const customerInfoDiv = document.getElementById('print-customer-info-extra');
  if (customerInfoDiv) {
    let extraHtml = '';
    if (order.customerPhone) {
      extraHtml += `<p style="margin: 3px 0 0 0;"><strong>Điện thoại:</strong> ${order.customerPhone}</p>`;
    }
    if (order.customerAddress) {
      extraHtml += `<p style="margin: 3px 0 0 0;"><strong>Địa chỉ:</strong> ${order.customerAddress}</p>`;
    }
    customerInfoDiv.innerHTML = extraHtml;
  }

  const printItemsBody = document.getElementById('print-invoice-items-body');
  printItemsBody.innerHTML = order.items.map((item, idx) => {
    const unitPrice = item.price || 0;
    const colorPct = item.colorPercent || 0;
    const unitPriceWithColor = unitPrice * (1 + colorPct / 100);
    const rowMarketSub = unitPriceWithColor * item.quantity;
    const discPct = item.discountPercent || 0;
    const rowPayableSub = item.payableSub !== undefined ? item.payableSub : (rowMarketSub * (1 - discPct / 100));
    
    const colorCodeHtml = (item.colorCode && item.colorCode.trim() !== '') 
      ? `<div style="font-size: 8.5pt; color: #555; font-weight: normal; margin-top: 3px; font-style: italic;">Mã màu: ${item.colorCode} (${colorPct > 0 ? '+' + colorPct + '%' : '0%'})</div>` 
      : '';
      
    const brandHtml = item.brand 
      ? `<div style="font-size: 8.5pt; color: #666; font-weight: normal; margin-top: 2px;">Hãng sơn: ${item.brand}</div>` 
      : '';
    
    return `
      <tr>
        <td class="print-text-center">${idx + 1}</td>
        <td class="print-text-center"><strong>${item.product.code}</strong></td>
        <td>
          <div style="font-weight:bold; line-height: 1.3;">${item.product.name}</div>
          ${brandHtml}
          ${colorCodeHtml}
        </td>
        <td class="print-text-center">${item.package || 'Thùng'}</td>
        <td class="print-text-center">${item.quantity}</td>
        <td class="print-text-right">${formatCurrency(unitPriceWithColor)}</td>
        <td class="print-text-center" style="font-weight:500;">${discPct}%</td>
        <td class="print-text-right" style="font-weight:bold;">${formatCurrency(rowPayableSub)}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('print-total-market').innerText = formatCurrency(order.totalMarket);
  document.getElementById('print-total-discount').innerText = `-${formatCurrency(order.totalDiscount)}`;
  
  const printShipRow = document.getElementById('print-shipping-discount-row');
  const printShipVal = document.getElementById('print-shipping-discount');
  if (printShipRow && printShipVal) {
    if (order.shippingDiscount && order.shippingDiscount > 0) {
      printShipVal.innerText = `-${formatCurrency(order.shippingDiscount)}`;
      printShipRow.style.display = 'flex';
    } else {
      printShipRow.style.display = 'none';
    }
  }

  document.getElementById('print-total-payable').innerText = formatCurrency(order.totalPayable);

  const totalCombinedDiscount = (order.totalDiscount || 0) + (order.shippingDiscount || 0);
  const discountPercent = (order.totalMarket > 0) ? Math.round((totalCombinedDiscount / order.totalMarket) * 100) : 0;
  const discountLabel = document.getElementById('print-discount-label');
  if (discountLabel) {
    if (discountPercent > 0) {
      discountLabel.innerText = `Tổng tiền chiết khấu (~${discountPercent}%):`;
    } else {
      discountLabel.innerText = `Tổng tiền chiết khấu:`;
    }
  }

  setTimeout(() => {
    window.print();
  }, 350);
}

function printOrderById(orderId) {
  const order = state.savedOrders.find(o => o.id === orderId);
  if (!order) {
    showToast(`Không tìm thấy đơn hàng "${orderId}"!`, 'danger');
    return;
  }
  renderAndPrintOrder(order);
}


// --- History Panel ---
function setupHistoryPanel() {
  document.getElementById('history-search-input').addEventListener('input', renderHistoryOrders);
  
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (state.savedOrders.length === 0) {
      showToast('Lịch sử đơn hàng trống!', 'warning');
      return;
    }
    
    if (confirm('CẢNH BÁO: Bạn có muốn xóa toàn bộ lịch sử đơn hàng không? Hành động này không thể hoàn tác.')) {
      const cleared = await dbDeleteAllOrders();
      if (cleared) {
        renderAll();
        showToast('Đã xóa toàn bộ lịch sử hóa đơn!', 'warning');
      }
    }
  });
}

function renderHistoryOrders() {
  const container = document.getElementById('history-orders-container');
  const searchVal = document.getElementById('history-search-input').value.toLowerCase().trim();

  const filtered = state.savedOrders.filter(o => {
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (o.createdBy !== state.currentUser.username) return false;
    }
    return o.id.toLowerCase().includes(searchVal) || o.customerName.toLowerCase().includes(searchVal);
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i data-lucide="clipboard-list"></i>
        <div class="empty-state-title">Không tìm thấy hóa đơn nào</div>
        <div class="empty-state-desc">Thử tìm bằng từ khóa khác hoặc tạo đơn hàng mới trên hệ thống.</div>
      </div>
    `;
    safeCreateIcons();
    return;
  }

  const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));

  container.innerHTML = sorted.map(order => {
    const totalItemsCount = order.items.reduce((sum, item) => sum + Number(item.quantity), 0);
    const statusClass = order.status === 'draft' ? 'status-draft' : 'status-settled';
    const statusBadge = order.status === 'draft' ? 
      `<span style="background: var(--color-danger-light); color: var(--color-danger); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đơn nháp</span>` : 
      `<span style="background: var(--color-primary-light); color: var(--color-primary); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã chốt</span>`;
      
    return `
      <div class="invoice-card ${statusClass}" data-id="${order.id}">
        <div class="invoice-card-header">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <div class="invoice-card-id">${order.id}</div>
            ${statusBadge}
          </div>
          <div class="invoice-card-date">${formatDateTime(order.date)}</div>
        </div>
        <div class="invoice-card-details">
          <div><strong style="color: #fff;">Khách hàng:</strong> ${order.customerName}</div>
          <div><strong style="color: #fff;">Số lượng SP:</strong> ${totalItemsCount} sản phẩm</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; overflow: hidden;" title="${order.notes}">
            <strong>Ghi chú:</strong> ${order.notes}
          </div>
        </div>
        <div class="invoice-card-totals">
          <span class="invoice-card-total-lbl">Thanh toán:</span>
          <span class="invoice-card-total-val">${formatCurrency(order.totalPayable)}</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.25rem;">
          <button class="btn btn-indigo btn-sm history-print-btn" data-id="${order.id}">
            <i data-lucide="printer" style="width: 13px; height: 13px;"></i> In lại
          </button>
          <button class="btn btn-secondary btn-sm history-load-btn" data-id="${order.id}">
            <i data-lucide="edit" style="width: 13px; height: 13px;"></i> Nạp lại
          </button>
        </div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.history-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      printOrderById(id);
    });
  });

  document.querySelectorAll('.history-load-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      loadOrderToInvoiceBuilder(id);
    });
  });

  document.querySelectorAll('.invoice-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
        const id = card.getAttribute('data-id');
        loadOrderToInvoiceBuilder(id);
      }
    });
  });

  safeCreateIcons();
}

function loadOrderToInvoiceBuilder(orderId) {
  const order = state.savedOrders.find(o => o.id === orderId);
  if (!order) return;

  if (confirm(`Bạn có muốn nạp đơn hàng "${orderId}" của khách "${order.customerName}" vào trang lên đơn hiện tại không? (Lưu ý: Thao tác này sẽ ghi đè hóa đơn đang soạn thảo)`)) {
    
    // Find customer by ID or name
    const customer = state.customers.find(c => (order.customerId && c.id === order.customerId) || c.name === order.customerName);
    if (customer) {
      selectInvoiceCustomer(customer.id);
    } else {
      resetInvoiceCustomer();
      const searchInput = document.getElementById('invoice-customer-search');
      if (searchInput) searchInput.value = order.customerName;
    }
    
    document.getElementById('invoice-notes').value = order.notes || '';
    
    // Set shipping support checkbox from loaded order
    const shipCheck = document.getElementById('invoice-shipping-support');
    if (shipCheck) {
      shipCheck.checked = order.shippingSupport || false;
    }

    state.invoiceItems = order.items.map(item => {
      const currentProduct = state.products.find(p => p.code === item.product.code && p.brand === item.brand) || item.product;
      return {
        product: currentProduct,
        brand: item.brand || 'Nano10*',
        package: item.package || 'Thùng',
        colorCode: item.colorCode || '',
        colorPercent: item.colorPercent !== undefined ? item.colorPercent : 0,
        quantity: item.quantity,
        discountPercent: item.discountPercent !== undefined ? item.discountPercent : 0,
        price: item.price !== undefined ? item.price : 0
      };
    });

    renderInvoiceTable();
    switchTab('invoice-panel');
    showToast(`Đã nạp đơn hàng ${orderId} vào trang lên đơn!`);
  }
}

// --- Excel Import & Export Template Logic ---
function setupExcelImportAndTemplate() {
  const excelModal = document.getElementById('excel-modal');
  const openImportBtn = document.getElementById('btn-open-excel-modal');
  const closeImportBtn = document.getElementById('btn-close-excel-modal');
  const cancelImportBtn = document.getElementById('btn-cancel-excel');
  const templateDownloadBtn = document.getElementById('btn-download-excel-template');
  const saveImportBtn = document.getElementById('btn-save-excel-submit');
  
  const dropzone = document.getElementById('excel-dropzone');
  const fileInput = document.getElementById('excel-file-input');
  const browseBtn = document.getElementById('btn-browse-excel');

  openImportBtn.addEventListener('click', () => {
    excelImportData = [];
    document.getElementById('excel-preview-container').style.display = 'none';
    document.getElementById('excel-preview-table-body').innerHTML = '';
    saveImportBtn.setAttribute('disabled', 'true');
    fileInput.value = '';
    
    excelModal.classList.add('active');
  });

  const closeModal = () => excelModal.classList.remove('active');
  closeImportBtn.addEventListener('click', closeModal);
  cancelImportBtn.addEventListener('click', closeModal);

  templateDownloadBtn.addEventListener('click', downloadExcelTemplate);

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleExcelFile(e.target.files[0]);
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleExcelFile(e.dataTransfer.files[0]);
    }
  });

  saveImportBtn.addEventListener('click', async () => {
    if (excelImportData.length === 0) return;
    
    const importMode = document.querySelector('input[name="import-mode"]:checked').value;
    
    if (importMode === 'overwrite') {
      if (confirm('Bạn có chắc chắn muốn ghi đè toàn bộ danh sách sản phẩm hiện tại? Hành động này sẽ xóa sạch danh sách cũ.')) {
        if (isCloudActive && supabaseClient) {
          try {
            updateDbStatusUI('connecting');
            const { error: delErr } = await supabaseClient.from(tableProductsName).delete().neq('code', 'TEMP_NONE');
            if (delErr) throw delErr;
            
            const dbRows = excelImportData.map(p => ({
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
            
            const { error: insErr } = await supabaseClient.from(tableProductsName).insert(dbRows);
            if (insErr) {
              if (insErr.message && (insErr.message.includes('column') || insErr.message.includes('not exist') || insErr.code === '42703')) {
                const fallbackRows = excelImportData.map(p => ({
                  code: p.code,
                  name: p.name,
                  price: p.priceThung || 0
                }));
                const { error: fallbackErr } = await supabaseClient.from(tableProductsName).insert(fallbackRows);
                if (fallbackErr) throw fallbackErr;
                showToast(`Đã ghi đè mới ${excelImportData.length} sản phẩm lên Cloud (không có hãng sơn/quy cách do thiếu cột ở Supabase).`, 'warning');
              } else {
                throw insErr;
              }
            } else {
              showToast(`Đã ghi đè mới ${excelImportData.length} sản phẩm lên Cloud thành công!`);
            }
            
            // Mirror to localStorage first
            state.products = [...excelImportData];
            localStorage.setItem('billing_system_products', JSON.stringify(state.products));
            
            await fetchCloudData();
            updateDbStatusUI('cloud');
            closeModal();
            renderAll();
          } catch(err) {
            console.error(err);
            showToast('Lỗi ghi đè sản phẩm lên Cloud: ' + err.message, 'danger');
            updateDbStatusUI('cloud');
          }
        } else {
          state.products = [...excelImportData];
          localStorage.setItem('billing_system_products', JSON.stringify(state.products));
          showToast(`Đã nhập mới ${excelImportData.length} sản phẩm cục bộ thành công!`);
          closeModal();
          renderAll();
        }
      }
    } else {
      // Merge mode
      if (isCloudActive && supabaseClient) {
        try {
          updateDbStatusUI('connecting');
          const dbRows = excelImportData.map(p => ({
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
          
          let { error } = await supabaseClient.from(tableProductsName).upsert(dbRows, { onConflict: 'code,brand' });
          if (error && (error.code === '42P10' || error.message.includes('constraint'))) {
            const fallbackRows = excelImportData.map(p => ({
              code: p.code,
              name: p.name,
              price: p.priceThung || 0
            }));
            const fallbackRes = await supabaseClient.from(tableProductsName).upsert(fallbackRows, { onConflict: 'code' });
            error = fallbackRes.error;
          }
          if (error) {
            throw error;
          } else {
            showToast(`Đã gộp thành công ${excelImportData.length} sản phẩm lên đám mây Supabase!`);
          }
          
          // Mirror to localStorage first
          excelImportData.forEach(item => {
            const existingIdx = state.products.findIndex(p => p.code === item.code && p.brand === item.brand);
            if (existingIdx > -1) {
              state.products[existingIdx] = item;
            } else {
              state.products.push(item);
            }
          });
          localStorage.setItem('billing_system_products', JSON.stringify(state.products));
          
          await fetchCloudData();
          updateDbStatusUI('cloud');
          closeModal();
          renderAll();
        } catch(err) {
          console.error(err);
          showToast('Lỗi gộp sản phẩm lên Cloud: ' + err.message, 'danger');
          updateDbStatusUI('cloud');
        }
      } else {
        let added = 0;
        let updated = 0;
        
        excelImportData.forEach(item => {
          const existingIdx = state.products.findIndex(p => p.code === item.code && p.brand === item.brand);
          if (existingIdx > -1) {
            state.products[existingIdx] = item;
            updated++;
          } else {
            state.products.push(item);
            added++;
          }
        });
        
        localStorage.setItem('billing_system_products', JSON.stringify(state.products));
        showToast(`Đã gộp thành công! Thêm mới: ${added}, Cập nhật: ${updated}.`);
        closeModal();
        renderAll();
      }
    }
  });
}

function handleExcelFile(file) {
  const saveImportBtn = document.getElementById('btn-save-excel-submit');
  const reader = new FileReader();
  
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      if (jsonData.length < 2) {
        showToast("Tệp Excel trống hoặc không đúng định dạng cột mẫu!", "danger");
        return;
      }
      
      excelImportData = [];
      const rows = jsonData.slice(1); // skip headers
      let skipErrorsCount = 0;

      rows.forEach((row, index) => {
        if (row.length === 0 || !row[0]) return; // Skip empty row

        const code = String(row[0]).trim().toUpperCase();
        const name = row[1] ? String(row[1]).trim() : '';
        const brand = row[2] ? String(row[2]).trim() : 'Nano10*';
        const priceThung = row[3] ? parseFloat(row[3]) : 0;
        const priceLon = row[4] ? parseFloat(row[4]) : 0;
        const priceHop = row[5] ? parseFloat(row[5]) : 0;
        const priceBao = row[6] ? parseFloat(row[6]) : 0;
        const priceTui = row[7] ? parseFloat(row[7]) : 0;

        if (!code || !name) {
          skipErrorsCount++;
          return;
        }

        excelImportData.push({ 
          code, 
          name, 
          brand, 
          priceThung: isNaN(priceThung) ? 0 : priceThung,
          priceLon: isNaN(priceLon) ? 0 : priceLon,
          priceHop: isNaN(priceHop) ? 0 : priceHop,
          priceBao: isNaN(priceBao) ? 0 : priceBao,
          priceTui: isNaN(priceTui) ? 0 : priceTui
        });
      });

      // Loại bỏ các mã sản phẩm trùng lặp trong file Excel để tránh lỗi SQL
      const uniqueData = [];
      const seenCodes = new Set();
      let duplicateCount = 0;
      excelImportData.forEach(item => {
        if (!seenCodes.has(item.code)) {
          seenCodes.add(item.code);
          uniqueData.push(item);
        } else {
          duplicateCount++;
        }
      });
      excelImportData = uniqueData;

      if (excelImportData.length === 0) {
        showToast("Không phân tích được dòng sản phẩm hợp lệ nào. Vui lòng kiểm tra lại file mẫu!", "danger");
        saveImportBtn.setAttribute('disabled', 'true');
        return;
      }

      // Render Preview Table (STT, Mã SP, Tên sản phẩm, Hãng sơn, Giá Thùng, Giá Lon, Giá Hộp, Giá Bao, Giá Túi)
      const previewBody = document.getElementById('excel-preview-table-body');
      previewBody.innerHTML = excelImportData.map((item, idx) => `
        <tr>
          <td style="text-align: center; color: var(--text-muted); font-weight: 500;">${idx + 1}</td>
          <td style="font-weight:600; color:#fff;">${item.code}</td>
          <td>${item.name}</td>
          <td>${item.brand || 'Khác'}</td>
          <td style="text-align: right; color: var(--color-primary); font-weight: 600;">${formatCurrency(item.priceThung || 0)}</td>
          <td style="text-align: right; color: var(--color-primary); font-weight: 600;">${formatCurrency(item.priceLon || 0)}</td>
          <td style="text-align: right; color: var(--color-primary); font-weight: 600;">${formatCurrency(item.priceHop || 0)}</td>
          <td style="text-align: right; color: var(--color-primary); font-weight: 600;">${formatCurrency(item.priceBao || 0)}</td>
          <td style="text-align: right; color: var(--color-primary); font-weight: 600;">${formatCurrency(item.priceTui || 0)}</td>
        </tr>
      `).join('');

      document.getElementById('excel-preview-container').style.display = 'block';
      document.getElementById('excel-preview-summary').innerText = `Tìm thấy ${excelImportData.length} sản phẩm hợp lệ.${skipErrorsCount > 0 ? ` Bỏ qua ${skipErrorsCount} dòng lỗi.` : ''}${duplicateCount > 0 ? ` Bỏ qua ${duplicateCount} sản phẩm trùng mã trong file.` : ''}`;
      
      saveImportBtn.removeAttribute('disabled');
      showToast(`Tải file thành công! Vui lòng kiểm tra dữ liệu xem trước.`);
      
    } catch(err) {
      console.error(err);
      showToast("Không thể đọc tệp Excel này. Vui lòng kiểm tra định dạng!", "danger");
      saveImportBtn.setAttribute('disabled', 'true');
    }
  };
  
  reader.readAsArrayBuffer(file);
}

function downloadExcelTemplate() {
  const headers = [
    ['Mã SP', 'Tên sản phẩm', 'Hãng sơn', 'Giá Thùng', 'Giá Lon', 'Giá Hộp', 'Giá Bao', 'Giá Túi']
  ];
  
  const sampleRows = [
    ['SP001', 'Sơn bóng ngoại thất WeatherShield', 'Nano10*', 1250000, 380000, 120000, 0, 0],
    ['SP006', 'Bột bả tường cao cấp Nano10*', 'Nano10*', 0, 0, 0, 280000, 60000],
    ['SP007', 'Chống thấm chuyên dụng Sika Latex', 'Hatacco nano', 850000, 250000, 0, 0, 75000]
  ];

  const sheetData = headers.concat(sampleRows);
  
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  
  ws['!cols'] = [
    { wch: 15 }, // Mã SP
    { wch: 45 }, // Tên sản phẩm
    { wch: 15 }, // Hãng sơn
    { wch: 15 }, // Giá Thùng
    { wch: 15 }, // Giá Lon
    { wch: 15 }, // Giá Hộp
    { wch: 15 }, // Giá Bao
    { wch: 15 }  // Giá Túi
  ];
  
  XLSX.utils.book_append_sheet(wb, ws, "Danh Sach San Pham");
  XLSX.writeFile(wb, "Mau_Danh_Sach_San_Pham.xlsx");
  showToast("Đã tải xuống file Excel mẫu thành công!");
}

// --- Authentication & Role-Based Access Control ---

async function handleLogin(e) {
  e.preventDefault();
  const usernameInput = document.getElementById('login-username').value.trim().toLowerCase();
  const passwordInput = document.getElementById('login-password').value.trim();

  // Find user in state
  const user = state.users.find(u => u.username === usernameInput && u.password === passwordInput);
  if (user) {
    state.currentUser = user;
    sessionStorage.setItem('billing_system_auth', 'true');
    sessionStorage.setItem('billing_system_username', user.username);
    
    // Hide login screen and show app layout
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-layout').classList.remove('auth-hidden');
    
    // Show header info & logout button
    document.getElementById('user-info-header').style.display = 'flex';
    document.getElementById('btn-logout').style.display = 'inline-flex';
    document.getElementById('header-user-display').innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
    
    // Apply role-based visibility permissions
    applyUserPermissions(user);
    
    // Re-render components with filtered data
    renderAll();
    
    showToast(`Chào mừng ${user.displayName} quay trở lại!`, 'success');
  } else {
    showToast('Tên đăng nhập hoặc mật khẩu không chính xác!', 'danger');
  }
}

function handleLogout() {
  sessionStorage.removeItem('billing_system_auth');
  sessionStorage.removeItem('billing_system_username');
  state.currentUser = null;
  location.reload();
}

function showLoginGate() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-layout').classList.add('auth-hidden');
  document.getElementById('user-info-header').style.display = 'none';
  document.getElementById('btn-logout').style.display = 'none';
}

function applyUserPermissions(user) {
  if (!user) return;
  const role = user.role;

  // Toggle nav links visibility
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    const target = link.getAttribute('data-target');
    const navItem = link.parentElement;
    
    if (role === 'sale') {
      // Sale: Only allow 'invoice-panel' and 'customers-panel'
      if (target === 'invoice-panel' || target === 'customers-panel') {
        navItem.style.display = 'block';
      } else {
        navItem.style.display = 'none';
      }
    } else if (role === 'accounting') {
      // Accountant: Allow everything except 'settings-panel' (Db config) and 'users-panel'
      if (target === 'settings-panel' || target === 'users-panel') {
        navItem.style.display = 'none';
      } else {
        navItem.style.display = 'block';
      }
    } else {
      // Admin: Allow everything
      navItem.style.display = 'block';
    }
  });

  // If sale, auto switch tab to invoice-panel
  if (role === 'sale') {
    switchTab('invoice-panel');
  }

  // Populate "managed-by" dropdown in customer modal
  populateManagedByDropdown();

  // Hide/Show "managed-by" field in customer modal based on role
  const managedBySection = document.getElementById('cust-managed-by-section');
  if (managedBySection) {
    if (role === 'sale') {
      managedBySection.style.display = 'none'; // Sale doesn't see or assign this field
    } else {
      managedBySection.style.display = 'block';
    }
  }

  // Adjust delete buttons visibility globally
  const styleTagId = 'role-based-css-rules';
  let styleTag = document.getElementById(styleTagId);
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = styleTagId;
    document.head.appendChild(styleTag);
  }

  if (role === 'sale') {
    styleTag.innerHTML = `
      .delete-cust-btn, .edit-cust-btn { display: none !important; }
      #btn-open-add-product-modal, .edit-product-btn, .delete-product-btn { display: none !important; }
      .delete-order-btn { display: none !important; }
    `;
  } else if (role === 'accounting') {
    styleTag.innerHTML = `
      .delete-cust-btn { display: inline-flex !important; }
      .edit-cust-btn { display: inline-flex !important; }
      #btn-open-add-product-modal, .edit-product-btn, .delete-product-btn { display: none !important; }
      .delete-order-btn { display: none !important; }
    `;
  } else {
    styleTag.innerHTML = `
      .delete-cust-btn, .edit-cust-btn { display: inline-flex !important; }
      #btn-open-add-product-modal, .edit-product-btn, .delete-product-btn { display: inline-flex !important; }
      .delete-order-btn { display: inline-flex !important; }
    `;
  }
}

function populateManagedByDropdown() {
  const select = document.getElementById('cust-managed-by');
  if (!select) return;
  
  // Populate with all users
  select.innerHTML = state.users.map(u => `
    <option value="${u.username}">${u.displayName} (${u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale'})</option>
  `).join('');
}

// --- User Management Logic ---
function setupUserManagement() {
  const addBtn = document.getElementById('btn-open-add-user-modal');
  const closeBtn = document.getElementById('btn-close-user-modal');
  const cancelBtn = document.getElementById('btn-cancel-user');
  const userForm = document.getElementById('user-form');
  const searchInput = document.getElementById('user-search-input');
  
  if (addBtn) addBtn.addEventListener('click', () => openUserModal());
  if (closeBtn) closeBtn.addEventListener('click', closeUserModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeUserModal);
  
  if (userForm) {
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveUser();
    });
  }
  
  if (searchInput) {
    searchInput.addEventListener('input', renderUsersTable);
  }
}

function openUserModal(userId = '') {
  const modal = document.getElementById('user-modal');
  const title = document.getElementById('user-modal-title');
  const form = document.getElementById('user-form');
  const usernameInput = document.getElementById('user-username');
  const passwordInput = document.getElementById('user-password');
  const passwordHelp = document.getElementById('user-password-help');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();
  
  if (!userId) {
    title.innerText = 'Thêm tài khoản mới';
    document.getElementById('user-edit-id').value = '';
    usernameInput.removeAttribute('disabled');
    passwordInput.setAttribute('required', 'true');
    passwordHelp.style.display = 'none';
  } else {
    title.innerText = 'Chỉnh sửa tài khoản';
    document.getElementById('user-edit-id').value = userId;
    
    const user = state.users.find(u => u.id === userId);
    if (user) {
      usernameInput.value = user.username;
      usernameInput.removeAttribute('disabled'); // Allow editing of username
      document.getElementById('user-displayname').value = user.displayName;
      document.getElementById('user-role').value = user.role;
      passwordInput.value = '';
      passwordInput.removeAttribute('required');
      passwordHelp.style.display = 'block';
    }
  }
}

function closeUserModal() {
  const modal = document.getElementById('user-modal');
  if (modal) modal.classList.remove('active');
}

async function saveUser() {
  const editId = document.getElementById('user-edit-id').value;
  const username = document.getElementById('user-username').value.trim().toLowerCase();
  const displayName = document.getElementById('user-displayname').value.trim();
  const password = document.getElementById('user-password').value.trim();
  const role = document.getElementById('user-role').value;
  
  if (!username || !displayName) {
    showToast('Tên đăng nhập và Tên hiển thị là bắt buộc!', 'danger');
    return;
  }
  
  let user;
  if (!editId) {
    // Adding new user
    // Check if username already exists
    const exists = state.users.some(u => u.username === username);
    if (exists) {
      showToast('Tên đăng nhập đã tồn tại trong hệ thống!', 'danger');
      return;
    }
    if (!password) {
      showToast('Mật khẩu là bắt buộc cho tài khoản mới!', 'danger');
      return;
    }
    
    user = {
      id: 'u-' + Date.now(),
      username,
      displayName,
      password,
      role
    };
  } else {
    // Editing user
    const existingUser = state.users.find(u => u.id === editId);
    if (!existingUser) return;
    
    // Check if new username conflicts with another user's username
    const exists = state.users.some(u => u.username === username && u.id !== editId);
    if (exists) {
      showToast('Tên đăng nhập đã tồn tại trong hệ thống!', 'danger');
      return;
    }
    
    user = {
      ...existingUser,
      username,
      displayName,
      role
    };
    if (password) {
      user.password = password;
    }
  }
  
  const saved = await dbSaveUser(user);
  if (saved) {
    // If the saved user is the currently logged-in user, update header, session & role dynamically
    if (state.currentUser && state.currentUser.id === user.id) {
      state.currentUser = user;
      sessionStorage.setItem('billing_system_username', user.username); // Keep session in sync
      document.getElementById('header-user-display').innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
      applyUserPermissions(user);
    }
    
    closeUserModal();
    renderAll();
    showToast('Lưu thông tin tài khoản thành công!', 'success');
  }
}

async function deleteUser(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (state.currentUser && state.currentUser.id === userId) {
    showToast('Không thể tự xóa tài khoản của chính bạn đang đăng nhập!', 'danger');
    return;
  }
  
  if (user.username === 'admin' || user.username === 'nhat') {
    if (state.users.filter(u => u.role === 'admin').length <= 1) {
      showToast('Phải giữ lại ít nhất một tài khoản Admin hệ thống!', 'danger');
      return;
    }
  }
  
  if (confirm(`Bạn có chắc chắn muốn xóa tài khoản "${user.displayName}" (${user.username})?`)) {
    const deleted = await dbDeleteUser(userId);
    if (deleted) {
      renderAll();
      showToast('Xóa tài khoản thành công!', 'warning');
    }
  }
}

function renderUsersTable() {
  const tableBody = document.getElementById('users-table-body');
  if (!tableBody) return;
  
  const searchVal = document.getElementById('user-search-input').value.toLowerCase().trim();
  
  const filtered = state.users.filter(u => {
    return u.username.toLowerCase().includes(searchVal) || 
           u.displayName.toLowerCase().includes(searchVal);
  });
  
  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không tìm thấy tài khoản người dùng nào
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = filtered.map((u, index) => {
    const roleText = u.role === 'admin' ? 'Admin (Toàn quyền)' : 
                     u.role === 'accounting' ? 'Kế toán' : 'Sale (Kinh doanh)';
    const roleColor = u.role === 'admin' ? 'var(--color-danger)' : 
                      u.role === 'accounting' ? 'var(--color-secondary)' : 'var(--color-primary)';
                      
    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${index + 1}</td>
        <td style="font-weight: 600; color: #fff;">${u.username}</td>
        <td>${u.displayName}</td>
        <td>
          <span style="color: ${roleColor}; font-weight: 500;">${roleText}</span>
        </td>
        <td style="text-align: center;">
          <div style="display: inline-flex; gap: 0.5rem; justify-content: center;">
            <button class="btn btn-secondary btn-sm btn-circle edit-user-btn" data-id="${u.id}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-user-btn" data-id="${u.id}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  document.querySelectorAll('.edit-user-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      openUserModal(id);
    });
  });
  
  document.querySelectorAll('.delete-user-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      deleteUser(id);
    });
  });
  
  safeCreateIcons();
}

async function dbSaveUser(user) {
  if (isCloudActive && supabaseClient) {
    try {
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
      
      const idx = state.users.findIndex(u => u.id === user.id);
      if (idx !== -1) {
        state.users[idx] = user;
      } else {
        state.users.push(user);
      }
      localStorage.setItem('billing_system_users', JSON.stringify(state.users));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể lưu người dùng trên đám mây: ' + err.message, 'danger');
      return false;
    }
  } else {
    const idx = state.users.findIndex(u => u.id === user.id);
    if (idx !== -1) {
      state.users[idx] = user;
    } else {
      state.users.push(user);
    }
    localStorage.setItem('billing_system_users', JSON.stringify(state.users));
    return true;
  }
}

async function dbDeleteUser(id) {
  if (isCloudActive && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from(tableUsersName)
        .delete()
        .eq('id', id);
        
      if (error) throw error;
      
      state.users = state.users.filter(u => u.id !== id);
      localStorage.setItem('billing_system_users', JSON.stringify(state.users));
      return true;
    } catch(err) {
      console.error(err);
      showToast('Không thể xóa người dùng trên đám mây: ' + err.message, 'danger');
      return false;
    }
  } else {
    state.users = state.users.filter(u => u.id !== id);
    localStorage.setItem('billing_system_users', JSON.stringify(state.users));
    return true;
  }
}

function populateCustomerEmployeeFilter() {
  const select = document.getElementById('customer-managed-filter');
  const wrapper = document.getElementById('cust-managed-filter-wrapper');
  if (!select) return;
  
  if (state.currentUser && state.currentUser.role === 'sale') {
    if (wrapper) wrapper.style.display = 'none';
    return;
  } else {
    if (wrapper) wrapper.style.display = 'block';
  }
  
  const currentVal = select.value;
  
  select.innerHTML = `
    <option value="">-- Tất cả nhân viên --</option>
    ${state.users.map(u => `
      <option value="${u.username}">${u.displayName} (${u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale'})</option>
    `).join('')}
  `;
  
  select.value = currentVal;
}

// --- Debt Payment Logic ---
function openPayDebtModal(customerIndex) {
  const modal = document.getElementById('pay-debt-modal');
  const form = document.getElementById('pay-debt-form');
  const cust = state.customers[customerIndex];
  if (!modal || !cust) return;
  
  modal.classList.add('active');
  form.reset();
  
  document.getElementById('pay-debt-customer-id').value = cust.id;
  document.getElementById('pay-debt-cust-name').innerText = `${cust.name} (${cust.code})`;
  document.getElementById('pay-debt-cust-current-debt').innerText = formatCurrency(cust.debt);
}

function closePayDebtModal() {
  const modal = document.getElementById('pay-debt-modal');
  if (modal) modal.classList.remove('active');
}

async function handlePayDebtSubmit(e) {
  e.preventDefault();
  const customerId = document.getElementById('pay-debt-customer-id').value;
  const amountPaid = parseFloat(document.getElementById('pay-debt-amount').value);
  const notes = document.getElementById('pay-debt-notes').value.trim() || 'Thu nợ khách hàng';
  
  if (!customerId || isNaN(amountPaid) || amountPaid <= 0) {
    showToast('Số tiền trả không hợp lệ!', 'danger');
    return;
  }
  
  const cust = state.customers.find(c => c.id === customerId);
  if (!cust) return;
  
  if (amountPaid > cust.debt) {
    if (!confirm(`Số tiền khách trả (${formatCurrency(amountPaid)}) lớn hơn số công nợ hiện tại (${formatCurrency(cust.debt)}). Bạn có muốn tiếp tục?`)) {
      return;
    }
  }
  
  cust.debt = Math.max(0, cust.debt - amountPaid);
  
  const saved = await dbSaveCustomer(cust);
  if (saved) {
    closePayDebtModal();
    renderAll();
    showToast(`Đã thu nợ ${formatCurrency(amountPaid)} từ khách hàng ${cust.name}!`, 'success');
  }
}
