import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/input-picker.js', import.meta.url), 'utf8').replace(/^export /gm, '');

function harness(options) {
  let doc;
  class Element {
    constructor(tag) { this.tag = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = {}; this.value = ''; this.hidden = false; this.classList = { toggle() {} }; }
    append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node); this.children.push(node); node.parentNode = this; } }
    insertBefore(node, before) { this.children.splice(this.children.indexOf(before), 0, node); node.parentNode = this; }
    replaceChildren() { this.children = []; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    dispatchEvent(event) { for (const fn of this.handlers[event.type] || []) fn(event); return !event.defaultPrevented; }
    fire(type, args = {}) { const event = { type, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...args }; this.dispatchEvent(event); return event; }
    focus() { if (doc.activeElement !== this) { doc.activeElement = this; this.fire('focus'); } }
    scrollIntoView() {}
    querySelectorAll() { return this.children.flatMap(child => [...(child.attrs.role === 'option' ? [child] : []), ...child.querySelectorAll()]); }
  }
  doc = new Element('document'); doc.createElement = tag => new Element(tag);
  const form = new Element('form'), input = new Element('input'); input.form = form; form.append(input);
  const context = vm.createContext({ Event }); vm.runInContext(source, context);
  const setup = field => { context.setupInputPicker(field, { getOptions: () => options, label: 'Danh sách kiểm tra' }); return { wrapper: field.parentNode.parentNode, toggle: field.parentNode.children[1], list: field.parentNode.parentNode.children[1] }; };
  return { input, form, doc, setup, ...setup(input), newField() { const field = new Element('input'); field.form = form; form.append(field); return { input: field, ...setup(field) }; } };
}

test('fixed arrow opens all results, filters Vietnamese names and selects the exact customer or SKU identity', () => {
  const h = harness([{ id: 'c1', value: 'Việt Long — KH01', label: 'Việt Long', description: 'KH01' }, { id: 'c2', value: 'Việt Long — KH02', label: 'Việt Long', description: 'KH02' }]);
  h.input.value = 'không khớp'; h.toggle.fire('click');
  assert.equal(h.list.hidden, false); assert.equal(h.list.querySelectorAll().length, 2);
  h.input.value = 'viet long'; h.input.fire('input');
  assert.equal(h.list.querySelectorAll().length, 2);
  h.list.querySelectorAll()[1].fire('click');
  assert.equal(h.input.dataset.pickerId, 'c2'); assert.equal(h.input.value, 'Việt Long — KH02');
  assert.equal(h.list.hidden, true);
  h.input.value = 'Người nộp khác'; h.input.fire('input');
  assert.equal(h.input.dataset.pickerId, undefined); assert.equal(h.list.querySelectorAll().length, 0);
});

test('unit selection emits input/change so BOM conversion runs; keyboard, reset and multiple pickers work', () => {
  const h = harness([{ value: 'g' }, { value: 'kg' }]);
  let inputEvents = 0, changeEvents = 0;
  h.input.addEventListener('input', () => inputEvents++); h.input.addEventListener('change', () => changeEvents++);
  h.toggle.fire('click'); h.input.fire('keydown', { key: 'ArrowUp' });
  assert.equal(h.input.fire('keydown', { key: 'Enter' }).prevented, true);
  assert.equal(h.input.value, 'kg'); assert.equal(inputEvents, 1); assert.equal(changeEvents, 1);
  h.toggle.fire('click'); const other = h.newField(); other.toggle.fire('click');
  assert.equal(h.list.hidden, true); assert.equal(other.list.hidden, false);
  other.input.fire('keydown', { key: 'Escape' }); assert.equal(other.list.hidden, true);
  h.input.dataset.pickerId = 'old'; h.form.fire('reset'); assert.equal(h.input.dataset.pickerId, undefined);
});

test('long lists remain bounded and names with markup are inserted as text', () => {
  const options = Array.from({ length: 80 }, (_, i) => ({ id: i, value: `SKU${i}`, label: i === 79 ? '<script>tên sản phẩm</script>' : `SKU${i}` }));
  const h = harness(options); h.toggle.fire('click'); assert.equal(h.list.querySelectorAll().length, 50);
  h.input.value = 'SKU79'; h.input.fire('input');
  assert.equal(h.list.querySelectorAll().length, 1);
  assert.equal(h.list.querySelectorAll()[0].children[0].textContent, '<script>tên sản phẩm</script>');
});

test('application templates contain no remaining native suggestion lists', () => {
  const root = new URL('../', import.meta.url);
  const files = ['index.html', ...readdirSync(new URL('js/components/', root)).filter(name => name.endsWith('.js')).map(name => `js/components/${name}`)];
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /<datalist\b|\blist=["']/i, file);
});
