-- ====================================================================
-- SQL Script nâng cấp bảo mật và cấu hình CSDL Supabase cho ứng dụng WebLendon
-- Sao chép toàn bộ mã này và chạy trong SQL Editor của Supabase để nâng cấp.
-- ====================================================================

-- 1. TẠO CÁC BẢNG DỮ LIỆU NẾU CHƯA CÓ

-- Bảng khách hàng (customers)
CREATE TABLE IF NOT EXISTS customers (
    id text PRIMARY KEY,
    code text UNIQUE NOT NULL,
    name text NOT NULL,
    phone text,
    address text,
    assigned_brand text DEFAULT 'Tất cả',
    brand_discounts jsonb DEFAULT '{}'::jsonb,
    shipping_support boolean DEFAULT false,
    debt numeric DEFAULT 0,
    total_transaction numeric DEFAULT 0,
    notes text,
    pricelist_id text,
    managed_by text,
    debt_history jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz DEFAULT now()
);

-- Bảng sản phẩm (products)
CREATE TABLE IF NOT EXISTS products (
    code text NOT NULL,
    brand text NOT NULL DEFAULT 'Nano10*',
    name text NOT NULL,
    price numeric DEFAULT 0,
    price_thung numeric DEFAULT 0,
    price_lon numeric DEFAULT 0,
    price_hop numeric DEFAULT 0,
    price_bao numeric DEFAULT 0,
    price_tui numeric DEFAULT 0,
    weight_thung text DEFAULT '',
    weight_bao text DEFAULT '',
    weight_lon text DEFAULT '',
    weight_hop text DEFAULT '',
    weight_tui text DEFAULT '',
    created_at timestamptz DEFAULT now(),
    CONSTRAINT products_pk PRIMARY KEY (code, brand)
);

-- Bảng hóa đơn (orders)
CREATE TABLE IF NOT EXISTS orders (
    id text PRIMARY KEY,
    customer_id text,
    customer_name text NOT NULL,
    notes text,
    items jsonb NOT NULL,
    total_market numeric DEFAULT 0,
    total_discount numeric DEFAULT 0,
    shipping_support boolean DEFAULT false,
    shipping_discount numeric DEFAULT 0,
    total_payable numeric DEFAULT 0,
    pricelist_id text,
    created_by text,
    status text DEFAULT 'settled',
    created_at timestamptz DEFAULT now()
);

-- Bảng đơn hàng nháp (draft_orders)
CREATE TABLE IF NOT EXISTS draft_orders (
    id text PRIMARY KEY,
    customer_id text,
    customer_name text NOT NULL,
    notes text,
    items jsonb NOT NULL,
    total_market numeric DEFAULT 0,
    total_discount numeric DEFAULT 0,
    shipping_support boolean DEFAULT false,
    shipping_discount numeric DEFAULT 0,
    total_payable numeric DEFAULT 0,
    pricelist_id text,
    created_by text,
    status text DEFAULT 'draft',
    created_at timestamptz DEFAULT now()
);

-- Bảng bảng giá (pricelists)
CREATE TABLE IF NOT EXISTS pricelists (
    id text PRIMARY KEY,
    name text NOT NULL,
    brand_discounts jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now()
);

-- Bảng người dùng nội bộ (users)
CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    username text NOT NULL UNIQUE,
    password text,
    display_name text NOT NULL,
    role text DEFAULT 'sale',
    created_at timestamptz DEFAULT now()
);


-- 2. ĐẢM BẢO CÁC CỘT ĐÃ TỒN TẠI (NẾU BẢNG ĐÃ ĐƯỢC TẠO TỪ TRƯỚC)

-- Cập nhật bảng customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_brand text DEFAULT 'Tất cả';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS brand_discounts jsonb DEFAULT '{}'::jsonb;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS shipping_support boolean DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS debt numeric DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_transaction numeric DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pricelist_id text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS managed_by text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS debt_history jsonb DEFAULT '[]'::jsonb;

-- Cập nhật bảng products
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand text DEFAULT 'Nano10*';
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_thung numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lon numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_hop numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_bao numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_tui numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_thung text DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_bao text DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_lon text DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_hop text DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_tui text DEFAULT '';

