# Timeout khi tạo file phục hồi — migration 0120

Sau khi Admin giữ 4 chứng từ cần đối soát và bật bảo trì, bước tạo file vẫn
timeout. Đây là bước `rpc_prepare_monthly_retention`, khác bước giữ chứng từ
đã sửa trong 0119. Không thực hiện purge để chẩn đoán.

## Đo trên production ngày 27/10/2026

- Trạng thái trước thử: 4 chứng từ giữ, bảo trì bật, 0 job, epoch 0, cutoff null.
- Preview: 9.981 ms; fingerprint: 7.357 ms.
- Tổng JSON của các bảng: 154.339.495 byte. Riêng nhật ký lưu trữ chiếm
  78.512.085 byte, vẫn phải có đầy đủ trong file phục hồi.
- Thử toàn bộ prepare trong transaction ROLLBACK: timeout sau 65.466 ms.
  PostgreSQL chỉ tới phép gán trong vòng lặp lắp snapshot:
  `snapshot:=snapshot||jsonb_build_object(target,rows_data)`.

Phép ghép này sao chép lại toàn bộ snapshot mỗi khi thêm một bảng. Bảo trì
không giảm khối lượng JSON phải sao chép.

## Thay đổi

0120 ghi từng phần vào bảng tạm riêng của transaction, rồi dùng một lần
`jsonb_object_agg` để lắp snapshot. Bảng tạm dùng EXTERNAL cho giá trị lớn,
không tốn nén lại từng phần; bảng và các biến lớn được giải phóng sớm.

Giữ nguyên mọi bảng/dòng, thứ tự canonical từng bảng, metadata cột/sequence,
fingerprint, SHA-256, định dạng phục hồi, hạn mức 256 MB, timeout RPC 60 giây,
quyền Admin, bảo trì, epoch, khóa nhất quán và điều kiện chặn xóa. Migration
chỉ thay định nghĩa hàm, ghi phiên bản và yêu cầu reload schema; không gọi
prepare, hold hoặc execute. Hash đầu vào bắt buộc khớp bản đã kiểm tra 0119.

## Kiểm chứng và tình trạng triển khai

- 70/70 kiểm thử retention đạt; thêm 10/10 kiểm tra migration/nâng cấp đạt.
- So sánh trước/sau trên dữ liệu giả có 500 nhật ký lớn: toàn bộ tables,
  columns, sequences và fingerprint giống nhau; SHA-256 đúng; gọi lại cùng
  request trả cùng file; bảng tạm được dọn; rollback không để lại job.
- Audit cục bộ: 63/63 hợp đồng hàm/quyền/cấu hình khớp.
- Chưa xác nhận thử đầy đủ hoặc cài 0120 trên production: lượt thử ROLLBACK
  bị gián đoạn kết nối Supabase (`Failed to fetch (api.supabase.com)`), không
  có kết quả server. Không được xem đây là bằng chứng prepare đã thành công.
- Kết nối sau đó đã trả lại trạng thái chỉ đọc: 4 chứng từ giữ, 0 job,
  epoch 0. Đã thử lại nhưng chưa đọc được kết quả: khi tiếp tục phiên làm việc,
  công cụ báo `Local browser use is disabled in Work settings`.

Khi kết nối trở lại: chạy thử transaction ROLLBACK với toàn bộ prepare và
kiểm tra SHA-256, chỉ trả metadata; sau khi đạt mới cài 0120 và chạy audit
READ ONLY `scripts/audit-retention-after-feature-changes.sql`. Kiểm tra vẫn
có 4 chứng từ giữ, 0 job phát sinh do thử và epoch/cutoff không đổi. Agent
chưa tải/mã hóa file trong trình duyệt người dùng và chưa xóa dữ liệu.

Số đo chẩn đoán nằm trong `outputs/retention-review/backup-*-profile.json`
và `backup-prepare-before-trial.json` (bị Git ignore). Không commit dữ liệu
khách hàng hoặc nội dung file phục hồi.
