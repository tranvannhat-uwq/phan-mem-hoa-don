import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer multi-select CSS uses floating popover with animation and avoids form stretching', () => {
  const css = read('style.css');

  // Dropdown must be absolutely positioned so it does NOT stretch the grid or form
  assert.match(css, /\.customer-multi-select-dropdown\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.customer-multi-select-dropdown\s*\{[^}]*z-index:\s*1000/);

  // Must have entrance animation for smooth popover effect
  assert.match(css, /\.customer-multi-select-dropdown\s*\{[^}]*animation:\s*customerDropdownSlideIn/);
  assert.match(css, /@keyframes\s+customerDropdownSlideIn/);

  // Stacking context elevation when opened
  assert.match(css, /\.customer-filter-section:has\(\.customer-multi-select\.open\)\s*\{[^}]*z-index:\s*60/);
  assert.match(css, /\.customer-multi-select\.open\s*\{[^}]*z-index:\s*70/);

  // Chevron smooth rotation
  assert.match(css, /\.customer-multi-select\.open\s+\.customer-multi-select-chevron\s*\{[^}]*transform:\s*rotate\(180deg\)/);

  // Selected option visual highlighting
  assert.match(css, /\.customer-multi-select-option\.selected\s*\{/);
});

test('customer multi-select option correctly respects hidden attribute and display none', () => {
  const css = read('style.css');

  // Must NOT have display: flex !important which overrules [hidden]
  assert.doesNotMatch(css, /\.customer-multi-select-option\s*\{[^}]*display:\s*flex\s*!important/);

  // Must have explicit [hidden] rule with !important
  assert.match(css, /\.customer-multi-select-option\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test('customer multi-select search supports Vietnamese aliases, compact queries and code matching', () => {
  const customers = read('js/components/customers.js');

  // Must define province search aliases
  assert.match(customers, /CUSTOMER_PROVINCE_SEARCH_ALIASES/);
  assert.match(customers, /sai gon/);
  assert.match(customers, /hanoi/);
  assert.match(customers, /vung tau/);
  assert.match(customers, /da nang/);
  assert.match(customers, /hue/);

  // Multi-select option search terms incorporate aliases and compact form
  assert.match(customers, /compactText\s*=\s*normText\.replace\(\/\[\^a-z0-9\]\/g,\s*''\)/);
  assert.match(customers, /CUSTOMER_PROVINCE_SEARCH_ALIASES\[val\]/);

  // Multi-select search input handles compact query and sets both hidden and display
  assert.match(customers, /item\.style\.display\s*=\s*show\s*\?\s*''\s*:\s*'none'/);
  assert.match(customers, /item\.hidden\s*=\s*!show/);

  // Reset search when opening dropdown
  assert.match(customers, /searchInput\.value\s*=\s*''/);

  // Escape key support
  assert.match(customers, /event\.key\s*===\s*'Escape'/);

  // Selected class toggling
  assert.match(customers, /item\.classList\.toggle\('selected',\s*isChecked\)/);
});

test('customer multi-select options display in horizontal rows with left alignment', () => {
  const css = read('style.css');

  // Multi-grid label style must use direct child combinator so it doesn't turn multi-select options into vertical columns
  assert.match(css, /\.customer-filter-multi-grid\s*>\s*label/);

  // Multi-select option must explicitly specify row layout and left text alignment
  assert.match(css, /\.customer-multi-select-option[^{]*\{[^}]*flex-direction:\s*row/);
  assert.match(css, /\.customer-multi-select-option[^{]*\{[^}]*text-align:\s*left/);
});
