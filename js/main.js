import { state } from './state.js';
import { COMPANY_SUPABASE_URL, COMPANY_SUPABASE_KEY, defaultProducts } from './config.js';
import { connectSupabase, disconnectSupabase, retrySupabaseConnection, syncLocalToCloud, isCloudActive, supabaseClient, loadLocalStorageBackup, backfillMultiCompanyAndRevenueData } from './services/supabase.js';
import { setupBackupRestoreListeners, checkAndShowBackupReminder } from './services/backup.js';
import { updateDashboardStats, setupDashboardFilters, setupDashboardQuickActions } from './components/dashboard.js';
import { renderProductsTable, setupExcelImportAndTemplate, setupProductManagement } from './components/products.js';
import { renderCustomersTable, setupCustomerManagement, populateManagedByDropdown } from './components/customers.js';
import { renderInvoiceTable, setupInvoiceCreator, resetInvoiceBuilder, resetInvoiceCustomer } from './components/invoice.js';
import { renderPricelistsTable, setupPricelistManagement, populatePricelistsDropdowns } from './components/pricelists.js';
import { renderUsersTable, setupUserManagement, handleLogin, handleLogout, showLoginGate, applyUserPermissions, populateCustomerEmployeeFilter } from './components/users.js';
import { setupHistoryPanel, renderHistoryOrders } from './components/history.js';
import { renderBrandsTable, setupBrandsPanel } from './components/brands.js';
import { setupSoQuyPanel, renderSoQuyTable } from './components/so_quy.js';
import { renderSuppliersTable, setupSupplierManagement, populateSupplierDatalist } from './components/suppliers.js';
import { renderGoodsPanel, setupGoodsPanel } from './components/goods.js';
import { setupReportsPanel, renderDebtReport, renderReturnsReport, renderKpiReport } from './components/reports.js';
import { setupPayrollPanel, renderPayrollTable } from './components/payroll.js';
import { showToast, safeCreateIcons, updateDbStatusUI, isSameUser } from './utils.js';

// Vẽ lại toàn bộ giao diện của tất cả các Tab
export function renderAll() {
  backfillMultiCompanyAndRevenueData();
  updateDashboardStats();
  renderProductsTable();
  renderCustomersTable();
  renderSuppliersTable();
  renderInvoiceTable();
  renderPricelistsTable();
  renderHistoryOrders();
  renderSoQuyTable();
  renderUsersTable();
  renderBrandsTable();
  populateCustomerEmployeeFilter();
  populatePricelistsDropdowns();
  populateSupplierDatalist();
  renderGoodsPanel();
  renderDebtReport();
  renderReturnsReport();
  renderKpiReport();
  renderPayrollTable();
  checkAndShowBackupReminder();
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
  else if (panelId === 'so-quy-panel') heading.innerText = 'Sổ quỹ thu chi';
  else if (panelId === 'customers-panel') heading.innerText = 'Danh sách khách hàng & Đại lý';
  else if (panelId === 'suppliers-panel') heading.innerText = 'Danh sách nhà cung cấp';
  else if (panelId === 'pricelists-panel') heading.innerText = 'Quản lý Bảng giá & Chiết khấu';
  else if (panelId === 'users-panel') heading.innerText = 'Quản lý tài khoản người dùng';
  else if (panelId === 'settings-panel') heading.innerText = 'Cấu hình đám mây';
  else if (panelId === 'goods-panel') heading.innerText = 'Quản lý Hàng hóa & Sản xuất';
  else if (panelId === 'reports-panel') heading.innerText = 'Báo cáo & Thống kê KPI';
  else if (panelId === 'payroll-panel') heading.innerText = 'Quản lý & Tính lương Nhân viên';
  
  // Tự động làm mới dữ liệu và thống kê trên tất cả các tab khi chuyển đổi
  renderAll();
}

