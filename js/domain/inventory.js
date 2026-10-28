export const INVENTORY_PAGE_SIZE = 50;
export const INVENTORY_STOCK_PAGE_SIZE = 15;
export const INVENTORY_CACHE_MS = 60_000;
export const INVENTORY_READ_BUDGET = 400_000_000;
export const INVENTORY_MAX_RESPONSE_BYTES = 32_768;

export function inventoryCycleStart(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const month = new Date(Date.UTC(Number(value.year), Number(value.month) - 1, 21));
  if (Number(value.day) < 21) month.setUTCMonth(month.getUTCMonth() - 1);
  return month.toISOString().slice(0, 10);
}

export function estimateInventoryUsage({ baselineGB = 3.9, users = 25, readsPerUserPerDay = 5, days = 30, responseBytes = INVENTORY_MAX_RESPONSE_BYTES } = {}) {
  const values = [baselineGB, users, readsPerUserPerDay, days, responseBytes];
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Số liệu dự kiến không hợp lệ.');
  const chargePerRead = Math.min(responseBytes, INVENTORY_MAX_RESPONSE_BYTES) * 2 + 8192 + 1024;
  const demandBytes = Math.ceil(users * readsPerUserPerDay * days * chargePerRead);
  const allowedBytes = Math.min(demandBytes, INVENTORY_READ_BUDGET);
  return {
    demandBytes, allowedBytes, estimatedTotalGB: baselineGB + allowedBytes / 1e9,
    withinFree: baselineGB + allowedBytes / 1e9 <= 4.5,
    budgetWouldStopReads: demandBytes > INVENTORY_READ_BUDGET
  };
}

export function validateInventoryDocument(input) {
  if (!input || !['receipt', 'issue', 'count'].includes(input.kind)) throw new Error('Loại phiếu kho không hợp lệ.');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new Error('Mỗi phiếu cần 1–50 SKU.');
  if (String(input.note || '').length > 240) throw new Error('Ghi chú tối đa 240 ký tự.');
  const ids = new Set();
  input.items.forEach(item => {
    if (!item.productId || ids.has(item.productId)) throw new Error('SKU trong phiếu phải khác nhau.');
    ids.add(item.productId);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1e8 || (input.kind !== 'count' && quantity === 0)
      || Math.abs(quantity * 10000 - Math.round(quantity * 10000)) > 0.00001) throw new Error('Số lượng cần hợp lệ, tối đa 4 chữ số thập phân.');
    if (input.kind === 'count' && (!Number.isFinite(Number(item.expectedQuantity)) || item.expectedQuantity == null)) throw new Error('Cần tải tồn hiện tại trước khi kiểm kê.');
  });
  if (new TextEncoder().encode(JSON.stringify(input)).length > 16_000) throw new Error('Phiếu quá lớn. Hãy chia thành nhiều phiếu nhỏ.');
  return input;
}

// One bounded page per query. No timers/polling, full-table loops or persisted
// inventory cache. Session generations prevent responses crossing accounts.
export function createInventoryGateway({ rpc, scope, now = Date.now }) {
  const cache = new Map();
  const pending = new Map();
  let currentScope = '';
  let generation = 0;
  const reset = () => { generation++; cache.clear(); pending.clear(); };
  const sync = () => {
    const next = scope();
    if (next !== currentScope) { currentScope = next; reset(); }
    if (!next) throw new Error('Cần đăng nhập để sử dụng kho.');
    return next;
  };
  return {
    clear: reset,
    async read(filters = {}, { force = false } = {}) {
      const actor = sync();
      const key = JSON.stringify(filters);
      const cached = cache.get(key);
      if (!force && cached && now() - cached.at < INVENTORY_CACHE_MS) return cached.value;
      if (pending.has(key)) return pending.get(key);
      const version = generation;
      const request = (async () => {
        const value = await rpc('rpc_inventory_window', { p_filters: filters });
        if (version !== generation || actor !== scope()) throw new Error('Phiên làm việc đã thay đổi.');
        const requestedLimit = Number(filters.limit ?? INVENTORY_PAGE_SIZE);
        if (!Array.isArray(value?.rows) || !Number.isInteger(requestedLimit) || requestedLimit < 1
          || requestedLimit > INVENTORY_PAGE_SIZE || value.rows.length > requestedLimit) {
          throw new Error('Cloud trả dữ liệu kho không hợp lệ.');
        }
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now(), value });
        return value;
      })();
      pending.set(key, request);
      try { return await request; } finally { if (pending.get(key) === request) pending.delete(key); }
    },
    async post(input) {
      const actor = sync();
      const version = generation;
      validateInventoryDocument(input);
      const result = await rpc('rpc_inventory_post', { p_input: input });
      if (version !== generation || actor !== scope()) throw new Error('Phiên làm việc đã thay đổi.');
      reset();
      return result;
    },
    async countContext(productId) {
      const actor = sync(); const version = generation;
      if (!productId || typeof productId !== 'string') throw new Error('SKU không hợp lệ.');
      const result = await rpc('rpc_inventory_count_context', { p_product_id: productId });
      if (version !== generation || actor !== scope()) throw new Error('Phiên làm việc đã thay đổi.');
      return result;
    },
    async countProduct(input) {
      const actor = sync(); const version = generation;
      validateInventoryDocument(input);
      if (input.kind !== 'count' || input.items.length !== 1 || !input.countToken || typeof input.activateProduct !== 'boolean') {
        throw new Error('Cần mở lại phiếu kiểm kê của một SKU.');
      }
      const result = await rpc('rpc_inventory_count_product', { p_input: input });
      if (version !== generation || actor !== scope()) throw new Error('Phiên làm việc đã thay đổi.');
      reset(); return result;
    },
    async activate() {
      const actor = sync();
      const version = generation;
      const result = await rpc('rpc_inventory_activate', { p_acknowledge_opening: true });
      if (version !== generation || actor !== scope()) throw new Error('Phiên làm việc đã thay đổi.');
      reset();
      return result;
    },
    async setSync(enabled, { acknowledgeOpening = false } = {}) {
      const actor = sync();
      const version = generation;
      if (typeof enabled !== 'boolean') throw new Error('Trạng thái đồng bộ kho không hợp lệ.');
      const result = await rpc('rpc_inventory_set_sync', { p_enabled: enabled, p_acknowledge_opening: acknowledgeOpening === true });
      if (version !== generation || actor !== scope()) throw new Error('Phiên làm việc đã thay đổi.');
      reset();
      return result;
    }
  };
}
