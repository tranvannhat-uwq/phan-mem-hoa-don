# Giữ chứng từ cảnh báo để kế toán đối soát

Migration: `0118_retention_reconciliation_holds.sql`. Cần có bản 0114–0117 đã rà soát.

## Phạm vi

Nút **Bỏ qua và giữ … chứng từ để đối soát sau** chỉ áp dụng cho cảnh báo hàng cấp
thiếu liên kết khách, số lượng không hợp lệ hoặc số lượng trả chưa khớp phiếu trả.
Admin chọn nút sau bước **Kiểm tra phạm vi**. Nó ghi nhận lý do, nguyên bản đơn và
chi tiết tại thời điểm giữ; không chạy xóa, không tự gán khách và không sửa số tiền.

Đơn gốc và các chứng từ có liên kết được loại khỏi phạm vi dọn, theo cả hai chiều:
chi tiết đơn, trả hàng, thu chi/thanh toán, bút toán và sửa/đảo, mua hàng/NCC nếu
chung nguồn, hoa hồng/kỳ lương, dữ liệu kho và nhật ký tham chiếu trực tiếp. Liên kết
FK và các cột nguồn của schema legacy đều được xét. Chung khách, SKU hoặc nhân viên
không tự làm cả nhóm chứng từ của người đó bị giữ. Nếu có liên kết chung thật,
phần giữ lại có thể lớn hơn số đơn trực tiếp gây cảnh báo.

Các kiểm tra lệch công nợ, phép tính bút toán, số dư quỹ/NCC, schema/FK chưa hỗ trợ,
trigger thay đổi và các điều kiện chặn còn lại vẫn có hiệu lực. Nút không ép hệ
thống chạy qua lỗi tài chính. Bản sao đã chuẩn bị trước khi thay đổi danh sách giữ
sẽ không còn hợp lệ; phải tạo và kiểm tra lại file phục hồi.

## Tra cứu

Admin và kế toán vào **Lịch sử giao dịch → Chứng từ giữ để đối soát**, mở từng đơn
để xem lý do, khách, ngày, ghi chú và chi tiết hàng gốc. Nhân viên bán hàng không
được đọc danh sách này. Dữ liệu gốc cùng các chứng từ liên quan vẫn ở database;
không phải chỉ giữ một dòng cảnh báo hoặc chuyển nguyên đơn sang lịch sử SKU tối giản.

Danh sách được giữ qua các lần dọn sau. Chưa có chức năng tự gỡ giữ hoặc sửa lùi
kỳ đã đóng: kế toán đối soát trước, sau đó quản trị viên xử lý theo nghiệp vụ phù
hợp. Việc mở danh sách không ghi dữ liệu và không làm thay đổi công nợ. Báo cáo
kỳ cũ vẫn có thể không đầy đủ, vì chỉ các chứng từ thuộc nhóm giữ còn tồn tại.

## Cài đặt

1. Chạy kiểm thử và SQL audit trước khi cài. Không chạy nút xóa để thử tính năng.
2. Chạy bản `outputs/retention-review/check-0118-rollback.sql` trên project đích:
   nó cài thử trong một transaction rồi `ROLLBACK`. Bản này được tạo từ đúng migration
   khi kiểm chứng; không dùng lại nếu đã thay đổi mã migration.
3. Nếu đạt, chạy nguyên `migrations/0118_retention_reconciliation_holds.sql`.
   Migration kiểm tra hash của năm hàm purge hiện hành, tạo một bảng trống và cập
   nhật hàm; không gọi prepare/execute/hold và không sửa/xóa chứng từ hiện có.
4. Chạy `scripts/audit-retention-after-feature-changes.sql`: phiên bản 0118,
   60 hợp đồng hàm, ACL riêng tư và phép tính số dư phải khớp. Audit dùng READ ONLY.
5. Phát hành frontend cùng phiên bản CSS/JS. Admin tự bấm giữ sau khi xem phạm vi,
   rồi thực hiện lại sao lưu/xác minh/xác nhận trước khi dọn phần còn lại.

## Bảo toàn và phục hồi

Kế hoạch dùng chung cho xem trước và thực thi. Giao dịch dọn chụp tất cả các dòng
được giữ, chỉ tính số chuyển kỳ từ dòng thực sự xóa, rồi so nguyên JSON từng dòng
giữ trước khi commit. Nếu một bước dọn tương lai sửa/xóa nhầm dòng giữ, toàn bộ
giao dịch phải rollback. Không dùng trigger âm thầm bỏ qua DELETE để che lỗi.

Bảng giữ và nguyên bản lý do nằm trong snapshot phục hồi mã hóa và fingerprint;
công cụ `scripts/restore-retention-backup.mjs` hỗ trợ bảng mới, yêu cầu staging
trống cùng schema 0118 nếu file có bảng này. Vẫn cần Auth tương thích; không tự
ghi đè database đang chạy và không coi đây là bản sao Auth/cấu hình Supabase.

Các ca kiểm thử bao gồm xóa phần hợp lệ/giữ nguyên đơn lỗi, liên kết thu–trả–sổ,
nhiều SKU kho, mua hàng/NCC dùng chung chứng từ, quyền Admin/kế toán/sale/anon,
file cũ bị từ chối, tra cứu READ ONLY, phân trang và rollback khi dòng giữ bị sửa.

Kiểm chứng cục bộ ngày 27/10/2026: toàn bộ 723 ca có **721 đạt, 2 bỏ qua, 0 lỗi**;
SQL audit READ ONLY khớp **60/60** hợp đồng hàm trên database PGlite dựng từ nguồn.
Đã thử migration CRLF bằng ROLLBACK rồi cài trên database 0117 có dữ liệu giả;
không đổi chứng từ/số dư, không tự tạo job hoặc giữ chứng từ. Diễn tập hai kỳ và
phục hồi file mã hóa có danh sách giữ vào staging trống cũng đạt.

Đối chiếu production SoViet lúc **18:40:33 ngày 27/10/2026 (UTC+7)**: bản 0118
đã có sẵn nên không cài lại. Đã chạy audit trong transaction READ ONLY và ROLLBACK:
**60/60 hợp đồng hàm khớp**, đủ phiên bản 0106–0118, trigger và ACL đúng; dashboard,
báo cáo nhân viên, sổ quỹ, trả độc lập và danh sách đối soát đọc được dưới quyền
ứng dụng. Có 1.750 khách, 3.271 đơn; 0 lệch công nợ khách/NCC và 0 bút toán sai.
Epoch vẫn 0, cutoff null, chưa có job xóa. Có 4 chứng từ chờ và 0 chứng từ đã giữ;
chưa gọi hold/prepare/execute trên dữ liệu thật trong lần kiểm chứng này.

Frontend `20261027-retention-holds-v1` đã được hosting phục vụ, có nút giữ và danh
sách đối soát. Admin bấm **Kiểm tra phạm vi** để hiện nút giữ 4 chứng từ; đây vẫn là
thao tác riêng trước bước tạo/xác minh file và xác nhận xóa phần còn lại.

Nhật ký được Git bỏ qua nằm tại `outputs/retention-review/holds-full-tests.log`,
`holds-audit-local.json`, `reconciliation-tests.log`, `holds-production-preflight.json`,
`holds-production-verification.json` và `holds-production-verification.png`.
