import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db, supplierId, legacyInput, legacyId, priorDiscountInput, priorDiscount;
const accountant = 'a1020000-0000-4000-8000-000000000001';
const sale = 'a1020000-0000-4000-8000-000000000002';
const read = name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
async function role(id = accountant, name = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`SET ROLE ${name}`);
}
const rpc = (name, input) => value(`SELECT public.${name}($1::jsonb) AS value`, [JSON.stringify(input)]);
const input = overrides => ({ supplierId, purchaseDate: '2026-10-24T01:00:00Z',
  idempotencyKey: randomUUID(), paidAmount: 0, paymentMethod: 'cash',
  items: [{ code: 'VO-NT01', name: 'Vỏ thùng NT01', unit: 'cái', quantity: 2, unitPrice: 125000 }],
  ...overrides });

before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, instance_id uuid, aud text, role text, email text,
      encrypted_password text, raw_app_meta_data jsonb DEFAULT '{}', raw_user_meta_data jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
  const files = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 9).sort();
  for (const file of files) {
    let sql = await read(file);
    if (file.startsWith('0001')) sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
    await db.exec(sql);
  }
  await db.exec(`INSERT INTO auth.users(id,email) VALUES ('${accountant}','vat-accountant@test.invalid'),('${sale}','vat-sale@test.invalid');
    UPDATE public.profiles SET role='accounting' WHERE auth_user_id='${accountant}';`);
  await role();
  supplierId = (await rpc('rpc_save_supplier', { code: 'VAT-NCC', name: 'VAT test supplier', openingDebt: 0 })).supplier.id;
  legacyInput = input({ items: [{ code: 'OLD', name: 'Phiếu trước nâng cấp', quantity: 1, unitPrice: 100 }] });
  legacyId = (await rpc('rpc_create_purchase', legacyInput)).purchase.id;
  await db.exec('RESET ROLE');
  await db.exec(await read('0102_purchase_vat.sql'));
  await db.exec(await read('0133_purchase_discount.sql'));
  await role();
  const priorSupplierId = (await rpc('rpc_save_supplier', { code: 'PRIOR-DISCOUNT', name: 'Prior discount supplier', openingDebt: 0 })).supplier.id;
  priorDiscountInput = input({ supplierId: priorSupplierId, vatRate: 8, discountType: 'amount', discountValue: 30000 });
  priorDiscount = (await rpc('rpc_create_purchase_discount', priorDiscountInput)).purchase;
  await db.exec('RESET ROLE');
  await db.exec(await read('0136_purchase_discount_vat_timing.sql'));
});
after(async () => { await db?.close(); });

const quoteItems = [
  { code: '602', name: 'Alcosper 602 N', unit: 'kg', quantity: 1200, unitPrice: 39000 },
  { code: '2330', name: 'SAP-2330', unit: 'kg', quantity: 3000, unitPrice: 40000 },
  { code: '405', name: 'Triton X-405', unit: 'kg', quantity: 217.72, unitPrice: 127800 }
];
async function newSupplier() { return (await rpc('rpc_save_supplier', { code: randomUUID(), name: 'Invoice timing test', openingDebt: 0 })).supplier.id; }

test('existing discounted invoices retain their totals and pending-request fingerprints', async () => {
  await role();
  const replay = await rpc('rpc_create_purchase_discount', priorDiscountInput);
  assert.equal(replay.already_recorded, true);
  assert.equal(replay.purchase.id, priorDiscount.id);
  assert.equal(replay.purchase.discountTiming, 'before_vat');
  assert.equal(replay.purchase.totalAmount, priorDiscount.totalAmount);
  assert.equal(replay.purchase.vatAmount, priorDiscount.vatAmount);
});

