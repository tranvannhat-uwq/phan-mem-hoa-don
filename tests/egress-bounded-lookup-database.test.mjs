import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const admin = '90000000-0000-4000-8000-000000000001';
const sale = '90000000-0000-4000-8000-000000000002';
const other = '90000000-0000-4000-8000-000000000003';
const fixture = new URL('../migrations/', import.meta.url);

async function as(id, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec(`SET ROLE ${role}`);
}
async function rpc(name, values = [], types = []) {
  const args = values.map((_, i) => `$${i + 1}::${types[i]}`).join(',');
  return (await db.query(`SELECT public.${name}(${args}) AS value`, values)).rows[0].value;
}

before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, instance_id uuid, aud text, role text, email text,
      encrypted_password text, raw_app_meta_data jsonb DEFAULT '{}', raw_user_meta_data jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
  const files = (await readdir(fixture))
    .filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 84).sort();
  for (const file of files) {
    let source = (await readFile(new URL(file, fixture), 'utf8')).replace(/^\uFEFF/, '');
    if (file.startsWith('0001')) source = source.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
    try { await db.exec(source); } catch (error) { throw new Error(`${file}: ${error.message}`); }
  }
  for (const file of [
    '0088_integrated_inventory_free_budget.sql',
    '0089_inventory_sync_toggle.sql',
    '0090_bounded_customer_product_lookup.sql'
  ]) {
    try { await db.exec(await readFile(new URL(file, fixture), 'utf8')); }
    catch (error) { throw new Error(`${file}: ${error.message}\n${error.where || ''}`); }
  }
  await db.exec(`INSERT INTO auth.users(id,email) VALUES
    ('${admin}','admin@test.invalid'),('${sale}','sale@test.invalid'),('${other}','other@test.invalid');
    UPDATE public.profiles SET role='admin' WHERE auth_user_id='${admin}';
    INSERT INTO public.customers(id,code,name,phone,managed_by,status,brand_discounts,pricelist_id)
    VALUES ('customer-visible','CV','Visible buyer','0901234567','sale@test.invalid','active','{"Nano10*":5}','price-visible'),
      ('customer-assigned','CA','Assigned buyer','0909999999','other@test.invalid','active','{}','price-assigned'),
      ('customer-hidden','CH','Hidden buyer','0911111111','other@test.invalid','active','{}','price-hidden');
    INSERT INTO public.customer_assignments(id,customer_id,employee_id,is_active)
      VALUES ('assignment-1','customer-assigned','sale@test.invalid',true);
    INSERT INTO public.products(id,code,variant_code,name,brand,package_type,base_code,product_group_id,weight_or_volume,is_active,is_legacy)
    VALUES ('variant-a','FAM-LON','FAM-LON','Paint family','Nano10*','Lon','FAM','group-fam',1,true,false),
      ('variant-b','FAM-THUNG','FAM-THUNG','Paint family','Nano10*','Thung','FAM','group-fam',5,true,false),
      ('variant-c','FAM-OLD','FAM-OLD','Paint family','Nano10*','Lon','FAM','group-fam',1,false,false),
      ('variant-other','OTHER-LON','OTHER-LON','Other paint','Nano10*','Lon','OTHER','group-other',1,true,false);`);
});
after(async () => { if (db) await db.close(); });

test('anonymous and inactive accounts cannot search; Sale sees only own or assigned customers', async () => {
  await as(null, 'anon');
  await assert.rejects(rpc('rpc_egress_search_customers', ['buyer'], ['text']), /permission denied|authentication required/);
  await as(sale);
  const found = await rpc('rpc_egress_search_customers', ['buyer'], ['text']);
  assert.deepEqual(found.data.map(row => row.id).sort(), ['customer-assigned', 'customer-visible']);
  assert.equal(await rpc('rpc_egress_customer_detail', ['customer-hidden'], ['text']), null);
  const selected = await rpc('rpc_egress_customer_detail', ['customer-visible'], ['text']);
  assert.equal(selected.pricelist_id, 'price-visible');
  assert.equal(selected.brand_discounts['Nano10*'], 5);
  await as(other);
  const otherView = await rpc('rpc_egress_search_customers', ['buyer'], ['text']);
  assert.deepEqual(otherView.data.map(row => row.id).sort(), ['customer-assigned', 'customer-hidden']);
  await db.exec('RESET ROLE');
  await db.query('UPDATE public.profiles SET is_active=false WHERE auth_user_id=$1', [other]);
  await as(other);
  await assert.rejects(rpc('rpc_egress_search_products', ['FAM'], ['text']), /active profile required/);
  await db.exec('RESET ROLE');
  await db.query('UPDATE public.profiles SET is_active=true WHERE auth_user_id=$1', [other]);
});

test('SKU search supports saleable filtering and family pages without catalog fetch', async () => {
  await as(sale);
  const search = await rpc('rpc_egress_search_products', ['FAM', 50, null, null, true], ['text', 'integer', 'text', 'text', 'boolean']);
  assert.deepEqual(search.data.map(row => row.id), ['variant-a', 'variant-b']);
  assert.equal(search.data[0].base_code, 'FAM');
  assert.equal(search.data[0].package_type, 'Lon');
  const family = await rpc('rpc_egress_product_family', ['variant-a', 1], ['text', 'integer']);
  assert.equal(family.data.length, 1);
  assert.equal(family.hasMore, true);
  const next = await rpc('rpc_egress_product_family', ['variant-a', 1, family.nextCursor], ['text', 'integer', 'text']);
  assert.deepEqual([...family.data, ...next.data].map(row => row.id), ['variant-a', 'variant-b']);
  assert.equal(next.hasMore, false);
  const detail = await rpc('rpc_egress_product_detail', ['variant-b'], ['text']);
  assert.equal(detail.weight_or_volume, 5);
});

