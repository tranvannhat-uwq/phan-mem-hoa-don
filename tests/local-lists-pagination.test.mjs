import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { paginationDocument } from './helpers/list-pagination-dom.mjs';

const read = file => readFileSync(new URL(`../js/components/${file}.js`, import.meta.url), 'utf8');
const pagination = read('list-pagination').replace(/^export /gm, '');

test('user paging preserves action IDs and global row numbers, then resets for a search', () => {
  const dom = paginationDocument();
  const users = Array.from({ length: 53 }, (_, index) => ({ id: `u${index}`, username: `USER-${index}`,
    displayName: `Tên ${index}`, role: 'sale', isActive: true }));
  users.push({ id: 'inactive', username: 'HIDDEN', isActive: false });
  const context = vm.createContext({ document: dom.document, state: { users, companies: [] },
    isActiveUser: user => user.isActive !== false, getCompanyNameById: () => 'Company', safeCreateIcons() {} });
  const source = read('users');
  const render = source.slice(source.indexOf('function normalizeUserSearch('), source.indexOf('export function openUserModal'));
  vm.runInContext(`${pagination}; const usersPager = createListPagination('users-pagination');
    ${render.replace(/^export /gm, '')}; renderUsersTable();`, context);
  assert.equal((dom.node('users-table-body').innerHTML.match(/<tr>/g) || []).length, 20);
  dom.node('users-pagination').querySelectorAll('[data-page]')[2].click();
  assert.match(dom.node('users-table-body').innerHTML, />21<\/td>/);
  assert.match(dom.node('users-table-body').innerHTML, /data-id="u20"/);
  assert.doesNotMatch(dom.node('users-table-body').innerHTML, /data-id="u0"/);
  dom.node('users-pagination').querySelectorAll('[data-page]')[3].click();
  assert.equal((dom.node('users-table-body').innerHTML.match(/<tr>/g) || []).length, 13);
  dom.node('user-search-input').value = 'USER-52';
  vm.runInContext('renderUsersTable()', context);
  assert.match(dom.node('users-table-body').innerHTML, /data-id="u52"/);
  assert.match(dom.node('users-pagination').innerHTML, /1–1 \/ 1 dòng/);
  dom.node('user-search-input').value = 'HIDDEN';
  vm.runInContext('renderUsersTable()', context);
  assert.match(dom.node('users-pagination').innerHTML, /0–0 \/ 0 dòng/);
  assert.doesNotMatch(dom.node('users-table-body').innerHTML, /data-id="inactive"/);
});

test('payroll pages reuse the database payload and preserve the total for the entire period', async () => {
  const dom = paginationDocument();
  let fetchCount = 0;
  const payrollRows = Array.from({ length: 53 }, (_, index) => ({ userId: `u${index}`, userCode: `NV-${index}`,
    userName: `Employee ${index}`, netSalary: 1000000 }));
  const payload = { period: '2026-10', rows: payrollRows, isLocked: false };
  dom.node('payroll-period-select').value = payload.period;
  const context = vm.createContext({ document: dom.document, state: { currentUser: { role: 'admin' } },
    window: {}, formatCurrency: value => String(value), safeCreateIcons() {}, showToast() {}, console,
    dbFetchPayrollPeriod: async () => { fetchCount++; return payload; } });
  const source = read('payroll').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${pagination}; ${source}`, context);
  await vm.runInContext('renderPayrollTable()', context);
  assert.equal(dom.node('stat-total-payroll-period').innerText, '53000000');
  dom.node('payroll-pagination').querySelectorAll('[data-page]')[3].click();
  assert.match(dom.node('payroll-table-body').innerHTML, /data-user-id="u40"/);
  assert.equal((dom.node('payroll-table-body').innerHTML.match(/<tr>/g) || []).length, 13);
  assert.equal(dom.node('stat-total-payroll-period').innerText, '53000000');
  assert.equal(fetchCount, 1, 'local page navigation must not recalculate payroll on the server');
  payload.rows = payrollRows.slice(0, 21);
  await vm.runInContext('renderPayrollTable()', context);
  assert.match(dom.node('payroll-table-body').innerHTML, /data-user-id="u20"/);
  assert.match(dom.node('payroll-pagination').innerHTML, /21–21 \/ 21 dòng/);
});
