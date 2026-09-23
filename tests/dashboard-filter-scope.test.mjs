import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const dashboard = read('js/components/dashboard.js');
const migration = read('migrations/0075_dashboard_filter_scope_consistency.sql');

test('dashboard sends a canonical brand value and the festival scope to the RPC', () => {
  assert.match(dashboard, /getBrandById/);
  assert.match(dashboard, /<option value="\$\{escapeHtml\(entry\.id\)\}">\$\{escapeHtml\(entry\.name\)\}<\/option>/);
  assert.match(dashboard, /state\.dashboardFilter\.brand = selectedBrand\.id/);
  assert.match(dashboard, /include_festival_allocation:\s*state\.dashboardFilter\.includeFestivalAllocation !== false/);
});

test('the replacement RPC resolves canonical and legacy brand identifiers', () => {
  assert.match(migration, /b\.id\s*=\s*COALESCE\([\s\S]*?item\.brand_id\)/);
  assert.match(migration, /b\.name\s*=\s*COALESCE\([\s\S]*?item\.brand_id\)/);
  assert.match(migration, /lower\(btrim\(b\.name\)\)\s*=\s*lower\(btrim\(COALESCE\(/);
  assert.match(migration, /brand\.id\s*=\s*brand_filter/);
  assert.match(migration, /lower\(btrim\(COALESCE\(brand\.name/);
  assert.match(migration, /CASE WHEN include_festival THEN snapshot\.payload->>'revenueBrand'/);
  assert.match(migration, /CASE WHEN include_festival THEN snapshot\.payload->>'revenueCompany'/);
});

test('all dashboard breakdowns use the same attributed item scope', () => {
  assert.match(migration, /scoped_orders AS/);
  assert.match(migration, /FROM attributed_items/);
  for (const key of ['by_company', 'by_brand', 'by_salesperson', 'by_customer', 'series', 'top_skus']) {
    const start = migration.indexOf(`'${key}'`);
    const end = migration.indexOf("'recent_orders'", start);
    assert.ok(start >= 0 && end > start, `${key} should be in the dashboard payload`);
    assert.match(migration.slice(start, end), /attributed_items/);
  }
  assert.match(migration, /'order_count', \(SELECT count\(\*\) FROM scoped_orders\)/);
  assert.doesNotMatch(migration, /'by_company'[\s\S]*?FROM visible_orders GROUP BY company_id/);
});

test('replacement migration preserves authenticated RPC boundaries and migration tracking', () => {
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_get_phase5_dashboard\(jsonb\) FROM PUBLIC, anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_get_phase5_dashboard\(jsonb\) TO authenticated/);
  assert.match(migration, /VALUES \('0075'/);
});