test('Viet Com quote 891 matches exactly with shipping support deducted after VAT', async () => {
  await role();
  const sid = await newSupplier();
  const request = input({ supplierId: sid, items: quoteItems, vatRate: 8, discountType: 'amount', discountValue: 2208860, discountTiming: 'after_vat', paidAmount: 100000000,
    totalAmount: 1, vatAmount: 1, discountAmount: 1 });
  const result = await rpc('rpc_create_purchase_tax_discount', request);
  const p = result.purchase;
  assert.equal(p.subtotalAmount, 194624616);
  assert.equal(p.discountAmount, 2208860);
  assert.equal(p.vatAmount, 15569969);
  assert.equal(p.totalAmount, 207985725);
  assert.equal(p.balanceDue, 107985725);
  assert.equal(result.supplier.debt, 107985725);
  const stored = (await db.query('SELECT discount_timing,vat_amount,total_amount FROM public.purchases WHERE id=$1', [p.id])).rows[0];
  assert.equal(stored.discount_timing, 'after_vat');
  assert.equal(Number(stored.total_amount), 207985725);
  assert.equal((await rpc('rpc_create_purchase_tax_discount', request)).already_recorded, true);
  await assert.rejects(rpc('rpc_create_purchase_tax_discount', { ...request, discountTiming: 'before_vat' }), /different purchase payload/);
  const payment = await rpc('rpc_record_supplier_payment', { supplierId: sid, purchaseId: p.id, amount: 107985725, idempotencyKey: randomUUID() });
  assert.equal(payment.purchase.paidAmount, 207985725);
  assert.equal(payment.supplier.debt, 0);
  const cancelled = await value('SELECT public.rpc_cancel_purchase($1,$2) AS value', [p.id, 'Cancel quote test']);
  assert.equal(cancelled.purchase.discountTiming, 'after_vat');
  assert.equal(cancelled.supplier.debt, 0);
  assert.equal(Number(await value('SELECT sum(amount_change) AS value FROM public.supplier_debt_transactions WHERE purchase_id=$1', [p.id])), 0);
});

test('before-VAT mode still calculates VAT on the discounted goods subtotal', async () => {
  await role();
  const result = await rpc('rpc_create_purchase_tax_discount', input({ supplierId: await newSupplier(), items: quoteItems, vatRate: 8, discountType: 'amount', discountValue: 2208860, discountTiming: 'before_vat' }));
  assert.equal(result.purchase.vatAmount, 15393260);
  assert.equal(result.purchase.totalAmount, 207809016);
});

test('percentage discounts use the selected base and allow a fully discounted total', async () => {
  await role();
  for (const [discountTiming, discountAmount, vatAmount] of [['before_vat', 25000, 18000], ['after_vat', 27000, 20000]]) {
    const result = await rpc('rpc_create_purchase_tax_discount', input({ supplierId: await newSupplier(), vatRate: 8, discountType: 'percent', discountValue: 10, discountTiming }));
    assert.equal(result.purchase.discountAmount, discountAmount);
    assert.equal(result.purchase.vatAmount, vatAmount);
    assert.equal(result.purchase.totalAmount, 243000);
  }
  const free = await rpc('rpc_create_purchase_tax_discount', input({ supplierId: await newSupplier(), vatRate: 8, discountType: 'percent', discountValue: 100, discountTiming: 'after_vat' }));
  assert.equal(free.purchase.discountAmount, 270000);
  assert.equal(free.purchase.totalAmount, 0);
});

test('invalid VAT timing and excessive discounts cannot write an invoice', async () => {
  await role();
  const count = await value('SELECT count(*) AS value FROM public.purchases');
  await assert.rejects(rpc('rpc_create_purchase_tax_discount', input({ discountTiming: 'unknown' })), /trước VAT hoặc sau VAT/);
  await assert.rejects(rpc('rpc_create_purchase_tax_discount', input({ vatRate: 8, discountType: 'amount', discountValue: 270001, discountTiming: 'after_vat' })), /không được vượt quá/);
  assert.equal(await value('SELECT count(*) AS value FROM public.purchases'), count);
});

