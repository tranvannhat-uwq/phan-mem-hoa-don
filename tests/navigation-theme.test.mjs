import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('gear menu has no navigation color customization controls or runtime', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const css = read('style.css');

  assert.doesNotMatch(html, /nav-color-settings|nav-color-picker|nav-color-swatch|Màu thanh điều hướng|Màu tùy chọn/);
  assert.doesNotMatch(main, /navigation-theme|setupNavigationColorSettings|applyNavigationColor|sovie_nav_color/);
  assert.doesNotMatch(css, /nav-color-settings|nav-color-picker|nav-color-swatch|btn-reset-nav-color/);
  assert.match(css, /background-color: var\(--nav-background-color\)/);
  assert.match(css, /\.sidebar > \.nav-menu > \.nav-item > \.nav-link[\s\S]*var\(--nav-foreground-color\)/);
  assert.doesNotMatch(css, /\.sidebar \.nav-link\s*\{\s*color:\s*var\(--nav-foreground-color\)/);
  assert.match(css, /\.purchase-menu-link\s*\{[\s\S]*color:\s*var\(--text-primary\)/);
  assert.match(css, /\.staff-menu \.staff-menu-link\s*\{[\s\S]*color:\s*var\(--text-primary\)/);
});
