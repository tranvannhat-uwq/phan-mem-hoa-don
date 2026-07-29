import { state } from '../state.js';
import { showToast, safeCreateIcons, isSameUser, getCompanyNameById } from '../utils.js';
import { dbSaveUser, dbDeleteUser, isCloudActive, supabaseClient, fetchCloudData } from '../services/supabase.js?v=20260727-debt-audit2';
import { renderAll, switchTab } from '../main.js';
import { populateManagedByDropdown } from './customers.js?v=20260727-customer-payments';
import { exportBackupToExcel } from '../services/backup.js';

export function renderUsersTable() {
  const tableBody = document.getElementById('users-table-body');
  if (!tableBody) return;
  
  const searchInput = document.getElementById('user-search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  const filtered = (state.users || []).filter(u => {
    if (!u) return false;
    const uname = (u.username || u.code || '').toLowerCase();
    const dname = (u.displayName || u.display_name || u.name || '').toLowerCase();
    return uname.includes(searchVal) || dname.includes(searchVal);
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
    const roleText = u.isExternal ? 'Kinh doanh ngoài' : 
                     (u.role === 'admin' ? 'Admin (Toàn quyền)' : 
                      u.role === 'accounting' ? 'Kế toán' : 'Sale (Kinh doanh)');
    const roleColor = u.isExternal ? '#a0aec0' : 
                      (u.role === 'admin' ? 'var(--color-danger)' : 
                       u.role === 'accounting' ? 'var(--color-secondary)' : 'var(--color-primary)');
                      
    const compName = getCompanyNameById(u.companyId || u.company_id, state.companies);
    const dName = u.displayName || u.display_name || u.name || u.username;
    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${index + 1}</td>
        <td style="font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${u.username}">${u.username}</td>
        <td>${dName}</td>
        <td>
          <span style="color: ${roleColor}; font-weight: 500;">${roleText}</span>
        </td>
        <td style="font-size: 0.8rem; color: var(--text-secondary);">${compName}</td>
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

export function openUserModal(userId = '') {
  const modal = document.getElementById('user-modal');
  const title = document.getElementById('user-modal-title');
  const form = document.getElementById('user-form');
  const usernameInput = document.getElementById('user-username');
  const passwordInput = document.getElementById('user-password');
  const passwordHelp = document.getElementById('user-password-help');
  const isExternalSelect = document.getElementById('user-is-external');
  const roleSelect = document.getElementById('user-role');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();
  
  const compSelect = document.getElementById('user-company');
  if (compSelect && state.companies && state.companies.length > 0) {
    compSelect.innerHTML = state.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  
  if (!userId) {
    title.innerText = 'Thêm tài khoản mới';
    document.getElementById('user-edit-id').value = '';
    usernameInput.removeAttribute('disabled');
    passwordInput.setAttribute('required', 'true');
    passwordHelp.style.display = 'none';
    
    if (isExternalSelect) isExternalSelect.value = 'false';
    passwordInput.disabled = false;
    if (roleSelect) roleSelect.disabled = false;
    if (compSelect) compSelect.value = 'ABS_NORTH';
  } else {
    title.innerText = 'Chỉnh sửa tài khoản';
    document.getElementById('user-edit-id').value = userId;
    
    const user = state.users.find(u => u.id === userId);
    if (user) {
      usernameInput.value = user.username;
      usernameInput.removeAttribute('disabled');
      document.getElementById('user-displayname').value = user.displayName;
      if (roleSelect) roleSelect.value = user.role;
      if (compSelect) compSelect.value = user.companyId || user.company_id || 'ABS_NORTH';
      
      const isExt = user.isExternal || false;
      if (isExternalSelect) isExternalSelect.value = isExt ? 'true' : 'false';
      
      passwordInput.value = '';
      passwordInput.removeAttribute('required');
      
      if (isExt) {
        passwordInput.disabled = true;
        if (roleSelect) roleSelect.disabled = true;
        passwordHelp.style.display = 'none';
      } else {
        passwordInput.disabled = false;
        if (roleSelect) roleSelect.disabled = false;
        passwordHelp.style.display = 'block';
      }
    }
  }
}

export function closeUserModal() {
  const modal = document.getElementById('user-modal');
  if (modal) modal.classList.remove('active');
}

export async function saveUser() {
  const editId = document.getElementById('user-edit-id').value;
  const isExternalSelect = document.getElementById('user-is-external');
  const isExternal = isExternalSelect ? isExternalSelect.value === 'true' : false;
  
  let username = document.getElementById('user-username').value.trim().toLowerCase();
  if (username && !username.includes('@')) {
    username = `${username}@lendon.com`;
  }
  const displayName = document.getElementById('user-displayname').value.trim();
  const password = document.getElementById('user-password').value.trim();
  const role = document.getElementById('user-role').value;
  
  if (!username || !displayName) {
    showToast('Tên đăng nhập và Tên hiển thị là bắt buộc!', 'danger');
    return;
  }
  
  // Kiểm tra độ dài mật khẩu nếu có nhập (Supabase Auth yêu cầu >= 6 ký tự)
  if (!isExternal && password && password.length < 6) {
    showToast('Mật khẩu phải có độ dài tối thiểu 6 ký tự!', 'danger');
    return;
  }
  
  // Cảnh báo nếu admin cố đổi mật khẩu của tài khoản khác trong chế độ Cloud
  if (isCloudActive && editId && state.currentUser && state.currentUser.id !== editId && password && !isExternal) {
    const confirmSave = confirm(
      "Lưu ý bảo mật (Chế độ Cloud):\n" +
      "Bạn không thể trực tiếp đổi mật khẩu của người khác từ ứng dụng này.\n" +
      "Mật khẩu của tài khoản này chỉ có thể được đặt lại trên trang quản trị Supabase Auth.\n\n" +
      "Tên hiển thị và Vai trò vẫn sẽ được cập nhật. Bạn có muốn tiếp tục lưu không?"
    );
    if (!confirmSave) return;
  }
  
  let user;
  if (!editId) {
    const exists = state.users.some(u => isSameUser(u.username, username));
    if (exists) {
      showToast('Tên đăng nhập đã tồn tại trong hệ thống!', 'danger');
      return;
    }
    if (!isExternal && !password) {
      showToast('Mật khẩu là bắt buộc cho tài khoản mới!', 'danger');
      return;
    }
    
    const companyId = document.getElementById('user-company') ? document.getElementById('user-company').value : 'ABS_NORTH';
    user = {
      id: 'u-' + Date.now(),
      username,
      displayName,
      password: isExternal ? '' : password,
      role: isExternal ? 'sale' : role,
      isExternal,
      companyId
    };
  } else {
    const existingUser = state.users.find(u => u.id === editId);
    if (!existingUser) return;
    
    const exists = state.users.some(u => u.id !== editId && isSameUser(u.username, username));
    if (exists) {
      showToast('Tên đăng nhập đã tồn tại trong hệ thống!', 'danger');
      return;
    }
    
    const companyId = document.getElementById('user-company') ? document.getElementById('user-company').value : 'ABS_NORTH';
    user = {
      ...existingUser,
      username,
      displayName,
      role: isExternal ? 'sale' : role,
      isExternal,
      companyId
    };
    if (!isExternal && password) {
      user.password = password;
    } else if (isExternal) {
      user.password = '';
    }
  }
  
  const saved = await dbSaveUser(user);
  if (saved) {
    // Cập nhật State local và LocalStorage
    const idx = state.users.findIndex(u => u.id === user.id);
    if (idx !== -1) {
      state.users[idx] = user;
    } else {
      state.users.push(user);
    }
    localStorage.setItem('billing_system_users', JSON.stringify(state.users));

    // Cập nhật lại UI Header nếu chỉnh sửa đúng tài khoản đang đăng nhập
    if (state.currentUser && state.currentUser.id === user.id) {
      state.currentUser = user;
      sessionStorage.setItem('billing_system_username', user.username);
      document.getElementById('header-user-display').innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
      applyUserPermissions(user);
    }
    
    closeUserModal();
    renderAll();
    showToast('Lưu thông tin tài khoản thành công!', 'success');
  }
}

export async function deleteUser(userId) {
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
      state.users = state.users.filter(u => u.id !== userId);
      localStorage.setItem('billing_system_users', JSON.stringify(state.users));
      renderAll();
      showToast('Xóa tài khoản thành công!', 'warning');
    }
  }
}

export function populateCustomerEmployeeFilter() {
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
    <option value="unassigned">-- Chưa có người quản lý --</option>
    <option value="unassigned_pricelist">-- Chưa áp bảng giá chuẩn --</option>
    ${state.users.map(u => `
      <option value="${u.username}">${u.displayName} (${u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale')})</option>
    `).join('')}
  `;
  
  select.value = currentVal;
}

let isLoggingIn = false;

export async function handleLogin(e) {
  e.preventDefault();
  if (isLoggingIn) return;
  isLoggingIn = true;

  const usernameInput = document.getElementById('login-username').value.trim().toLowerCase();
  const passwordInput = document.getElementById('login-password').value.trim();

  const submitBtn = document.getElementById('btn-login-submit') || e.target.querySelector('button[type="submit"]');
  const originalBtnHTML = submitBtn ? submitBtn.innerHTML : '';
  const usernameField = document.getElementById('login-username');
  const passwordField = document.getElementById('login-password');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span style="display: inline-block; width: 14px; height: 14px; border: 2px solid #fff; border-top: 2px solid transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 6px; vertical-align: middle;"></span> ĐANG ĐĂNG NHẬP...`;
  }
  if (usernameField) usernameField.disabled = true;
  if (passwordField) passwordField.disabled = true;

  const resetFormState = () => {
    isLoggingIn = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnHTML;
    }
    if (usernameField) usernameField.disabled = false;
    if (passwordField) passwordField.disabled = false;
  };

  try {
    // Kiểm tra đăng nhập bằng tài khoản cục bộ / hệ thống mặc định trước
    const cleanUsername = usernameInput.includes('@') ? usernameInput.split('@')[0] : usernameInput;
    const localUser = state.users.find(u => {
      const uClean = (u.username || '').toLowerCase().trim();
      const uCleanNoDomain = uClean.includes('@') ? uClean.split('@')[0] : uClean;
      return (uClean === usernameInput || uCleanNoDomain === cleanUsername) && u.password === passwordInput && u.password !== '';
    });

    if (localUser) {
      state.currentUser = localUser;
      sessionStorage.setItem('billing_system_auth', 'true');
      sessionStorage.setItem('billing_system_username', localUser.username);
      
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app-layout').classList.remove('auth-hidden');
      
      const userInfoHeader = document.getElementById('user-info-header');
      if (userInfoHeader) userInfoHeader.style.display = 'flex';
      const logoutBtn = document.getElementById('btn-logout');
      if (logoutBtn) logoutBtn.style.display = 'inline-flex';
      const userDisplay = document.getElementById('header-user-display');
      if (userDisplay) {
        userDisplay.innerText = `${localUser.displayName} (${localUser.role === 'admin' ? 'Admin' : localUser.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
      }
      
      applyUserPermissions(localUser);
      renderAll();
      showToast(`Đăng nhập thành công (Tài khoản hệ thống)! Chào mừng ${localUser.displayName}!`, 'success');
      resetFormState();
      return;
    }

    if (isCloudActive && supabaseClient) {
      let loginSuccess = false;
      let loginError = null;

      if (usernameInput.includes('@')) {
        const { error } = await supabaseClient.auth.signInWithPassword({
          email: usernameInput,
          password: passwordInput
        });
        if (error) {
          loginError = error;
        } else {
          loginSuccess = true;
        }
      } else {
        // Thử song song với các tên miền để tối ưu hóa thời gian phản hồi
        const domains = ['@lendon.com', '@weblendon.com', '@gmail.com'];
        const results = await Promise.all(
          domains.map(async (domain) => {
            const email = `${usernameInput}${domain}`;
            try {
              const { data, error } = await supabaseClient.auth.signInWithPassword({
                email,
                password: passwordInput
              });
              if (error) throw error;
              return { success: true, data, email };
            } catch (err) {
              return { success: false, error: err, email };
            }
          })
        );

        const successResult = results.find(r => r.success);
        if (successResult) {
          loginSuccess = true;
        } else {
          // Lấy lỗi từ @lendon.com làm lỗi mặc định nếu có, không thì lấy lỗi đầu tiên
          const lendonResult = results.find(r => r.email.endsWith('@lendon.com'));
          loginError = lendonResult ? lendonResult.error : results[0].error;
        }
      }

      if (!loginSuccess) {
        throw loginError || new Error('Tài khoản hoặc mật khẩu không chính xác!');
      }

      // Lấy thông tin xác thực vừa đăng nhập thành công từ Supabase Auth
      const { data: { user: authUser } } = await supabaseClient.auth.getUser();
      if (!authUser) {
        throw new Error('Không thể lấy thông tin xác thực sau khi đăng nhập.');
      }

      // Đồng bộ dữ liệu mới nhất (bao gồm hồ sơ tài khoản từ bảng users) sau khi đăng nhập thành công
      await fetchCloudData();

      // Tìm user trong CSDL (state.users) bằng UUID trước, sau đó bằng Email/Username
      let user = state.users.find(u => u.id === authUser.id);
      if (!user && authUser.email) {
        user = state.users.find(u => isSameUser(u.username, authUser.email));
      }
      if (user) {
        state.currentUser = user;
        sessionStorage.setItem('billing_system_auth', 'true');
        sessionStorage.setItem('billing_system_username', user.username);
        
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-layout').classList.remove('auth-hidden');
        
        const userInfoHeader = document.getElementById('user-info-header');
        if (userInfoHeader) userInfoHeader.style.display = 'flex';
        const logoutBtn = document.getElementById('btn-logout');
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';
        const userDisplay = document.getElementById('header-user-display');
        if (userDisplay) {
          userDisplay.innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
        }
        
        applyUserPermissions(user);
        renderAll();
        showToast(`Đăng nhập đám mây thành công! Chào mừng ${user.displayName}!`, 'success');
      } else {
        const fallbackUser = {
          id: authUser.id,
          username: authUser.email || usernameInput,
          displayName: authUser.email ? authUser.email.split('@')[0] : usernameInput,
          role: 'sale'
        };
        state.currentUser = fallbackUser;
        sessionStorage.setItem('billing_system_auth', 'true');
        sessionStorage.setItem('billing_system_username', fallbackUser.username);
        
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-layout').classList.remove('auth-hidden');
        
        const userInfoHeader = document.getElementById('user-info-header');
        if (userInfoHeader) userInfoHeader.style.display = 'flex';
        const logoutBtn = document.getElementById('btn-logout');
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';
        const userDisplay = document.getElementById('header-user-display');
        if (userDisplay) {
          userDisplay.innerText = `${fallbackUser.displayName} (Sale)`;
        }
        
        applyUserPermissions(fallbackUser);
        renderAll();
        showToast('Đăng nhập đám mây thành công! (Tài khoản chưa khởi tạo hồ sơ)', 'warning');
      }
    } else {
      const cleanUsername = usernameInput.includes('@') ? usernameInput.split('@')[0] : usernameInput;
      const user = state.users.find(u => u.username === cleanUsername && u.password === passwordInput);
      if (user) {
        state.currentUser = user;
        sessionStorage.setItem('billing_system_auth', 'true');
        sessionStorage.setItem('billing_system_username', user.username);
        
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-layout').classList.remove('auth-hidden');
        
        const userInfoHeader = document.getElementById('user-info-header');
        if (userInfoHeader) userInfoHeader.style.display = 'flex';
        const logoutBtn = document.getElementById('btn-logout');
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';
        const userDisplay = document.getElementById('header-user-display');
        if (userDisplay) {
          userDisplay.innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
        }
        
        applyUserPermissions(user);
        renderAll();
        showToast(`Chế độ ngoại tuyến: Chào mừng ${user.displayName}!`, 'success');
      } else {
        showToast('Tên đăng nhập hoặc mật khẩu không chính xác!', 'danger');
      }
    }
  } catch (err) {
    console.error('Login error:', err);
    showToast('Đăng nhập thất bại: ' + (err.message || 'Tài khoản hoặc mật khẩu không chính xác!'), 'danger');
  } finally {
    resetFormState();
  }
}

export async function handleLogout() {
  if (state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.role === 'accounting')) {
    const todayStr = new Date().toLocaleDateString('vi-VN');
    const lastBackup = localStorage.getItem('weblendon_last_backup_date');
    if (lastBackup !== todayStr) {
      const confirmBackup = confirm("Hôm nay bạn chưa tải bản sao lưu dữ liệu Excel cuối ngày về máy tính.\n\nBạn có muốn tải bản sao lưu Excel về máy trước khi đăng xuất không?");
      if (confirmBackup) {
        try {
          await exportBackupToExcel();
          localStorage.setItem('weblendon_last_backup_date', todayStr);
        } catch (err) {
          console.error("Backup before logout failed:", err);
        }
      }
    }
  }

  sessionStorage.removeItem('billing_system_auth');
  sessionStorage.removeItem('billing_system_username');
  state.currentUser = null;
  if (isCloudActive && supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch (err) {
      console.error('Sign out error:', err);
    }
  }
  location.reload();
}

export function showLoginGate() {
  const loginScreen = document.getElementById('login-screen');
  const appLayout = document.getElementById('app-layout');
  const userInfoHeader = document.getElementById('user-info-header');
  const logoutBtn = document.getElementById('btn-logout');

  if (loginScreen) loginScreen.style.display = 'flex';
  if (appLayout) appLayout.classList.add('auth-hidden');
  if (userInfoHeader) userInfoHeader.style.display = 'none';
  if (logoutBtn) logoutBtn.style.display = 'none';
}

export function applyUserPermissions(user) {
  if (!user) return;
  const role = user.role;

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    const target = link.getAttribute('data-target');
    const navItem = link.parentElement;
    if (!target) return;
    
    if (role === 'sale') {
      if (target === 'dashboard-panel' || target === 'invoice-panel' || target === 'customers-panel' || target === 'products-panel' || target === 'history-panel' || target === 'pricelists-panel' || target === 'brands-panel') {
        navItem.style.display = 'block';
      } else {
        navItem.style.display = 'none';
      }
    } else if (role === 'accounting') {
      if (target === 'settings-panel' || target === 'users-panel') {
        navItem.style.display = 'none';
      } else {
        navItem.style.display = 'block';
      }
    } else {
      navItem.style.display = 'block';
    }
  });

  const purchaseNavItem = document.querySelector('.purchase-nav-item');
  if (purchaseNavItem) {
    purchaseNavItem.style.display = role === 'sale' ? 'none' : 'block';
  }

  // Hiding dropdown items based on role
  const dropdownNavLinks = document.querySelectorAll('.dropdown-nav-link');
  dropdownNavLinks.forEach(link => {
    const target = link.getAttribute('data-target');
    if (role === 'sale' || role === 'accounting') {
      if (target === 'users-panel' || target === 'settings-panel') {
        link.style.display = 'none';
      } else {
        link.style.display = 'flex';
      }
    } else {
      link.style.display = 'flex';
    }
  });

  if (role === 'sale') {
    switchTab('dashboard-panel');
  }

  // Handle Dashboard Sale Filter dropdown visibility and population
  const dashSaleFilterGroup = document.getElementById('dashboard-sale-filter-group');
  const dashSaleFilter = document.getElementById('dashboard-sale-filter');
  
  if (dashSaleFilterGroup && dashSaleFilter) {
    if (role === 'admin' || role === 'accounting') {
      dashSaleFilterGroup.style.display = 'flex';
      
      const saleUsers = state.users.filter(u => u.role === 'sale');
      dashSaleFilter.innerHTML = `
        <option value="all">-- Tất cả nhân viên --</option>
        ${saleUsers.map(u => `<option value="${u.username}">${u.displayName}</option>`).join('')}
      `;
      if (!state.dashboardFilter.saleUser) {
        state.dashboardFilter.saleUser = 'all';
      }
      dashSaleFilter.value = state.dashboardFilter.saleUser;
    } else {
      dashSaleFilterGroup.style.display = 'none';
      state.dashboardFilter.saleUser = user.username;
    }
  }

  populateManagedByDropdown();

  const managedBySection = document.getElementById('cust-managed-by-section');
  if (managedBySection) {
    managedBySection.style.display = role === 'sale' ? 'none' : 'block';
  }

  const custDebtInput = document.getElementById('cust-debt');
  if (custDebtInput) {
    if (role === 'sale') custDebtInput.setAttribute('disabled', 'true');
    else custDebtInput.removeAttribute('disabled');
  }

  const styleTagId = 'role-based-css-rules';
  let styleTag = document.getElementById(styleTagId);
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = styleTagId;
    document.head.appendChild(styleTag);
  }

  if (role === 'sale') {
    styleTag.innerHTML = `
      #btn-save-order { display: none !important; }
      #btn-print-type-warehouse { display: none !important; }
      .delete-cust-btn, .pay-debt-btn { display: none !important; }
      .edit-cust-btn { display: inline-flex !important; }
      #btn-open-add-product-modal, #btn-open-excel-modal, #btn-download-excel-template, .edit-product-btn, .delete-prod-btn { display: none !important; }
      #products-panel th:last-child, #products-panel td:last-child { display: none !important; }
      .col-delete-prod { display: none !important; }
      .delete-order-btn { display: none !important; }
      #btn-clear-history { display: none !important; }
      #btn-open-add-pricelist-modal { display: none !important; }
      #pricelists-panel th:last-child, #pricelists-panel td:last-child { display: none !important; }
      #btn-open-add-brand-modal, .edit-brand-btn, .delete-brand-btn { display: none !important; }
      #brands-panel th:last-child, #brands-panel td:last-child { display: none !important; }
      #dash-btn-add-product { display: none !important; }
    `;
  } else if (role === 'accounting') {
    styleTag.innerHTML = `
      .delete-cust-btn { display: inline-flex !important; }
      .edit-cust-btn { display: inline-flex !important; }
      .pay-debt-btn { display: inline-flex !important; }
      #btn-open-add-product-modal, .edit-product-btn, .delete-product-btn { display: none !important; }
      .delete-order-btn { display: none !important; }
    `;
  } else {
    styleTag.innerHTML = '';
  }
}

export function setupUserManagement() {
  const addBtn = document.getElementById('btn-open-add-user-modal');
  const closeBtn = document.getElementById('btn-close-user-modal');
  const cancelBtn = document.getElementById('btn-cancel-user');
  const userForm = document.getElementById('user-form');
  const searchInput = document.getElementById('user-search-input');
  const isExternalSelect = document.getElementById('user-is-external');
  const passwordInput = document.getElementById('user-password');
  const roleSelect = document.getElementById('user-role');

  if (addBtn) addBtn.addEventListener('click', () => openUserModal());
  if (closeBtn) closeBtn.addEventListener('click', closeUserModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeUserModal);
  
  if (isExternalSelect) {
    isExternalSelect.addEventListener('change', () => {
      const isExt = isExternalSelect.value === 'true';
      if (isExt) {
        if (passwordInput) {
          passwordInput.removeAttribute('required');
          passwordInput.value = '';
          passwordInput.disabled = true;
        }
        if (roleSelect) {
          roleSelect.value = 'sale';
          roleSelect.disabled = true;
        }
      } else {
        const editId = document.getElementById('user-edit-id').value;
        if (!editId && passwordInput) {
          passwordInput.setAttribute('required', 'true');
        }
        if (passwordInput) passwordInput.disabled = false;
        if (roleSelect) roleSelect.disabled = false;
      }
    });
  }

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