test('discount migration supports percentage and VND before VAT, persistence and retries', async () => {
  await role();
  for (const [discountType, discountValue, discountAmount] of [['percent', 10, 25000], ['amount', 30000, 30000]]) {
    const request = input({ discountType, discountValue, vatRate: 8, paidAmount: 100000 });
    const result = await rpc('rpc_create_purchase_discount', request);
    const purchase = result.purchase;
    const total = Math.round((250000 - discountAmount) * 1.08);
    assert.equal(purchase.discountType, discountType);
    assert.equal(purchase.discountValue, discountValue);
    assert.equal(purchase.discountAmount, discountAmount);
    assert.equal(purchase.vatAmount, (250000 - discountAmount) * 0.08);
    assert.equal(purchase.totalAmount, total);
    assert.equal(purchase.balanceDue, total - 100000);
    const stored = (await db.query('SELECT discount_type,discount_value,discount_amount,total_amount FROM public.purchases WHERE id=$1', [purchase.id])).rows[0];
    assert.equal(stored.discount_type, discountType);
    assert.equal(Number(stored.discount_amount), discountAmount);
    assert.equal(Number(stored.total_amount), total);
    assert.equal((await rpc('rpc_create_purchase_discount', request)).already_recorded, true);
    await assert.rejects(rpc('rpc_create_purchase_discount', { ...request, discountValue: discountValue + 1 }), /different purchase payload/);
    const cancelled = await value('SELECT public.rpc_cancel_purchase($1,$2) AS value', [purchase.id, 'Discount test cancellation']);
    assert.equal(cancelled.purchase.discountAmount, discountAmount);
    const ledger = (await db.query('SELECT amount_change FROM public.supplier_debt_transactions WHERE purchase_id=$1', [purchase.id])).rows;
    assert.equal(ledger.reduce((sum, row) => sum + Number(row.amount_change), 0), 0);
  }
});

test('invalid discounts raise their intended messages and create no purchases', async () => {
  await role();
  const count = await value('SELECT count(*) AS value FROM public.purchases');
  for (const discountValue of [-1, 100.01, 8.001, 'NaN', '8%', true]) {
    await assert.rejects(rpc('rpc_create_purchase_discount', input({ discountType: 'percent', discountValue })), /Giảm giá theo %/);
  }
  for (const discountValue of [-1, 0.5, 250001]) {
    await assert.rejects(rpc('rpc_create_purchase_discount', input({ discountType: 'amount', discountValue })), /Giảm giá VNĐ/);
  }
  assert.equal(await value('SELECT count(*) AS value FROM public.purchases'), count);
});

test('old purchases and pending zero-VAT retries keep the same amounts and fingerprint', async () => {
  await role();
  const result = await rpc('rpc_create_purchase_vat', { ...legacyInput, vatRate: 0 });
  assert.equal(result.already_recorded, true);
  assert.equal(result.purchase.id, legacyId);
  assert.equal(result.purchase.subtotalAmount, 100);
  assert.equal(result.purchase.vatRate, 0);
  assert.equal(result.purchase.vatAmount, 0);
  assert.equal(result.purchase.totalAmount, 100);
});

