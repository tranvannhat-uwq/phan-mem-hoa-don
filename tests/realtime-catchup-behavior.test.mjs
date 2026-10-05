import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'js/services/realtime.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createRealtimeHarness() {
  const listeners = new Map();
  const timers = new Map();
  const channels = [];
  const requests = [];
  const appliedEvents = [];
  const loadResults = [];
  const shutdownResults = [];
  let now = 100_000;
  let nextTimerId = 0;
  let renderCount = 0;
  let dashboardInvalidations = 0;
  const effects = [];
  const state = {
    currentUser: { authUserId: 'alice', role: 'sale' },
    currentTab: 'invoice-panel'
  };
  const document = { visibilityState: 'visible' };
  const addEventListener = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
  };
  const removeEventListener = (name, callback) => listeners.get(name)?.delete(callback);
  const context = {
    console: { warn() {} }, Map, Promise, JSON, String, Boolean,
    Date: { now: () => now }, state, isCloudActive: true,
    document: Object.assign(document, { addEventListener, removeEventListener }),
    window: { addEventListener, removeEventListener },
    invalidateDashboardPayloadCache() { dashboardInvalidations += 1; effects.push('invalidate'); },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetchCloudData(options) {
      requests.push(JSON.parse(JSON.stringify(options)));
      const result = loadResults.shift();
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result ?? { failedDomains: [] });
    },
    supabaseClient: {
      channel() {
        const channel = {
          handlers: new Map(),
          on(_type, filter, callback) { this.handlers.set(filter.table, callback); return this; },
          subscribe(callback) { this.status = callback; return this; }
        };
        channels.push(channel);
        return channel;
      },
      async removeChannel() {
        const result = shutdownResults.shift();
        if (result) await result;
      }
    }
  };
  for (const declaration of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const item of declaration[1].split(',')) {
      const name = item.trim();
      if (!name || name in context) continue;
      if (name.startsWith('table')) context[name] = name;
      else if (name.startsWith('apply')) {
        context[name] = payload => { appliedEvents.push({ name, payload }); return true; };
      } else context[name] = () => Promise.resolve(true);
    }
  }
  const executable = source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\bexport\s+/g, '');
  vm.createContext(context);
  vm.runInContext(`${executable}\nthis.api = { startRealtimeSync, stopRealtimeSync };`, context);
  const flushPromises = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
  return {
    state, document, requests, channels, appliedEvents, loadResults, shutdownResults, effects,
    get renderCount() { return renderCount; },
    get dashboardInvalidations() { return dashboardInvalidations; },
    async start() {
      const started = await context.api.startRealtimeSync(() => { renderCount += 1; effects.push('render'); });
      if (!started) return false;
      return channels.at(-1);
    },
    async stop() { await context.api.stopRealtimeSync(); },
    event(name) { for (const callback of [...(listeners.get(name) || [])]) callback(); },
    async advance(milliseconds = 350) {
      now += milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= now);
        if (!due.length) break;
        for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
        await flushPromises();
      }
      await flushPromises();
    }
  };
}

async function startSubscribed() {
  const harness = createRealtimeHarness();
  const channel = await harness.start();
  channel.status('SUBSCRIBED');
  return { harness, channel };
}

test('returning to a healthy subscribed tab does not read cloud tables', async () => {
  const { harness } = await startSubscribed();
  harness.document.visibilityState = 'hidden';
  harness.event('visibilitychange');
  harness.document.visibilityState = 'visible';
  harness.event('visibilitychange');
  harness.event('pageshow');
  await harness.advance();
  assert.equal(harness.requests.length, 0);
});

test('online catch-up and later SUBSCRIBED for the same outage read only once', async () => {
  const { harness, channel } = await startSubscribed();
  channel.status('CHANNEL_ERROR');
  harness.event('online');
  await harness.advance();
  assert.equal(harness.requests.length, 1);
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0].onlyDomains, ['products', 'customers', 'pricelists']);
});

test('a later browser online event reuses the SDK recovery for the same outage', async () => {
  const { harness, channel } = await startSubscribed();
  channel.status('CHANNEL_ERROR');
  channel.status('SUBSCRIBED');
  await harness.advance();
  harness.event('online');
  await harness.advance();
  assert.equal(harness.requests.length, 1);
});