-- Cập nhật bảng orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_support boolean DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_discount numeric DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'settled';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricelist_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by text;

-- Cập nhật bảng draft_orders
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS shipping_support boolean DEFAULT false;
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS shipping_discount numeric DEFAULT 0;
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft';
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS pricelist_id text;
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS created_by text;

-- Cập nhật bảng pricelists
ALTER TABLE pricelists ADD COLUMN IF NOT EXISTS brand_discounts jsonb DEFAULT '{}'::jsonb;


-- 3. KÍCH HOẠT ROW LEVEL SECURITY (RLS) TRÊN TẤT CẢ CÁC BẢNG

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricelists ENABLE ROW LEVEL SECURITY;


-- 4. TẠO CÁC HÀM HỖ TRỢ PHÂN QUYỀN (SECURITY DEFINER để tránh đệ quy RLS)

-- Hàm so sánh 2 tên người dùng linh hoạt (hỗ trợ so khớp tiền tố không phân biệt tên miền email)
CREATE OR REPLACE FUNCTION public.is_same_user(u1 text, u2 text)
RETURNS boolean AS $$
BEGIN
  RETURN COALESCE(u1, '') = COALESCE(u2, '') 
         OR split_part(COALESCE(u1, ''), '@', 1) = split_part(COALESCE(u2, ''), '@', 1);
END;
$$ LANGUAGE plpgsql;

-- Hàm kiểm tra xem người dùng hiện tại có phải là Admin hay không
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()::text AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql;

-- Hàm kiểm tra xem người dùng hiện tại có phải là Admin hoặc Kế toán hay không
CREATE OR REPLACE FUNCTION public.is_admin_or_accounting()
RETURNS boolean SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()::text AND role IN ('admin', 'accounting')
  );
END;
$$ LANGUAGE plpgsql;

-- Hàm lấy username (tên đăng nhập) của người dùng hiện tại từ auth.uid()
CREATE OR REPLACE FUNCTION public.get_current_username()
RETURNS text SECURITY DEFINER AS $$
BEGIN
  RETURN (
    SELECT username FROM public.users
    WHERE id = auth.uid()::text
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql;


-- 5. ĐỊNH NGHĨA CÁC CHÍNH SÁCH BẢO MẬT (POLICIES) CHO TỪNG BẢNG

-- === BẢNG NGƯỜI DÙNG (users) ===
DROP POLICY IF EXISTS select_users ON users;
DROP POLICY IF EXISTS manage_users ON users;

CREATE POLICY select_users ON users FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_users ON users FOR ALL TO authenticated USING (public.is_admin());

-- === BẢNG SẢN PHẨM (products) ===
DROP POLICY IF EXISTS select_products ON products;
DROP POLICY IF EXISTS manage_products ON products;

CREATE POLICY select_products ON products FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_products ON products FOR ALL TO authenticated USING (public.is_admin_or_accounting());

-- === BẢNG BẢNG GIÁ (pricelists) ===
DROP POLICY IF EXISTS select_pricelists ON pricelists;
DROP POLICY IF EXISTS manage_pricelists ON pricelists;

CREATE POLICY select_pricelists ON pricelists FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_pricelists ON pricelists FOR ALL TO authenticated USING (public.is_admin_or_accounting());

-- === BẢNG KHÁCH HÀNG (customers) ===
DROP POLICY IF EXISTS select_customers ON customers;
DROP POLICY IF EXISTS insert_customers ON customers;
DROP POLICY IF EXISTS update_customers ON customers;
DROP POLICY IF EXISTS delete_customers ON customers;

-- Admin/Kế toán xem tất cả khách hàng; Sale chỉ xem khách hàng mình quản lý
CREATE POLICY select_customers ON customers FOR SELECT TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(managed_by, public.get_current_username())
);

-- Admin/Kế toán thêm bất kỳ khách hàng nào; Sale chỉ được thêm khách hàng gán cho mình
CREATE POLICY insert_customers ON customers FOR INSERT TO authenticated WITH CHECK (
  public.is_admin_or_accounting() OR public.is_same_user(managed_by, public.get_current_username())
);

