# Sao lưu theo từng phần — 0121

Sau 0120 và khi bỏ archive, Admin vẫn gặp `statement timeout`/`Failed to fetch`,
trạng thái kiểm tra vẫn 0 job. Tối ưu phép ghép JSON chưa đủ để xác nhận luồng
một RPC lớn chạy được trên production.

## Luồng mới

- Start chốt preview, schema/cột/sequence và fingerprint từng bảng trong cùng
  khóa dữ liệu. Chỉ Admin, bảo trì bật, epoch đúng; không có archive.
- Mỗi bảng được chuẩn bị trong một RPC riêng. Hàm đối chiếu fingerprint của
  bảng với mốc đầu, ghi JSON từng dòng vào các phần tối đa 64 Ki ký tự/256 KiB.
  Không gom toàn bộ các bảng thành JSONB lớn.
- Finish đối chiếu lại toàn bộ fingerprint và metadata schema. Chỉ lúc này mới
  tạo job `prepared`; checksum SHA-256 được tính trên đúng văn bản file.
- Download trả tối đa 4 phần mỗi RPC. Trình duyệt tải tối đa 4 trang đồng thời,
  kiểm tra số thứ tự, kích thước, hash từng phần và SHA-256 toàn bộ file.
- Sau đó dùng nguyên định dạng phục hồi v1 và mã hóa AES-GCM/PBKDF2 hiện hành.
  Vẫn phải chọn lại file, giải mã và đối chiếu trước khi mở nút xác nhận xóa.

Request key giữ nguyên khi thử lại sau lỗi mạng; các bảng đã commit được dùng
tiếp, không nhân đôi phần hoặc tạo job mới. Đổi tài khoản/project chặn tải tiếp.
Preview/restart tạo request mới. Không lưu file thô hoặc mật khẩu ở localStorage.

## Dữ liệu vận chuyển và quyền

`retention_backup_sessions` và `retention_backup_parts` là bảng riêng tư có RLS,
không cấp SELECT/DML trực tiếp cho ứng dụng, không đưa vào file phục hồi.
RPC kiểm tra Admin và chủ phiên; người khác không đọc được phần tải. Phiên hết
hạn sau 30 phút. Bản tạm được bỏ sau khi tạo link tải thành công; nếu mất mạng,
được dọn ở lần chuẩn bị mới hoặc khi dọn dữ liệu thành công. Phiên hết hạn cũng
bị dọn khi start được gọi; không bổ sung cron. Không tự xóa job audit.

Purge vẫn dùng nguyên fingerprint, hạn dùng, checksum và các bất biến tài chính.
0121 chỉ bổ sung dọn các bản vận chuyển trong cùng transaction purge thành công,
để không còn bản sao riêng tư của lịch sử vừa xóa. Không gọi purge khi cài đặt.
Hash của các hàm 0120/execute phải khớp trước khi cài; không tăng timeout toàn cục.

## Kiểm chứng cục bộ

- 80/80 ca của `npm run test:retention` đạt; thêm kiểm thử đổi tài khoản giữa
  metadata và tải file đạt. Các kiểm tra thứ tự migration/nâng cấp cũng đạt.
- File Unicode nhiều phần khớp từng bảng/cột/sequence của RPC đầy đủ cũ;
  SHA-256 đúng. File được mã hóa, giải mã, dùng sau một purge thử và phục hồi
  đúng đơn/công nợ vào staging trống có schema tương thích.
- Mất phản hồi sau khi stage đã commit: thử lại cùng request trả cùng file,
  1 job. Thay dữ liệu trước stage/finalize: từ chối và không tạo job. Thiếu,
  đảo, sửa phần tải hoặc sai hash: từ chối. Tải GET chạy được READ ONLY.
- Audit nguồn/ACL/cấu hình: 73/73 hợp đồng khớp cục bộ.
- Dữ liệu giả 72.698.603 byte: SHA-256 khớp, RPC chậm nhất khoảng 3,2 giây,
  phản hồi lớn nhất 262.817 byte. Đây là PGlite cục bộ, không phải tốc độ Supabase.

Chứng cứ không chứa dữ liệu thật được giữ trong `outputs/retention-review/`
(Git ignore): `staged-retention-suite.log`, `staged-large-benchmark.json`,
`staged-client-migration-checks.log`, `staged-migration-recheck.log`.

## Triển khai

Cài migration `0121_retention_staged_recovery_download.sql`; bước cài chỉ tạo
bảng/hàm và ghi version. Frontend `20261027-retention-staged-v1` cần version này
và báo rõ nếu chưa cài, không quay lại RPC đầy đủ cũ. Các thử nghiệm production
được thực hiện trực tiếp qua SQL Editor trên project SoViet ngày 27/10/2026:

- Cài 0121 thành công, bảo trì vẫn bật, 4 chứng từ giữ, 0 job.
- Start: 9.131 ms. Chuẩn bị đủ 55 bảng, tổng 24.343 ms qua các RPC riêng;
  bảng chậm nhất `audit_logs` 5.178 ms (đơn 2.628 ms, dòng hàng 3.026 ms).
- Finish: 11.163 ms; văn bản phục hồi **75.955.605 byte**. Gọi API đọc trang
  bên trong phép thử database, kiểm tra đủ **333 trang**, mọi part hash khớp;
  bước kiểm tra trang 2.647 ms, trang lớn nhất 296.399 byte JSON.
- Finish và việc ghi job nằm trong transaction ROLLBACK. Sau đó đã release
  vùng vận chuyển thử: 0 session, 0 part, 0 job; epoch 0, cutoff null, bảo trì
  true, giữ nguyên 4 chứng từ. Không gọi execute/purge trên production.
- Audit READ ONLY lúc **20:56:17 UTC+7**: **73/73** hàm/ACL/config khớp,
  không thiếu version, trigger đúng. 1.750 khách/3.271 đơn, 0 lệch công nợ
  khách/NCC, 0 bút toán sai; báo cáo và ranh giới quyền ứng dụng đều đạt.

Các phép đo production trên xác nhận quy trình server; chưa có bằng chứng
người dùng đã tải và giải mã file qua trình duyệt. Chứng cứ Git ignore:
`staged-production-complete-trial.json`, `staged-production-cleanup.json`,
`staged-production-owner-audit.json`, `staged-production-application-audit.json`.
