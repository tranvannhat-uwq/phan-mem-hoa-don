import { state } from '../state.js';
import { formatCurrency, safeCreateIcons, isSameUser } from '../utils.js';
import { switchTab } from '../main.js';
import { openProductModal } from './products.js';

let revenueChartInstance = null;

export function getFilteredDashboardOrders() {
  // Bỏ qua đơn hàng nháp (draft) khi hiển thị báo cáo tổng quan
  let orders = state.savedOrders.filter(o => o.status !== 'draft');

  // 1. Lọc theo nhân viên Sale
  if (state.currentUser && state.currentUser.role === 'sale') {
    orders = orders.filter(o => isSameUser(o.createdBy, state.currentUser.username));
  } else if (state.dashboardFilter.saleUser && state.dashboardFilter.saleUser !== 'all') {
    orders = orders.filter(o => isSameUser(o.createdBy, state.dashboardFilter.saleUser));
  }

  // 2. Lọc theo khoảng thời gian
  const timeRange = state.dashboardFilter.timeRange;
  const now = new Date();
  
  return orders.filter(order => {
    if (!order.date) return false;
    const orderDate = new Date(order.date);
    
    switch (timeRange) {
      case 'day': {
        return orderDate.toDateString() === now.toDateString();
      }
      case 'week': {
        // Tuần hiện tại (Thứ 2 đến Chủ nhật)
        const startOfWeek = new Date(now);
        const day = startOfWeek.getDay();
        const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
        startOfWeek.setDate(diff);
        startOfWeek.setHours(0, 0, 0, 0);
        
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        endOfWeek.setHours(23, 59, 59, 999);
        
        return orderDate >= startOfWeek && orderDate <= endOfWeek;
      }
      case 'month': {
        return orderDate.getMonth() === now.getMonth() && orderDate.getFullYear() === now.getFullYear();
      }
      case 'year': {
        return orderDate.getFullYear() === now.getFullYear();
      }
      case 'custom': {
        const startStr = state.dashboardFilter.startDate;
        const endStr = state.dashboardFilter.endDate;
        if (!startStr || !endStr) return true;
        const start = new Date(startStr);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endStr);
        end.setHours(23, 59, 59, 999);
        return orderDate >= start && orderDate <= end;
      }
      default:
        return true;
    }
  });
}

