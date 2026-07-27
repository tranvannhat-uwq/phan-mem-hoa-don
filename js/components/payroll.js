import { state } from '../state.js';
import { formatCurrency, safeCreateIcons, formatDateTime, getUserDisplayName, showToast } from '../utils.js';

export function getSalaryPeriods() {
  const stored = localStorage.getItem('billing_system_salary_periods');
  if (stored) {
    try { return JSON.parse(stored); } catch(e) { return {}; }
  }
  return {};
}

export function saveSalaryPeriods(periods) {
  localStorage.setItem('billing_system_salary_periods', JSON.stringify(periods));
}

export function setupPayrollPanel() {
  const periodSelect = document.getElementById('payroll-period-select');
  if (periodSelect) {
    periodSelect.addEventListener('change', () => renderPayrollTable());
  }

  const btnLock = document.getElementById('btn-lock-payroll-period');
  if (btnLock) {
    btnLock.addEventListener('click', () => toggleLockPayrollPeriod());
  }
}

export function toggleLockPayrollPeriod() {
  const currUser = state.currentUser;
  if (!currUser || (currUser.role !== 'admin' && currUser.role !== 'ketoan')) {
    showToast('Chỉ Admin hoặc Kế toán mới có quyền khóa/mở khóa kỳ lương!', 'danger');
    return;
  }

  const periodSelect = document.getElementById('payroll-period-select');
  const selectedPeriod = periodSelect ? periodSelect.value : getSelectedSalaryPeriod();

  const periods = getSalaryPeriods();
  const isCurrentlyLocked = periods[selectedPeriod] && periods[selectedPeriod].isLocked;

  if (isCurrentlyLocked) {
    if (confirm(`Bạn có chắc muốn MỞ KHÓA kỳ lương [${selectedPeriod}]? Kỳ lương mở sẽ tự động cập nhật khi có đơn hàng/trả hàng mới.`)) {
      periods[selectedPeriod].isLocked = false;
      periods[selectedPeriod].unlockedAt = new Date().toISOString();
      periods[selectedPeriod].unlockedBy = currUser.username || currUser.displayName;
      saveSalaryPeriods(periods);
      showToast(`Đã mở khóa kỳ lương ${selectedPeriod}!`, 'success');
      renderPayrollTable();
    }
  } else {
    if (confirm(`Bạn có chắc muốn KHÓA kỳ lương [${selectedPeriod}]? Sau khi khóa, đơn phát sinh mới sẽ không làm thay đổi bảng lương của kỳ này.`)) {
      // Calculate snapshot
      const snapshot = calculatePayrollData(selectedPeriod);
      periods[selectedPeriod] = {
        period: selectedPeriod,
        isLocked: true,
        lockedAt: new Date().toISOString(),
        lockedBy: currUser.username || currUser.displayName,
        snapshot: snapshot
      };
      saveSalaryPeriods(periods);
      showToast(`Đã khóa kỳ lương ${selectedPeriod} thành công!`, 'success');
      renderPayrollTable();
    }
  }
}

