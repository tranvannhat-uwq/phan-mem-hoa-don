import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function createTimers() {
  const jobs = new Map();
  let now = 0;
  let nextId = 1;
  const schedule = (fn, delay, repeat) => {
    const id = nextId++;
    jobs.set(id, { fn, delay, repeat, next: now + delay });
    return id;
  };
  return {
    jobs,
    setTimeout: (fn, delay) => schedule(fn, delay, false),
    clearTimeout: id => jobs.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: id => jobs.delete(id),
    async advance(duration) {
      const until = now + duration;
      for (;;) {
        const entry = [...jobs].filter(([, job]) => job.next <= until).sort((a, b) => a[1].next - b[1].next)[0];
        if (!entry) break;
        const [id, job] = entry;
        now = job.next;
        if (job.repeat) job.next += job.delay;
        else jobs.delete(id);
        job.fn();
        await flush();
      }
      now = until;
      await flush();
    }
  };
}

function createEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    emit(type) { for (const handler of listeners.get(type) || []) handler({ target: this, stopPropagation() {} }); }
  };
}

function createDocument() {
  const elements = new Map();
  const document = { ...createEventTarget(), hidden: false, querySelectorAll: () => [] };
  document.getElementById = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        ...createEventTarget(), value: '', innerHTML: '', textContent: '', disabled: false,
        options: [{}, {}], dataset: {}, style: {}, querySelectorAll: () => [],
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
          toggle(name) { if (classes.has(name)) classes.delete(name); else classes.add(name); }
        }
      });
    }
    return elements.get(id);
  };
  return document;
}

