import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const dashboard = read('js/components/dashboard.js');

test('dashboard breakdown uses four distinct chart presentations', () => {
  assert.match(html, /id="revenue-chart"/);
  assert.match(dashboard, /type:\s*'doughnut'/);
  assert.match(dashboard, /type:\s*'line'/);
  assert.match(dashboard, /orientation:\s*'vertical'/);
  assert.match(dashboard, /orientation:\s*'horizontal'/);
  assert.match(dashboard, /indexAxis:\s*type === 'bar' \? \(isHorizontalBar \? 'y' : 'x'\)/);
  assert.match(dashboard, /const isLine = type === 'line'/);
  assert.match(dashboard, /fill:\s*isLine/);
  assert.match(dashboard, /tension:\s*isLine \? 0\.34 : 0/);
  assert.match(dashboard, /dashboardBreakdownCharts\.set\(key, chart\)/);
});

test('dashboard filters use a structured responsive control bar', () => {
  const css = read('style.css');
  assert.match(html, /class="dashboard-toolbar-head"/);
  assert.match(html, /class="dashboard-filter-grid"/);
  assert.match(html, /class="dashboard-festival-toggle"/);
  assert.match(html, /class="filter-group dashboard-filter-field dashboard-filter-sale"/);
  assert.match(html, /id="dashboard-customer-search-input"[^>]*placeholder="Tìm tên, mã hoặc số điện thoại\.\.\."/);
  assert.match(html, /id="dashboard-customer-suggestions"/);
  assert.match(html, /class="dashboard-people-filters"/);
  assert.doesNotMatch(html.slice(html.indexOf('class="dashboard-toolbar glass-panel"'), html.indexOf('<!-- Widgets Grid -->')), /class="filter-row-[12]"/);
  assert.match(css, /\.dashboard-filter-grid\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /\.dashboard-people-filters\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.dashboard-filter-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
});

test('customer autocomplete persists and drives the existing dashboard customer filter', () => {
  assert.match(dashboard, /function setupCustomerAutocomplete\(\)/);
  assert.match(dashboard, /setupSaleAutocomplete\(\);\s*setupCustomerAutocomplete\(\);/);
  assert.match(dashboard, /state\.dashboardFilter\.customerId = custId/);
  assert.match(dashboard, /customer_id:\s*state\.dashboardFilter\.customerId \|\| 'all'/);
  assert.match(dashboard, /orders = orders\.filter\(o => String\(o\.customerId\) === String\(state\.dashboardFilter\.customerId\)\)/);
  assert.doesNotMatch(dashboard, /populateDashboardFilters\(\)\s*\{[\s\S]{0,220}state\.dashboardFilter\.customerId = 'all'/);
});

test('all visual breakdowns use the same filtered server payload as before', () => {
  assert.match(dashboard, /rows:\s*payload\.by_company/);
  assert.match(dashboard, /rows:\s*payload\.by_brand/);
  assert.match(dashboard, /rows:\s*filterLoginEmployeeRevenueRows\(payload\.by_salesperson, state\.users\)/);
  assert.match(dashboard, /rows:\s*payload\.by_customer/);
  assert.match(dashboard, /await dbFetchPhase5Dashboard/);
});

test('chart range buttons update only the chart and leave dashboard filters unchanged', () => {
  const buttonHandler = dashboard.slice(dashboard.indexOf("document.querySelectorAll('.chart-view-btn')"));
  assert.match(buttonHandler, /state\.dashboardChartView\s*=\s*view;/);
  assert.match(buttonHandler, /updateRevenueChartForView\(view\)/);
  assert.doesNotMatch(buttonHandler.slice(0, buttonHandler.indexOf('function setupSaleAutocomplete')), /dashboardFilter\.timeRange\s*=\s*view/);
  assert.match(dashboard, /buildDashboardChartSeries\(payload\?\.series \|\| \[\], state\.dashboardChartView, payload\?\.period \|\| \{\}\)/);
  assert.match(dashboard, /Doanh số gốc[\s\S]*?Doanh số ròng/);
});

test('chart view transitions update one chart instance instead of rebuilding the dashboard', () => {
  assert.match(dashboard, /revenueChartInstance\.data\.labels\s*=\s*chartSeries\.labels/);
  assert.match(dashboard, /revenueChartInstance\.data\.datasets\[0\]\.data\s*=\s*chartSeries\.dataPoints/);
  assert.match(dashboard, /revenueChartInstance\.update\(\)/);
  assert.doesNotMatch(dashboard.slice(dashboard.indexOf('function renderServerRevenueChart'), dashboard.indexOf('function dashboardRequestFiltersForRange')), /revenueChartInstance\.destroy\(\)/);
});

test('revenue chart animates progressively and respects reduced motion', () => {
  assert.match(dashboard, /prefers-reduced-motion:\s*reduce/);
  assert.match(dashboard, /duration:\s*900/);
  assert.match(dashboard, /easing:\s*'easeOutQuart'/);
  assert.match(dashboard, /context\.dataIndex \* 35/);
  assert.match(dashboard, /animation:\s*getRevenueChartAnimation\(\)/);
});

test('chart cards have accessible labels and empty states', () => {
  for (const id of ['company', 'brand', 'salesperson', 'customer']) {
    assert.match(html, new RegExp(`id="${id}-revenue-chart"[^>]*role="img"[^>]*aria-label=`));
    assert.match(html, new RegExp(`id="${id}-revenue-chart-empty"`));
  }
});