test('accountant-entered VAT is authoritative, survives reload, and is reversed with debt and payments', async () => {
  await role();
  const request = input({ vatRate: 8, paidAmount: 100000, totalAmount: 1, vatAmount: 1, subtotalAmount: 1 });
  const first = await rpc('rpc_create_purchase_vat', request);
  const purchase = first.purchase;
  assert.equal(purchase.subtotalAmount, 250000);
  assert.equal(purchase.vatRate, 8);
  assert.equal(purchase.vatAmount, 20000);
  assert.equal(purchase.totalAmount, 270000);
  assert.equal(purchase.balanceDue, 170000);
  assert.equal(first.supplier.debt, 170100);
  const stored = (await db.query('SELECT subtotal_amount,vat_rate,vat_amount,total_amount FROM public.purchases WHERE id=$1', [purchase.id])).rows[0];
  assert.equal(Number(stored.vat_amount), 20000);
  assert.equal(Number(stored.total_amount), 270000);
  assert.equal((await rpc('rpc_create_purchase_vat', request)).already_recorded, true);
  await assert.rejects(rpc('rpc_create_purchase_vat', { ...request, vatRate: 10 }), /different purchase payload/);
  const payment = await rpc('rpc_record_supplier_payment', { supplierId, purchaseId: purchase.id,
    amount: 170000, paymentMethod: 'bank', idempotencyKey: randomUUID() });
  assert.equal(payment.purchase.balanceDue, 0);
  assert.equal(payment.purchase.vatAmount, 20000);
  const cancelled = await value('SELECT public.rpc_cancel_purchase($1,$2) AS value', [purchase.id, 'VAT test cancellation']);
  assert.equal(cancelled.purchase.status, 'cancelled');
  assert.equal(cancelled.purchase.balanceDue, 0);
  assert.equal(cancelled.purchase.vatAmount, 20000);
  assert.equal(cancelled.supplier.debt, 100);
  const ledger = (await db.query('SELECT transaction_type, amount_change FROM public.supplier_debt_transactions WHERE purchase_id=$1', [purchase.id])).rows;
  assert.equal(Number(ledger.find(row => row.transaction_type === 'purchase').amount_change), 270000);
  assert.equal(Number(ledger.find(row => row.transaction_type === 'purchase_reversal').amount_change), -270000);
  assert.equal(ledger.reduce((sum, row) => sum + Number(row.amount_change), 0), 0);
});

test('decimal rates, zero VAT and rounding use the subtotal rounded by the server', async () => {
  await role();
  const response = await rpc('rpc_create_purchase_vat', input({ vatRate: 7.5,
    items: [{ code: 'DEC', name: 'Decimal', quantity: 1.5, unitPrice: 101 }] }));
  assert.equal(response.purchase.subtotalAmount, 152);
  assert.equal(response.purchase.vatAmount, 11);
  assert.equal(response.purchase.totalAmount, 163);
  const half = await rpc('rpc_create_purchase_vat', input({ vatRate: 12.5,
    items: [{ code: 'ROUND', name: 'Round', quantity: 1, unitPrice: 100 }] }));
  assert.equal(half.purchase.vatAmount, 13);
  const zero = await rpc('rpc_create_purchase_vat', input({ vatRate: 0 }));
  assert.equal(zero.purchase.vatAmount, 0);
  assert.equal(zero.purchase.totalAmount, 250000);
});

test('invalid VAT and overpayment are rejected without writing any financial records', async () => {
  await role();
  const count = await value('SELECT count(*) AS value FROM public.purchases');
  for (const vatRate of [-1, 100.01, 8.001, 'NaN', 'Infinity', '8%', true]) {
    await assert.rejects(rpc('rpc_create_purchase_vat', input({ vatRate })), /VAT/);
  }
  await assert.rejects(rpc('rpc_create_purchase_vat', input({ vatRate: 8, paidAmount: 270001 })), /Initial payment/);
  assert.equal(await value('SELECT count(*) AS value FROM public.purchases'), count);
});

test('VAT RPC denies Sale and anon and does not expose private purchase responses', async () => {
  await role(sale);
  await assert.rejects(rpc('rpc_create_purchase_vat', input({ vatRate: 8 })), /accounting role required/);
  await assert.rejects(rpc('rpc_create_purchase_tax_discount', input({ vatRate: 8, discountTiming: 'after_vat' })), /accounting role required/);
  await assert.rejects(value('SELECT public.p4_purchase_response($1) AS value', [legacyId]), /permission denied/);
  await role('', 'anon');
  await assert.rejects(rpc('rpc_create_purchase_vat', input({ vatRate: 8 })), /permission denied/);
  await assert.rejects(rpc('rpc_create_purchase_tax_discount', input({ vatRate: 8, discountTiming: 'after_vat' })), /permission denied/);
});

test('the existing purchase, payment and cancellation staging fixture remains compatible', async () => {
  await db.exec('RESET ROLE');
  const results = await db.exec(await read('tests/phase4_supplier_purchases_integration.sql'));
  const rows = results.flatMap(result => result.rows || []).filter(row => 'passed' in row);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.passed === true));
});
