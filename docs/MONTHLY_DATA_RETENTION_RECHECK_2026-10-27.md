# Kết quả rà soát lại chức năng dọn dữ liệu

**Ngày 27/10/2026. Kết luận: bản hôm trước còn ngoại lệ cần sửa; không nên dùng nguyên bản đó để xóa. Các lỗi phát hiện dưới đây đã được khắc phục và kiểm thử lại. Chưa có dữ liệu thật nào bị dọn.**

## Các vấn đề đã tìm thấy và xử lý

| Vấn đề | Ảnh hưởng có thể xảy ra | Cách xử lý hiện tại |
|---|---|---|
| Hàm phụ đọc phiếu trả được cấp quyền API từ migration 0055 | Người đăng nhập biết mã phiếu có thể đọc trực tiếp, vượt phạm vi khách và bảo trì | 0111 thu hồi quyền gọi trực tiếp; các RPC nghiệp vụ có kiểm tra quyền vẫn gọi nội bộ được |
| Báo cáo nhân viên trên production còn bản 0066, có CRLF; một số phép thay chuỗi trong 0108 không khớp | Sau dọn, báo cáo công nợ theo công ty có thể bỏ số chuyển kỳ; biểu đồ không trừ trả hàng qua kỳ. Số công nợ gốc trong hồ sơ khách không bị lỗi này sửa đổi | 0112 sửa đúng hai chỗ lọc công ty và dòng biểu đồ; kiểm tra số vị trí đã sửa, từ chối cài nếu hợp đồng không khớp |
| Hoa hồng kỳ còn giữ hoặc chưa rõ kỳ liên quan phiếu quỹ cũ | Lần dọn có thể xóa khoản hoa hồng cần giữ | 0113 chặn trước bước tạo bản sao, yêu cầu chốt và đối soát. Có kiểm thử cả trường hợp kỳ bị bỏ trống |
| Phiếu trả mất phản hồi rồi đổi tài khoản/kết nối; hoặc lần thử lại nhận lỗi SQL | Gửi lại dưới tài khoản khác có thể tạo thêm phiếu; bỏ mã gửi cũ có thể khiến người dùng tạo phiếu thay thế trong khi lần đầu đã thành công | Frontend v2 ràng buộc lần gửi với tài khoản và project; giữ nguyên mã nếu lần đầu chưa rõ kết quả, kể cả khi lần kiểm tra lại báo lỗi |

Các lỗi phân quyền, báo cáo và hoa hồng đã được tái hiện trên dữ liệu giả bằng bộ RPC thật trước khi sửa. Ca báo cáo cũ tái hiện công nợ công ty từ 1.200 thành 300 sau dọn; sau sửa vẫn là 1.200 và doanh số trên biểu đồ khớp số tổng. Không dùng chứng từ thật để thử xóa.

0113 từng tự từ chối cài vì SQL Editor chuyển cả chuỗi neo sang CRLF. Giao dịch đã rollback, registry xác nhận chưa có 0113. Đã chuẩn hóa cả mã nguồn lẫn chuỗi neo, thêm diễn tập gửi toàn bộ installer dạng CRLF, kiểm thử lại rồi cài thành công. Cơ chế chặn hợp đồng không được bỏ qua.

## Kiểm chứng trên Supabase SoViet

Lần kiểm tra cuối **08:35:49 ngày 27/10/2026, UTC+7**, bằng `BEGIN READ ONLY ... ROLLBACK`:

- Đã cài đủ 0106–0113.
- Có **1.749 khách, 3.243 đơn**; **0 khách lệch công nợ**.
- **0 lần chuẩn bị/dọn**, phiên dữ liệu vẫn 0, mốc đã dọn và lần dọn cuối đều trống.
- Xem trước không có điều kiện chặn tại thời điểm kiểm tra.
- Dashboard, báo cáo nhân viên, sổ quỹ và danh sách trả độc lập chạy được dưới quyền ứng dụng.
- Hàm đọc phiếu trả nội bộ đã khóa; bảng job và helper dọn không được đọc/gọi trực tiếp; anonymous không được thực thi dọn.
- Hai bản vá số chuyển kỳ công ty và biểu đồ trả hàng đều hiện diện.
- Đối chiếu **41/41 hàm**: nội dung, tính chất SECURITY DEFINER, cấu hình và quyền khớp bản schema legacy đã dựng và kiểm thử đến 0113. Giữ nguyên cách phân trang của báo cáo 0066 đang dùng, không tự thay bằng 0067.

