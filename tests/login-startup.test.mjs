import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const main = read('js/main.js');
const timeout = read('js/domain/auth-timeout.js').replace(/^export /gm, '');
const init = main.slice(main.indexOf('function setupLoginEntry()'), main.indexOf('// Xử lý khi nhấn nút kết nối lại trên Badge'));
const starter = main.slice(main.indexOf('async function startApp()'), main.indexOf("if (document.readyState === 'loading') window.addEventListener"));

function harness({ connect = 'pending', session = null, profile = 'valid', maintenance = 'normal', setupFails = false } = {}) {
  const nodes = new Map(); const timers = new Map(); let nextTimer = 0;
  const calls = { cloud: 0, clearTokens: 0, signOut: 0, render: 0 };
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set(); const listeners = {};
      nodes.set(id, { value: '', checked: false, innerHTML: 'Đăng nhập', innerText: '', textContent: '',
        disabled: false, hidden: true, dataset: {}, style: { display: 'none' }, listeners,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
        addEventListener(event, listener) { (listeners[event] ||= []).push(listener); }, focus() {} });
    }
    return nodes.get(id);
  }
  const state = { currentUser: null, users: [] };
  const storage = new Map();
  let resolveConnect;
  const context = vm.createContext({ state, console: { error() {}, warn() {} },
    document: { getElementById: node, querySelectorAll: () => [] },
    window: { location: { hash: '#/ban-hang' } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    isSalesWorkspaceRoute: () => true, isCloudActive: false,
    COMPANY_SUPABASE_URL: 'https://synthetic.invalid', COMPANY_SUPABASE_KEY: 'synthetic-public-key',
    safeCreateIcons() {}, showToast() {}, updateDbStatusUI() {}, loadLocalStorageBackup() {},
    clearSupabaseAuthStorage: () => { calls.clearTokens++; },
    clearAuthenticatedSessionState: () => { state.currentUser = null; },
    showLoginGate: () => { node('login-screen').style.display = 'none'; node('app-layout').classList.add('auth-hidden'); },
    handleLogin() {}, handleLogout() {},
    connectSupabase: () => new Promise(resolve => {
      resolveConnect = value => { context.isCloudActive = value; resolve(value); };
      if (connect !== 'pending') resolveConnect(connect);
    }),
    supabaseClient: { auth: { getSession: () => session === 'pending' ? new Promise(() => {}) : Promise.resolve({ data: { session } }),
      signOut: async () => { calls.signOut++; } } },
    loadAuthenticatedProfile: () => profile === 'pending' ? new Promise(() => {}) : Promise.resolve({ id: 'profile', auth_user_id: 'auth', role: 'sale', is_active: true }),
    getMaintenanceStatus: () => maintenance === 'pending' ? new Promise(() => {}) : Promise.resolve({ enabled: maintenance === 'enabled' }), noteMaintenanceStatusCheck() {},
    fetchCloudData: async () => { calls.cloud++; return {}; },
    renderAll: () => { calls.render++; }, populatePricelistsDropdowns() {}, resetAuthenticatedBusinessState() {}, applyUserPermissions() {}, startMaintenanceMonitor() {}, switchTab() {}, startRealtimeSync() {} });
  for (const name of new Set(init.match(/\bsetup[A-Z]\w+(?=\()/g))) context[name] = () => {};
  if (setupFails) context.setupProductManagement = () => { throw new Error('Synthetic setup failure'); };
  vm.runInContext(`${timeout}\n${init}\n${starter}`, context);
  return { state, node, calls, context, timers, run: code => vm.runInContext(code, context),
    connect: value => resolveConnect(value),
    expire(ms = 12000) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); } } };
}

test('login UI and submit handlers exist before the Cloud connection completes', async () => {
  const h = harness(); const pending = h.run('initApp()');
  assert.equal(h.node('login-screen').style.display, 'flex');
  assert.equal(h.node('login-form').listeners.submit.length, 2);
  assert.equal(h.node('btn-login-submit').disabled, true);
  assert.equal(h.node('login-form').dataset.loginState, 'connecting');
  assert.equal(h.calls.cloud, 0);
  h.connect(false); await pending;
  assert.equal(h.node('login-form').dataset.loginState, 'error');
  assert.equal(h.node('btn-retry-login-startup').hidden, false);
});

