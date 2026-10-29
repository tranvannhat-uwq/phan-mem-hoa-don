let sequence = 0;
let opened = null;
let listening = false;

const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();

// Editable suggestions with a visible trigger, independent of native datalist UI.
export function setupInputPicker(input, { getOptions, label = 'Danh sách lựa chọn', emptyText = 'Không tìm thấy kết quả. Bạn có thể nhập giá trị khác.' }) {
  if (!input || input.dataset.inputPickerBound) return;
  input.dataset.inputPickerBound = 'true';
  const doc = input.ownerDocument;
  if (!listening) {
    doc.addEventListener('pointerdown', event => { if (opened && !opened.element.contains(event.target)) opened.close(); });
    listening = true;
  }
  const wrapper = doc.createElement('div');
  wrapper.className = 'input-picker';
  input.parentNode.insertBefore(wrapper, input);
  const control = doc.createElement('div');
  control.className = 'input-picker-control';
  wrapper.append(control);
  control.append(input);
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'input-picker-toggle';
  toggle.setAttribute('aria-label', `Mở ${label.toLowerCase()}`);
  toggle.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  control.append(toggle);
  const list = doc.createElement('div');
  list.className = 'input-picker-list';
  list.id = `input-picker-options-${++sequence}`;
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  wrapper.append(list);
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  toggle.setAttribute('aria-controls', list.id);
  let matches = [], active = -1, showAll = false, selecting = false;
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (opened?.element === wrapper) opened = null;
    active = -1;
  };
  const activate = index => {
    active = index === null || !matches.length ? -1 : (index + matches.length) % matches.length;
    Array.from(list.querySelectorAll('[role="option"]')).forEach((option, i) => {
      option.classList.toggle('is-active', i === active);
      option.setAttribute('aria-selected', String(i === active));
      if (i === active) option.scrollIntoView({ block: 'nearest' });
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const open = (all = false) => {
    if (input.disabled || input.readOnly) return;
    if (opened?.element !== wrapper) opened?.close();
    opened = { element: wrapper, close };
    showAll = all;
    const query = all || input.dataset.pickerId ? '' : normalize(input.value);
    const filtered = (getOptions() || []).filter(option => !query || normalize(`${option.value} ${option.label || ''} ${option.description || ''} ${option.searchText || ''}`).includes(query));
    matches = filtered.slice(0, 50);
    list.replaceChildren();
    matches.forEach((option, index) => {
      const button = doc.createElement('button');
      button.type = 'button'; button.tabIndex = -1;
      button.className = 'input-picker-option'; button.id = `${list.id}-${index}`;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
      const name = doc.createElement('strong'); name.textContent = option.label || option.value; button.append(name);
      if (option.description) { const detail = doc.createElement('small'); detail.textContent = option.description; button.append(detail); }
      button.addEventListener('click', () => choose(index));
      list.append(button);
    });
    if (!matches.length || filtered.length > matches.length) {
      const message = doc.createElement('p'); message.className = 'input-picker-message';
      message.textContent = !matches.length ? emptyText : 'Gõ thêm tên hoặc mã để tìm trong danh sách.';
      list.append(message);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-expanded', 'true');
    activate(null);
  };
  const choose = index => {
    const option = matches[index]; if (!option) return;
    input.value = option.value;
    selecting = true;
    if (option.id != null) input.dataset.pickerId = String(option.id);
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    selecting = false;
    close();
  };
  toggle.addEventListener('click', () => {
    if (!list.hidden && showAll) return close();
    input.focus(); open(true);
  });
  input.addEventListener('focus', () => { if (!selecting) open(); });
  input.addEventListener('input', () => { if (!selecting) { delete input.dataset.pickerId; open(); } });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (list.hidden) open(true);
      activate(active < 0 ? (event.key === 'ArrowDown' ? 0 : matches.length - 1) : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && !list.hidden && active >= 0) { event.preventDefault(); choose(active); }
    else if (event.key === 'Tab') close();
  });
  input.addEventListener('picker-options-updated', () => { if (!list.hidden) open(showAll); });
  wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
  input.form?.addEventListener('reset', () => { delete input.dataset.pickerId; close(); });
  close();
  return { close, refresh: () => { if (!list.hidden) open(showAll); } };
}
