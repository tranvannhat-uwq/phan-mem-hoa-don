import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('staff selectors use the shared searchable select without changing native values', () => {
  const expectedBindings = [
    ['js/components/customers.js', 'cust-managed-by'],
    ['js/components/invoice.js', 'quick-cust-manager'],
    ['js/components/users.js', 'customer-managed-filter'],
    ['js/components/so_quy.js', 'so-quy-creator-select'],
    ['js/components/so_quy.js', 'so-quy-employee-select'],
    ['js/components/so_quy.js', 'cashbook-edit-collector'],
    ['js/components/activity-log.js', 'activity-actor-filter']
  ];

  for (const [file, selectId] of expectedBindings) {
    assert.match(
      read(file),
      new RegExp(`makeSelectSearchable\\(['\"]${selectId}['\"]`),
      `${selectId} must provide searchable staff selection`
    );
  }
});

test('shared searchable select remains idempotent and supports Vietnamese text', () => {
  const utility = read('js/utils.js');
  assert.match(utility, /searchable-select-wrapper/);
  assert.match(utility, /Tránh tạo lặp nhiều lần wrapper/);
  assert.match(utility, /normalize\("NFD"\)/);
  assert.match(utility, /select\.dispatchEvent\(new Event\('change'\)\)/);
  assert.match(utility, /observer\.observe\(select, \{ childList: true, subtree: true, attributes: true \}\)/);
});

