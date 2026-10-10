# Kết nối đơn hàng với Quản Lý Kho

Migration `migrations/0085_warehouse_inventory_outbox.sql` xếp hàng các đơn **mới** khi chốt, sửa, hoàn hoặc hủy. Đơn có trước khi cài migration không được xếp hàng tự động để tránh trừ kho lần nữa. Trang bán hàng không cần sửa JavaScript: `rpc_confirm_order`, `rpc_amend_order`, `rpc_cancel_order` và luồng hoàn đều cập nhật `orders`, kích hoạt trigger.

## Bật kết nối

1. Triển khai ứng dụng Quản Lý Kho cùng migration và biến môi trường theo README của kho.
2. Chạy migration `0085_warehouse_inventory_outbox.sql` trên Supabase của trang bán hàng, trước ở staging. Kiểm tra extension `pg_net` đã bật. Migration tạo hàng đợi với RLS; chỉ service role đọc được.
3. Tạo một chuỗi ngẫu nhiên dài ít nhất 32 ký tự. Đặt chuỗi đó trong biến `INVENTORY_SYNC_SIGNING_SECRET` của ứng dụng kho và trong SQL dưới đây. URL phải là URL HTTPS công khai của kho:

   ```sql
   insert into private.inventory_sync_settings(id, endpoint, signing_secret)
   values (
     true,
     'https://YOUR-WAREHOUSE-DOMAIN/api/integrations/chamsockhachhang/sync',
     'YOUR-LONG-RANDOM-SIGNING-SECRET'
   )
   on conflict (id) do update
     set endpoint = excluded.endpoint,
         signing_secret = excluded.signing_secret;
   ```

4. Bật `pg_cron` trong Supabase và tạo lịch thử lại mỗi phút bằng SQL Editor:

   ```sql
   create extension if not exists pg_cron;
   select cron.schedule(
     'warehouse-inventory-retry',
     '* * * * *',
     'select private.dispatch_inventory_sync();'
   );
   ```

5. Kiểm tra đơn mới sau khi bấm **Thanh toán & Chốt đơn**. Bảng `public.inventory_sync_outbox` có `pending = false` khi kho đã ghi nhận. Nếu `pending = true`, xem `last_error` hoặc màn hình **Đồng bộ đơn** trong kho. Trường hợp SKU chưa tồn tại hoặc kho không đủ tồn, sửa sản phẩm/tồn kho; lịch trên sẽ thử lại.

Khóa `BILLING_SUPABASE_SECRET_KEY` chỉ được cấu hình ở máy chủ ứng dụng kho. Chữ ký gửi qua `pg_net` có thời hạn 5 phút; secret và service role key không được đưa vào request. Tạo lịch từ SQL Editor bằng quyền quản trị của dự án. Trước khi dùng production, đối chiếu mã biến thể với SKU kho và thử một đơn ở staging.