export function renderRevenueChart(orders) {
  const chartCanvas = document.getElementById('revenue-chart');
  if (!chartCanvas) return;
  const ctx = chartCanvas.getContext('2d');
  
  if (revenueChartInstance) {
    revenueChartInstance.destroy();
  }

  let labels = [];
  let dataPoints = [];
  const now = new Date();
  const view = state.dashboardChartView;
  
  if (view === 'day') {
    // Biểu đồ theo giờ trong ngày
    labels = Array.from({ length: 12 }, (_, i) => `${(i * 2).toString().padStart(2, '0')}:00`);
    dataPoints = Array(12).fill(0);
    
    orders.forEach(o => {
      const d = new Date(o.date);
      if (d.toDateString() === now.toDateString()) {
        const hour = d.getHours();
        const bucket = Math.floor(hour / 2);
        if (bucket >= 0 && bucket < 12) {
          dataPoints[bucket] += (o.totalPayable || 0);
        }
      }
    });
  } else if (view === 'week') {
    // Biểu đồ theo thứ trong tuần
    labels = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
    dataPoints = Array(7).fill(0);
    
    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
    startOfWeek.setDate(diff);
    startOfWeek.setHours(0, 0, 0, 0);

    orders.forEach(o => {
      const d = new Date(o.date);
      const dayDiff = Math.floor((d - startOfWeek) / (1000 * 60 * 60 * 24));
      if (dayDiff >= 0 && dayDiff < 7) {
        dataPoints[dayDiff] += (o.totalPayable || 0);
      }
    });
  } else if (view === 'month') {
    // Biểu đồ theo ngày trong tháng
    const year = now.getFullYear();
    const month = now.getMonth();
    const numDays = new Date(year, month + 1, 0).getDate();
    
    labels = Array.from({ length: numDays }, (_, i) => `${i + 1}`);
    dataPoints = Array(numDays).fill(0);
    
    orders.forEach(o => {
      const d = new Date(o.date);
      if (d.getMonth() === month && d.getFullYear() === year) {
        const dateNum = d.getDate();
        if (dateNum >= 1 && dateNum <= numDays) {
          dataPoints[dateNum - 1] += (o.totalPayable || 0);
        }
      }
    });
  } else if (view === 'year') {
    // Biểu đồ theo tháng trong năm
    labels = ['Th 1', 'Th 2', 'Th 3', 'Th 4', 'Th 5', 'Th 6', 'Th 7', 'Th 8', 'Th 9', 'Th 10', 'Th 11', 'Th 12'];
    dataPoints = Array(12).fill(0);
    
    const year = now.getFullYear();
    orders.forEach(o => {
      const d = new Date(o.date);
      if (d.getFullYear() === year) {
        const monthNum = d.getMonth();
        if (monthNum >= 0 && monthNum < 12) {
          dataPoints[monthNum] += (o.totalPayable || 0);
        }
      }
    });
  }

  // Neon Gradient Background
  const gradient = ctx.createLinearGradient(0, 0, 0, 280);
  gradient.addColorStop(0, 'rgba(16, 185, 129, 0.25)'); 
  gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

  revenueChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Doanh thu',
        data: dataPoints,
        borderColor: '#10b981',
        borderWidth: 3,
        pointBackgroundColor: '#10b981',
        pointBorderColor: 'rgba(255,255,255,0.8)',
        pointBorderWidth: 1,
        pointRadius: 4,
        pointHoverRadius: 6,
        tension: 0.35,
        fill: true,
        backgroundColor: gradient
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: '#111827',
          titleColor: '#fff',
          bodyColor: '#fff',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return `Doanh thu: ${formatCurrency(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: '#64748b',
            font: {
              family: "'Inter', sans-serif",
              size: 11
            }
          }
        },
        y: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: '#64748b',
            font: {
              family: "'Inter', sans-serif",
              size: 11
            },
            callback: function(value) {
              if (value >= 1e6) {
                return (value / 1e6).toFixed(1) + 'M ₫';
              }
              if (value >= 1e3) {
                return (value / 1e3).toFixed(0) + 'k ₫';
              }
              return value + ' ₫';
            }
          }
        }
      }
    }
  });
}

export function renderTopProducts(orders) {
  const topProductsList = document.getElementById('top-products-list');
  if (!topProductsList) return;

  const salesMap = {};
  orders.forEach(order => {
    (order.items || []).forEach(item => {
      const key = (item.product && item.product.code) || item.productCode || item.code || item.name || 'Unknown';
      const name = (item.product && item.product.name) || item.productName || item.name || 'Sản phẩm không tên';
      const qty = Number(item.quantity || 0);
      const price = Number(item.price || 0);
      const disc = Number(item.discountPercent || 0);
      const revenue = qty * price * (1 - disc / 100);

      if (!salesMap[key]) {
        salesMap[key] = {
          code: key,
          name: name,
          quantity: 0,
          revenue: 0
        };
      }
      salesMap[key].quantity += qty;
      salesMap[key].revenue += revenue;
    });
  });

  const salesList = Object.values(salesMap);

  if (salesList.length === 0) {
    topProductsList.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 3rem; font-size: 0.9rem;">
        Chưa có dữ liệu bán hàng trong khoảng thời gian này
      </div>
    `;
    return;
  }

  salesList.sort((a, b) => b.quantity - a.quantity);
  const top5 = salesList.slice(0, 5);
  const maxQty = top5[0].quantity || 1;

  topProductsList.innerHTML = top5.map(p => {
    const percent = Math.round((p.quantity / maxQty) * 100);
    return `
      <div class="top-product-item">
        <div class="top-product-info">
          <span class="top-product-name" title="${p.name}">${p.name}</span>
          <span class="top-product-sales">${p.quantity} đã bán</span>
        </div>
        <div class="top-product-progress-bg">
          <div class="top-product-progress-bar" style="width: ${percent}%;"></div>
        </div>
        <div class="top-product-meta">
          <span>Mã: ${p.code}</span>
          <span style="font-weight: 500; color: #fff;">${formatCurrency(p.revenue)}</span>
        </div>
      </div>
    `;
  }).join('');
}