-- Admin/Kế toán sửa bất kỳ khách hàng nào; Sale chỉ sửa khách hàng mình quản lý
CREATE POLICY update_customers ON customers FOR UPDATE TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(managed_by, public.get_current_username())
);

-- Chỉ Admin và Kế toán mới có quyền xóa khách hàng
CREATE POLICY delete_customers ON customers FOR DELETE TO authenticated USING (
  public.is_admin_or_accounting()
);

-- === BẢNG ĐƠN HÀNG ĐÃ CHỐT (orders) ===
DROP POLICY IF EXISTS select_orders ON orders;
DROP POLICY IF EXISTS insert_orders ON orders;
DROP POLICY IF EXISTS update_orders ON orders;
DROP POLICY IF EXISTS delete_orders ON orders;

-- Admin/Kế toán xem tất cả hóa đơn; Sale chỉ xem hóa đơn mình tạo
CREATE POLICY select_orders ON orders FOR SELECT TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán tạo đơn cho bất kỳ ai; Sale chỉ được tạo đơn dưới tên của mình
CREATE POLICY insert_orders ON orders FOR INSERT TO authenticated WITH CHECK (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán sửa bất kỳ đơn nào; Sale không có quyền sửa đơn đã chốt
CREATE POLICY update_orders ON orders FOR UPDATE TO authenticated USING (
  public.is_admin_or_accounting()
);

-- Chỉ Admin và Kế toán mới có quyền xóa đơn hàng đã chốt
CREATE POLICY delete_orders ON orders FOR DELETE TO authenticated USING (
  public.is_admin_or_accounting()
);

-- === BẢNG ĐƠN HÀNG NHÁP (draft_orders) ===
DROP POLICY IF EXISTS select_draft_orders ON draft_orders;
DROP POLICY IF EXISTS insert_draft_orders ON draft_orders;
DROP POLICY IF EXISTS update_draft_orders ON draft_orders;
DROP POLICY IF EXISTS delete_draft_orders ON draft_orders;

-- Admin/Kế toán xem tất cả đơn nháp; Sale chỉ xem đơn nháp mình tạo
CREATE POLICY select_draft_orders ON draft_orders FOR SELECT TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán tạo đơn nháp; Sale chỉ được tạo đơn nháp dưới tên mình
CREATE POLICY insert_draft_orders ON draft_orders FOR INSERT TO authenticated WITH CHECK (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán sửa bất kỳ đơn nháp nào; Sale chỉ sửa đơn nháp mình tạo
CREATE POLICY update_draft_orders ON draft_orders FOR UPDATE TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);

-- Admin/Kế toán xóa bất kỳ đơn nháp nào; Sale được quyền xóa đơn nháp mình tạo
CREATE POLICY delete_draft_orders ON draft_orders FOR DELETE TO authenticated USING (
  public.is_admin_or_accounting() OR public.is_same_user(created_by, public.get_current_username())
);


-- 6. TRIGGER ĐỒNG BỘ TỰ ĐỘNG TỪ auth.users SANG public.users

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  u_username text;
BEGIN
  -- Ưu tiên lấy email đầy đủ làm username để đồng nhất với Auth
  u_username := COALESCE(new.email, new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));

  -- Xóa mọi tài khoản cũ trùng username nhưng khác ID (do local offline cũ hoặc tài khoản đã xóa trên Auth)
  DELETE FROM public.users WHERE username = u_username AND id <> new.id::text;

  INSERT INTO public.users (id, username, display_name, role, password)
  VALUES (
    new.id::text,
    u_username, -- Lưu email đầy đủ hoặc username gốc
    COALESCE(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'displayName', u_username),
    COALESCE(new.raw_user_meta_data->>'role', 'sale'),
    '' -- Không lưu mật khẩu dạng plain-text
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    role = EXCLUDED.role;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger tự động xác nhận email cho tài khoản mới (tránh lỗi bắt buộc xác nhận email từ Supabase)
CREATE OR REPLACE FUNCTION public.auto_confirm_user()
RETURNS trigger AS $$
BEGIN
  new.email_confirmed_at := COALESCE(new.email_confirmed_at, now());
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_before ON auth.users;
CREATE TRIGGER on_auth_user_created_before
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auto_confirm_user();

-- Gán trigger tạo tài khoản
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger xóa tài khoản tự động
CREATE OR REPLACE FUNCTION public.handle_deleted_user()
RETURNS trigger AS $$
BEGIN
  DELETE FROM public.users WHERE id = old.id::text;
  RETURN old;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Gán trigger xóa tài khoản
DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_deleted_user();

-- TỰ ĐỘNG ĐỒNG BỘ CÁC TÀI KHOẢN ĐÃ CÓ TRƯỚC ĐÓ TỪ auth.users SANG public.users (Tránh xung đột ràng buộc)
INSERT INTO public.users (id, username, display_name, role, password)
SELECT DISTINCT ON (uname)
  u.id::text,
  u.uname,
  u.display_name,
  u.role,
  ''
FROM (
  SELECT 
    id,
    split_part(email, '@', 1) as uname,
    COALESCE(raw_user_meta_data->>'display_name', raw_user_meta_data->>'displayName', split_part(email, '@', 1)) as display_name,
    COALESCE(raw_user_meta_data->>'role', 'admin') as role
  FROM auth.users
  WHERE email IS NOT NULL AND email <> ''
) u
WHERE NOT EXISTS (
  SELECT 1 FROM public.users p WHERE p.username = u.uname OR p.id = u.id::text
);


-- ====================================================================
-- 7. LẬP LỊCH TỰ ĐỘNG XÓA ĐƠN NHÁP CŨ HƠN 2 NGÀY (YÊU CẦU EXTENSION pg_cron)
-- ====================================================================
-- Lưu ý: pg_cron cần được bật trong mục Database -> Extensions trên trang quản trị Supabase.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Chạy dọn dẹp lúc 00:00 hàng ngày
SELECT cron.schedule(
  'cleanup-old-drafts-job',
  '0 0 * * *',
  $$ DELETE FROM public.draft_orders WHERE created_at < now() - interval '2 days' $$
);

-- ====================================================================
-- 8. TẠO BẢNG HÃNG SƠN (brands) & PHÂN QUYỀN RLS
-- ====================================================================

-- Tạo bảng brands
CREATE TABLE IF NOT EXISTS public.brands (
    name text PRIMARY KEY,
    company_name text NOT NULL,
    logo_filename text NOT NULL,
    hotline text NOT NULL,
    cskh text NOT NULL,
    email text NOT NULL,
    address_main text NOT NULL,
    address_factory text NOT NULL,
    address_business text,
    created_at timestamptz DEFAULT now()
);

-- Kích hoạt RLS
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;

-- Tạo chính sách bảo mật
DROP POLICY IF EXISTS select_brands ON brands;
DROP POLICY IF EXISTS manage_brands ON brands;

CREATE POLICY select_brands ON brands FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_brands ON brands FOR ALL TO authenticated USING (public.is_admin_or_accounting());

-- Chèn dữ liệu hạt giống mẫu ban đầu (seeding)
INSERT INTO public.brands (name, company_name, logo_filename, hotline, cskh, email, address_main, address_factory, address_business)
VALUES 
  ('Nano10*', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh'),
  ('Hatacco nano', 'CÔNG TY CỔ PHẦN EMP HOA KỲ', 'hatacco.png', '0325.855.222 - 0985.769.689', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', NULL),
  ('Festiva nano', 'CÔNG TY CỔ PHẦN EMP HOA KỲ', 'festiva.png', '0325.855.222 - 0985.769.689', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', NULL),
  ('mutsutec', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh'),
  ('tdkaw', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh'),
  ('cova', 'CÔNG TY CỔ PHẦN ABS JAPAN', 'absjapan.png', '088.603.7878 - 0961.030.923', '0868.055.866', 'nhamaysonnano@gmail.com', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh')
ON CONFLICT (name) DO NOTHING;

