// Shared controls for lists already in memory and bounded server report pages.
// Pagination never changes the complete collection used by totals or exports.
export function createListPagination(id, { pageSize = 20 } = {}) {
  let page = 0;
  let limit = pageSize;
  let queryKey;
  let total = 0;

  function read(query = '') {
    const key = JSON.stringify(query);
    if (key !== queryKey) { queryKey = key; page = 0; }
    return { page, limit, offset: page * limit };
  }

  function setPage(value) {
    const requested = Number(value);
    if (!Number.isFinite(requested)) return false;
    const next = Math.min(Math.max(0, Math.trunc(requested)), Math.max(0, Math.ceil(total / limit) - 1));
    if (next === page) return false;
    page = next;
    return true;
  }

  function render(count, onChange, { busy = false, error = false } = {}) {
    if (!busy && !error) total = Math.max(0, Number(count) || 0);
    const pages = Math.max(1, Math.ceil(total / limit));
    page = Math.min(page, pages - 1);
    const host = document.getElementById(id);
    if (!host) return;
    host.classList.add('list-pagination');
    const from = total ? page * limit + 1 : 0;
    const to = Math.min((page + 1) * limit, total);
    const disabled = busy || error;
    host.innerHTML = `
      <span class="list-pagination-summary" role="status">${busy ? 'Đang tải danh sách...' : error ? 'Chưa tải được danh sách' : `${from}–${to} / ${total} dòng`}</span>
      <div class="list-pagination-controls">
        <label>Số dòng <select class="form-control" data-page-size aria-label="Số dòng mỗi trang" ${disabled ? 'disabled' : ''}>${[20, 50, 100].map(size => `<option value="${size}" ${limit === size ? 'selected' : ''}>${size}</option>`).join('')}</select></label>
        <button type="button" class="btn btn-secondary btn-sm" data-page="0" aria-label="Trang đầu" ${disabled || page === 0 ? 'disabled' : ''}>Đầu</button>
        <button type="button" class="btn btn-secondary btn-sm" data-page="${page - 1}" ${disabled || page === 0 ? 'disabled' : ''}>Trước</button>
        <label>Trang <input class="form-control" data-page-number type="number" min="1" max="${pages}" step="1" value="${page + 1}" aria-label="Số trang" ${disabled ? 'disabled' : ''}> / ${pages}</label>
        <button type="button" class="btn btn-secondary btn-sm" data-page="${page + 1}" ${disabled || page + 1 >= pages ? 'disabled' : ''}>Sau</button>
        <button type="button" class="btn btn-secondary btn-sm" data-page="${pages - 1}" aria-label="Trang cuối" ${disabled || page + 1 >= pages ? 'disabled' : ''}>Cuối</button>
      </div>`;
    host.querySelectorAll('[data-page]').forEach(button => {
      button.addEventListener('click', () => {
        if (!button.disabled && setPage(button.dataset.page)) onChange();
      });
    });
    const sizeControl = host.querySelector('[data-page-size]');
    sizeControl.addEventListener('change', () => {
      const size = Number(sizeControl.value);
      if (disabled || ![20, 50, 100].includes(size) || size === limit) return;
      limit = size; page = 0; onChange();
    });
    const pageControl = host.querySelector('[data-page-number]');
    pageControl.addEventListener('change', () => {
      if (!disabled && pageControl.value !== '' && setPage(Number(pageControl.value) - 1)) onChange();
      else pageControl.value = String(page + 1);
    });
  }

  function slice(rows, query, onChange) {
    read(query);
    render(rows.length, onChange);
    return rows.slice(page * limit, (page + 1) * limit);
  }

  return { read, render, slice, setPage };
}
