# Sửa các khác biệt database phát hiện ngày 27/10/2026

Gói này xử lý các vấn đề có tác động thực tế trong lần rà soát Supabase SoViet. Không chạy bù các migration cũ đã được thay thế. Không sửa lại số liệu lịch sử, không tự đối soát/điều chỉnh công nợ, không chạy xóa dữ liệu.

## Nội dung

| Migration | Thay đổi |
|---|---|
| 0115 | Thay đúng hàm nhập số dư khách hàng: cột tiền bị bỏ trống/null/rỗng giữ số dư nhập trước đó; số 0 nhập rõ ràng vẫn thay phần đóng góp cũ; cho phép giá trị có dấu theo mã nguồn hiện tại; giữ ngày giao dịch cuối khi không nhập ngày mới, kể cả đơn gốc đã bị dọn. |
| 0116 | Sửa nhãn tiếng Việt trong sửa thu chi; nhận diện trạng thái đã hủy đúng Unicode, không dấu, tiếng Anh và hai biến thể lỗi mã hóa cũ. Giữ cách ghi bút toán điều chỉnh. Thu hồi quyền API EXECUTE trên hàm chỉ dùng làm trigger `p84_guard_cancelled_order_debt()`. |
| 0117 | Bổ sung phân trang chi tiết và tùy chọn bỏ tổng hợp/biểu đồ của 0067 vào bản báo cáo đã có số dư chuyển kỳ, lọc công ty và trả hàng độc lập của 0108/0112. |

Các hàm vẫn xác thực vai trò tại server. Không thay guard công nợ, chính sách RLS, trigger nghiệp vụ hoặc logic purge.

## Kiểm soát khi cài

- Cần schema đã được nâng cấp qua 0114.
- Kiểm tra MD5 nội dung hàm, có chuẩn hóa CRLF, trước khi thay. Chỉ chấp nhận bản đã rà soát trên cloud, bản canonical từ repository hoặc bản mới để cho phép retry. Hàm có tùy chỉnh không được nhận diện sẽ làm giao dịch rollback.
- Các migration riêng lẻ có transaction; gói gộp cài cả ba trong **một transaction**.
- `lock_timeout=3s`, `statement_timeout=60s`; gói gộp khóa advisory tương thích với cơ chế purge để hai thao tác không chạy chồng.
- Gói gộp dùng REPEATABLE READ và so fingerprint công nợ/tổng doanh số khách, số liệu tổng nhà cung cấp, số chứng từ, tổng quỹ, sổ nợ và trạng thái retention trước/sau. Không xuất chi tiết khách hàng ra kết quả. Đây là kiểm tra các trường được liệt kê trong script, không thay thế kiểm tra mọi dòng của mọi bảng.
- Hash nội dung sau cài phải khớp bản đã kiểm thử. Thông báo reload schema PostgREST chỉ được phát khi commit thành công.
- Không có DML sửa/xóa dữ liệu nghiệp vụ trong quá trình cài; các lệnh UPDATE/INSERT trong thân hàm chỉ chạy khi người dùng gọi chức năng sau này.

## Cách tạo gói SQL

Chạy tại thư mục repository:

```powershell
node scripts/build-database-audit-fixes.mjs
```

Sinh hai file trong `outputs/retention-review/`:

1. `check-database-fixes-0115-0117-rollback.sql`: kiểm tra tương thích trên database đích; mọi thay đổi bị rollback.
2. `install-database-fixes-0115-0117.sql`: cài thật, kiểm tra lại và commit nguyên gói.

Trước khi cài, đọc lại metadata và lưu định nghĩa hiện tại của ba hàm cùng quyền EXECUTE của trigger. Chỉ chạy gói cài sau khi gói kiểm tra trả `mode=ROLLBACK_COMPATIBILITY`, `financial_snapshot_unchanged=true`, đủ ba phiên bản và đúng hash mới. Nếu SQL Editor báo lỗi, transaction không được coi là đã cài; đọc trạng thái thực tế bằng truy vấn chỉ đọc trước khi thử lại.

Kết quả cài cần có `mode=INSTALLED`, `financial_snapshot_unchanged=true`, các phiên bản 0115/0116/0117 và `trigger_api_execute=false`.

| Hàm | MD5 thân hàm mới, bỏ ký tự CR |
|---|---|
| rpc_import_customer_financial_baselines(jsonb) | 516af2520e9df2335fb1774071cd3dce |
| rpc_amend_cashbook_transaction(text,jsonb) | 8dc1c96c2f17db10a9ecbe385042f577 |
| rpc_get_employee_business_report(jsonb) | 93a9bff8d81f193da0b41dc8953f5384 |

Kiểm tra lại ở transaction chỉ đọc sau commit. Không dùng nhập file thật, sửa chứng từ thật hoặc chạy purge làm phép thử.

## Các trường hợp đã kiểm thử

- Nhập thiếu cột, null, chuỗi rỗng; giữ công nợ, tổng tiền và ngày cũ.
- Nhập rõ số 0; chỉ thay phần số dư đã nhập, giữ phần phát sinh từ đơn hàng.
- Nhập lại cùng file không cộng dồn; giá trị âm không bị ép về 0.
- Một dòng nhập lỗi khiến toàn bộ lần nhập rollback; Sale không được nhập số dư.
- Không sửa được phiếu đã hủy, kể cả nhãn cũ lỗi mã hóa hoặc có khoảng trắng/chữ hoa.
- Sửa phiếu đang hoạt động giữ công nợ khớp sổ; không thêm bút toán tiền khi giá trị không đổi.
- Phân trang báo cáo không lặp trang; tổng hợp và biểu đồ có thể bỏ qua ở request chi tiết.
- Nâng từ báo cáo 0066 + retention, chuẩn hóa CRLF, diễn tập rollback, cài lại an toàn và từ chối hàm bị thay ngoài dự kiến.
- Sau purge dữ liệu giả: công nợ theo công ty và doanh số/biểu đồ trả hàng khác kỳ giữ đúng.

## Không chạy lại các file sau để lấp registry

0022/0056/0075 có chức năng đã được thay thế hoặc đã hiện diện; 0085–0087 không tự ghi registry nhưng chức năng đã cài; 0101 là cơ chế tạo vỏ cũ đã được 0105 thay thế. Không đánh dấu giả rằng các file này đã từng được chạy nguyên bản. Khác tên khóa/index legacy và cột đơn nháp legacy không phải lý do chạy lại bootstrap.

Gói sửa ngăn lỗi cho các thao tác tiếp theo. Nếu cần xác định một lần nhập cũ có làm sai số dư hay không, phải đối chiếu file gốc và audit của lần nhập đó; không tự khôi phục số tiền bằng suy đoán.
