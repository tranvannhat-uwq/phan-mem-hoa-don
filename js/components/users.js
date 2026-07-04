import { state } from '../state.js';
import { showToast, safeCreateIcons } from '../utils.js';
import { dbSaveUser, dbDeleteUser, isCloudActive, supabaseClient, fetchCloudData } from '../services/supabase.js';
import { renderAll, switchTab } from '../main.js';
import { populateManagedByDropdown } from './customers.js';

export function renderUsersTable() {
  const tableBody = document.getElementById('users-table-body');
  if (!tableBody) return;
  
  const searchInput = document.getElementById('user-search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
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
        <td style="font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${u.username}">${u.username}</td>
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

export function openUserModal(userId = '') {
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
      usernameInput.removeAttribute('disabled');
      document.getElementById('user-displayname').value = user.displayName;
      document.getElementById('user-role').value = user.role;
      passwordInput.value = '';
      passwordInput.removeAttribute('required');
      passwordHelp.style.display = 'block';
    }
  }
}

export function closeUserModal() {
  const modal = document.getElementById('user-modal');
  if (modal) modal.classList.remove('active');
}

export async function saveUser() {
  const editId = document.getElementById('user-edit-id').value;
  let username = document.getElementById('user-username').value.trim().toLowerCase();
  const displayName = document.getElementById('user-displayname').value.trim();
  const password = document.getElementById('user-password').value.trim();
  const role = document.getElementById('user-role').value;
  
  if (!username || !displayName) {
    showToast('Tên đăng nhập và Tên hiển thị là bắt buộc!', 'danger');
    return;
  }
  
  // Kiểm tra độ dài mật khẩu nếu có nhập (Supabase Auth yêu cầu >= 6 ký tự)
  if (password && password.length < 6) {
    showToast('Mật khẩu phải có độ dài tối thiểu 6 ký tự!', 'danger');
    return;
  }
  
  // Cảnh báo nếu admin cố đổi mật khẩu của tài khoản khác trong chế độ Cloud
  if (isCloudActive && editId && state.currentUser && state.currentUser.id !== editId && password) {
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
    const exists = state.users.some(u => {
      const uName = u.username.toLowerCase();
      const uNamePart = uName.includes('@') ? uName.split('@')[0] : uName;
      const targetPart = username.includes('@') ? username.split('@')[0] : username;
      return uName === username || uNamePart === targetPart;
    });
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
    const existingUser = state.users.find(u => u.id === editId);
    if (!existingUser) return;
    
    const exists = state.users.some(u => {
      if (u.id === editId) return false;
      const uName = u.username.toLowerCase();
      const uNamePart = uName.includes('@') ? uName.split('@')[0] : uName;
      const targetPart = username.includes('@') ? username.split('@')[0] : username;
      return uName === username || uNamePart === targetPart;
    });
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
    ${state.users.map(u => `
      <option value="${u.username}">${u.displayName} (${u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale'})</option>
    `).join('')}
  `;
  
  select.value = currentVal;
}

export async function handleLogin(e) {
  e.preventDefault();
  const usernameInput = document.getElementById('login-username').value.trim().toLowerCase();
  const passwordInput = document.getElementById('login-password').value.trim();

  if (isCloudActive && supabaseClient) {
    try {
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
        // Thử với tên miền công ty @lendon.com trước (mặc định mới)
        const emailLd = `${usernameInput}@lendon.com`;
        const { error: errLd } = await supabaseClient.auth.signInWithPassword({
          email: emailLd,
          password: passwordInput
        });
        
        if (!errLd) {
          loginSuccess = true;
        } else {
          // Thử với tên miền công ty cũ @weblendon.com (cho các tài khoản cũ tạo từ app)
          const emailWl = `${usernameInput}@weblendon.com`;
          const { error: errWl } = await supabaseClient.auth.signInWithPassword({
            email: emailWl,
            password: passwordInput
          });
          
          if (!errWl) {
            loginSuccess = true;
          } else {
            // Nếu không được, thử với @gmail.com (cho tài khoản mới liên kết gmail)
            const emailGmail = `${usernameInput}@gmail.com`;
            const { error: errGmail } = await supabaseClient.auth.signInWithPassword({
              email: emailGmail,
              password: passwordInput
            });
            
            if (!errGmail) {
              loginSuccess = true;
            } else {
              loginError = errGmail;
            }
          }
        }
      }

      if (!loginSuccess) {
        throw loginError || new Error('Tài khoản hoặc mật khẩu không chính xác!');
      }

      // Đồng bộ dữ liệu mới nhất (bao gồm hồ sơ tài khoản từ bảng users) sau khi đăng nhập thành công
      await fetchCloudData();

      const cleanInput = usernameInput.toLowerCase().trim();
      const usernamePart = cleanInput.includes('@') ? cleanInput.split('@')[0] : cleanInput;
      const user = state.users.find(u => {
        const uName = u.username.toLowerCase();
        const uNamePart = uName.includes('@') ? uName.split('@')[0] : uName;
        return uName === cleanInput || uName === usernamePart || uNamePart === cleanInput || uNamePart === usernamePart;
      });
      if (user) {
        state.currentUser = user;
        sessionStorage.setItem('billing_system_auth', 'true');
        sessionStorage.setItem('billing_system_username', user.username);
        
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-layout').classList.remove('auth-hidden');
        
        document.getElementById('user-info-header').style.display = 'flex';
        document.getElementById('btn-logout').style.display = 'inline-flex';
        document.getElementById('header-user-display').innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
        
        applyUserPermissions(user);
        renderAll();
        showToast(`Đăng nhập đám mây thành công! Chào mừng ${user.displayName}!`, 'success');
      } else {
        showToast('Đăng nhập thành công nhưng không tìm thấy thông tin tài khoản trong cơ sở dữ liệu!', 'warning');
      }
    } catch (err) {
      console.error('Login error:', err);
      showToast('Đăng nhập thất bại: ' + (err.message || 'Tài khoản hoặc mật khẩu không chính xác!'), 'danger');
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
      
      document.getElementById('user-info-header').style.display = 'flex';
      document.getElementById('btn-logout').style.display = 'inline-flex';
      document.getElementById('header-user-display').innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
      
      applyUserPermissions(user);
      renderAll();
      showToast(`Chế độ ngoại tuyến: Chào mừng ${user.displayName}!`, 'success');
    } else {
      showToast('Tên đăng nhập hoặc mật khẩu không chính xác!', 'danger');
    }
  }
}

export async function handleLogout() {
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
    
    if (role === 'sale') {
      if (target === 'invoice-panel' || target === 'customers-panel' || target === 'products-panel' || target === 'history-panel' || target === 'pricelists-panel' || target === 'brands-panel') {
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

  if (role === 'sale') {
    switchTab('invoice-panel');
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
