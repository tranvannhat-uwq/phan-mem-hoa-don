import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../js/components/independent-returns.js', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');

class Node {
  constructor() { this.value = ''; this.children = []; this.attributes = {}; this.handlers = {}; this.hidden = true; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  dispatchEvent(event) { for (const handler of this.handlers[event.type] || []) handler(event); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  setCustomValidity(value) { this.validationMessage = value; }
  scrollIntoView() {}
  querySelectorAll() { return this.children.filter(node => node.attributes.role === 'option'); }
}
function picker(candidates) {
  let scope = 'project|admin';
  const input = new Node(); const hidden = new Node(); const results = new Node(); results.id = 'test-results';
  const wrapper = new Node(); wrapper.querySelector = () => results; wrapper.contains = node => node === input || results.children.includes(node);
  input.closest = () => wrapper;
  const state = {currentUser: {role: 'admin'}};
  const context = vm.createContext({state, document: {createElement: () => new Node()},
    getRetentionSessionScope: () => scope, Event: class {constructor(type) {this.type = type;}}});
  vm.runInContext(source, context);
  const controller = vm.runInContext('setupReturnLookup', context)(input, hidden, () => candidates,
    item => `${item.code} — ${item.name}`, item => item.phone || item.packaging || '');
  return {input, hidden, results, controller, state, scope: value => {scope = value;},
    type(value) { input.value = value; input.dispatchEvent({type: 'input'}); },
    key(key) { let prevented = false; input.dispatchEvent({type: 'keydown', key, preventDefault() {prevented = true;}, stopPropagation() {}}); return prevented; },
    options: () => results.querySelectorAll()};
}

test('unaccented names, customer codes and unformatted phones select the original customer ID', () => {
  const search = picker([{id: 'customer-1', code: 'KH-MINH', name: 'Nguyễn Thị Minh', phone: '0000 123 456'}]);
  for (const query of ['nguyen minh', 'kh-minh', '0000123456']) {
    search.type(query);
    assert.equal(search.options().length, 1);
    assert.equal(search.key('Enter'), true, 'Selecting a suggestion must not submit the return');
    assert.equal(search.hidden.value, 'customer-1');
    assert.equal(search.input.validationMessage, '');
    assert.equal(search.results.hidden, true);
  }
});

test('editing selected text invalidates the old ID until another suggestion is selected', () => {
  const search = picker([{id: 'old', code: 'ONE', name: 'Khách cũ'}, {id: 'new', code: 'TWO', name: 'Khách mới'}]);
  search.type('one'); search.key('Enter');
  assert.equal(search.hidden.value, 'old');
  search.type('not-a-customer');
  assert.equal(search.hidden.value, '');
  assert.ok(search.input.validationMessage);
  search.key('Enter');
  assert.equal(search.hidden.value, '');
  search.type('two'); search.options()[0].dispatchEvent({type: 'click'});
  assert.equal(search.hidden.value, 'new');
  search.controller.reset();
  assert.equal(search.hidden.value, ''); assert.equal(search.input.value, '');
  assert.equal(search.results.hidden, true); assert.equal(search.input.validationMessage, '');
});

test('same-name SKUs remain distinct and keyboard navigation preserves the selected SKU ID', () => {
  const search = picker([{id: 'bucket', code: 'SKU-01', name: 'Sơn chống thấm', packaging: 'Thùng'},
    {id: 'can', code: 'SKU-02', name: 'Sơn chống thấm', packaging: 'Lon'}]);
  search.type('son chong tham');
  assert.equal(search.options().length, 2);
  search.key('ArrowUp'); search.key('Enter');
  assert.equal(search.hidden.value, 'can');
  search.type('sku'); search.key('ArrowDown'); search.key('Enter');
  assert.equal(search.hidden.value, 'bucket');
  search.type('sku-02'); search.key('Escape');
  assert.equal(search.results.hidden, true); assert.equal(search.hidden.value, '');
});

test('large lists render only 20 options and stale or locked suggestions cannot change a selection', () => {
  const search = picker(Array.from({length: 2000}, (_, index) => ({id: `id-${index}`, code: `KH-${index}`, name: `Khách hàng ${index}`})));
  search.type('khach'); assert.equal(search.options().length, 20);
  assert.match(search.results.children.at(-1).textContent, /Nhập thêm/);
  search.scope('project|another-admin'); search.options()[0].dispatchEvent({type: 'click'});
  assert.equal(search.hidden.value, ''); assert.equal(search.results.hidden, true);
  search.type('kh-1'); search.input.disabled = true;
  search.options()[0].dispatchEvent({type: 'click'}); assert.equal(search.hidden.value, '');
  search.input.disabled = false; search.type('kh-1'); search.state.currentUser.role = 'sale';
  search.key('Enter'); assert.equal(search.hidden.value, '');
});