test('an online signal during initial subscribe does not cover a later outage', async () => {
  const harness = createRealtimeHarness();
  const channel = await harness.start();
  harness.event('online');
  await harness.advance();
  channel.status('SUBSCRIBED');
  channel.status('CHANNEL_ERROR');
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.requests.length, 2);
});

test('a separate outage still refreshes within the previous 60 second cooldown', async () => {
  const { harness, channel } = await startSubscribed();
  channel.status('CHANNEL_ERROR');
  harness.event('online');
  await harness.advance();
  channel.status('SUBSCRIBED');
  await harness.advance();
  channel.status('CHANNEL_ERROR');
  harness.event('online');
  await harness.advance();
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.requests.length, 2);
});

test('browser offline identifies a new gap even before the SDK changes status', async () => {
  const { harness, channel } = await startSubscribed();
  harness.event('offline');
  harness.event('online');
  await harness.advance();
  channel.status('SUBSCRIBED');
  await harness.advance();
  harness.event('offline');
  harness.event('online');
  await harness.advance();
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.requests.length, 2);
});

test('missed changes during hidden reconnect are refreshed when the tab returns', async () => {
  const { harness, channel } = await startSubscribed();
  harness.document.visibilityState = 'hidden';
  channel.status('TIMED_OUT');
  harness.event('online');
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.requests.length, 0);
  harness.document.visibilityState = 'visible';
  harness.event('visibilitychange');
  await harness.advance();
  assert.equal(harness.requests.length, 1);
});

test('hiding a tab after scheduling catch-up retains its missing data until return', async () => {
  const { harness, channel } = await startSubscribed();
  channel.status('CHANNEL_ERROR');
  harness.event('online');
  channel.status('SUBSCRIBED');
  harness.document.visibilityState = 'hidden';
  await harness.advance();
  assert.equal(harness.requests.length, 0);
  harness.document.visibilityState = 'visible';
  harness.event('visibilitychange');
  await harness.advance();
  assert.equal(harness.requests.length, 1);
});

test('a failed catch-up remains retryable when a subscribed tab returns', async () => {
  for (const failure of [{ failedDomains: ['pricelists'] }, new Error('network failure')]) {
    const { harness, channel } = await startSubscribed();
    harness.loadResults.push(failure);
    channel.status('CHANNEL_ERROR');
    harness.event('online');
    channel.status('SUBSCRIBED');
    await harness.advance();
    assert.equal(harness.requests.length, 1);
    harness.event('visibilitychange');
    await harness.advance();
    assert.equal(harness.requests.length, 2);
    harness.event('visibilitychange');
    await harness.advance();
    assert.equal(harness.requests.length, 2);
  }
});

test('a new gap during an in-flight catch-up receives its own refresh afterwards', async () => {
  const { harness, channel } = await startSubscribed();
  const firstLoad = deferred();
  harness.loadResults.push(firstLoad.promise);
  harness.event('offline');
  harness.event('online');
  await harness.advance();
  channel.status('SUBSCRIBED');
  channel.status('CHANNEL_ERROR');
  harness.event('online');
  await harness.advance();
  assert.equal(harness.requests.length, 1);
  firstLoad.resolve({ failedDomains: [] });
  await harness.advance(0);
  assert.equal(harness.requests.length, 2);
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.requests.length, 2);
});

test('row deltas still apply while hidden without reading cloud tables', async () => {
  const { harness, channel } = await startSubscribed();
  harness.document.visibilityState = 'hidden';
  channel.handlers.get('tableProductsName')({ eventType: 'UPDATE', new: { id: 'product-1' } });
  await harness.advance();
  assert.equal(harness.appliedEvents.length, 1);
  assert.equal(harness.requests.length, 0);
});

