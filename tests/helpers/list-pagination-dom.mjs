// Small DOM fixture exercising the actual pagination event handlers.
export function paginationDocument() {
  const nodes = new Map();
  function control({ value = '', disabled = false, dataset = {} } = {}) {
    const handlers = {};
    return { value, disabled, dataset,
      addEventListener: (event, callback) => { handlers[event] = callback; },
      click() { if (!this.disabled) return handlers.click?.(); },
      change(value) { this.value = String(value); if (!this.disabled) return handlers.change?.(); } };
  }
  function node(id) {
    if (!nodes.has(id)) {
      let html = '';
      let buttons = [];
      let size;
      let page;
      nodes.set(id, { value: '', innerText: '', textContent: '', dataset: {}, style: {},
        classList: { add() {}, remove() {} },
        get innerHTML() { return html; },
        set innerHTML(value) {
          html = value;
          buttons = [...value.matchAll(/<button[^>]*data-page="([^"]+)"[^>]*>/g)]
            .map(match => control({ dataset: { page: match[1] }, disabled: match[0].includes('disabled') }));
          const selected = value.match(/<option value="(\d+)" selected/);
          size = control({ value: selected?.[1] || '20', disabled: /data-page-size[^>]*disabled/.test(value) });
          page = control({ value: value.match(/data-page-number[^>]*value="(\d+)"/)?.[1] || '1',
            disabled: /data-page-number[^>]*disabled/.test(value) });
        },
        querySelectorAll: selector => selector === '[data-page]' ? buttons : [],
        querySelector: selector => selector === '[data-page-size]' ? size : page });
    }
    return nodes.get(id);
  }
  return { node, document: { getElementById: node, querySelectorAll: () => [] } };
}
