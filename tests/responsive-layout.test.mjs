import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('workspace declares a mobile viewport and versioned responsive stylesheet', () => {
  const html = read('index.html');

  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover"/);
  assert.match(html, /style\.css\?v=20261002-mobile-data-recovery-v1/);
  assert.match(html, /id="btn-mobile-nav-toggle"[\s\S]*aria-controls="primary-navigation"/);
  assert.match(html, /id="btn-toggle-dashboard-filters"[\s\S]*aria-controls="dashboard-filter-content"/);
});

test('authenticated workspace collapses safely across phone widths', () => {
  const css = read('style.css');

  assert.match(css, /\.main-content[\s\S]*margin-top: calc\(96px \+ env\(safe-area-inset-top, 0px\)\)/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.dashboard-filter-grid\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.widgets-grid\s*\{[\s\S]*repeat\(2, minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 350px\)[\s\S]*\.widgets-grid\s*\{[\s\S]*minmax\(0, 1fr\)/);
  assert.match(css, /\.purchase-nav-item \.purchase-menu,[\s\S]*position: fixed/);
  assert.match(css, /\.mobile-nav-toggle\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /\.sidebar\.open \.nav-menu\s*\{[\s\S]*display:\s*flex/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.sidebar\s*\{[\s\S]*z-index: 1001 !important/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.sidebar-overlay\s*\{[\s\S]*backdrop-filter: none/);
  assert.match(css, /\.dashboard-toolbar:not\(\.is-filter-open\) \.dashboard-filter-grid\s*\{[\s\S]*display: none/);
  assert.match(css, /\.dashboard-toolbar\.is-filter-open \.dashboard-filter-grid\s*\{[\s\S]*position: absolute/);
});

test('mobile navigation keeps the existing panel switching and closes accessibly', () => {
  const main = read('js/main.js');

  assert.match(main, /btn-mobile-nav-toggle/);
  assert.match(main, /toggleMobileSidebar\(\)/);
  assert.match(main, /event\.key === 'Escape'/);
  assert.match(main, /mobile-nav-open/);
  assert.match(main, /closeMobileSidebar\(\);/);
});

test('dashboard filter popover is wired to the existing filter controls', () => {
  const dashboard = read('js/components/dashboard.js');

  assert.match(dashboard, /btn-toggle-dashboard-filters/);
  assert.match(dashboard, /dashboard-filter-content/);
  assert.match(dashboard, /setFilterPopupOpen\(!isOpen\)/);
  assert.match(dashboard, /btn-close-dashboard-filters/);
});
