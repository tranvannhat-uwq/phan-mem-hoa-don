# Vận hành dọn dữ liệu theo tháng

Ngày cập nhật: 27/10/2026. Tài liệu này mô tả bản triển khai 0106–0114; báo cáo `MONTHLY_DATA_RETENTION_REVIEW.md` là hồ sơ rà soát trước khi viết chức năng. Xem [kết quả rà soát lại ngày 27/10](MONTHLY_DATA_RETENTION_RECHECK_2026-10-27.md) về các ngoại lệ đã sửa.

**Chưa thực hiện xóa dữ liệu thật. Việc cài migration và việc bấm xóa là hai bước riêng.** Các bài diễn tập dùng dữ liệu giả trên PostgreSQL/PGlite và trang kiểm thử cục bộ, không tạo chứng từ thử trên Supabase production.

**Đã cài 0106–0114 trên production SoViet.** Kiểm tra chỉ đọc lúc 27/10/2026 09:40:26 UTC+7: 1.749 khách, 3.250 đơn, 0 lệch công nợ, 0 lần dọn; epoch vẫn 0 và cutoff đã dọn vẫn null. Các báo cáo, cấu hình SKU và tra lịch sử hàng cấp chạy được dưới quyền ứng dụng; 48 hàm khớp bản legacy đã kiểm thử. Danh sách SKU chưa được xác nhận, nên hệ thống chủ động chặn chuẩn bị dọn cho đến khi Admin chọn và lưu lần đầu. Frontend dùng phiên bản `20261027-support-v3`; cần xác nhận hosting phục vụ đúng bản này trước khi thao tác.

Xem [cách chọn SKU và tra lịch sử hàng cấp](DEALER_SUPPORT_HISTORY.md). Đích đã có 0106–0113 chỉ cài thêm 0114.

## Quy tắc đã thực hiện

- Giữ tháng hiện tại và tháng trước theo UTC+7. Trong tháng 10/2026: giữ từ 01/09/2026, xóa chi tiết trước mốc đó. Không dùng cách đếm lùi 60 ngày.
- Giữ nguyên hồ sơ khách và các số cuối cùng: công nợ có dấu, tổng bán, tổng trả, doanh thu ròng lũy kế, ngày mua/thu gần nhất và các số nhập đầu kỳ. Không tính lại các số này chỉ từ đơn còn giữ.
- Chuyển phần công nợ đã xóa thành số dư mở kỳ. Có số chuyển kỳ thu tiền, công nợ theo công ty và nhà cung cấp; tiền mặt/ngân hàng/ví và tồn kho hiện tại được đối soát riêng.
- Công nợ theo công ty giữ cách phân bổ của báo cáo hiện có. Khoản đầu kỳ/thu tiền vốn chưa có công ty không tự được gán sang một công ty; tổng theo công ty có thể khác công nợ đầy đủ của khách như trước.
- Giữ riêng lịch sử số lượng của SKU đã chọn, không giữ giá hoặc toàn bộ đơn trong bản lưu này; xem chi tiết trong `DEALER_SUPPORT_HISTORY.md`.
- Giữ hàng hóa, bảng giá, tài khoản và danh mục hiện tại. Chức năng này không xóa toàn bộ lịch sử BOM/sản xuất hay dữ liệu tại hệ thống kho ngoài.
- Xóa thật chi tiết cũ trong đơn, đơn nháp, thanh toán, quỹ, trả hàng, mua hàng, sổ công nợ và các bản sửa thuộc phạm vi tương ứng. Xử lý liên kết của chứng từ còn giữ trước khi xóa nguồn cũ.
- Loại bản sao lịch sử công nợ trong nhật ký mới và nhật ký có tham chiếu lồng tới chứng từ bị xóa. Bảng archive được kiểm tra riêng và mặc định được chọn dọn.
- Không làm mất thông tin hiện tại mà người dùng nhập trong ghi chú khách. Văn bản tự do còn giữ có thể nhắc tới giao dịch cũ; đây không phải chức năng ẩn danh toàn bộ hồ sơ khách hàng.

Sổ công nợ không bắt buộc phải xóa theo một tiền tố liên tục của thứ tự ghi sổ. Số mở kỳ được tính độc lập từ số mở trước đó và tổng bút toán thực sự bị xóa; các snapshot còn giữ không bị viết lại để ép khớp. Toàn bộ số cuối cùng và phép tính sổ được kiểm tra lại trong cùng giao dịch.

## Trả hàng sau khi đơn gốc đã xóa

Vào **Bán hàng & khách hàng → Nhận hàng trả**. Admin hoặc kế toán chọn khách, công ty, SKU đang hoạt động, số lượng và đơn giá nhận lại đã duyệt; nhập lý do và xác nhận tem niêm phong.