export function getSelectedSalaryPeriod() {
  const select = document.getElementById('payroll-period-select');
  if (select && select.value) return select.value;

  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${month}`;
}

export function calculatePayrollData(period) {
  const users = state.users || [];
  const orders = state.savedOrders || [];
  const returns = (state.salesReturns || []).filter(r => r.status !== 'cancelled');
  const commTxs = state.commissionTransactions || [];
  const adjustments = getPayrollAdjustments(period);

  return users.map(user => {
    const userId = user.id || user.username;
    const baseSalary = parseFloat(user.baseSalary || user.base_salary || 0);

    // 1. Calculate Commission from commission_transactions or order rules in period
    let commissionAmt = 0;
    let returnDeduction = 0;

    // Filter order items / transactions in period for this user
    orders.forEach(o => {
      if (o.status === 'settled') {
        const oDateStr = (o.date || '').substring(0, 7);
        if (oDateStr === period) {
          const empId = o.salespersonId || o.createdBy;
          if (empId && (empId === userId || empId === user.username)) {
            // Standard commission calculation fallback (e.g. 3% if no rule specified)
            commissionAmt += Math.round((o.totalPayable || 0) * 0.03);
          }
        }
      }
    });

    returns.forEach(r => {
      const rDateStr = (r.createdAt || r.returnDate || '').substring(0, 7);
      if (rDateStr === period) {
        const empId = r.salespersonId || r.createdBy;
        if (empId && (empId === userId || empId === user.username)) {
          returnDeduction += Math.round((r.totalRefund || 0) * 0.03);
        }
      }
    });

    const userAdj = adjustments[userId] || { kpiBonus: 0, deductions: 0, notes: '' };
    const kpiBonus = parseFloat(userAdj.kpiBonus || 0);
    const deductions = parseFloat(userAdj.deductions || 0);

    // Formula: Lương = Lương cơ bản + Hoa hồng + Thưởng KPI - Trừ trả hàng - Khấu trừ khác
    const netSalary = Math.max(0, Math.round(baseSalary + commissionAmt + kpiBonus - returnDeduction - deductions));

    return {
      userId,
      userCode: user.employeeCode || user.employee_code || user.username,
      userName: user.displayName || user.name || user.username,
      position: user.position || (user.role === 'admin' ? 'Quản trị viên' : user.role === 'ketoan' ? 'Kế toán' : 'NVKD'),
      baseSalary,
      commissionAmt,
      kpiBonus,
      returnDeduction,
      deductions,
      netSalary,
      notes: userAdj.notes || ''
    };
  });
}

export function getPayrollAdjustments(period) {
  const stored = localStorage.getItem(`billing_system_payroll_adj_${period}`);
  if (stored) {
    try { return JSON.parse(stored); } catch(e) { return {}; }
  }
  return {};
}

export function savePayrollAdjustments(period, adj) {
  localStorage.setItem(`billing_system_payroll_adj_${period}`, JSON.stringify(adj));
}

export function renderPayrollTable() {
  const tbody = document.getElementById('payroll-table-body');
  if (!tbody) return;

  const period = getSelectedSalaryPeriod();
  const periods = getSalaryPeriods();
  const isLocked = periods[period] && periods[period].isLocked;

  const btnLock = document.getElementById('btn-lock-payroll-period');
  const lockStatusBadge = document.getElementById('payroll-lock-status-badge');

  if (lockStatusBadge) {
    if (isLocked) {
      lockStatusBadge.className = 'db-status-badge status-cloud';
      lockStatusBadge.style.background = 'rgba(239, 68, 68, 0.15)';
      lockStatusBadge.style.color = '#ef4444';
      lockStatusBadge.style.border = '1px solid rgba(239, 68, 68, 0.3)';
      lockStatusBadge.innerText = `ĐÃ KHÓA KỲ LƯƠNG (${periods[period].lockedBy || 'Admin'})`;
    } else {
      lockStatusBadge.className = 'db-status-badge status-local';
      lockStatusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
      lockStatusBadge.style.color = '#10b981';
      lockStatusBadge.style.border = '1px solid rgba(16, 185, 129, 0.3)';
      lockStatusBadge.innerText = 'KỲ LƯƠNG MỞ (ĐANG TÍNH TỰ ĐỘNG)';
    }
  }

  if (btnLock) {
    btnLock.className = isLocked ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
    btnLock.innerHTML = isLocked 
      ? `<i data-lucide="unlock" style="width: 14px; height: 14px;"></i> Mở khóa kỳ lương`
      : `<i data-lucide="lock" style="width: 14px; height: 14px;"></i> Khóa kỳ lương ${period}`;
  }

  // If period is locked, read frozen snapshot!
  let payrollData = [];
  if (isLocked && periods[period].snapshot) {
    payrollData = periods[period].snapshot;
  } else {
    payrollData = calculatePayrollData(period);
  }

  if (payrollData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có nhân viên nào trong danh sách tính lương</td></tr>`;
    return;
  }

  let totalPayrollAll = 0;
  payrollData.forEach(p => { totalPayrollAll += p.netSalary; });

  const totalPayrollEl = document.getElementById('stat-total-payroll-period');
  if (totalPayrollEl) totalPayrollEl.innerText = formatCurrency(totalPayrollAll);

  tbody.innerHTML = payrollData.map(p => `
    <tr>
      <td style="font-weight: 600;">${p.userCode}</td>
      <td style="font-weight: 600; color: var(--text-primary);">${p.userName}</td>
      <td>${p.position}</td>
      <td style="text-align: right; font-weight: 500;">${formatCurrency(p.baseSalary)}</td>
      <td style="text-align: right; font-weight: 600; color: var(--color-primary);">${formatCurrency(p.commissionAmt)}</td>
      <td style="text-align: right; font-weight: 600; color: var(--color-success);">${formatCurrency(p.kpiBonus)}</td>
      <td style="text-align: right; font-weight: 600; color: var(--color-danger);">${formatCurrency(p.returnDeduction)}</td>
      <td style="text-align: right; font-weight: 600; color: var(--color-warning);">${formatCurrency(p.deductions)}</td>
      <td style="text-align: right; font-weight: 700; font-size: 1.05rem; color: var(--color-primary);">${formatCurrency(p.netSalary)}</td>
      <td style="text-align: center;">
        ${isLocked ? `<span style="font-size: 0.8rem; color: var(--text-muted);">Đã khóa</span>` : `
          <button class="btn btn-secondary btn-xs" onclick="window.editEmployeePayroll('${p.userId}', '${period}')" title="Điều chỉnh thưởng KPI / Khấu trừ">
            <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i> Sửa
          </button>
        `}
      </td>
    </tr>
  `).join('');

  safeCreateIcons();
}

window.editEmployeePayroll = function(userId, period) {
  const periods = getSalaryPeriods();
  if (periods[period] && periods[period].isLocked) {
    showToast('Kỳ lương này đã bị khóa. Vui lòng mở khóa để chỉnh sửa!', 'danger');
    return;
  }

  const user = (state.users || []).find(u => (u.id === userId || u.username === userId));
  if (!user) return;

  const adj = getPayrollAdjustments(period);
  const userAdj = adj[userId] || { kpiBonus: 0, deductions: 0, notes: '' };

  const bonusStr = prompt(`Nhập Thưởng KPI cho [${user.displayName || user.username}]:`, userAdj.kpiBonus || 0);
  if (bonusStr === null) return;

  const dedStr = prompt(`Nhập Khoản khấu trừ khác cho [${user.displayName || user.username}]:`, userAdj.deductions || 0);
  if (dedStr === null) return;

  const notesStr = prompt(`Nhập Ghi chú lý do điều chỉnh:`, userAdj.notes || '');

  adj[userId] = {
    kpiBonus: parseFloat(bonusStr) || 0,
    deductions: parseFloat(dedStr) || 0,
    notes: notesStr || ''
  };

  savePayrollAdjustments(period, adj);
  showToast('Đã cập nhật điều chỉnh lương cho nhân viên!', 'success');
  renderPayrollTable();
};
