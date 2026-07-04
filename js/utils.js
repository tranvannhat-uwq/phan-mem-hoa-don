// Hàm hiển thị icon Lucide an toàn
export function safeCreateIcons() {
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    try {
      lucide.createIcons();
    } catch (e) {
      console.error("Lucide icon generation failed:", e);
    }
  }
}

// Định dạng tiền tệ VND
export function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND'
  }).format(amount);
}

// Định dạng số thông thường
export function formatNumber(amount) {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(amount));
}

// Lấy phần trăm phụ thu màu sơn từ ký tự cuối mã màu
export function getColorPercentFromCode(colorCode) {
  if (!colorCode) return 0;
  const lastChar = colorCode.trim().slice(-1).toUpperCase();
  if (lastChar === 'P') return 0;
  if (lastChar === 'T') return 15;
  if (lastChar === 'D') return 20;
  if (lastChar === 'A') return 25;
  return 0; // Mặc định 0%
}

// Định dạng ngày giờ đầy đủ
export function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Định dạng chỉ hiển thị ngày
export function formatDateOnly(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
}

// Hiển thị thông báo Toast
export function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
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
  
  // Fade out và xóa khỏi DOM
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 3000);
}

// Cập nhật giao diện trạng thái đồng bộ cơ sở dữ liệu
export function updateDbStatusUI(status, message = '') {
  const badge = document.getElementById('db-status-badge');
  if (!badge) return;
  badge.className = 'db-status-badge'; // reset
  badge.style.border = ''; // reset styles
  
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
  } else {
    badge.classList.add('status-local');
    badge.innerHTML = `<i data-lucide="database" style="width:12px;height:12px;"></i> Cục bộ (LocalStorage)${message ? ` - ${message}` : ''}`;
  }
  safeCreateIcons();
}

// Định dạng số điện thoại ngăn cách bằng dấu chấm
export function formatPhoneNumber(phone) {
  if (!phone) return 'N/A';
  const clean = phone.toString().replace(/\D/g, '');
  if (clean.length === 10) {
    return `${clean.slice(0, 4)}.${clean.slice(4, 7)}.${clean.slice(7)}`;
  } else if (clean.length === 11) {
    return `${clean.slice(0, 4)}.${clean.slice(4, 7)}.${clean.slice(7, 10)}.${clean.slice(10)}`;
  } else if (clean.length === 9) {
    return `${clean.slice(0, 3)}.${clean.slice(3, 6)}.${clean.slice(6)}`;
  }
  return phone;
}

// So sánh hai tên đăng nhập / email linh hoạt (không phân biệt hoa thường và so khớp tiền tố)
export function isSameUser(u1, u2) {
  if (!u1 || !u2) return false;
  const clean1 = u1.toLowerCase().trim();
  const clean2 = u2.toLowerCase().trim();
  if (clean1 === clean2) return true;
  const prefix1 = clean1.split('@')[0];
  const prefix2 = clean2.split('@')[0];
  return prefix1 === prefix2;
}