test('keyset lookup finds rows after page 1,000 and never returns more than 50 rows or 32 KiB', async () => {
  await db.exec('RESET ROLE');
  await db.exec(`INSERT INTO public.customers(id,code,name,managed_by,status)
    SELECT 'bulk-c-'||g, 'BC-'||lpad(g::text,4,'0'),
      CASE WHEN g=1105 THEN 'Distant buyer needle' ELSE 'Ordinary buyer' END,
      'sale@test.invalid','active' FROM generate_series(1,1105) g;
    INSERT INTO public.products(id,code,name,brand,package_type,is_active,is_legacy)
    SELECT 'bulk-p-'||g, 'BP-'||lpad(g::text,4,'0'),
      CASE WHEN g=1105 THEN 'Distant SKU needle' ELSE 'Ordinary paint' END,
      'Nano10*','Lon',true,false FROM generate_series(1,1105) g;`);
  await as(sale);
  const customer = await rpc('rpc_egress_search_customers', ['needle'], ['text']);
  const product = await rpc('rpc_egress_search_products', ['needle'], ['text']);
  assert.deepEqual(customer.data.map(row => row.id), ['bulk-c-1105']);
  assert.deepEqual(product.data.map(row => row.id), ['bulk-p-1105']);
  let cursor = null; const seen = new Set();
  do {
    const response = await rpc('rpc_egress_search_customers', ['', 50, cursor?.code ?? null, cursor?.id ?? null], ['text', 'integer', 'text', 'text']);
    assert.ok(response.data.length <= 50);
    assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') <= 32768);
    for (const row of response.data) assert.ok(!seen.has(row.id)), seen.add(row.id);
    cursor = response.hasMore ? response.nextCursor : null;
  } while (cursor);
  assert.ok(seen.has('bulk-c-1105'));
  assert.equal(seen.size, 1107);
});

test('accentless Vietnamese lookup finds composed and decomposed names, brands and codes', async () => {
  await db.exec('RESET ROLE');
  await db.exec(`INSERT INTO public.customers(id,code,name,managed_by)
    VALUES ('accent-c','ĐL-01','Nguyễn Văn An','sale@test.invalid'),
      ('accent-decomposed','DL-02',U&'Nguye\\0302\\0303n Thị Mai','sale@test.invalid');
    INSERT INTO public.products(id,code,name,brand,package_type,is_active,is_legacy)
    VALUES ('accent-p','SƠN-01','Sơn bóng','Đức Thịnh','Lon',true,false);`);
  await as(sale);
  assert.deepEqual((await rpc('rpc_egress_search_customers', ['Nguyen'], ['text'])).data
    .filter(row => row.id.startsWith('accent')).map(row => row.id).sort(),
  ['accent-c', 'accent-decomposed']);
  assert.deepEqual((await rpc('rpc_egress_search_customers', ['DL-01'], ['text'])).data.map(row => row.id), ['accent-c']);
  assert.deepEqual((await rpc('rpc_egress_search_products', ['son'], ['text'])).data.map(row => row.id), ['accent-p']);
  assert.deepEqual((await rpc('rpc_egress_search_products', ['duc thinh'], ['text'])).data.map(row => row.id), ['accent-p']);
});

test('long Unicode notes trim pages by byte size, retain cursor, and reject oversized single details', async () => {
  await db.exec('RESET ROLE');
  await db.exec(`INSERT INTO public.customers(id,code,name,managed_by,notes)
    SELECT 'wide-'||g, 'ZZ-'||lpad(g::text,3,'0'), 'Wide buyer',
      'sale@test.invalid', repeat('á',2600) FROM generate_series(1,8) g;`);
  await as(sale);
  const first = await rpc('rpc_egress_search_customers', ['Wide buyer', 50], ['text', 'integer']);
  assert.ok(first.data.length > 0 && first.data.length < 8);
  assert.equal(first.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 32768);
  const second = await rpc('rpc_egress_search_customers', ['Wide buyer', 50, first.nextCursor.code, first.nextCursor.id], ['text','integer','text','text']);
  assert.equal(first.data.length + second.data.length, 8);
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.customers SET notes=repeat('á',18000) WHERE id='wide-1'");
  await as(sale);
  await assert.rejects(rpc('rpc_egress_customer_detail', ['wide-1'], ['text']), /32 KiB/);
});

test('filters reject oversized input and cursor mismatch; literal wildcard does not expose rows', async () => {
  await as(sale);
  await assert.rejects(rpc('rpc_egress_search_customers', ['X'.repeat(241)], ['text']), /Invalid customer lookup filter/);
  await assert.rejects(rpc('rpc_egress_search_products', ['', 10, 'A'], ['text','integer','text']), /Invalid product lookup filter/);
  const literal = await rpc('rpc_egress_search_customers', ["%' OR 1=1 --"], ['text']);
  assert.equal(literal.data.length, 0);
});
