import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

let db;
const admin='a1050000-0000-4000-8000-000000000001';
const accounting='a1050000-0000-4000-8000-000000000002';
const sale='a1050000-0000-4000-8000-000000000003';
const directory=new URL('../migrations/',import.meta.url);
const read=async name=>(await readFile(new URL(name,directory),'utf8')).replace(/^\uFEFF/,'');
async function as(id=admin,role='authenticated'){
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);
  await db.exec(`SET ROLE ${role}`);
}
const query=async(filters={})=>(await db.query('SELECT public.rpc_purchase_catalog($1::jsonb) AS result',[JSON.stringify(filters)])).rows[0].result;

before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,instance_id uuid,aud text,role text,email text,
      encrypted_password text,raw_app_meta_data jsonb DEFAULT '{}',raw_user_meta_data jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;`);
  const files=(await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=84).sort();
  files.push('0088_integrated_inventory_free_budget.sql','0089_inventory_sync_toggle.sql','0090_bounded_customer_product_lookup.sql',
    '0091_inventory_page_limit.sql','0092_bom_two_stage.sql','0094_repair_bom_item_unit_edit.sql',
    '0097_invoice_product_brand_search.sql','0105_purchase_existing_product_shells.sql');
  for(const name of files){
    let sql=await read(name);
    if(name.startsWith('0001'))sql=sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
    await db.exec(sql);
  }
  await db.exec(`INSERT INTO auth.users(id,email) VALUES('${admin}','catalog-admin@test.invalid'),
    ('${accounting}','catalog-accounting@test.invalid'),('${sale}','catalog-sale@test.invalid');
    UPDATE public.profiles SET role='admin' WHERE auth_user_id='${admin}';
    UPDATE public.profiles SET role='accounting' WHERE auth_user_id='${accounting}';
    INSERT INTO public.products(id,code,variant_code,name,brand,packaging_name,purchase_price,is_active,is_legacy) VALUES
      ('paint-b1','NT-B1-THUNG','NT-B1-THUNG','Sơn siêu bóng nội thất cao cấp','NANO10 MB','Thùng',900000,true,false),
      ('shell-b1','VỎ THÙNG NT-B1','VỎ THÙNG NT-B1','Sơn siêu bóng nội thất cao cấp','NANO10 MB','Bộ',51250,true,false),
      ('shell-b2','VỎ THÙNG NT-B2','VỎ THÙNG NT-B2','Sơn siêu bóng ngoại thất cao cấp','NANO10 MB','Bộ',48867.65,true,false),
      ('shell-899','VỎ THÙNG NT-899','VỎ THÙNG NT-899','Sơn men sứ nội thất cao cấp 9in1','NANO10 MB','Bộ',48296.87,true,false),
      ('shell-d1','VỎ THÙNG NT-Đ1','VỎ THÙNG NT-Đ1','Sơn lót chống kiềm nội thất cao cấp','NANO10 MB','Bộ',51250,true,false),
      ('shell-other-brand','VỎ THÙNG NT-B1','VỎ THÙNG NT-B1','Sơn siêu bóng nội thất cao cấp','NANO10 MN','Bộ',51000,true,false),
      ('shell-can','VỎ LON NT-B1','VỎ LON NT-B1','Sơn siêu bóng nội thất cao cấp','NANO10 MB','Bộ',20000,true,false),
      ('shell-off','VỎ THÙNG OFF',NULL,'Ngừng sử dụng','NANO10 MB','Bộ',1,false,false),
      ('shell-old','VỎ THÙNG OLD',NULL,'Mã cũ','NANO10 MB','Bộ',1,true,true);
    INSERT INTO public.bom_items(code,name,kind,base_unit,purchase_unit,purchase_to_base) VALUES
      ('BB-THUNG-18L-01','VỎ THÙNG 18 LÍT LOẠI 1','packaging','cái','cái',1),
      ('NL-TIO2','Titan trắng','raw','kg','bao',25);`);
});
after(async()=>{await db?.close();});

test('vỏ thùng NT lists actual product shell codes and paint descriptions, not generic or paint SKU shells',async()=>{
  await as();
  const result=await query({query:'vỏ thùng nt'});
  assert.equal(result.rows.length,5);
  assert.ok(result.rows.every(row=>row.source==='product'&&row.code.startsWith('VỎ THÙNG NT-')));
  assert.ok(result.rows.some(row=>row.code==='VỎ THÙNG NT-899'));
  const b1=result.rows.find(row=>row.product_id==='shell-b1');
  assert.equal(b1.name,'Sơn siêu bóng nội thất cao cấp');
  assert.equal(b1.code,'VỎ THÙNG NT-B1');
  assert.equal(b1.purchase_unit,'Bộ');
  assert.equal(Number(b1.unit_price),51250);
  assert.ok(!result.rows.some(row=>/LOẠI 1|VO-/.test(row.code+' '+row.name)));
});

test('search tolerates Vietnamese accents, spaces, reordered words and retains distinct brand matches',async()=>{
  await as(accounting);
  const a=await query({query:'vo thung nt d1'});
  assert.equal(a.rows.length,1);
  assert.equal(a.rows[0].code,'VỎ THÙNG NT-Đ1');
  assert.equal((await query({query:'nt thùng vỏ b1'})).rows.length,2);
  assert.equal((await query({query:'vỏ lon nt b1'})).rows.length,1);
  assert.equal((await query({query:'titan'})).rows[0].source,'material');
  assert.equal((await query({query:'BB-THUNG-18L-01'})).rows[0].code,'BB-THUNG-18L-01');
  assert.equal((await query({query:'vỏ ngừng'})).rows.length,0);
});

test('cursor paging remains complete for shells sharing the same code across brands',async()=>{
  await as();
  let cursor=null;const ids=[];
  for(let page=0;page<10;page++){
    const result=await query({query:'vỏ thùng nt',limit:2,cursor});
    assert.ok(result.rows.length<=2);
    ids.push(...result.rows.map(row=>row.id));
    if(!result.hasMore)break;
    cursor=result.nextCursor;
    assert.ok(cursor?.id&&cursor?.code);
  }
  assert.equal(ids.length,5);
  assert.equal(new Set(ids).size,5);
});

test('reading the purchase catalogue does not create or alter products, stock or packaging materials',async()=>{
  await db.exec('RESET ROLE');
  const before=(await db.query(`SELECT (SELECT count(*) FROM public.bom_items) AS materials,
    (SELECT count(*) FROM public.products) AS products,(SELECT count(*) FROM public.inventory_movements) AS movements`)).rows[0];
  await as();await query({query:'vỏ'});await query({query:''});
  await assert.rejects(db.query('SELECT public.rpc_bom_add_product_packaging()'),/lấy trực tiếp từ Danh sách sản phẩm/);
  await db.exec('RESET ROLE');
  const after=(await db.query(`SELECT (SELECT count(*) FROM public.bom_items) AS materials,
    (SELECT count(*) FROM public.products) AS products,(SELECT count(*) FROM public.inventory_movements) AS movements`)).rows[0];
  assert.deepEqual(after,before);
});

test('legacy generated packaging is excluded when 0101 metadata exists',async()=>{
  await db.exec('RESET ROLE');
  await db.exec(`ALTER TABLE public.bom_items ADD COLUMN source_product_id text;
    INSERT INTO public.bom_items(code,name,kind,base_unit,purchase_unit,purchase_to_base,source_product_id)
    VALUES('VO-PAINT-HASH','VỎ THÙNG NT-B1-THUNG','packaging','cái','cái',1,'paint-b1');`);
  await as();
  assert.equal((await query({query:'VO-PAINT-HASH'})).rows.length,0);
  assert.equal((await query({query:'vỏ thùng nt'})).rows.length,5);
});

test('catalogue is finance-only and validates bounds',async()=>{
  await as(sale);await assert.rejects(query(),/Chỉ Admin/);
  await as('','anon');await assert.rejects(query(),/permission denied/);
  await as();await assert.rejects(query({limit:31}),/1–30/);
  await assert.rejects(query({query:'x'.repeat(81)}),/Bộ lọc/);
  await assert.rejects(query({cursor:{source:'other',code:'x',id:'x'}}),/Cursor/);
});
