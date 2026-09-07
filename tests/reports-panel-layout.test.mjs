import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('business reports panel is not nested inside the hidden settings panel', () => {
  const settingsStart = html.indexOf('<section id="settings-panel"');
  const reportsStart = html.indexOf('<section id="reports-panel"');
  assert.ok(settingsStart >= 0 && reportsStart > settingsStart);
  const beforeReports = html.slice(settingsStart, reportsStart);
  assert.match(beforeReports, /<\/section>\s*<!-- Báo cáo & KPI Panel -->\s*$/);
});

test('employee business report has a visible tab and report surface', () => {
  assert.match(html, /data-subtab="employee"/);
  assert.match(html, /id="report-subtab-employee"/);
  assert.match(html, /id="employee-business-table-body"/);
});