Số đơn tăng so với hôm trước do hệ thống vẫn đang được sử dụng; những số trên là một snapshot kiểm tra, không phải một mốc đóng sổ.

## Kết quả kiểm thử

Toàn bộ bộ kiểm thử: **675 qua, 2 bỏ qua, 0 lỗi**. Nhóm dọn dữ liệu gồm **35 ca**. Bao phủ:

- Giữ mọi trường hiện tại của khách, doanh số lũy kế, số dư có dấu; công nợ âm và khách nhập đầu kỳ không có sổ.
- Đơn/sổ công nợ có ngày lùi và thứ tự không liên tục; phiếu trả qua kỳ; hoàn tiền cũ; dọn kỳ tiếp theo.
- Thu tiền chuyển kỳ, sửa/hủy phiếu thu còn giữ, hủy đơn còn giữ rồi bán tiếp; số NCC sau thanh toán mới; ba loại quỹ.
- Trả hàng và hủy trả có kho; thiếu tồn để hủy thì toàn bộ giao dịch bị từ chối.
- Bản sao cũ/sai hash/sai mật khẩu; request trùng; phiên cũ; phân quyền; bảo trì; schema/trigger lạ.
- Lỗi ràng buộc ở cuối giao dịch rollback cả chứng từ, số chuyển kỳ, archive và trạng thái job.
- Giải mã file và phục hồi dữ liệu giả vào staging trống; từ chối đích có dữ liệu; RPC chỉ đọc; nguồn SQL CRLF.
- Mất phản hồi, đổi tài khoản/project và lỗi SQL khi kiểm tra lại phiếu trả.

Kiểm tra trình duyệt cục bộ dùng dữ liệu giả: các module nạp không có lỗi console; phép nhận trả 0,29 × 100 × 50% cho 15 đồng, khớp cách làm tròn của database.

## Điều kiện trước lần xóa thật

**Backend đã sửa và kiểm chứng; frontend v2 mới ở mã nguồn, chưa phát hành lên hosting. Chưa đủ cơ sở khẳng định toàn bộ website đang chạy đã dùng bản mới.**

1. Phát hành frontend `20261027-retention-v2`, kiểm tra bằng Admin/kế toán và tải lại các phiên cũ.
2. Đối soát số cuối với kế toán, bật bảo trì, tạo và kiểm tra lại đúng file phục hồi mã hóa của lần chuẩn bị mới. Dữ liệu thay đổi thì tạo lại file.
3. Chỉ sau khi đáp ứng các bước trên mới xác nhận xóa. Không chạy DELETE thủ công hoặc bỏ điều kiện chặn.

Đã diễn tập xóa và phục hồi trên dữ liệu giả/PGlite; **chưa diễn tập xóa dữ liệu thật hoặc khôi phục đầy đủ một project Supabase mới kèm Auth/cấu hình**. File phục hồi ứng dụng không thay thế bản sao đầy đủ của project. Mất kết nối trong lúc dọn phải tra trạng thái job; không đoán kết quả.

Không cam kết loại trừ mọi lỗi tương lai. Các kiểm tra hiện tại bảo vệ phạm vi schema và nghiệp vụ đã rà soát; thay đổi tích hợp/trigger/schema sau này cần kiểm tra lại. Dữ liệu đã xuất ra file, cache trên máy offline và bản sao hạ tầng có phạm vi lưu riêng. DELETE thường tạo chỗ trống tái sử dụng, không đảm bảo file đĩa nhỏ ngay.

Hướng dẫn chi tiết: [MONTHLY_DATA_RETENTION_RUNBOOK.md](MONTHLY_DATA_RETENTION_RUNBOOK.md).

Chứng cứ cục bộ trong `outputs/retention-review/`: `review-20261027-production-final.json`, `review-20261027-function-comparison-final.json`, `review-20261027-full-tests-final.log`, các log tái hiện trước sửa và ảnh giao diện. Thư mục này không được đưa vào Git.
