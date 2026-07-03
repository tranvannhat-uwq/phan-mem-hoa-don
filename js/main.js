import { state } from './state.js';
import { defaultProducts } from './config.js';
import { connectSupabase, disconnectSupabase, retrySupabaseConnection, syncLocalToCloud, isCloudActive, supabaseClient } from './services/supabase.js';
import { setupBackupRestoreListeners } from './services/backup.js';
import { updateDashboardStats, setupDashboardFilters, setupDashboardQuickActions } from './components/dashboard.js';
import { renderProductsTable, setupExcelImportAndTemplate, setupProductManagement } from './components/products.js';
import { renderCustomersTable, setupCustomerManagement, populateManagedByDropdown } from './components/customers.js';
import { renderInvoiceTable, setupInvoiceCreator, resetInvoiceBuilder, resetInvoiceCustomer } from './components/invoice.js';
import { renderPricelistsTable, setupPricelistManagement, populatePricelistsDropdowns } from './components/pricelists.js';
import { renderUsersTable, setupUserManagement, handleLogin, handleLogout, showLoginGate, applyUserPermissions, populateCustomerEmployeeFilter } from './components/users.js';
import { setupHistoryPanel, renderHistoryOrders } from './components/history.js';
import { showToast, safeCreateIcons, updateDbStatusUI } from './utils.js';

// Vẽ lại toàn bộ giao diện của tất cả các Tab
export function renderAll() {
  updateDashboardStats();
  renderProductsTable();
  renderCustomersTable();
  renderInvoiceTable();
  renderPricelistsTable();
  renderHistoryOrders();
  renderUsersTable();
  populateCustomerEmployeeFilter();
  safeCreateIcons();
}

// Chuyển đổi giữa các phân hệ (Tab)
export function switchTab(panelId) {
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

// Trình quản lý thanh điều hướng
function setupNavigation() {
  if (window.innerWidth > 768) {
    const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
    const appLayout = document.getElementById('app-layout');
    if (appLayout && isCollapsed) {
      appLayout.classList.add('sidebar-collapsed');
    }
  }

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetPanel = link.getAttribute('data-target');
      switchTab(targetPanel);
      closeMobileSidebar();
    });
  });

  const hamburgerBtn = document.getElementById('hamburger-btn');
  const sidebarOverlay = document.getElementById('sidebar-overlay');

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        toggleMobileSidebar();
      } else {
        const appLayout = document.getElementById('app-layout');
        if (appLayout) {
          appLayout.classList.toggle('sidebar-collapsed');
          const isCollapsed = appLayout.classList.contains('sidebar-collapsed');
          localStorage.setItem('sidebar_collapsed', isCollapsed);
        }
      }
    });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      closeMobileSidebar();
    });
  }

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

// Quản lý tab Cấu hình đám mây
function setupSupabaseSettings() {
  const form = document.getElementById('supabase-config-form');
  const disconnectBtn = document.getElementById('btn-disconnect-db');
  const syncBtn = document.getElementById('btn-sync-to-cloud');

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
    if (document.getElementById('backup-section')) {
      document.getElementById('backup-section').style.display = 'block';
    }
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

// Tải dữ liệu dự phòng từ LocalStorage khi mất kết nối mạng
function loadLocalStorageBackup() {
  const storedProducts = localStorage.getItem('billing_system_products');
  const storedOrders = localStorage.getItem('billing_system_orders');
  
  if (storedProducts) {
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
  if (storedCustomers) {
    state.customers = JSON.parse(storedCustomers);
  } else {
    state.customers = [];
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  }

  const storedUsers = localStorage.getItem('billing_system_users');
  if (storedUsers) {
    state.users = JSON.parse(storedUsers);
  } else {
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

// Khởi chạy ứng dụng
async function initApp() {
  const today = new Date();
  const dateLbl = document.getElementById('current-date-lbl');
  if (dateLbl) dateLbl.innerText = today.toLocaleDateString('vi-VN');

  setupNavigation();
  setupProductManagement();
  setupCustomerManagement();
  setupPricelistManagement();
  setupInvoiceCreator();
  setupHistoryPanel();
  setupDashboardQuickActions();
  setupDashboardFilters();
  setupExcelImportAndTemplate();
  setupSupabaseSettings();
  setupUserManagement();
  setupBackupRestoreListeners(renderAll);

  const savedUrl = localStorage.getItem('billing_supabase_url');
  const savedKey = localStorage.getItem('billing_supabase_key');
  
  if (savedUrl && savedKey) {
    let connected = false;
    const retries = 3;
    const delayMs = 2000;
    
    for (let i = 1; i <= retries; i++) {
      updateDbStatusUI('connecting', `Kết nối Cloud (Lần ${i}/${retries})...`);
      connected = await connectSupabase(savedUrl, savedKey, false);
      if (connected) break;
      
      if (i < retries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
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
  
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  let activeUser = null;
  if (isCloudActive && supabaseClient) {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session && session.user) {
        const username = session.user.email.split('@')[0];
        const user = state.users.find(u => u.username === username);
        if (user) {
          activeUser = user;
        }
      }
    } catch (err) {
      console.error('Session recovery failed:', err);
    }
  }
  
  if (!activeUser) {
    const isAuth = sessionStorage.getItem('billing_system_auth') === 'true';
    const username = sessionStorage.getItem('billing_system_username');
    if (isAuth && username) {
      activeUser = state.users.find(u => u.username === username);
    }
  }

  if (activeUser) {
    state.currentUser = activeUser;
    sessionStorage.setItem('billing_system_auth', 'true');
    sessionStorage.setItem('billing_system_username', activeUser.username);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-layout').classList.remove('auth-hidden');
    document.getElementById('user-info-header').style.display = 'flex';
    document.getElementById('btn-logout').style.display = 'inline-flex';
    document.getElementById('header-user-display').innerText = `${activeUser.displayName} (${activeUser.role === 'admin' ? 'Admin' : activeUser.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
    applyUserPermissions(activeUser);
  } else {
    showLoginGate();
  }

  populatePricelistsDropdowns();
  renderAll();
}

// Xử lý khi nhấn nút kết nối lại trên Badge trạng thái
document.addEventListener('click', async (e) => {
  if (e.target.closest('#btn-retry-connection')) {
    const success = await retrySupabaseConnection();
    if (success) {
      renderAll();
    }
  }
});

window.addEventListener('DOMContentLoaded', initApp);
