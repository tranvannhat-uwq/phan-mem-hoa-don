// Đối tượng trạng thái toàn cục của ứng dụng (State)
export const state = {
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
  isQuickCustomerMode: false,
  dashboardFilter: {
    timeRange: 'month',
    startDate: '',
    endDate: '',
    saleUser: 'all'
  },
  dashboardChartView: 'month' // 'day', 'week', 'month', 'year'
};
