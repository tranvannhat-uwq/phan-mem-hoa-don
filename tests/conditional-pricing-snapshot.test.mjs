import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const importSource = async relative => import(`data:text/javascript;base64,${Buffer.from(read(relative)).toString('base64')}`);
const pricing = await importSource('js/domain/pricing.js');
const { collectAllPages } = await importSource('js/domain/pagination.js');
const executable = read('js/services/supabase.js').replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
const executableState = read('js/state.js').replace(/^export /gm, '');
const actor = { id: 'profile-1', authUserId: 'actor-1', role: 'accounting', companyId: 'company-1' };
const activeList = { id: 'list-1', name: 'General', price_list_type: 'general', is_active: true, is_available_for_sales: true };
const inactiveList = { id: 'list-2', name: 'Archived', price_list_type: 'general', is_active: false };
const priceRow = (id = 'item-1', listId = 'list-1', price = 100) => ({
  id, price_list_id: listId, product_id: `product-${id}`, variant_id: `variant-${id}`, price,
});
const json = value => JSON.parse(JSON.stringify(value));
const mappedList = row => ({ id: row.id, name: row.name, type: 'general', isActive: row.is_active !== false, isAvailableForSales: row.is_available_for_sales === true });
const mappedItem = row => ({ id: row.id, priceListId: row.price_list_id, productId: row.variant_id || row.product_id, variantId: row.variant_id || row.product_id, price: row.price });
const cachedSnapshot = ({ lists = [activeList], items = [priceRow()], revision = 'revision-1' } = {}) => ({
  actorId: actor.authUserId, role: actor.role, cachedAt: '2026-10-05T00:00:00.000Z', revision,
  priceLists: lists.map(mappedList), priceListItems: items.map(mappedItem),
});
const fullResponse = ({ user = actor, lists = [activeList], items = [priceRow()], revision = 'revision-1' } = {}) => ({
  data: { actor_id: user.authUserId, role: user.role, revision, not_modified: false, price_lists: lists, items }, error: null,
});
const unchangedResponse = ({ user = actor, revision = 'revision-1' } = {}) => ({
  data: { actor_id: user.authUserId, role: user.role, revision, not_modified: true }, error: null,
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createHarness({ user = actor, cache = null, cacheLoader = null, tables = {}, tableRead = null, rpc = () => fullResponse({ user }) } = {}) {
  const rpcCalls = [];
  const tableCalls = [];
  const cacheWrites = [];
  const timers = new Map();
  const storage = new Map();
  let nextTimer = 1;
  const context = vm.createContext({
    ...pricing, collectAllPages,
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    showToast() {}, rawMaterialsSeed: [],
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    loadAuthorizedPricingCache: async requestedUser => {
      if (cacheLoader) return cacheLoader(requestedUser);
      if (!cache || cache.actorId !== requestedUser.authUserId || cache.role !== requestedUser.role) return null;
      return json(cache);
    },
    saveAuthorizedPricingCache: async (...args) => { cacheWrites.push(json(args)); return true; },
  });
  vm.runInContext(executableState, context, { filename: 'js/state.js' });
  vm.runInContext(executable, context, { filename: 'js/services/supabase.js' });
  context.testClient = {
    async rpc(name, params) {
      rpcCalls.push({ name, params: json(params || {}) });
      return rpc(name, params, rpcCalls.length);
    },
    from(table) {
      let from = 0;
      let to = Infinity;
      let limit = Infinity;
      let columns = '';
      let exactCount = false;
      const filters = [];
      const query = {
        select(value, options) { columns = value; exactCount = options?.count === 'exact'; return query; },
        order() { return query; },
        eq(column, value) { filters.push(row => row[column] === value); return query; },
        in(column, values) { filters.push(row => values.includes(row[column])); return query; },
        range(start, end) { from = start; to = end; return query; },
        limit(value) { limit = value; return query; },
        then(resolve, reject) {
          const customResponse = tableRead?.({ table, columns, from, to });
          if (customResponse !== undefined) {
            return Promise.resolve(customResponse).then(response => {
              tableCalls.push({ table, columns, from, to, rows: response.data?.length || 0 });
              return response;
            }).then(resolve, reject);
          }
          const source = table in tables ? tables[table] : table === 'pricelists' ? [activeList] : [];
          const rows = source.filter(row => filters.every(filter => filter(row)));
          const data = json(rows.slice(from, Math.min(to + 1, from + limit)));
          tableCalls.push({ table, columns, from, to, rows: data.length });
          return Promise.resolve({ data, error: null, count: exactCount ? rows.length : null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  context.testActor = json(user);
  vm.runInContext('supabaseClient = testClient; isCloudActive = true; state.currentUser = testActor; globalThis.testState = state;', context);
  return {
    state: context.testState, rpcCalls, tableCalls, cacheWrites,
    run: expression => vm.runInContext(expression, context),
    bootstrap: () => vm.runInContext('fetchCloudData({ leanBootstrap: true, hydrateCustomerHistory: false })', context),
    load: () => vm.runInContext("fetchCloudData({ onlyDomains: ['pricelists'], hydrateCustomerHistory: false })", context),
  };
}

test('cold sessions load complete authorized rows through the conditional RPC', async () => {
  for (const role of ['admin', 'accounting', 'sale']) {
    const harness = createHarness({ user: { ...actor, role } });
    const result = await harness.load();
    assert.deepEqual(json(result.failedDomains), []);
    assert.equal(harness.state.pricingSnapshotComplete, true);
    assert.equal(harness.state.pricingSnapshotRevision, 'revision-1');
    assert.equal(harness.state.allPriceListItems.length, 1);
    assert.equal(harness.state.priceListItems[0].price, 100);
    assert.deepEqual(harness.rpcCalls, [{ name: 'rpc_get_pricing_snapshot', params: { p_cached_revision: null } }]);
    assert.equal(harness.tableCalls.length, 0);
  }
});

test('warm sessions validate the cached revision without transferring price rows again', async () => {
  const harness = createHarness({ cache: cachedSnapshot(), rpc: () => unchangedResponse() });
  await harness.bootstrap();
  assert.equal(harness.state.pricingSnapshotComplete, true);
  assert.equal(harness.state.cloudLoadStatus.pricelists.status, 'partial');
  await harness.load();
  assert.deepEqual(harness.rpcCalls, [{ name: 'rpc_get_pricing_snapshot', params: { p_cached_revision: 'revision-1' } }]);
  assert.equal(harness.tableCalls.filter(call => call.table === 'price_list_items').length, 0);
  assert.equal(harness.state.allPriceListItems[0].price, 100);
  assert.equal(harness.state.cloudLoadStatus.pricelists.status, 'ready');
  await harness.run('persistAuthorizedPricingCache()');
  assert.equal(harness.cacheWrites.at(-1)[3], 'revision-1');
});

test('a changed revision atomically replaces cached items, including removed rows', async () => {
  const cache = cachedSnapshot({ items: [priceRow(), priceRow('removed-item')] });
  const harness = createHarness({ cache, rpc: () => fullResponse({ revision: 'revision-2', items: [priceRow('item-1', 'list-1', 200)] }) });
  await harness.load();
  assert.equal(harness.rpcCalls[0].params.p_cached_revision, 'revision-1');
  assert.equal(harness.state.pricingSnapshotRevision, 'revision-2');
  assert.equal(harness.state.allPriceListItems.length, 1);
  assert.equal(harness.state.allPriceListItems[0].price, 200);
});

test('an absent conditional RPC retains complete paginated legacy reads', async () => {
  const items = Array.from({ length: 2501 }, (_, i) => priceRow(`item-${i}`));
  const harness = createHarness({
    tables: { price_list_items: items },
    rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'RPC is not installed' } }),
  });
  const result = await harness.load();
  assert.deepEqual(json(result.failedDomains), []);
  assert.equal(harness.state.allPriceListItems.length, 2501);
  assert.equal(harness.state.pricingSnapshotComplete, true);
  assert.equal(harness.state.pricingSnapshotRevision, '');
  assert.deepEqual(harness.tableCalls.filter(call => call.table === 'price_list_items').map(call => call.rows), [1000, 1000, 501]);
  await harness.load();
  assert.equal(harness.rpcCalls.length, 1, 'missing endpoint is probed once per client');
});

test('RPC errors preserve the last authorized snapshot and report the domain failure', async () => {
  const harness = createHarness({ cache: cachedSnapshot(), rpc: () => ({ data: null, error: { code: '57014', message: 'timeout' } }) });
  const result = await harness.load();
  assert.deepEqual(json(result.failedDomains), ['pricelists']);
  assert.equal(harness.state.allPriceListItems[0].price, 100);
  assert.equal(harness.state.pricingSnapshotComplete, true);
  assert.equal(harness.state.cloudLoadStatus.pricelists.status, 'error');
});

test('simultaneous complete domain loads share one RPC request', async () => {
  const gate = deferred();
  const started = deferred();
  const harness = createHarness({ rpc: () => { started.resolve(); return gate.promise; } });
  const first = harness.load();
  const second = harness.load();
  await started.promise;
  assert.equal(harness.rpcCalls.length, 1);
  gate.resolve(fullResponse());
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.failedDomains.length === 0));
  assert.equal(harness.state.allPriceListItems.length, 1);
});

test('logout and account changes ignore earlier pricing responses', async () => {
  for (const nextUser of [null, { ...actor, authUserId: 'actor-2' }, { ...actor, companyId: 'company-2' }]) {
    const gate = deferred();
    const started = deferred();
    const harness = createHarness({ rpc: () => { started.resolve(); return gate.promise; } });
    const pending = harness.load();
    await started.promise;
    harness.state.currentUser = nextUser;
    harness.state.cloudLoadStatus = {};
    gate.resolve(fullResponse());
    await pending;
    assert.equal(harness.state.allPriceListItems.length, 0);
    assert.equal(harness.state.pricingSnapshotComplete, false);
    assert.deepEqual(json(harness.state.cloudLoadStatus), {});
  }
});

test('Realtime invalidation during cached validation requests an unconditional snapshot', async () => {
  const gate = deferred();
  const started = deferred();
  const harness = createHarness({ cache: cachedSnapshot(), rpc: (_name, params) => {
    if (params.p_cached_revision) { started.resolve(); return gate.promise; }
    return fullResponse({ revision: 'revision-2', items: [priceRow('item-1', 'list-1', 200)] });
  } });
  const pending = harness.load();
  await started.promise;
  harness.run("applyPricingRealtimePayload('priceListItem', { eventType: 'UPDATE', new: { id: 'item-1', price_list_id: 'list-1', product_id: 'product-item-1', variant_id: 'variant-item-1', price: 200 } })");
  gate.resolve(unchangedResponse());
  await pending;
  assert.deepEqual(harness.rpcCalls.map(call => call.params.p_cached_revision), ['revision-1', null]);
  assert.equal(harness.state.allPriceListItems[0].price, 200);
  assert.equal(harness.state.pricingSnapshotRevision, 'revision-2');
});

test('Realtime updates arriving during a full snapshot prevent stale row replacement', async () => {
  const gate = deferred();
  const started = deferred();
  const harness = createHarness({ rpc: (_name, _params, callNumber) => {
    if (callNumber === 1) { started.resolve(); return gate.promise; }
    return fullResponse({ revision: 'revision-2', items: [priceRow('item-1', 'list-1', 200)] });
  } });
  const pending = harness.load();
  await started.promise;
  harness.run("applyPricingRealtimePayload('priceListItem', { eventType: 'UPDATE', new: { id: 'item-1', price_list_id: 'list-1', product_id: 'product-item-1', variant_id: 'variant-item-1', price: 200 } })");
  gate.resolve(fullResponse());
  await pending;
  assert.deepEqual(harness.rpcCalls.map(call => call.params.p_cached_revision), [null, null]);
  assert.equal(harness.state.allPriceListItems[0].price, 200);
  assert.equal(harness.state.pricingSnapshotRevision, 'revision-2');
});

test('three concurrent pricing mutations stop retries and preserve known newer rows', async () => {
  let harness;
  harness = createHarness({ cache: cachedSnapshot(), rpc: (_name, _params, callNumber) => {
    harness.run(`applyPricingRealtimePayload('priceListItem', { eventType: 'UPDATE', new: { id: 'item-1', price_list_id: 'list-1', product_id: 'product-item-1', variant_id: 'variant-item-1', price: ${200 + callNumber} } })`);
    return fullResponse();
  } });
  const result = await harness.load();
  assert.equal(harness.rpcCalls.length, 3);
  assert.deepEqual(json(result.failedDomains), ['pricelists']);
  assert.equal(harness.state.allPriceListItems[0].price, 203);
  assert.equal(harness.state.pricingSnapshotComplete, true);
  assert.equal(harness.state.pricingSnapshotRevision, '');
});

test('a new login for the same account ignores an earlier pending response', async () => {
  const gate = deferred();
  const started = deferred();
  const harness = createHarness({ rpc: () => { started.resolve(); return gate.promise; } });
  const pending = harness.load();
  await started.promise;
  harness.state.currentUser = { ...actor };
  harness.state.cloudLoadStatus = {};
  gate.resolve(fullResponse());
  await pending;
  assert.equal(harness.state.allPriceListItems.length, 0);
  assert.equal(harness.state.pricingSnapshotComplete, false);
  assert.deepEqual(json(harness.state.cloudLoadStatus), {});
});

test('a new login for the same account does not reuse an earlier login request', async () => {
  const gate = deferred();
  const started = deferred();
  const harness = createHarness({ rpc: (_name, _params, callNumber) => {
    if (callNumber === 1) { started.resolve(); return gate.promise; }
    return fullResponse({ revision: 'revision-2', items: [priceRow('item-1', 'list-1', 200)] });
  } });
  const earlier = harness.load();
  await started.promise;
  harness.state.currentUser = { ...actor };
  harness.state.cloudLoadStatus = {};
  const current = harness.load();
  await Promise.resolve();
  await Promise.resolve();
  gate.resolve(fullResponse());
  await Promise.all([earlier, current]);
  assert.equal(harness.rpcCalls.length, 2);
  assert.equal(harness.state.allPriceListItems[0].price, 200);
  assert.equal(harness.state.pricingSnapshotComplete, true);
  assert.equal(harness.state.cloudLoadStatus.pricelists.status, 'ready');
});

test('late browser cache hydration cannot overwrite data after same-account login changes', async () => {
  const gate = deferred();
  const started = deferred();
  const harness = createHarness({ cacheLoader: () => { started.resolve(); return gate.promise; } });
  const pending = harness.bootstrap();
  await started.promise;
  harness.state.currentUser = { ...actor };
  harness.state.allPriceListItems = [mappedItem(priceRow('new-session-item', 'list-1', 200))];
  harness.state.pricingSnapshotRevision = 'new-session-revision';
  gate.resolve(cachedSnapshot());
  await pending;
  assert.equal(harness.state.allPriceListItems[0].id, 'new-session-item');
  assert.equal(harness.state.allPriceListItems[0].price, 200);
  assert.equal(harness.state.pricingSnapshotRevision, 'new-session-revision');
});

test('late customer loads preserve the next account or login customer state and cache', async () => {
  for (const nextUser of [{ ...actor }, { ...actor, id: 'profile-2', authUserId: 'actor-2' }]) {
    const gate = deferred();
    const started = deferred();
    const harness = createHarness({ tableRead: ({ table }) => {
      if (table === 'customers') { started.resolve(); return gate.promise; }
    } });
    const pending = harness.run("fetchCloudData({ onlyDomains: ['customers'], hydrateCustomerHistory: false })");
    await started.promise;
    harness.state.currentUser = nextUser;
    harness.state.customers = [{ id: 'new-session-customer', name: 'Current customer', debt: 25 }];
    harness.state.activeCustomerId = 'new-session-customer';
    harness.state.cloudLoadStatus = { customers: { status: 'ready' } };
    harness.run('state.customerSnapshotScope = getCustomerCacheScope(); writeCustomerCache(state.customers)');
    const expectedCache = harness.run('localStorage.getItem(getScopedCustomerCacheKey())');
    gate.resolve({ data: [{ id: 'earlier-session-customer', name: 'Earlier customer', debt: 75 }], count: 1, error: null });
    await pending;
    assert.deepEqual(json(harness.state.customers), [{ id: 'new-session-customer', name: 'Current customer', debt: 25 }]);
    assert.equal(harness.state.activeCustomerId, 'new-session-customer');
    assert.equal(harness.run('localStorage.getItem(getScopedCustomerCacheKey())'), expectedCache);
    assert.equal(harness.run("localStorage.getItem('billing_system_customers')"), expectedCache);
    assert.deepEqual(json(harness.state.cloudLoadStatus), { customers: { status: 'ready' } });
  }
});

test('customer-assigned pricing invalidates the global revision before caching added rows', async () => {
  const saleActor = { ...actor, role: 'sale' };
  const privateList = { id: 'dealer-list', name: 'Dealer', price_list_type: 'dealer_private', customer_id: 'dealer-1', is_active: true };
  const harness = createHarness({ user: saleActor, rpc: name => {
    if (name === 'rpc_get_customer_assigned_pricing') {
      return { data: { price_list: privateList, items: [priceRow('dealer-item', privateList.id, 75)] }, error: null };
    }
    return fullResponse({ user: saleActor });
  } });
  await harness.load();
  assert.equal(harness.state.pricingSnapshotRevision, 'revision-1');
  const result = await harness.run("dbLoadCustomerAssignedPricing({ id: 'dealer-1', pricelistId: 'dealer-list' })");
  assert.equal(result.loaded, true);
  assert.equal(harness.state.allPriceListItems.find(item => item.priceListId === privateList.id).price, 75);
  assert.equal(harness.state.pricingSnapshotRevision, '');
  await harness.run('persistAuthorizedPricingCache()');
  assert.equal(harness.cacheWrites.at(-1)[3], '');
  await harness.load();
  const completeCalls = harness.rpcCalls.filter(call => call.name === 'rpc_get_pricing_snapshot');
  assert.deepEqual(completeCalls.map(call => call.params.p_cached_revision), [null, null]);
});

test('late customer-assigned pricing responses cannot mutate a different session', async () => {
  const gate = deferred();
  const started = deferred();
  const saleActor = { ...actor, role: 'sale' };
  const harness = createHarness({ user: saleActor, rpc: () => { started.resolve(); return gate.promise; } });
  const pending = harness.run("dbLoadCustomerAssignedPricing({ id: 'dealer-1', pricelistId: 'dealer-list' })");
  await started.promise;
  harness.state.currentUser = { ...saleActor };
  gate.resolve({ data: { price_list: { id: 'dealer-list', name: 'Dealer', price_list_type: 'dealer_private', customer_id: 'dealer-1', is_active: true }, items: [priceRow('dealer-item', 'dealer-list', 75)] }, error: null });
  const result = await pending;
  assert.equal(result.loaded, false);
  assert.equal(result.reason, 'session_changed');
  assert.equal(harness.state.allPriceListItems.length, 0);
});

test('metadata bootstrap preserves cached authorized inactive rows', async () => {
  const lists = [activeList, inactiveList];
  const cache = cachedSnapshot({ lists, items: [priceRow(), priceRow('inactive-item', 'list-2')] });
  const harness = createHarness({ cache, tables: { pricelists: lists } });
  await harness.bootstrap();
  assert.equal(harness.state.pricingSnapshotComplete, true);
  assert.equal(harness.state.allPriceListItems.length, 2);
  assert.equal(harness.state.priceListItems.length, 1);
  assert.equal(harness.state.pricingSnapshotRevision, 'revision-1');
});

test('metadata-only bootstrap never persists an incomplete snapshot as complete', async () => {
  const harness = createHarness();
  await harness.bootstrap();
  assert.equal(harness.state.pricingSnapshotComplete, false);
  assert.equal(harness.state.allPriceListItems.length, 0);
  assert.equal(await harness.run('persistAuthorizedPricingCache()'), false);
  assert.equal(harness.cacheWrites.length, 0);
});

test('cold metadata bootstrap paginates more than 1000 authorized lists', async () => {
  const lists = Array.from({ length: 1001 }, (_, i) => ({ ...activeList, id: `list-${i}` }));
  const harness = createHarness({ tables: { pricelists: lists } });
  await harness.bootstrap();
  assert.equal(harness.state.allPricelists.length, 1001);
  assert.equal(harness.state.pricingSnapshotComplete, false);
  assert.deepEqual(harness.tableCalls.filter(call => call.table === 'pricelists').map(call => call.rows), [1000, 1]);
});

test('Sale retains its scoped legacy RPC when the conditional endpoint is absent', async () => {
  const saleActor = { ...actor, role: 'sale' };
  const harness = createHarness({ user: saleActor, rpc: name => {
    if (name === 'rpc_get_pricing_snapshot') return { data: null, error: { code: '42883' } };
    return { data: { price_lists: [activeList], items: [priceRow()] }, error: null };
  } });
  await harness.load();
  assert.deepEqual(harness.rpcCalls.map(call => call.name), ['rpc_get_pricing_snapshot', 'rpc_get_sale_pricing_snapshot']);
  assert.equal(harness.state.pricingSnapshotComplete, true);
  assert.equal(harness.state.allPriceListItems.length, 1);
  assert.equal(harness.tableCalls.length, 0);
});

test('browser cache persists revisions, isolates actors, and tolerates old complete snapshots without a revision', async () => {
  let stored = { ...cachedSnapshot(), key: 'actor-1::accounting', version: 2 };
  const database = {
    close() {},
    transaction() {
      const transaction = {
        objectStore: () => ({
          get: () => ({ result: json(stored) }),
          put: value => { stored = json(value); return { result: value.key }; },
        }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  const context = vm.createContext({
    indexedDB: { open() { const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess?.(); }); return request; } },
    console: { warn() {} }, testActor: actor,
  });
  vm.runInContext(read('js/services/pricing-cache.js').replace(/^export /gm, ''), context);
  const load = () => vm.runInContext('loadAuthorizedPricingCache(testActor)', context);
  assert.equal((await load()).revision, 'revision-1');
  delete stored.revision;
  assert.equal((await load()).revision, '');
  stored.actorId = 'other-actor';
  assert.equal(await load(), null);
  stored.actorId = actor.authUserId;
  stored.role = 'sale';
  assert.equal(await load(), null);
  stored.role = actor.role;
  stored.version = 1;
  assert.equal(await load(), null);
  await vm.runInContext("saveAuthorizedPricingCache(testActor, [], [], 'revision-2')", context);
  assert.equal(stored.revision, 'revision-2');
  assert.equal(stored.actorId, actor.authUserId);
  assert.equal(stored.role, actor.role);
});

test('mismatched cached actors are ignored and mismatched RPC actors are rejected', async () => {
  const cache = { ...cachedSnapshot(), actorId: 'other-actor' };
  const harness = createHarness({ cache, rpc: () => fullResponse({ user: { ...actor, authUserId: 'other-actor' } }) });
  const result = await harness.load();
  assert.deepEqual(json(result.failedDomains), ['pricelists']);
  assert.equal(harness.rpcCalls[0].params.p_cached_revision, null);
  assert.equal(harness.state.pricingSnapshotComplete, false);
  assert.equal(harness.state.allPriceListItems.length, 0);
});

test('conditional snapshot SQL validates roles, hashes content, and does not mutate business data', () => {
  const migration = read('migrations/0082_conditional_pricing_snapshot.sql');
  assert.match(migration, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(migration, /actor\.role NOT IN \('admin', 'accounting', 'sale'\)/);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/);
  assert.match(migration, /price_list\.is_available_for_sales = true/);
  assert.match(migration, /price_list\.customer_id IS NULL/);
  assert.match(migration, /revision := md5\([\s\S]*'actor_id'[\s\S]*'company_id'[\s\S]*'snapshot', snapshot/);
  assert.match(migration, /IF p_cached_revision = revision THEN[\s\S]*'not_modified', true/);
  assert.match(migration, /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|TRUNCATE)\s+(?:FROM\s+)?public\.(?:pricelists|price_list_items|orders|customers)\b/i);
});
