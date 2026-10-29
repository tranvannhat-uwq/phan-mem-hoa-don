import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/components/so_quy.js', import.meta.url), 'utf8');
const paymentCode = source.slice(source.indexOf('// 17. Modal actions'), source.indexOf('// 18. Export file report'));
function harness(save) {
  const nodes = new Map(), calls = [], toasts = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: true, dataset: {}, disabled: false, handlers: {}, classList: { add() {}, remove() {} },
      addEventListener(name, fn) { this.handlers[name] = fn; }, querySelector() { return node('submit'); }, reset() {}, fire(type) { return this.handlers[type]?.({ preventDefault() {} }); } });
    return nodes.get(id);
  };
  let sequence = 0, transactions = [];
  const context = vm.createContext({
    document: { getElementById: node }, crypto: { randomUUID: () => `attempt-uuid-${++sequence}` }, pendingPaymentIdempotencyKey: '',
    setupPaymentRecipientPicker() {}, setupCashbookCurrencyInput() {}, populatePaymentRecipientDatalist() {},
    setCashbookDateTimeValue: (id, value) => { node(id).value = value; }, activeFilters: { accountType: 'cash' },
    state: { currentUser: { displayName: 'Kế toán' }, suppliers: [] }, findSupplierByInput: () => null,
    parseCashbookCurrencyInput: field => Number(field.value), getCashbookTransactions: () => transactions,
    saveCashbookTransactions: rows => { transactions = rows; }, renderAll() {}, showToast: message => toasts.push(message), getCashbookDisplayCode: tx => tx.id,
    dbSaveCashbookTransaction: async (tx, options) => { calls.push({ ...tx }); return save ? save(tx, options) : (tx.id = `PC-${calls.length}`, { success: true }); }
  });
  vm.runInContext(paymentCode, context);
  node('payment-value').value = '100000000'; node('payment-recipient').value = 'Việt Long'; node('payment-category').value = 'Chi tiền nhập hàng';
  return { node, calls, toasts };
}

test('separate payment forms get different keys even when the generated display code repeats', async () => {
  const h = harness();
  h.node('so-quy-btn-add-chi').fire('click'); await h.node('so-quy-payment-form').fire('submit');
  h.node('so-quy-btn-add-chi').fire('click'); await h.node('so-quy-payment-form').fire('submit');
  assert.equal(h.calls[0].id, h.calls[1].id);
  assert.notEqual(h.calls[0].idempotencyKey, h.calls[1].idempotencyKey);
});

test('failed saves keep the attempt key, report the Cloud error, and concurrent submissions are blocked', async () => {
  let finish;
  const h = harness(async (tx, { onError }) => { await new Promise(resolve => { finish = resolve; }); onError('Cloud từ chối yêu cầu thử nghiệm'); return false; });
  h.node('so-quy-btn-add-chi').fire('click');
  const saving = h.node('so-quy-payment-form').fire('submit');
  await h.node('so-quy-payment-form').fire('submit');
  assert.equal(h.calls.length, 1); assert.equal(h.node('submit').disabled, true);
  finish(); await saving; assert.equal(h.node('submit').disabled, false);
  assert.match(h.toasts[0], /Cloud từ chối yêu cầu thử nghiệm/);
  const retry = h.node('so-quy-payment-form').fire('submit'); finish(); await retry;
  assert.equal(h.calls[0].idempotencyKey, h.calls[1].idempotencyKey);
  assert.equal(h.node('payment-value').value, '100000000');
});

test('cashbook service preserves the server rejection for the payment form', async () => {
  const service = readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
  const code = service.slice(service.indexOf('export async function dbSaveCashbookTransaction('), service.indexOf('export async function dbSaveStartingBalances(')).replace(/^export /gm, '');
  const context = vm.createContext({ isCloudActive: true, supabaseClient: { rpc: async () => ({ error: { message: '409: different cashbook payload' } }) }, console: { warn() {} }, showToast() {} });
  vm.runInContext(code, context);
  let failure = '';
  assert.equal(await context.dbSaveCashbookTransaction({ id: 'TCM000001', value: 100 }, { onError: message => { failure = message; } }), false);
  assert.match(failure, /different cashbook payload/);
});

test('database reproduces reused display-code keys and accepts independent UUID attempts exactly once', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, instance_id uuid, aud text, role text, email text,
        encrypted_password text, raw_app_meta_data jsonb DEFAULT '{}', raw_user_meta_data jsonb DEFAULT '{}',
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated,anon;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
    const directory = new URL('../migrations/', import.meta.url);
    const files = readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 7).sort();
    for (const file of files) await db.exec(readFileSync(new URL(file, directory), 'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    const actor = 'cb140000-0000-4000-8000-000000000001';
    await db.exec(`INSERT INTO auth.users(id,email) VALUES ('${actor}','payment-create@test.invalid');
      UPDATE public.profiles SET role='accounting' WHERE auth_user_id='${actor}';`);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.exec('SET ROLE authenticated');
    const create = async input => (await db.query('SELECT public.rpc_create_cashbook_transaction($1::jsonb) AS result', [JSON.stringify(input)])).rows[0].result;
    const input = { idempotencyKey: 'cashbook:TCM000001', externalReference: 'TCM000001', type: 'chi', method: 'cash', partner: 'Việt Long', category: 'Chi tiền nhập hàng', value: 100000000, transactionDate: '2026-10-29T08:00:00Z' };
    await create(input);
    await assert.rejects(create({ ...input, value: 200000000 }), /different cashbook payload/);
    const second = { ...input, idempotencyKey: randomUUID(), value: 200000000 };
    assert.equal((await create(second)).already_recorded, false);
    assert.equal((await create(second)).already_recorded, true);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.cashbook_transactions')).rows[0].count, 2);
  } finally { await db.close(); }
});
