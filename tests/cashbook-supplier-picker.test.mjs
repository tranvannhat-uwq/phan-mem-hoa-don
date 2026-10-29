import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/so_quy.js', import.meta.url), 'utf8');
const pickerCode = source.slice(source.indexOf('function setupPaymentRecipientPicker()'), source.indexOf('// Helper: load/save starting balances'));

function harness(suppliers) {
  const document = { activeElement: null, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } };
  const element = () => ({
    dataset: {}, attrs: {}, handlers: {}, value: '', hidden: true, innerHTML: '',
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    classList: { toggle() {} }, scrollIntoView() {},
    focus() { if (document.activeElement !== this) { document.activeElement = this; this.handlers.focus?.(); } },
    fire(name, values = {}) {
      const event = { prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...values };
      this.handlers[name]?.(event);
      return event;
    }
  });
  const picker = element(), input = element(), toggle = element(), list = element(), form = element();
  input.form = form;
  list.querySelectorAll = () => Array.from(list.innerHTML.matchAll(/data-index="(\d+)"/g), match => {
    const option = element(); option.dataset.index = match[1]; return option;
  });
  const nodes = { 'payment-recipient-picker': picker, 'payment-recipient': input, 'payment-recipient-toggle': toggle, 'payment-recipient-list': list };
  document.getElementById = id => nodes[id];
  picker.contains = target => Object.values(nodes).includes(target);
  const state = { suppliers, currentUser: { role: 'accounting' } };
  const context = vm.createContext({ document, state, escapeCashbookHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') });
  vm.runInContext(`${pickerCode}\nsetupPaymentRecipientPicker();`, context);
  return { input, toggle, list, picker, form, document, state };
}

test('accounting can open every supplier with the arrow and select the exact ID for duplicate names', () => {
  const h = harness([{ id: 's1', name: 'Việt Long', code: 'NCC01' }, { id: 's2', name: 'Việt Long', code: 'NCC02' }]);
  h.input.value = 'không khớp';
  h.toggle.fire('click');
  assert.equal(h.list.hidden, false);
  assert.match(h.list.innerHTML, /NCC01/);
  assert.match(h.list.innerHTML, /NCC02/);
  assert.equal(h.input.attrs['aria-expanded'], 'true');
  h.list.fire('click', { target: { closest: () => ({ dataset: { index: '1' } }) } });
  assert.equal(h.input.value, 'Việt Long — NCC02');
  assert.equal(h.input.dataset.supplierId, 's2');
  assert.equal(h.list.hidden, true);
  h.input.value = 'Người nhận khác';
  h.input.fire('input');
  assert.equal(h.input.dataset.supplierId, undefined);
  assert.equal(h.input.value, 'Người nhận khác');
});

test('search handles Vietnamese accents, keyboard selection, empty lists and form reset', () => {
  const h = harness([{ id: 's1', name: 'Việt Long <A>', code: 'VL01' }, { id: 'old', name: 'Việt Long cũ', isActive: false }]);
  h.input.value = 'viet long';
  h.input.fire('input');
  assert.match(h.list.innerHTML, /Việt Long &lt;A&gt;/);
  assert.doesNotMatch(h.list.innerHTML, /Việt Long cũ/);
  assert.equal(h.input.attrs['aria-activedescendant'], undefined);
  h.input.fire('keydown', { key: 'ArrowDown' });
  assert.equal(h.input.attrs['aria-activedescendant'], 'payment-recipient-option-0');
  assert.equal(h.input.fire('keydown', { key: 'Enter' }).prevented, true);
  assert.equal(h.input.dataset.supplierId, 's1');
  h.form.fire('reset');
  assert.equal(h.input.dataset.supplierId, undefined);
  h.state.suppliers = [];
  h.toggle.fire('click');
  assert.match(h.list.innerHTML, /Chưa có nhà cung cấp/);
  h.input.fire('keydown', { key: 'Escape' });
  assert.equal(h.list.hidden, true);
  h.toggle.fire('click');
  h.document.handlers.pointerdown({ target: {} });
  assert.equal(h.list.hidden, true);
});