test('a stalled session or profile lookup times out without restoring an unverified user', async () => {
  for (const scenario of ['session', 'profile']) {
    const h = harness({ connect: true, session: scenario === 'session' ? 'pending' : { user: { id: 'auth' } }, profile: scenario === 'profile' ? 'pending' : 'valid' });
    const pending = h.run('initApp()');
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    h.expire();
    await pending;
    assert.equal(h.state.currentUser, null);
    assert.equal(h.calls.cloud, 0);
    assert.equal(h.calls.clearTokens, 0, 'a slow connection must not delete a valid stored session');
    assert.equal(h.node('login-screen').style.display, 'flex');
    assert.equal(h.node('btn-login-submit').disabled, false);
  }
});

test('maintenance denial or timeout never restores the recovered profile', async () => {
  for (const maintenance of ['enabled', 'pending']) {
    const h = harness({ connect: true, session: { user: { id: 'auth' } }, maintenance });
    const pending = h.run('initApp()');
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    if (maintenance === 'pending') h.expire();
    await pending;
    assert.equal(h.state.currentUser, null);
    assert.equal(h.calls.cloud, 0);
    assert.equal(h.node('login-screen').style.display, 'flex');
  }
});

test('a synchronous setup failure keeps login visible with an explicit retry action', async () => {
  const h = harness({ setupFails: true });
  await h.run('startApp()');
  assert.equal(h.node('login-screen').style.display, 'flex');
  assert.equal(h.node('login-form').dataset.loginState, 'error');
  assert.equal(h.node('btn-retry-login-startup').hidden, false);
  assert.equal(h.state.currentUser, null);
});

test('the independent doorway blocks accidental form submission before the application is ready', () => {
  const h = harness();
  vm.runInContext(read('js/login-entry.js'), h.context);
  assert.equal(h.node('login-screen').style.display, 'flex');
  let prevented = false; let stopped = false;
  h.node('login-form').listeners.submit[0]({ preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(prevented && stopped, true);
  h.expire(15000);
  assert.equal(h.node('btn-retry-login-startup').hidden, false);
  assert.match(h.node('login-startup-status').textContent, /Kết nối đang chậm/);
});

test('Auth deadlines reject stalled work and clean their timers after success or failure', async () => {
  const h = harness();
  const stalled = h.run('withAuthTimeout(new Promise(() => {}))');
  h.expire(); await assert.rejects(stalled, error => error.code === 'AUTH_TIMEOUT' && error.loginCode === 'NETWORK');
  assert.equal(await h.run('withAuthTimeout(Promise.resolve(42))'), 42);
  await assert.rejects(h.run('withAuthTimeout(Promise.reject(new Error("denied")))'), /denied/);
  assert.equal(h.timers.size, 0);
});

test('login-critical libraries are served locally and the doorway precedes application modules', () => {
  const html = read('index.html');
  for (const name of ['supabase', 'lucide', 'xlsx', 'chart']) {
    assert.match(html, new RegExp(`<script defer src="js/vendor/${name}\\.js\\?v=`));
  }
  assert.doesNotMatch(html, /<script[^>]*src="https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)/);
  assert.ok(html.indexOf('src="js/login-entry.js?') < html.indexOf('type="module" src="js/main.js?'));
  assert.match(html, /fonts\.googleapis\.com[^>]+media="print"/);
});

test('a stalled password sign-in restores editable fields and the submit button after its deadline', async () => {
  const h = harness();
  h.context.isCloudActive = true;
  h.context.supabaseClient.auth.signInWithPassword = () => new Promise(() => {});
  Object.assign(h.context, {
    stopRealtimeSync: async () => {}, setMaintenanceNotice() {}, loginErrorMessage: () => 'Không thể kết nối.',
    classifySupabaseError: () => 'NETWORK', LOGIN_ERROR: { NETWORK: 'NETWORK', MAINTENANCE: 'MAINTENANCE' }
  });
  const users = read('js/components/users.js');
  const handle = users.slice(users.indexOf('export async function handleLogin('), users.indexOf('export async function handleLogout(')).replace('export ', '');
  vm.runInContext(`let isLoggingIn=false; ${handle}`, h.context);
  h.node('login-username').value = 'synthetic-user'; h.node('login-password').value = 'synthetic-not-a-real-password';
  const pending = h.context.handleLogin({ preventDefault() {}, target: {} });
  assert.equal(h.node('btn-login-submit').disabled, true);
  h.expire(); await pending;
  assert.equal(h.node('btn-login-submit').disabled, false);
  assert.equal(h.node('login-username').disabled, false);
  assert.equal(h.node('login-password').disabled, false);
  assert.equal(h.state.currentUser, null);
});