test('logout fences old channel callbacks, queued events and catch-up completion', async () => {
  const { harness, channel } = await startSubscribed();
  const oldLoad = deferred();
  harness.loadResults.push(oldLoad.promise);
  harness.event('online');
  await harness.advance();
  channel.handlers.get('tableProductsName')({ eventType: 'UPDATE', new: { id: 'before-logout' } });
  await harness.stop();
  harness.state.currentUser = null;
  channel.handlers.get('tableProductsName')({ eventType: 'UPDATE', new: { id: 'after-logout' } });
  channel.status('SUBSCRIBED');
  harness.event('online');
  oldLoad.resolve({ failedDomains: ['products'] });
  await harness.advance();
  assert.equal(harness.appliedEvents.length, 0);
  assert.equal(harness.renderCount, 0);
  assert.equal(harness.requests.length, 1);
  harness.state.currentUser = { authUserId: 'bob', role: 'sale' };
  const newChannel = await harness.start();
  newChannel.status('SUBSCRIBED');
  channel.handlers.get('tableProductsName')({ eventType: 'UPDATE', new: { id: 'old-user' } });
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.appliedEvents.length, 0);
  assert.equal(harness.requests.length, 1);
});

test('logout during channel shutdown cancels the waiting realtime start', async () => {
  const { harness } = await startSubscribed();
  const shutdown = deferred();
  harness.shutdownResults.push(shutdown.promise);
  const restarting = harness.start();
  await harness.stop();
  harness.state.currentUser = null;
  shutdown.resolve();
  assert.equal(await restarting, false);
  assert.equal(harness.channels.length, 1);
});

test('dashboard reconnect loads customers and lets its statistics renderer use the RPC', async () => {
  const { harness, channel } = await startSubscribed();
  harness.state.currentTab = 'dashboard-panel';
  channel.status('CHANNEL_ERROR');
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.deepEqual(harness.requests[0].onlyDomains, ['customers']);
  assert.equal(harness.renderCount, 1);
  assert.equal(harness.dashboardInvalidations, 1);
  assert.deepEqual(harness.effects, ['invalidate', 'render']);
});

test('one batch of dashboard business events invalidates totals once before rendering', async () => {
  const { harness, channel } = await startSubscribed();
  harness.state.currentTab = 'dashboard-panel';
  for (const [table, row] of [
    ['tableOrdersName', { id: 'order-1' }],
    ['tableOrdersName', { id: 'order-2' }],
    ['tableCustomersName', { id: 'customer-1' }],
    ['tableCustomerDebtTransactionsName', { id: 'debt-1' }],
    ['tableSalesReturnsName', { id: 'return-1' }],
    ['tableSalesReturnItemsName', { id: 'return-item-1', return_id: 'return-1' }],
    ['tableBrandsName', { id: 'brand-1' }]
  ]) channel.handlers.get(table)({ eventType: 'UPDATE', new: row });
  await harness.advance(250);
  assert.equal(harness.dashboardInvalidations, 1);
  assert.equal(harness.renderCount, 1);
  assert.deepEqual(harness.effects, ['invalidate', 'render']);
  assert.equal(harness.requests.length, 0);
});

test('draft and pricing batches and healthy visibility events retain the dashboard cache', async () => {
  const { harness, channel } = await startSubscribed();
  for (const table of ['tableDraftOrdersName', 'tablePricelistsName', 'tablePriceListItemsName', 'tableProductsName']) {
    channel.handlers.get(table)({ eventType: 'UPDATE', new: { id: `${table}-1` } });
  }
  await harness.advance(250);
  assert.equal(harness.renderCount, 1);
  assert.equal(harness.dashboardInvalidations, 0);
  harness.document.visibilityState = 'hidden';
  harness.event('visibilitychange');
  harness.document.visibilityState = 'visible';
  harness.event('visibilitychange');
  harness.event('pageshow');
  await harness.advance();
  assert.equal(harness.dashboardInvalidations, 0);
  assert.equal(harness.requests.length, 0);
});

test('online and SDK recovery invalidate dashboard cache only once for the same gap', async () => {
  const { harness, channel } = await startSubscribed();
  channel.status('CHANNEL_ERROR');
  harness.event('online');
  await harness.advance();
  channel.status('SUBSCRIBED');
  await harness.advance();
  assert.equal(harness.dashboardInvalidations, 1);
  assert.equal(harness.requests.length, 1);
});
