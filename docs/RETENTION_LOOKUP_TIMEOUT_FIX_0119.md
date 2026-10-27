# Sửa timeout khi giữ chứng từ để đối soát

Migration: `0119_retention_lookup_key_performance.sql`, sau 0118.

## Nguyên nhân và thay đổi

Luồng 0118 dựng đồ thị liên kết bằng `p118_row_key(to_jsonb(row))`. Với nhật ký cũ,
việc lấy một mã dòng kéo theo chuyển cả JSON cũ/mới lớn sang JSONB ở nhiều nhánh
JOIN. Bộ kiểm thử ban đầu không có đủ dữ liệu nhật ký lớn để phát hiện chi phí này.
Production báo `canceling statement due to statement timeout` khi bấm giữ 4 đơn;
kiểm tra sau lỗi vẫn có 0 dòng giữ và 0 job xóa.

0119 dùng trực tiếp cột khóa có kiểu phù hợp (kể cả khóa ghép order/SKU và các
khóa có thể NULL). Đồ thị FK và cột tham chiếu legacy vẫn được duyệt theo cả hai
chiều. Cache và bước đối chiếu nguyên bản cuối giao dịch chỉ đọc JSON đầy đủ sau
khi tìm được đúng dòng giữ. Các bước dọn phụ so khóa scalar thay vì chuyển cả
dòng nhật ký thành JSON chỉ để kiểm tra mã.

Không tăng timeout của RPC, không nới quyền ứng dụng, không bỏ kiểm tra công nợ
hoặc bước sao lưu/xác minh. Các helper mới đều riêng tư. `p119_related_rows(text[])`
cho owner đo tập liên quan bằng truy vấn READ ONLY mà không phải ghi danh sách giữ.
Migration chỉ thay định nghĩa hàm và ghi phiên bản, không gọi hold/prepare/execute.

## Kiểm chứng

- 69 ca trong `npm run test:retention` đạt, 0 lỗi; kiểm tra chuỗi migration và nâng
  cấp thêm 10 ca đạt.
- Dữ liệu giả có 1.500 nhật ký legacy, mỗi bản cũ/mới hơn 8 KiB: tập dòng liên quan
  trước/sau nâng cấp khớp hoàn toàn; nhật ký của đơn khác không bị giữ theo.
- Khóa scalar khớp khóa JSON đối với ID, khóa ghép, NULL và định danh cần quote.
- Các ca giữ nguyên thu/trả/sổ, mua/NCC, nhiều SKU kho, quyền riêng tư, phục hồi
  mã hóa, kỳ kế tiếp và rollback khi sửa nhầm dòng giữ tiếp tục đạt.
- Audit cục bộ: 63/63 hợp đồng hàm khớp.

Diễn tập trên SoViet lúc **19:03:33 ngày 27/10/2026 UTC+7**, trong transaction
ROLLBACK: 4 đơn và 8 dòng hàng được tìm đúng; lookup lần đầu 9.323 ms, RPC giữ
hoàn tất 6.551 ms và preview đạt, phần dọn còn 1.096 đơn. Không tạo job xóa.
File `outputs/retention-review/lookup-performance-production-trial.json` là kết quả
diễn tập, không phải bằng chứng đã giữ 4 đơn hoặc đã dọn dữ liệu thật.

## Triển khai

Chạy toàn bộ migration 0119 rồi audit READ ONLY
`scripts/audit-retention-after-feature-changes.sql` (63 hàm, đủ 0106–0119).
Migration kiểm tra hash các hàm 0118 trước khi cập nhật; schema khác phải dừng.
Chức năng giữ có thể mất vài giây; Admin bấm lại nút giữ trên web sau cập nhật.
Việc tạo sao lưu và việc xác nhận xóa vẫn là những thao tác riêng của Admin.

Đã cài production và kiểm tra lại lúc **19:08:39 ngày 27/10/2026 UTC+7**:
đủ 0106–0119, **63/63** hợp đồng hàm khớp, quyền ứng dụng/trigger đúng,
0 lệch công nợ khách/NCC và 0 bút toán sai. Lookup READ ONLY của 4 đơn/8 dòng
hàng mất **5.073 ms**. Có 0 dòng giữ, 0 job xóa, epoch 0 và cutoff null sau
diễn tập/triển khai; chưa thực hiện hold hoặc purge có commit trên dữ liệu thật.
Chứng cứ: `outputs/retention-review/lookup-fix-production-verification.json`
và ảnh cùng tên `.png`; không đưa dữ liệu chứng từ vào Git.
