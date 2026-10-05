# Product Billing App

## Chạy thử trên máy

Cần Node.js 18 trở lên. Máy chủ chạy thử không cần cài thêm thư viện.

Trong thư mục dự án, chạy:

```powershell
npm run dev
```

Mở <http://127.0.0.1:5173/#/ban-hang>, đăng nhập và vào **Sổ quỹ → Phiếu thu**.
Trong **Loại thu**, chọn **Thu hỗ trợ biển bảng đại lý**.

Sau khi sửa mã, tải lại trang để xem thay đổi. Nhấn `Ctrl+C` trong terminal để dừng máy chủ.
Ứng dụng dùng các thư viện CDN và cấu hình Supabase hiện có nên cần kết nối Internet.

Nếu cổng 5173 đang được sử dụng, chạy `npm run dev -- --port 5174` rồi mở địa chỉ được in trong terminal.