// Trình quản lý thanh điều hướng
function setupNavigation() {
  // Tự động xóa trạng thái thu nhỏ cũ để tránh ẩn thanh điều hướng trên máy khách
  localStorage.removeItem('sidebar_collapsed');

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetPanel = link.getAttribute('data-target');
      switchTab(targetPanel);
      closeMobileSidebar();
    });
  });

  const sidebarOverlay = document.getElementById('sidebar-overlay');

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

  // Toggle global settings dropdown
  const settingsMenu = document.getElementById('global-settings-menu');
  
  window.toggleSettingsDropdown = function(e) {
    if (e) e.stopPropagation();
    if (settingsMenu) {
      const isHidden = settingsMenu.style.display === 'none' || settingsMenu.style.display === '';
      settingsMenu.style.display = isHidden ? 'block' : 'none';
    }
  };

  if (settingsMenu) {
    document.addEventListener('click', (e) => {
      const isToggleClick = e.target.closest('#btn-settings-toggle');
      const isMenuClick = e.target.closest('#global-settings-menu');
      if (!isToggleClick && !isMenuClick) {
        settingsMenu.style.display = 'none';
      }
    });

    // Handle clicks on dropdown navigation links
    const dropdownLinks = document.querySelectorAll('.dropdown-nav-link');
    dropdownLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetPanel = link.getAttribute('data-target');
        switchTab(targetPanel);

        // Update active nav-link highlighting in the main navbar
        document.querySelectorAll('.nav-link').forEach(nl => {
          if (nl.getAttribute('data-target') === targetPanel) {
            nl.classList.add('active');
          } else {
            nl.classList.remove('active');
          }
        });

        // Close dropdown
        settingsMenu.style.display = 'none';
      });
    });
  }
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

// loadLocalStorageBackup đã được chuyển sang services/supabase.js để tối ưu hóa

// Khởi chạy ứng dụng
async function initApp() {
  if (window.__app_initialized) return;
  window.__app_initialized = true;

  const today = new Date();
  const dateLbl = document.getElementById('current-date-lbl');
  if (dateLbl) dateLbl.innerText = today.toLocaleDateString('vi-VN');

  setupNavigation();
  setupProductManagement();
  setupCustomerManagement();
  setupSupplierManagement();
  setupPricelistManagement();
  setupInvoiceCreator();
  setupHistoryPanel();
  setupSoQuyPanel();
  setupDashboardQuickActions();
  setupDashboardFilters();
  setupExcelImportAndTemplate();
  setupSupabaseSettings();
  setupUserManagement();
  setupBrandsPanel();
  setupGoodsPanel();
  setupReportsPanel();
  setupPayrollPanel();
  setupBackupRestoreListeners(renderAll);

  let savedUrl = localStorage.getItem('billing_supabase_url');
  let savedKey = localStorage.getItem('billing_supabase_key');
  
  // Nếu chưa có cấu hình trong LocalStorage, tự động dùng cấu hình đám mây mặc định của công ty
  if (!savedUrl || !savedKey) {
    savedUrl = COMPANY_SUPABASE_URL;
    savedKey = COMPANY_SUPABASE_KEY;
    localStorage.setItem('billing_supabase_url', savedUrl);
    localStorage.setItem('billing_supabase_key', savedKey);
  }
  
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
        const authUser = session.user;
        // 1. Tìm theo ID UUID trước (chính xác nhất)
        let user = state.users.find(u => u.id === authUser.id);
        
        // 2. Nếu không tìm thấy, thử tìm theo email/username trùng khớp linh hoạt
        if (!user && authUser.email) {
          user = state.users.find(u => isSameUser(u.username, authUser.email));
        }
        
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
    const userInfoHeader = document.getElementById('user-info-header');
    if (userInfoHeader) userInfoHeader.style.display = 'flex';
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    const userDisplay = document.getElementById('header-user-display');
    if (userDisplay) {
      userDisplay.innerText = `${activeUser.displayName} (${activeUser.role === 'admin' ? 'Admin' : activeUser.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
    }
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

// Bắt và xử lý các lỗi Uncaught Promise Rejection từ extension hoặc script bên ngoài (như onboarding.js)
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && (
    (typeof event.reason.message === 'string' && event.reason.message.includes('getImageNode')) ||
    (typeof event.reason.stack === 'string' && event.reason.stack.includes('onboarding.js'))
  )) {
    console.warn('Đã xử lý an toàn lỗi Uncaught Promise Rejection từ Extension/Script bên ngoài:', event.reason?.message || event.reason);
    event.preventDefault(); // Ngăn chặn lỗi đỏ hiển thị ra Console
  }
});

window.addEventListener('DOMContentLoaded', initApp);

