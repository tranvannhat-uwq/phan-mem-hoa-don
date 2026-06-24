-- ====================================================================
-- SQL Script nâng cấp và cấu hình CSDL Supabase cho ứng dụng WebLendon
-- Hãy sao chép toàn bộ đoạn mã này và chạy trong SQL Editor của Supabase.
-- ====================================================================

-- 1. BẢNG KHÁCH HÀNG (customers) - Quản lý đại lý & Chiết khấu riêng biệt
CREATE TABLE IF NOT EXISTS customers (
    id text PRIMARY KEY,
    code text UNIQUE NOT NULL,      -- Mã khách hàng (VD: KH-0001)
    name text NOT NULL,             -- Tên khách hàng
    phone text,                     -- Số điện thoại
    address text,                   -- Địa chỉ
    assigned_brand text DEFAULT 'Tất cả', -- Nhãn sơn đại lý được mua. VD: 'Nano10*', 'Hatacco nano', 'Tất cả'
    brand_discounts jsonb DEFAULT '{}'::jsonb, -- Bản đồ chiết khấu theo hãng sơn. VD: {"Hatacco nano": 50, "Nano10*": 40}
    shipping_support boolean DEFAULT false, -- Hỗ trợ vận chuyển 3% giá trị đơn
    debt numeric DEFAULT 0,         -- Công nợ hiện tại
    total_transaction numeric DEFAULT 0, -- Tổng tiền đã giao dịch
    notes text,                     -- Ghi chú khách hàng
    created_at timestamptz DEFAULT now()
);

-- Thêm cột vận chuyển vào bảng customers nếu bảng đã tồn tại từ trước:
ALTER TABLE customers ADD COLUMN IF NOT EXISTS shipping_support boolean DEFAULT false;

-- Tắt cơ chế bảo mật dòng (RLS) để cho phép đọc/ghi tự do từ client (Anon key) giống 2 bảng kia:
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;

-- 2. BẢNG HÓA ĐƠN (orders) - Cập nhật liên kết khách hàng & chiết khấu vận chuyển
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_support boolean DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_discount numeric DEFAULT 0;
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;

-- (Tham khảo) Script tạo bảng orders nếu chưa có từ đầu:
-- CREATE TABLE IF NOT EXISTS orders (
--     id text PRIMARY KEY,
--     customer_id text,
--     customer_name text NOT NULL,
--     notes text,
--     items jsonb NOT NULL,
--     total_market numeric DEFAULT 0,
--     total_discount numeric DEFAULT 0,
--     shipping_support boolean DEFAULT false,
--     shipping_discount numeric DEFAULT 0,
--     total_payable numeric DEFAULT 0,
--     created_at timestamptz DEFAULT now()
-- );

-- 3. BẢNG SẢN PHẨM (products) - Nâng cấp cấu trúc phân nhóm
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand text DEFAULT 'Nano10*';
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_thung numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_lon numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_hop numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_bao numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_tui numeric DEFAULT 0;
ALTER TABLE products ALTER COLUMN price DROP NOT NULL;
ALTER TABLE products ALTER COLUMN price SET DEFAULT 0;
ALTER TABLE products DISABLE ROW LEVEL SECURITY;

-- 4. BẢNG BẢNG GIÁ (pricelists) - Quản lý bảng giá bán & chiết khấu hãng sơn cho đại lý
CREATE TABLE IF NOT EXISTS pricelists (
    id text PRIMARY KEY,
    name text NOT NULL,             -- Tên bảng giá (VD: Bảng giá 02, Bảng giá 03)
    brand_discounts jsonb DEFAULT '{}'::jsonb, -- Bản đồ chiết khấu theo hãng sơn. VD: {"Nano10*": 74.7, "Hatacco nano": 70}
    created_at timestamptz DEFAULT now()
);

-- Tắt cơ chế bảo mật dòng (RLS):
ALTER TABLE pricelists DISABLE ROW LEVEL SECURITY;

-- Thêm cột pricelist_id liên kết bảng giá mặc định cho khách hàng
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pricelist_id text;

-- Thêm cột pricelist_id lưu vết bảng giá đã chọn cho đơn hàng
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricelist_id text;


-- 5. BẢNG NGƯỜI DÙNG & PHÂN QUYỀN (users)
CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    username text NOT NULL UNIQUE,       -- Tên đăng nhập (VD: admin, ketoan, nhat)
    password text NOT NULL,              -- Mật khẩu
    display_name text NOT NULL,          -- Tên hiển thị (VD: Kế toán A, Sale B)
    role text DEFAULT 'sale',            -- Quyền: admin, accounting, sale
    created_at timestamptz DEFAULT now()
);

-- Tắt cơ chế bảo mật dòng (RLS):
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

-- Nhập sẵn tài khoản đại diện cho 3 vai trò
INSERT INTO users (id, username, password, display_name, role)
VALUES 
  ('u-nhat', 'nhat', '1307', 'Trần Văn Nhật', 'admin'),
  ('u-ketoan', 'ketoan', 'ketoan123', 'Kế toán Công ty', 'accounting'),
  ('u-sale1', 'sale1', '123', 'Sale Nguyễn Văn A', 'sale'),
  ('u-sale2', 'sale2', '123', 'Sale Lê Văn B', 'sale')
ON CONFLICT (username) DO NOTHING;

-- Thêm cột người quản lý vào bảng khách hàng
ALTER TABLE customers ADD COLUMN IF NOT EXISTS managed_by text;

-- Thêm cột người tạo đơn vào bảng đơn hàng
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by text;

