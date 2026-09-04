import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const { buildHistoryOrderWindowFilter } = await import('../js/services/supabase.js');

const augustStart = '2026-07-31T17:00:00.000Z';
const septemberStart = '2026-08-31T17:00:00.000Z';

test('history includes legacy orders without order_date by their created_at date', () => {
  assert.equal(
    buildHistoryOrderWindowFilter(augustStart, septemberStart),
    `and(order_date.gte.${augustStart},order_date.lt.${septemberStart}),and(order_date.is.null,created_at.gte.${augustStart},created_at.lt.${septemberStart})`
  );
});

test('history date filter preserves an open-ended range', () => {
  assert.equal(
    buildHistoryOrderWindowFilter(augustStart, null),
    `order_date.gte.${augustStart},and(order_date.is.null,created_at.gte.${augustStart})`
  );
  assert.equal(buildHistoryOrderWindowFilter(null, null), '');
});
