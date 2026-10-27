# Xóa không hoàn tất và thông báo xác minh file — 0122

## Bằng chứng production

Nhật ký PostgreSQL SoViet lúc **21:17:02 ngày 27/10/2026 UTC+7** ghi lỗi
`DELETE requires a WHERE clause` từ lời gọi PostgREST
`rpc_execute_monthly_retention`. Admin đã bấm nút xóa; không thể suy từ 0
successful calls trong pg_stat_statements rằng RPC chưa được gọi.

0121 đã thêm câu `DELETE FROM public.retention_backup_sessions;` ở cuối RPC.
Quy tắc safe-delete của kết nối production chặn lệnh này. Đây là câu DELETE
public duy nhất không có WHERE trong định nghĩa RPC và các helper được kiểm tra.
Lỗi làm rollback toàn bộ giao dịch, kể cả cập nhật `completed`/epoch.

Kiểm tra READ ONLY sau báo lỗi: 1 job `prepared`, `result/completed_at=null`,
epoch 0/cutoff null, 3.271 đơn và 7.431 bút toán như trước. Khách trong ảnh
còn 5 bút toán trước tháng 9 ở database; không chỉ là cache giao diện. Không
đưa tên/ID khách hoặc nội dung chứng từ vào Git.

## Sửa

- 0122 thay câu dọn bản vận chuyển thành
  `DELETE FROM public.retention_backup_sessions WHERE epoch<=job.epoch_before;`.
  Chỉ dọn các phiên thuộc kỳ vừa trở thành cũ, trong cùng transaction purge.
  Không tắt quy tắc safe-delete, không thay các bất biến tài chính.
- Migration kiểm tra chính xác MD5 nguồn 0121 rồi cập nhật định nghĩa. Cài đặt
  không gọi execute và không xóa chứng từ hoặc sửa job hiện tại.
- Sau phản hồi execute, web đọc lại job: phải đúng ID/hash, state `completed`,
  có thời điểm hoàn tất, result `verified=true` và epoch hợp lệ. Sau đó đọc
  retention status để xác nhận epoch/cutoff mới; chỉ lúc này mới báo thành công.
- Thông báo tạo/giải mã file nói rõ **chưa xóa dữ liệu**. Nếu execute lỗi hoặc
  chưa xác minh được commit, dòng xác minh cũng ghi rõ chưa xác nhận xóa.

## Kiểm chứng

87/87 kiểm thử retention đạt: rollback/nâng cấp, điều kiện WHERE của các DELETE,
dọn cache vận chuyển đúng epoch, bảo toàn công nợ/kho, giữ chứng từ lỗi và phục
hồi staging. Kiểm thử client chặn phản hồi `verified=true` khi job vẫn prepared,
chặn control epoch/cutoff cũ, và chỉ chấp nhận job đã commit đúng checksum.

Production đã cài 0122 bằng script định nghĩa riêng: 4 chứng từ giữ, 0 lần xóa
hoàn tất, epoch 0. Agent chỉ đọc chẩn đoán/cài hàm, không chạy lại xóa nghiệp vụ.
Đối chiếu sau cài đặt: **73/73** nguồn hàm, ACL và cấu hình khớp, 0 sai khác.
Frontend: `20261027-retention-safe-delete-v1`.

Lưu ý đối chiếu fingerprint phải dùng cùng TimeZone với API. Bản kiểm tra
`Asia/Bangkok` trả khác vì timestamp JSON dùng offset +07; kiểm tra lại UTC
lúc **21:35:24 UTC+7** cho fingerprint khớp. Không sửa fingerprint của job để
vượt kiểm tra và không coi kết quả khác múi giờ là bằng chứng dữ liệu đã đổi.

Bằng chứng Git ignore trong `outputs/retention-review/`: `delete-error-2117.txt`,
`post-purge-latest-state.json`, `cleanup-0122-retention-suite.log` và kết quả
đối chiếu function contract sau cài đặt. Lần chuẩn bị cũ có hạn đến 21:38:45;
nếu đã hết hạn hoặc tải lại web, Admin tạo/xác minh một file mới trước khi xóa.