Phiếu mới giảm công nợ hiện tại. Nếu khách đã hết nợ, số dư thành tiền khách được cấn trừ ở các giao dịch sau. Không truy tìm đơn đã xóa, không tự sinh phiếu hoàn tiền. Nếu kho tích hợp đã được kích hoạt, lượng nhận trả được nhập kho trong cùng giao dịch.

Mỗi lần gửi có mã chống ghi trùng, ràng buộc với tài khoản và project. Khi mất phản hồi, giao diện khóa nội dung và cho **Kiểm tra lại lần gửi trước**; không tạo lại một phiếu khác để đoán kết quả. Nếu đổi tài khoản/kết nối, đăng nhập lại đúng nơi đã gửi để kiểm tra. Lỗi SQL ở lần thử lại không chứng minh lần đầu chưa thành công, nên mã cũ vẫn được giữ. Không đóng tab khi chưa rõ kết quả.

Hủy phiếu mới sẽ đảo đúng công nợ và lượng nhập kho của phiếu đó. Nếu hàng đã xuất tiếp và không đủ tồn để đảo, toàn bộ lần hủy bị từ chối. Phiếu trả cũ còn trong hai tháng nhưng đơn gốc thuộc kỳ xóa được tách nguồn, giữ nguyên số tiền; trường hợp hoàn tiền lịch sử giữ và đảo đúng phần tiền/nợ ban đầu.

## Cài đặt

1. Chạy `npm run test:retention`. Có thể chạy toàn bộ test bằng danh sách file mở rộng trong PowerShell; Node 20 trên Windows không tự mở rộng `tests/*.test.mjs`.
2. Chạy `node scripts/build-retention-upgrade.mjs` để tạo hai file trong `outputs/retention-review/`:
   - `production-compatibility-rollback.sql`: thử cài trong một giao dịch, luôn kết thúc bằng `ROLLBACK`.
   - `install-retention-0106-0114.sql`: cài chín migration trong **một giao dịch**, không gọi hàm thực thi xóa. Chỉ dùng khi đích chưa có cả nhóm này.
3. Đối chiếu database đích, rà soát SQL và xác nhận cảnh báo của SQL Editor trước khi cài. Không áp dụng lại nếu một phần 0106–0114 đã có; file cài sẽ từ chối trường hợp này để tránh ghi đè mù. Đích đã có 0106–0110 cần áp dụng riêng các migration 0111, 0112, 0113, 0114 theo thứ tự, không chạy lại installer đầy đủ.
4. Phát hành frontend cùng phiên bản `20261027-support-v3`, rồi kiểm tra bằng tài khoản Admin và kế toán. Chưa bấm xóa ở bước cài.

Truy vấn chỉ đọc lúc **26/10/2026 10:02:24 UTC** trên SoViet cho thấy các dấu mốc hàm phản hồi trả hàng, xác thực, sổ quỹ, bảo vệ công nợ, dashboard, báo cáo trả/nhân viên và index đơn nháp đều khớp. Lúc kiểm tra có 1.749 khách và 3.227 đơn; 0106–0108 chưa cài. Đây là đối chiếu catalog, không phải xác nhận đã cài thành công.

Lần cài đầu dừng và rollback vì draft_orders ở production không có order_date như schema dựng mới. Đã xác nhận không có migration/table mới sau lần thất bại, so sánh toàn bộ danh mục cột thực tế và bổ sung test với đúng biến thể legacy. Không cài bù các phần VAT/BOM chưa có vì không phải phụ thuộc cần thiết của tính năng này.

