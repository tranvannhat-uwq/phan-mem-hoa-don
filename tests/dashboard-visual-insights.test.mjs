import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const dashboard = read('js/components/dashboard.js');

test('dashboard combines line, doughnut and horizontal ranking charts', () => {
  assert.match(html, /id="revenue-chart"/);
  assert.match(dashboard, /type:\s*'doughnut'/);
  assert.match(dashboard, /indexAxis:\s*isDoughnut \? undefined : 'y'/);
  assert.match(dashboard, /dashboardBreakdownCharts\.set\(key, chart\)/);
});

test('all visual breakdowns use the same filtered server payload as before', () => {
  assert.match(dashboard, /rows:\s*payload\.by_company/);
  assert.match(dashboard, /rows:\s*payload\.by_brand/);
  assert.match(dashboard, /rows:\s*payload\.by_salesperson/);
  assert.match(dashboard, /rows:\s*payload\.by_customer/);
  assert.match(dashboard, /await dbFetchPhase5Dashboard/);
});

test('chart cards have accessible labels and empty states', () => {
  for (const id of ['company', 'brand', 'salesperson', 'customer']) {
    assert.match(html, new RegExp(`id="${id}-revenue-chart"[^>]*role="img"[^>]*aria-label=`));
    assert.match(html, new RegExp(`id="${id}-revenue-chart-empty"`));
  }
});
