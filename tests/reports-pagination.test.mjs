import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { paginationDocument } from './helpers/list-pagination-dom.mjs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const pagination = read('js/components/list-pagination.js').replace(/^export /gm, '');
const reports = read('js/components/reports.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const rows = Array.from({ length: 237 }, (_, id) => ({ id, code: `KH-${id}`, name: `Customer ${id}`,
  debt: id, amount: id, quantity: id, count: id, phone: '0123456789' }));

function harness({ manual = false, extras = {} } = {}) {
  const dom = paginationDocument();
  const calls = [];
  const pending = [];
  const state = { currentUser: { id: 'admin', role: 'admin' }, retentionEpoch: 0, users: [] };
  const payload = input => ({ rows: rows.slice(input.offset, input.offset + input.limit), total: rows.length,
    summary: { total_debt: 123456, overdue_debt: 9876 } });
  const context = vm.createContext({ state, document: dom.document, window: {}, console,
    formatCurrency: value => String(value), formatDateTime: value => value,
    getManagerDisplayName: () => 'Manager', getUserDisplayName: value => value, safeCreateIcons() {},
    dbFetchPhase5Report: input => {
      calls.push(input);
      return manual ? new Promise((resolve, reject) => pending.push({ resolve, reject, input })) : Promise.resolve(payload(input));
    }, ...extras });
  vm.runInContext(`${pagination}\n${reports}`, context);
  return { ...dom, state, calls, pending, payload, run: code => vm.runInContext(code, context) };
}

test('debt report reaches every server page beyond 200 rows and totals remain for the whole result', async () => {
  const h = harness();
  await h.run('renderDebtReport()');
  const seen = [];
  const collect = () => seen.push(...[...h.node('report-debt-table-body').innerHTML.matchAll(/>KH-(\d+)</g)].map(match => Number(match[1])));
  collect();
  for (let page = 1; page < 12; page++) {
    h.node('report-debt-pagination').querySelectorAll('[data-page]')[2].click();
    await flush();
    collect();
    assert.equal(h.node('report-debt-total-stat').innerText, '123456');
  }
  assert.deepEqual(seen, rows.map(row => row.id));
  assert.deepEqual(h.calls.map(call => call.offset), Array.from({ length: 12 }, (_, page) => page * 20));
  assert.ok(h.calls.every(call => call.limit === 20 && call.type === 'debt'));
  h.node('report-debt-search').value = 'Customer';
  await h.run('renderDebtReport()');
  assert.equal(h.calls.at(-1).offset, 0);
  assert.equal(h.calls.at(-1).search, 'Customer');
});

test('all return groupings use server pagination and changing grouping resets the offset', async () => {
  const h = harness();
  for (const mode of ['product', 'customer', 'employee']) {
    h.node('report-return-filter').value = mode;
    await h.run('renderReturnsReport()');
    assert.equal(h.calls.at(-1).offset, 0);
    h.node('report-return-pagination').querySelectorAll('[data-page]')[3].click();
    await flush();
    const lastOffset = Math.floor((rows.length - 1) / h.calls.at(-1).limit) * h.calls.at(-1).limit;
    assert.equal(h.calls.at(-1).offset, lastOffset);
    assert.equal(h.calls.at(-1).mode, mode);
    assert.ok(h.node('report-return-pagination').innerHTML.includes(`${lastOffset + 1}–237`));
    const nextSize = h.calls.at(-1).limit === 50 ? 100 : 50;
    h.node('report-return-pagination').querySelector('[data-page-size]').change(nextSize);
    await flush();
    assert.equal(h.calls.at(-1).limit, nextSize);
    assert.equal(h.calls.at(-1).offset, 0);
  }
});

test('delayed success or failure from the old filter cannot replace the current report', async () => {
  for (const type of ['debt', 'returns']) {
    for (const fails of [false, true]) {
      const h = harness({ manual: true });
      const render = type === 'debt' ? 'renderDebtReport()' : 'renderReturnsReport()';
      const first = h.run(render);
      h.node('report-debt-search').value = 'new';
      h.node('report-return-filter').value = 'customer';
      const second = h.run(render);
      h.pending[1].resolve({ ...h.payload(h.pending[1].input), rows: [{ ...rows[0], code: 'CURRENT' }] });
      await second;
      if (fails) h.pending[0].reject(new Error('Stale failure'));
      else h.pending[0].resolve({ ...h.payload(h.pending[0].input), rows: [{ ...rows[0], code: 'OLD' }] });
      await first;
      const body = h.node(type === 'debt' ? 'report-debt-table-body' : 'report-return-table-body').innerHTML;
      assert.match(body, /CURRENT/);
      assert.doesNotMatch(body, /OLD|Không tải được/);
    }
  }
});

test('when server rows disappear, the report fetches the last valid page instead of showing an empty high page', async () => {
  const h = harness({ manual: true });
  const first = h.run('renderDebtReport()');
  h.pending[0].resolve(h.payload(h.pending[0].input));
  await first;
  h.run('debtReportPager.setPage(11)');
  const last = h.run('renderDebtReport()');
  h.pending[1].resolve({ rows: [], total: 21, summary: {} });
  await flush();
  assert.equal(h.pending[2].input.offset, 20);
  h.pending[2].resolve({ rows: [rows[20]], total: 21, summary: {} });
  await last;
  assert.match(h.node('report-debt-table-body').innerHTML, /KH-20/);
  assert.match(h.node('report-debt-pagination').innerHTML, /21–21 \/ 21/);
});

test('pager containers exist outside their scrollable tables for every newly paged list', () => {
  const html = read('index.html');
  for (const id of ['report-debt', 'report-return', 'report-kpi', 'pricelists', 'brands', 'users', 'payroll',
    'payroll-product-groups', 'customer-debt-history', 'debt-history']) {
    assert.equal(html.split(`id="${id}-pagination"`).length - 1, 1, id);
  }
});

test('employee Excel export fetches all bounded pages instead of truncating at 100 employees', async () => {
  const calls = [];
  let exported;
  const h = harness({ extras: {
    dbFetchEmployeeBusinessReport: async input => {
      calls.push(input);
      return { total: 237, rows: rows.slice(input.offset, input.offset + input.limit)
        .map(row => ({ employee_name: row.name, employee_code: row.code })) };
    },
    XLSX: { utils: { json_to_sheet: data => { exported = data; return {}; }, book_new: () => ({}), book_append_sheet() {} }, writeFile() {} }
  } });
  h.run("employeeBusinessFilters = () => ({limit:100, offset:0, include_summary:false, include_series:false})");
  await h.run('exportEmployeeBusinessReport()');
  assert.deepEqual(calls.map(call => call.offset), [0, 100, 200]);
  assert.equal(exported.length, 237);
  assert.equal(exported.at(-1)['Mã tài khoản'], 'KH-236');
});