export function updateDashboardStats() {
  const filteredOrders = getFilteredDashboardOrders();

  let userCustomers = state.customers;
  if (state.currentUser && state.currentUser.role === 'sale') {
    userCustomers = state.customers.filter(c => isSameUser(c.managedBy, state.currentUser.username));
  } else if (state.dashboardFilter.saleUser && state.dashboardFilter.saleUser !== 'all') {
    userCustomers = state.customers.filter(c => isSameUser(c.managedBy, state.dashboardFilter.saleUser));
  }

  const labelSuffix = state.dashboardFilter.timeRange === 'custom' 
    ? '(Tùy chỉnh)' 
    : state.dashboardFilter.timeRange === 'day' 
      ? '(Hôm nay)' 
      : state.dashboardFilter.timeRange === 'week' 
        ? '(Tuần này)' 
        : state.dashboardFilter.timeRange === 'year' 
          ? '(Năm nay)' 
          : '(Tháng này)';
  
  const revLabel = document.getElementById('stat-revenue-label');
  if (revLabel) revLabel.innerText = `Doanh thu tích lũy ${labelSuffix}`;
  
  const soldLabel = document.getElementById('stat-sold-products-label');
  if (soldLabel) soldLabel.innerText = `Sản phẩm đã bán ${labelSuffix}`;

  const totalRevenue = filteredOrders.reduce((sum, order) => sum + (order.totalPayable || 0), 0);
  const totalOrders = filteredOrders.length;
  const totalDebt = userCustomers.reduce((sum, c) => sum + (c.debt || 0), 0);
  
  let totalSoldProducts = 0;
  filteredOrders.forEach(order => {
    (order.items || []).forEach(item => {
      totalSoldProducts += Number(item.quantity || 0);
    });
  });

  const revEl = document.getElementById('stat-total-revenue');
  if (revEl) revEl.innerText = formatCurrency(totalRevenue);
  
  const ordEl = document.getElementById('stat-total-orders');
  if (ordEl) ordEl.innerText = totalOrders;
  
  const debtEl = document.getElementById('stat-total-debt');
  if (debtEl) debtEl.innerText = formatCurrency(totalDebt);
  
  const soldEl = document.getElementById('stat-total-sold-products');
  if (soldEl) soldEl.innerText = totalSoldProducts;

  // Render recent orders on dashboard
  const recentOrdersBody = document.getElementById('dashboard-recent-orders-body');
  if (recentOrdersBody) {
    const recent = filteredOrders.slice(0, 5);
    if (recent.length === 0) {
      recentOrdersBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            Không có đơn hàng nào trong khoảng thời gian này
          </td>
        </tr>
      `;
    } else {
      recentOrdersBody.innerHTML = recent.map(o => {
        const itemSummary = o.items.map(item => `${item.productName || (item.product && item.product.name)} x${item.quantity}`).join(', ');
        return `
          <tr>
            <td style="font-weight: 600; color: #fff;">${o.id}</td>
            <td style="font-size: 0.8rem; color: var(--text-secondary);">${new Date(o.date).toLocaleDateString('vi-VN')}</td>
            <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${itemSummary}">${itemSummary}</td>
            <td style="text-align: right; font-weight: 600; color: var(--color-primary);">${formatCurrency(o.totalPayable)}</td>
            <td style="text-align: center;">
              <button class="btn btn-secondary btn-sm dash-view-order-btn" data-id="${o.id}">
                <i data-lucide="eye" style="width: 12px; height: 12px;"></i>
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Add view event listeners
      document.querySelectorAll('.dash-view-order-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          switchTab('history-panel');
          const searchInput = document.getElementById('order-search-input');
          if (searchInput) {
            searchInput.value = id;
            // Trigger input event to filter
            searchInput.dispatchEvent(new Event('input'));
          }
        });
      });
    }
  }

  // Draw revenue chart and top products
  renderRevenueChart(filteredOrders);
  renderTopProducts(filteredOrders);
  safeCreateIcons();
}

