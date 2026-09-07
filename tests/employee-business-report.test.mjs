import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/0064_employee_business_report.sql');
const hotfix = read('migrations/0065_fix_employee_business_report_employee_id.sql');
const attributionHotfix = read('migrations/0066_attribute_employee_report_to_customer_manager.sql');
const egressHotfix = read('migrations/0067_employee_business_report_egress_optimization.sql');
const service = read('js/services/supabase.js');
const reports = read('js/components/reports.js');
const html = read('index.html');

test('employee business report is a read-only authenticated RPC', () => {
  assert.match(migration, /rpc_get_employee_business_report\(p_input jsonb/);
  assert.match(migration, /LANGUAGE plpgsql STABLE SECURITY DEFINER/);
  assert.match(migration, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_get_employee_business_report\(jsonb\) FROM PUBLIC, anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_get_employee_business_report\(jsonb\) TO authenticated/);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE)\s+INTO\s+public\.(?:orders|cashbook_transactions|customer_debt_transactions|sales_returns|payroll_entries|commission_transactions)\b/i);
});

test('report uses Vietnam dates, server-side sale scope and excludes invalid documents', () => {
  assert.match(migration, /Asia\/Ho_Chi_Minh/);
  assert.match(migration, /interval '366 days'/);
  assert.match(migration, /IF requested_employee = 'all' THEN requested_employee := NULL/);
  assert.match(migration, /IF actor\.role = 'sale' THEN[\s\S]*requested_employee := actor\.id/);
  assert.match(migration, /sale\.status NOT IN \('cancelled', 'canceled', 'draft'\)/);
  assert.match(migration, /ret\.status NOT IN \('cancelled', 'canceled'\)/);
  assert.match(migration, /transaction_type IN \('payment', 'payment_amend'\) AND debt_change < 0/);
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM public\.customer_debt_transactions reversed WHERE reversed\.reversal_of_id = ledger_rows\.id\)/);
  assert.match(migration, /tx\.status NOT IN \('cancelled', 'canceled'\)/);
});

test('ledger identity is normalized without shadowing the source employee column', () => {
  assert.match(hotfix, /AS report_employee_id/);
  assert.match(hotfix, /AS report_employee_name/);
  assert.match(hotfix, /SELECT report_employee_id AS employee_id/);
  assert.match(hotfix, /GROUP BY report_employee_id/);
});

test('employee performance follows customer management and receipts come from cashbook', () => {
  assert.match(attributionHotfix, /customer\.managed_by/);
  assert.match(attributionHotfix, /sale\.customer_manager_id/);
  assert.match(attributionHotfix, /FROM public\.cashbook_transactions cashbook/);
  assert.match(attributionHotfix, /lower\(COALESCE\(cashbook\.type, ''\)\) = 'thu'/);
  assert.match(attributionHotfix, /cashbook\.reversal_of_id IS NULL/);
  assert.match(attributionHotfix, /cashbook\.transaction_type, ''\)\) NOT LIKE '%reversal%'/);
  assert.match(attributionHotfix, /cashbook_metrics[\s\S]*AS collected/);
  assert.match(attributionHotfix, /COALESCE\(cashbook\.collected, 0\) AS collected/);
});

test('employee report bounds detail egress and allows unused aggregates to be omitted', () => {
  assert.match(egressHotfix, /detail_limit integer := LEAST\(GREATEST/);
  assert.match(egressHotfix, /detail_offset integer := GREATEST/);
  assert.match(egressHotfix, /include_summary boolean/);
  assert.match(egressHotfix, /include_series boolean/);
  assert.match(egressHotfix, /LIMIT detail_limit OFFSET detail_offset/);
  assert.match(egressHotfix, /'detail_total', \(SELECT count\(\*\) FROM detail_rows\)/);
  assert.match(reports, /EMPLOYEE_BUSINESS_CACHE_TTL_MS = 30_000/);
  assert.match(reports, /employeeBusinessReportInFlight/);
  assert.match(reports, /detailLimit: detail\.limit, detailOffset: page \* detail\.limit/);
  assert.match(reports, /includeSummary: false, includeSeries: false/);
});

test('browser displays and exports the Cloud report without local financial reconstruction', () => {
  assert.match(service, /rpc_get_employee_business_report/);
  assert.match(reports, /await fetchEmployeeBusinessReport/);
  assert.match(reports, /employee-business-export/);
  assert.match(reports, /globalThis\.XLSX/);
  assert.match(html, /data-subtab="employee"/);
  assert.match(html, /employee-business-detail-modal/);
  assert.match(html, /employee-business-detail-modal-content/);
  assert.match(html, /employee-business-detail-page-label/);
  assert.match(read('style.css'), /#employee-business-detail-modal \.employee-business-detail-modal-content[\s\S]*width: 96vw[\s\S]*max-width: none/);
  assert.match(read('style.css'), /#employee-business-detail-modal \.table-responsive[\s\S]*overflow: auto/);
  assert.doesNotMatch(reports.slice(reports.indexOf('renderEmployeeBusinessReport'), reports.indexOf('function renderReturnsReportLegacy')), /state\.(?:savedOrders|salesReturns|cashbookTransactions)/);
});
