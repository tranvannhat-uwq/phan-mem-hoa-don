import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { collectAllPages } from '../js/domain/pagination.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const source = read('js/components/suppliers.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

function harness(suppliers, query = '', library = null) {
  const output = [];
  const toasts = [];
  const button = {};
  const encode = ({ r, c }) => `${String.fromCharCode(65 + c)}${r + 1}`;
  const XLSX = library || {
    utils: {
      aoa_to_sheet(rows) {
        return Object.fromEntries(rows.flatMap((row, r) => row.map((v, c) => [encode({ r, c }), { v, t: typeof v === 'number' ? 'n' : 's' }])));
      },
      encode_cell: encode,
      encode_range: ({ s, e }) => `${encode(s)}:${encode(e)}`,
      book_new: () => ({ Sheets: {}, SheetNames: [] }),
      book_append_sheet: (book, sheet, name) => { book.Sheets[name] = sheet; book.SheetNames.push(name); }
    },
    writeFile: (book, name) => output.push({ book, name })
  };
  const context = vm.createContext({ state: { suppliers, suppliersPage: 2 }, XLSX,
    document: { getElementById: id => id === 'supplier-search-input' ? { value: query, addEventListener() {} } : id === 'btn-export-suppliers-excel' ? button : null },
    showToast: (...args) => toasts.push(args), console: { error() {} } });
  vm.runInContext(source, context);
  return { context, output, toasts, XLSX, button, run: () => vm.runInContext('exportSuppliersExcel()', context) };
}

test('supplier Excel exports every matching page without changing state, using stored financial totals', () => {
  const suppliers = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, code: `00${i}`, name: `Vendor ${String(i).padStart(2, '0')}`,
    debt: i === 0 ? -10 : 10, totalPurchase: 100, phone: '0900123456', address: 'Hà Nội', notes: '=SUM(A1:A2)' })).reverse();
  const before = JSON.stringify(suppliers);
  const h = harness(suppliers, '  VENDOR ');
  h.run();
  const { book, name } = h.output[0];
  const sheet = book.Sheets.DanhSachNhaCungCap;
  assert.match(name, /^DanhSachNhaCungCap_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.equal(sheet.C2.v, 'Vendor 00');
  assert.equal(sheet.C46.v, 'Vendor 44');
  assert.equal(sheet.C47.v, 'TỔNG CỘNG');
  assert.equal(sheet.F2.v, -10);
  assert.equal(sheet.F47.v, 430);
  assert.equal(sheet.G47.v, 4500);
  assert.equal(sheet.F47.t, 'n');
  assert.equal(sheet.D2.v, '0900123456');
  assert.equal(sheet.B2.v, '000');
  assert.equal(sheet.D2.t, 's');
  assert.equal(sheet.H2.v, '=SUM(A1:A2)');
  assert.equal(sheet.H2.t, 's');
  assert.equal(sheet.H2.f, undefined);
  assert.equal(sheet['!autofilter'].ref, 'A1:H46');
  assert.equal(JSON.stringify(suppliers), before);
  assert.equal(h.context.state.suppliersPage, 2);
});

test('export button uses the same code/name/phone search as the supplier list', () => {
  for (const query of ['ncc02', 'beta', '091234']) {
    const h = harness([{ code: 'NCC01', name: 'Alpha' }, { code: 'NCC02', name: 'Beta', phone: '0912345678' }], query);
    vm.runInContext('setupSupplierManagement()', h.context);
    h.button.onclick();
    const sheet = h.output[0].book.Sheets.DanhSachNhaCungCap;
    assert.equal(sheet.C2.v, 'Beta');
    assert.equal(sheet.C3.v, 'TỔNG CỘNG');
  }
});

test('empty lists, missing library and write failures do not report a successful export', () => {
  const empty = harness([{ name: 'Alpha' }], 'missing');
  empty.run();
  assert.equal(empty.output.length, 0);
  assert.equal(empty.toasts.at(-1)[1], 'warning');
  const absent = harness([{ name: 'Alpha' }]);
  absent.context.XLSX = undefined;
  absent.run();
  assert.equal(absent.output.length, 0);
  assert.equal(absent.toasts.at(-1)[1], 'warning');
  const failure = harness([{ name: 'Alpha' }]);
  failure.XLSX.writeFile = () => { throw new Error('write failed'); };
  failure.run();
  assert.equal(failure.toasts.at(-1)[1], 'danger');
});

test('supplier Cloud loading reaches rows beyond the API limit before replacing the list', async () => {
  const service = read('js/services/supabase.js');
  const start = service.indexOf('const fetchSuppliers = async () => {');
  const loader = service.slice(start, service.indexOf('const fetchPurchases', start)).replace('const fetchSuppliers', 'globalThis.fetchSuppliers');
  const rows = Array.from({ length: 1205 }, (_, i) => ({ id: String(i), name: `Vendor ${i}`, is_active: i !== 0, debt: '-20', total_purchase: '150' }));
  const ranges = [];
  let failed = null;
  const query = { select: () => query, order: () => query, range: (offset, end) => {
    ranges.push([offset, end]); return Promise.resolve({ data: rows.slice(offset, end + 1), count: rows.length, error: null });
  } };
  const context = vm.createContext({ state: { suppliers: [] }, tableProductsName: 'products',
    supabaseClient: { from: name => { assert.equal(name, 'suppliers'); return query; } }, collectAllPages,
    markDomainFailed: (_, error) => { failed = error; }, console: { log() {}, warn() {} } });
  vm.runInContext(loader, context);
  await context.fetchSuppliers();
  assert.equal(failed, null);
  assert.equal(ranges.length, 2);
  assert.equal(context.state.suppliers.length, 1204);
  assert.equal(context.state.suppliers.at(-1).id, '1204');
  assert.equal(context.state.suppliers.at(-1).debt, -20);
});