export function updateChartViewActiveButton(view) {
  document.querySelectorAll('.chart-view-btn').forEach(btn => {
    if (btn.getAttribute('data-view') === view) {
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
    } else {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
    }
  });
}

export function setupDashboardFilters() {
  const timeFilter = document.getElementById('dashboard-time-filter');
  const customDates = document.getElementById('dashboard-custom-dates');
  const startDateInput = document.getElementById('dashboard-start-date');
  const endDateInput = document.getElementById('dashboard-end-date');
  const saleFilter = document.getElementById('dashboard-sale-filter');

  if (timeFilter) {
    timeFilter.addEventListener('change', () => {
      const val = timeFilter.value;
      state.dashboardFilter.timeRange = val;
      if (val === 'custom') {
        customDates.style.display = 'flex';
        const today = new Date();
        const past30 = new Date();
        past30.setDate(today.getDate() - 30);
        
        startDateInput.value = past30.toISOString().split('T')[0];
        endDateInput.value = today.toISOString().split('T')[0];
        state.dashboardFilter.startDate = startDateInput.value;
        state.dashboardFilter.endDate = endDateInput.value;
      } else {
        customDates.style.display = 'none';
        state.dashboardFilter.startDate = '';
        state.dashboardFilter.endDate = '';
      }
      
      let newView = 'month';
      if (val === 'day') newView = 'day';
      else if (val === 'week') newView = 'week';
      else if (val === 'year') newView = 'year';
      else if (val === 'custom') {
        const days = (new Date(state.dashboardFilter.endDate) - new Date(state.dashboardFilter.startDate)) / (1000 * 60 * 60 * 24);
        newView = days <= 60 ? 'month' : 'year';
      }
      updateChartViewActiveButton(newView);
      state.dashboardChartView = newView;
      
      updateDashboardStats();
    });
  }

  if (startDateInput) {
    startDateInput.addEventListener('change', () => {
      state.dashboardFilter.startDate = startDateInput.value;
      updateDashboardStats();
    });
  }

  if (endDateInput) {
    endDateInput.addEventListener('change', () => {
      state.dashboardFilter.endDate = endDateInput.value;
      updateDashboardStats();
    });
  }

  if (saleFilter) {
    saleFilter.addEventListener('change', () => {
      state.dashboardFilter.saleUser = saleFilter.value;
      updateDashboardStats();
    });
  }

  document.querySelectorAll('.chart-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      state.dashboardChartView = view;
      updateChartViewActiveButton(view);
      
      const filteredOrders = getFilteredDashboardOrders();
      renderRevenueChart(filteredOrders);
    });
  });
}

export function setupDashboardQuickActions() {
  const quickOrderBtn = document.getElementById('btn-quick-order');
  const addProdBtn = document.getElementById('dash-btn-add-product');
  const newOrdBtn = document.getElementById('dash-btn-new-order');
  const viewAllBtn = document.getElementById('btn-view-all-history');

  if (quickOrderBtn) {
    quickOrderBtn.addEventListener('click', () => {
      switchTab('invoice-panel');
    });
  }
  
  if (addProdBtn) {
    addProdBtn.addEventListener('click', () => {
      switchTab('products-panel');
      openProductModal();
    });
  }
  
  if (newOrdBtn) {
    newOrdBtn.addEventListener('click', () => {
      switchTab('invoice-panel');
    });
  }
  
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', () => {
      switchTab('history-panel');
    });
  }
}