function loadComponent(path, context, expose) {
  const source = read(path).replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/^export\s+/gm, '');
  const sandbox = vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.api = { ${expose.join(', ')} };`, sandbox, { filename: path });
  return sandbox.api;
}

function maintenanceHarness() {
  const timers = createTimers();
  const document = createDocument();
  const state = { currentUser: { id: 'staff-1', authUserId: 'auth-1', role: 'sale' }, users: [] };
  const calls = { status: 0, realtimeStop: 0, signOut: 0, clearAuth: 0, warnings: [], toasts: [] };
  const results = [];
  let stopResult = null;
  const api = loadComponent('js/components/users.js', {
    state, document, ...timers,
    getMaintenanceStatus: () => { calls.status++; return results.shift() || Promise.resolve({ enabled: false }); },
    stopRealtimeSync: () => { calls.realtimeStop++; return stopResult || Promise.resolve(); },
    supabaseClient: { auth: { signOut: async () => { calls.signOut++; } } },
    clearSupabaseAuthStorage: () => { calls.clearAuth++; },
    showToast: (...args) => calls.toasts.push(args),
    LOGIN_ERROR: { MAINTENANCE: 'maintenance' }, loginErrorMessage: () => 'maintenance',
    console: { warn: (...args) => calls.warnings.push(args) }
  }, ['startMaintenanceMonitor', 'stopMaintenanceMonitor']);
  return { api, timers, document, state, calls, results, setStopResult: value => { stopResult = value; } };
}

test('maintenance skips hidden polling, checks when visible and cleans listeners on stop', async () => {
  const h = maintenanceHarness();
  h.document.hidden = true;
  h.api.startMaintenanceMonitor();
  await h.timers.advance(120_000);
  assert.equal(h.calls.status, 0);
  h.document.hidden = false;
  h.document.emit('visibilitychange');
  await flush();
  assert.equal(h.calls.status, 1);
  await h.timers.advance(15_000);
  assert.equal(h.calls.status, 2);
  h.api.stopMaintenanceMonitor();
  assert.equal(h.document.listeners.get('visibilitychange').size, 0);
  assert.equal(h.timers.jobs.size, 0);
  h.document.emit('visibilitychange');
  await h.timers.advance(30_000);
  assert.equal(h.calls.status, 2);
});

test('maintenance requests stay single-flight through interval and visibility events, then retry after failure', async () => {
  const h = maintenanceHarness();
  const pending = deferred();
  h.results.push(pending.promise);
  h.api.startMaintenanceMonitor();
  await h.timers.advance(60_000);
  h.document.emit('visibilitychange');
  await flush();
  assert.equal(h.calls.status, 1);
  pending.reject(new Error('offline'));
  await flush();
  await h.timers.advance(15_000);
  assert.equal(h.calls.status, 2);
  assert.equal(h.calls.warnings.length, 1);
});

test('maintenance responses from stopped sessions cannot sign out a newly logged-in user', async () => {
  for (const nextAuthId of ['auth-2', 'auth-1']) {
    const h = maintenanceHarness();
    const pending = deferred();
    h.results.push(pending.promise);
    h.api.startMaintenanceMonitor();
    await h.timers.advance(15_000);
    h.api.stopMaintenanceMonitor();
    const nextUser = { id: 'staff-next', authUserId: nextAuthId, role: 'sale' };
    h.state.currentUser = nextUser;
    h.api.startMaintenanceMonitor();
    pending.resolve({ enabled: true, message: 'maintenance' });
    await flush();
    assert.equal(h.state.currentUser, nextUser);
    assert.equal(h.calls.realtimeStop, 0);
    assert.equal(h.calls.signOut, 0);
    assert.equal(h.calls.status, 2, 'new session gets its own check when the previous request finishes');
    assert.equal(h.document.listeners.get('visibilitychange').size, 1);
  }
});

test('maintenance logout cannot clear a new session while waiting for realtime shutdown', async () => {
  const h = maintenanceHarness();
  const stopping = deferred();
  h.setStopResult(stopping.promise);
  h.results.push(Promise.resolve({ enabled: true, message: 'maintenance' }));
  h.api.startMaintenanceMonitor();
  await h.timers.advance(15_000);
  assert.equal(h.calls.realtimeStop, 1);
  const nextUser = { id: 'staff-2', authUserId: 'auth-2', role: 'sale' };
  h.state.currentUser = nextUser;
  h.api.startMaintenanceMonitor();
  stopping.resolve();
  await flush();
  assert.equal(h.calls.signOut, 0);
  assert.equal(h.calls.clearAuth, 0);
  assert.equal(h.state.currentUser, nextUser);
});

test('maintenance still signs employees out when enabled and does not poll admin sessions', async () => {
  const h = maintenanceHarness();
  h.results.push(Promise.resolve({ enabled: true, message: 'Đang bảo trì' }));
  h.api.startMaintenanceMonitor();
  await h.timers.advance(15_000);
  assert.equal(h.calls.signOut, 1);
  assert.equal(h.calls.clearAuth, 1);
  assert.equal(h.state.currentUser, null);
  assert.equal(h.state.pricingSnapshotRevision, '');
  assert.equal(h.document.getElementById('login-maintenance-notice').textContent, 'Đang bảo trì');
  assert.equal(h.document.listeners.get('visibilitychange').size, 0);
  h.state.currentUser = { id: 'admin', role: 'admin' };
  h.api.startMaintenanceMonitor();
  await h.timers.advance(30_000);
  assert.equal(h.calls.status, 1);
  assert.equal(h.timers.jobs.size, 0);
});

function activityHarness() {
  const timers = createTimers();
  const document = createDocument();
  const state = { currentUser: { role: 'admin' }, currentTab: 'activity-log-panel', users: [] };
  const calls = [];
  const results = [];
  const api = loadComponent('js/components/activity-log.js', {
    state, document, ...timers,
    dbFetchActivityLogs: filters => { calls.push(filters); return results.shift() || Promise.resolve({ rows: [], total: 100 }); },
    dbFetchOrderActivity: async () => [],
    safeCreateIcons() {}, showToast() {}, makeSelectSearchable() {}, getOrderDisplayCode: () => 'order',
    switchTab: tab => { state.currentTab = tab; }
  }, ['setupActivityLog', 'renderActivityLog']);
  api.setupActivityLog();
  const search = value => { const input = document.getElementById('activity-search'); input.value = value; input.emit('input'); };
  return { api, timers, document, state, calls, results, search };
}

test('typing an activity search sends one query after 300ms using the final search text', async () => {
  const h = activityHarness();
  h.search('a');
  await h.timers.advance(100);
  h.search('ab');
  await h.timers.advance(100);
  h.search('abc');
  await h.timers.advance(299);
  assert.equal(h.calls.length, 0);
  await h.timers.advance(1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].search, 'abc');
  assert.equal(h.calls[0].limit, 20);
  assert.equal(h.calls[0].offset, 0);
});

test('activity filters and page navigation query immediately and cancel pending search timers', async () => {
  const h = activityHarness();
  h.search('customer');
  const filter = h.document.getElementById('activity-module-filter');
  filter.value = 'customers';
  filter.emit('change');
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].module, 'customers');
  await h.timers.advance(300);
  assert.equal(h.calls.length, 1);
  h.search('next');
  h.document.getElementById('activity-next').emit('click');
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].offset, 20);
  await h.timers.advance(300);
  assert.equal(h.calls.length, 2);
});

test('activity search does not query a closed panel or repeat a render triggered before the delay expires', async () => {
  const h = activityHarness();
  h.search('closed');
  h.state.currentTab = 'dashboard-panel';
  await h.timers.advance(300);
  assert.equal(h.calls.length, 0);
  h.state.currentTab = 'activity-log-panel';
  h.search('open');
  await h.api.renderActivityLog();
  assert.equal(h.calls.length, 1);
  await h.timers.advance(300);
  assert.equal(h.calls.length, 1);
});

test('an older activity response cannot render during a new debounced search', async () => {
  const h = activityHarness();
  const pending = deferred();
  h.results.push(pending.promise);
  const rendering = h.api.renderActivityLog();
  h.search('new');
  pending.resolve({ rows: [], total: 999 });
  await rendering;
  assert.equal(h.document.getElementById('activity-page-info').textContent, '');
  await h.timers.advance(300);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].search, 'new');
  assert.match(h.document.getElementById('activity-page-info').textContent, /100 hoạt động/);
});
