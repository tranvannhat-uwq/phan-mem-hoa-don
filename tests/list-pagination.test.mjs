import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { paginationDocument } from './helpers/list-pagination-dom.mjs';

const pagination = readFileSync(new URL('../js/components/list-pagination.js', import.meta.url), 'utf8');
function harness() {
  const dom = paginationDocument();
  const context = vm.createContext({ document: dom.document });
  const createPager = vm.runInContext(`${pagination.replace(/^export /gm, '')}; createListPagination`, context);
  return { ...dom, pager: createPager('pager') };
}

test('all rows are reachable without duplication and source data is preserved', () => {
  const { pager, node } = harness();
  const rows = Array.from({ length: 237 }, (_, id) => ({ id }));
  const seen = [];
  function render() { seen.push(...pager.slice(rows, 'query', render).map(row => row.id)); }
  render();
  assert.equal(node('pager').querySelectorAll('[data-page]')[0].disabled, true);
  for (let page = 1; page < 12; page++) node('pager').querySelectorAll('[data-page]')[2].click();
  assert.deepEqual(seen, rows.map(row => row.id));
  assert.equal(rows.length, 237);
  assert.match(node('pager').innerHTML, /221–237 \/ 237 dòng/);
  assert.equal(node('pager').querySelectorAll('[data-page]')[2].disabled, true);
});

test('first, last, direct page and page size controls use bounded pages', () => {
  const { pager, node } = harness();
  const rows = Array.from({ length: 237 }, (_, id) => id);
  let visible;
  const render = () => { visible = pager.slice(rows, 'all', render); };
  render();
  node('pager').querySelectorAll('[data-page]')[3].click();
  assert.equal(visible[0], 220);
  node('pager').querySelector('[data-page-number]').change(2);
  assert.equal(visible[0], 20);
  node('pager').querySelector('[data-page-number]').change(-10);
  assert.equal(visible[0], 0);
  node('pager').querySelector('[data-page-number]').change(9999);
  assert.equal(visible[0], 220);
  node('pager').querySelector('[data-page-size]').change(50);
  assert.equal(visible.length, 50);
  assert.equal(visible[0], 0);
  node('pager').querySelectorAll('[data-page]')[3].click();
  assert.equal(visible[0], 200);
  node('pager').querySelectorAll('[data-page]')[0].click();
  assert.equal(visible[0], 0);
});

test('filters and customer identity reset the page; shrinking data clamps to its last valid page', () => {
  const { pager, node } = harness();
  const rows = Array.from({ length: 61 }, (_, id) => id);
  pager.slice(rows, ['customer-A', false], () => {});
  pager.setPage(3);
  assert.deepEqual(pager.slice(rows.slice(0, 21), ['customer-A', false], () => {}), [20]);
  pager.slice(rows, ['customer-B', false], () => {});
  assert.equal(pager.read(['customer-B', false]).offset, 0);
  pager.setPage(2);
  pager.slice(rows, ['customer-B', true], () => {});
  assert.equal(pager.read(['customer-B', true]).offset, 0);
  assert.deepEqual(pager.slice([], ['empty'], () => {}), []);
  assert.match(node('pager').innerHTML, /0–0 \/ 0 dòng/);
  assert.ok(node('pager').querySelectorAll('[data-page]').every(button => button.disabled));
});

test('loading and failure disable controls without losing the requested server page', () => {
  const { pager, node } = harness();
  const query = 'debt';
  pager.read(query);
  pager.render(237, () => {});
  pager.setPage(10);
  pager.render(0, () => assert.fail('No navigation while loading'), { busy: true });
  assert.equal(pager.read(query).offset, 200);
  assert.ok(node('pager').querySelectorAll('[data-page]').every(button => button.disabled));
  assert.equal(node('pager').querySelector('[data-page-size]').disabled, true);
  pager.render(0, () => {}, { error: true });
  assert.equal(pager.read(query).offset, 200);
  assert.match(node('pager').innerHTML, /Chưa tải được/);
});
