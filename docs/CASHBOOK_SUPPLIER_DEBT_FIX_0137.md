# Phiếu chi nhà cung cấp chưa giảm công nợ

Kiểm tra ngày 30/10/2026 trên chamsockhachhang.store và mã nguồn:

- PC-001466: 79.563.600 đ; PC-001468: 101.736.000 đ; PC-001469: 106.567.920 đ.
- Sun Chem còn phải trả 287.873.358 đ; lần chi gần nhất vẫn là 20/10/2026.
- Chi tiết PC-001469 hiển thị “Đối tượng khác”. Form nhận diện supplierId nhưng
  dbSaveCashbookTransaction bỏ trường này và gọi RPC chỉ ghi Sổ quỹ. Không có
  purchase_payments/supplier_debt_transactions tương ứng trong luồng này.
- Tổng ba phiếu: 287.867.520 đ. Nếu cả ba dùng trả khoản nợ trên, số dư dự kiến
  sau đối soát: 5.838 đ; tổng đã thanh toán dự kiến: 1.660.571.820 đ.

## Bản sửa

Chi tiền nhập hàng/Thanh toán nhà cung cấp có supplierId dùng RPC mới để ghi
phiếu và thanh toán công nợ trong cùng giao dịch. Giữ ngày giờ, phương thức,
hạch toán và nội dung đã nhập. Thiếu migration thì báo lỗi và giữ form;
không chuyển sang ghi phiếu độc lập. Tên/mã NCC phải khớp chính xác và duy nhất
khi không chọn ID trực tiếp từ danh sách.

Phiếu cũ có nút “Ghi vào công nợ NCC” trong chi tiết Sổ quỹ. RPC tạo liên kết
thanh toán và dòng công nợ trên chính phiếu đó, không tạo phiếu chi thứ hai.
Có khóa dòng, chống ghi trùng, phân quyền Admin/Kế toán, kiểm tra kỳ đã đóng,
kiểm tra người nhận/loại chi/nghiệp vụ liên quan và nhật ký trước/sau. Giữ hạn
mức không vượt nợ cho thanh toán chưa phân bổ vào phiếu mua như RPC hiện có.
Sửa/hủy phiếu tiếp tục đi qua nghiệp vụ thanh toán NCC đã có.

## Triển khai và xử lý phiếu cũ

1. Kiểm tra đúng project production coebrkerpcgwckkwxlfo và sao lưu các bản ghi
   NCC, ba phiếu và lịch sử thanh toán/công nợ liên quan trước khi đối soát.
2. Chạy migrations/0137_cashbook_supplier_debt_payments.sql trên database đã có
   0135. Migration chỉ tạo chức năng, không tự sửa số dư hay quét phiếu cũ.
3. Phát hành frontend có cùng phiên bản module 20261030-supplier-cashbook-v1.
4. Tài khoản Admin/Kế toán mở từng phiếu, kiểm tra người nhận và số tiền, chọn
   “Ghi vào công nợ NCC”. Đối soát ba phiếu Sun Chem theo thứ tự thời gian.
   Không tạo phiếu chi bù và không sửa số dư đầu kỳ.
5. Tải lại trang, kiểm tra còn nợ 5.838 đ nếu không có nghiệp vụ mới; tổng chi
   Sổ quỹ và mã/giá trị/ngày giờ ba phiếu phải giữ nguyên.

Tại thời điểm chuẩn bị bản sửa, chưa push/phát hành frontend, chưa chạy 0137
trên production và chưa cập nhật các phiếu thật.

Kiểm thử: 34/34 test đạt gồm tái hiện ba phiếu, trừ nợ đúng một lần, giữ số
phiếu/tổng chi, ghi mới nguyên tử, lỗi không ghi dở, sửa/hủy, phân quyền,
đóng kỳ, tên trùng/mã rỗng và lỗi thiếu RPC. Lệnh:

```powershell
node --experimental-default-type=module --test tests/cashbook-supplier-debt-payment.test.mjs tests/cashbook-payment-create.test.mjs tests/cashbook-supplier-picker.test.mjs tests/cashbook-inline-detail.test.mjs tests/cashbook-cancellation-routing.test.mjs tests/cashbook-amendment.test.mjs tests/phase4-supplier-purchases.test.mjs
```