0109 dùng advisory transaction locks cho cả báo cáo và luồng ghi. [PostgREST chạy RPC STABLE trong giao dịch chỉ đọc](https://postgrest.org/en/stable/references/transactions.html), nên không dùng khóa dòng FOR SHARE ở ranh giới xác thực chung. Có bài thử READ ONLY trước/sau dọn và kiểm chứng trực tiếp trên production. 0111 khóa helper trả hàng; 0112 xác minh đầy đủ bản vá báo cáo cũ dù khác định dạng xuống dòng; 0113 chặn hoa hồng kỳ còn giữ/chưa rõ kỳ dựa vào phiếu quỹ cũ. Cả ba không sửa số tiền hay xóa chứng từ khi cài.

Không áp dụng các file sửa sự cố riêng 0100/0104 lên database trống như một bản bootstrap thông thường. Script tạo staging chỉ lấy phần schema cần thiết của 0100.

## Thao tác dọn một kỳ

1. Admin xác nhận danh sách SKU tại Cấu hình → Giữ lịch sử hàng cấp đại lý (xem `DEALER_SUPPORT_HISTORY.md`). Đối soát số cuối cùng với kế toán. Chuẩn bị nơi lưu file phục hồi và mật khẩu riêng. Đóng các phiên Admin khác; bật **Chế độ bảo trì**.
2. Trong **Cấu hình → Dọn dữ liệu theo tháng**, bấm **Kiểm tra phạm vi**. Đọc mốc ngày, số chứng từ và các điều kiện đang chặn. Nếu bỏ chọn archive, bảng nhật ký lưu trữ đó sẽ vẫn còn.
3. Nhập mật khẩu bản sao ít nhất 12 ký tự hai lần; tải file phục hồi mã hóa. Mật khẩu không được gửi lên Supabase hoặc lưu trong cache.
4. Nhập mật khẩu kiểm tra và chọn lại **file vừa tải**. Giao diện phải giải mã được, khớp SHA-256 và đúng mã lần chuẩn bị.
5. Nhập chính xác dòng xác nhận đang hiển thị, ví dụ `XOA TRUOC 01/09/2026`, rồi bấm nút xóa. Lần chuẩn bị hết hạn sau 30 phút.
6. Nếu mất phản hồi, bấm **Kiểm tra kết quả trên máy chủ**. Không tự đoán thành công/thất bại, không chạy câu DELETE thủ công. Lần thực thi đã hoàn tất có thể được tra lại mà không xóa lần hai.
7. Sau thành công, ứng dụng tải lại. Kiểm tra hồ sơ khách, số tổng, quỹ, kho và các báo cáo còn lưu. **Bảo trì vẫn bật**; Admin chủ động tắt sau khi đối soát.

Bất kỳ dữ liệu thuộc bản sao thay đổi sau bước chuẩn bị đều làm lần xóa bị từ chối. Hãy tạo bản sao mới; không sửa hash hoặc bỏ bước kiểm tra. Khóa chờ quá lâu, timeout hoặc lỗi ràng buộc đều làm giao dịch hủy toàn bộ.

## Các trường hợp tự chặn

- Không phải Admin đang hoạt động, chưa bật bảo trì, file/mã xác nhận sai hoặc bản chuẩn bị cũ.
- Công nợ khách sai phép tính, sổ không khớp số hiện tại; số cuối NCC chưa khớp quan hệ mở kỳ/tổng mua/tổng trả.
- Đơn cũ còn chờ kho; chứng từ còn giữ có liên kết thanh toán/hoàn tiền chưa xử lý được; hoa hồng kỳ mới hoặc chưa rõ kỳ còn dựa vào đơn, trả hàng hay phiếu quỹ sẽ xóa.
- Schema có FK chưa hỗ trợ; bảng archive có trigger/dependency mới hoặc dữ liệu thuộc hai tháng giữ lại.
- Mã trigger thay đổi sau khi cài. Cần rà soát và migration đăng ký lại hợp đồng sau khi kiểm chứng, không tự sửa `expected_trigger_hash` trên production để vượt chặn.
- Đối soát sau xóa phát hiện thay đổi bất kỳ trường hiện tại của khách, NCC, tồn kho, số dư quỹ gốc hoặc lệch số chuyển kỳ.

Sau lần dọn đầu, các luồng ghi phải mang đúng phiên dữ liệu; trình duyệt cũ bị từ chối và cần tải lại. Các request đã xóa chỉ giữ dấu băm chống phát lại, không giữ nội dung chứng từ. Các kỳ đã đóng không cho lập lại chứng từ lùi về trước mốc đó; điều chỉnh dùng chứng từ kỳ hiện tại.

## File phục hồi và diễn tập khôi phục

File dùng AES-GCM 256 bit, khóa dẫn xuất PBKDF2 SHA-256 với 210.000 vòng và salt/IV ngẫu nhiên; nén gzip nếu môi trường hỗ trợ. File chứa snapshot ứng dụng thuộc phạm vi phục hồi, schema/column manifest và trạng thái sequence. Nó **không chứa Auth users/password, secrets, cấu hình dự án hoặc toàn bộ hệ thống bên ngoài**; không thay thế một bản sao đầy đủ của project.

`scripts/restore-retention-backup.mjs` chỉ xử lý offline, không kết nối database. Dùng Node 20+ và `--experimental-default-type=module`. Đọc mật khẩu bằng giao diện ẩn thay vì ghi trực tiếp vào lịch sử lệnh:

```powershell
$backupSecret = Read-Host 'Mật khẩu bản sao' -AsSecureString
$backupHandle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($backupSecret)
try {
  $env:RETENTION_BACKUP_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($backupHandle)
  node --experimental-default-type=module scripts/restore-retention-backup.mjs --inspect 'D:\secure\backup.encrypted.json'
  node --experimental-default-type=module scripts/restore-retention-backup.mjs --emit-staging-sql 'D:\secure\backup.encrypted.json' 'D:\secure\recovery-staging.sql'
} finally {
  Remove-Item Env:\RETENTION_BACKUP_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($backupHandle)
  $backupSecret.Dispose()
}
```

File SQL sinh ra là **dữ liệu nhạy cảm đã giải mã**. Chỉ mở trong môi trường phục hồi riêng, bảo vệ và xóa bản tạm sau diễn tập. Công cụ không ghi đè file đã có.

Database đích phải có schema khớp, các Auth UUID cần thiết và các phần tích hợp tương ứng. Kết nối staging cần khai báo rõ:

```sql
SET app.retention_restore_target = 'ISOLATED_EMPTY_STAGING';
```

SQL vẫn từ chối nếu có dữ liệu nghiệp vụ/danh mục ngoài các dòng bootstrap được cho phép; marker không đủ để vượt kiểm tra database trống. Công cụ kiểm tra cột, FK và số dư sau nạp. Dùng quyền owner để phục hồi, không mở thêm quyền cho ứng dụng. Kiểm tra vận hành/Auth và áp dụng lại mốc dọn thích hợp trước khi cân nhắc đưa dữ liệu phục hồi vào sử dụng.

Đã diễn tập: tạo chứng từ bằng RPC thật trên dữ liệu giả, tải/mã hóa/giải mã, sinh SQL, từ chối đích có dữ liệu, phục hồi vào PGlite trống cùng schema/Auth UUID, so khớp toàn bộ khách và công nợ. Chưa coi đây là diễn tập khôi phục đầy đủ Auth/cấu hình trên một project Supabase mới.

## Dung lượng và giới hạn bảo mật

- Archive đủ điều kiện dùng `TRUNCATE ONLY ... RESTRICT`, không dùng CASCADE. Các bảng giao dịch dùng xóa có chọn lọc; chỗ trống sau DELETE chủ yếu được PostgreSQL tái sử dụng. File đĩa không nhất thiết nhỏ ngay. Không tự chạy VACUUM FULL vì cần khóa và kế hoạch riêng.
- Dữ liệu chi tiết đã xóa không còn được truy vấn trong database đang dùng. Không cam kết xóa tức thì mọi byte trong WAL hoặc sao lưu hạ tầng của nhà cung cấp.
- Cache ứng dụng được dọn khi nhận phiên mới; thiết bị offline và Excel/PDF/file đã tải ra ngoài cần quản lý riêng.
- Bản sao bảo mật cũng chứa lịch sử cũ. Kế toán/quản trị cần thống nhất hạn giữ file, quyền truy cập và thời điểm hủy; ứng dụng không tự tải bản sao lên dịch vụ khác.
- Server từ chối snapshot vượt 256 MiB trước khi trả dữ liệu/tạo lần chuẩn bị; bước chuẩn bị/thực thi có giới hạn câu lệnh 60 giây. Nếu bản sao quá lớn hoặc server timeout, dừng ở bước chuẩn bị và dùng quy trình quản trị phù hợp; không được bỏ sao lưu để chạy xóa.

## Kiểm thử

Lệnh chuẩn: `npm run test:retention` (47 ca). Nhóm kiểm tra gồm phân quyền, sai file/hash/mật khẩu, request trùng, backup cũ, lỗi cuối giao dịch và rollback archive, sổ không liên tục do ngày lùi, phiếu trả qua kỳ, hoàn tiền lịch sử, công nợ âm/import không ledger, ba quỹ, số NCC sau thanh toán tiếp, kho thiếu khi hủy trả, dọn kỳ kế tiếp, doanh số/công nợ công ty trước–sau, sửa/hủy phiếu thu và hủy đơn còn giữ, nhật ký sao chép nội dung cũ, hoa hồng liên quan phiếu quỹ, schema/trigger mới, đổi tài khoản khi mất phản hồi, SQL CRLF, READ ONLY RPC và diễn tập phục hồi. Lần chạy toàn bộ sau cùng: **687 qua, 2 bỏ qua, 0 lỗi**; log tại `outputs/retention-review/support-full-tests-final.log`.

Trang `node scripts/retention-ui-harness.mjs` tại localhost:5181 dùng toàn bộ dữ liệu giả và RPC mô phỏng để kiểm tra giao diện. Không nhập tài khoản thật ở đó. Ảnh và log nằm trong `outputs/retention-review/` (không đưa vào Git).
