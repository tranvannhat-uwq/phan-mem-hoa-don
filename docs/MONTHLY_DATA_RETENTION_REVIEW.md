# Rà soát xóa dữ liệu theo tháng để giảm dung lượng và hạn chế lộ lịch sử

> Hồ sơ rà soát trước triển khai. Phần thực hiện 0106–0113 và cách vận hành hiện tại được mô tả tại [MONTHLY_DATA_RETENTION_RUNBOOK.md](MONTHLY_DATA_RETENTION_RUNBOOK.md), bao gồm hỗ trợ sổ công nợ không liên tục và trả hàng độc lập. Những đoạn đề xuất “chưa có chức năng” bên dưới phản ánh thời điểm kiểm kê ban đầu.

Ngày đánh giá: 26/10/2026. Phạm vi: mã nguồn và migration đến 0105 trong workspace hiện tại; tài liệu chính thức Supabase/PostgreSQL; mô phỏng cục bộ bằng PostgreSQL/PGlite với dữ liệu giả; và **kiểm tra trực tiếp production SoViet qua SQL Editor đã đăng nhập**.

**Đã kiểm tra production bằng giao dịch `BEGIN READ ONLY ... ROLLBACK`; database xác nhận `transaction_read_only=on`. Snapshot cuối lúc 09:08:57 ngày 26/10/2026, UTC+7. Không xóa/sửa bản ghi, không đổi schema, quyền, cron, backup hoặc chạy VACUUM.** Có lưu bản xuất kết quả tổng hợp tại `outputs/retention-review/production-snapshot-20261026.json` và `.csv`; không xuất nội dung chứng từ, thông tin liên lạc hay giá trị mật khẩu.

Hệ thống vẫn có người sử dụng trong lúc kiểm tra, nên số dòng của các truy vấn khác thời điểm có thể chênh nhẹ. Số liệu trọng yếu ở phần kết quả production lấy từ snapshot cuối trong cùng một transaction.

## Kết luận và lựa chọn

**Ưu tiên thực tế sau khi kiểm tra production: dọn archive nhật ký cũ trước**, vì riêng bảng này chiếm 66,72 MB, tương đương 35,72% database, không tìm thấy liên kết nghiệp vụ cần duy trì. Sau đó duy trì thời hạn nhật ký đang dùng và tối ưu dung lượng theo đo đạc. Việc xóa đơn/sổ quỹ theo tháng là giai đoạn riêng cần hoàn thiện cơ chế **đóng kỳ có kiểm tra điều kiện, chuyển số dư sang một mốc mới, xóa thật toàn bộ nội dung chi tiết thuộc phạm vi đủ điều kiện, làm sạch bản sao và kiểm tra thu hồi dung lượng**.

Đây là tính năng mới cần migration và điều chỉnh các luồng nghiệp vụ. Mã hiện tại chưa có cơ chế đóng kỳ/chuyển kỳ/xóa theo tháng bảo toàn mọi liên kết. Không thể xác nhận an toàn bằng cách chỉ so sánh `customers.debt` trước và sau `DELETE`.

Mặc định an toàn cho phiên bản đầu: **nếu có liên kết qua kỳ chưa được hỗ trợ, chuỗi số dư không đúng, hoặc hàng chờ kho chưa xử lý thì dừng toàn bộ lần xóa trước khi thay đổi dữ liệu**. Không tự bỏ qua FK, không tự biến phiếu thu theo đơn thành phiếu thu độc lập. Màn hình xem trước phải nêu rõ phần bị chặn, không thông báo đã xóa sạch trong khi âm thầm giữ lại chứng từ.

| Phương án | Dung lượng | Bảo mật lịch sử | Đánh giá |
|---|---|---|---|
| Ẩn giao dịch hoặc đánh dấu `deleted_at` | Gần như không giảm | Nội dung vẫn trong database | Không đáp ứng |
| Chuyển nguyên dữ liệu sang bảng archive cùng project | Ít hoặc không giảm tổng dung lượng | Nội dung vẫn trong Supabase | Không đáp ứng |
| Xóa đơn/phiếu nhưng giữ toàn bộ ledger và snapshot | Giảm một phần | Còn số tiền, mã đơn, mô tả, bản sao | Không đủ cho mục tiêu đầy đủ |
| Chuyển số dư, xóa chi tiết cùng các bản sao, kiểm tra từng kỳ | Có thể giảm đáng kể; phải đo | Loại bỏ nội dung lịch sử khỏi dữ liệu hoạt động | Khuyến nghị sau khi hoàn thiện các điều kiện bên dưới |
| Chuyển sang project Supabase mới | Có thể tạo database gọn | Project/backup cũ vẫn cần xử lý riêng | Không ưu tiên do tăng rủi ro Auth, RLS, RPC, Storage và cấu hình |

## Các phát hiện cụ thể trong mã hiện tại

### 1. Xóa ledger theo ngày chứng từ có thể sai mà chưa báo lỗi ngay

`migrations/0074_customer_debt_full_invariant_and_reconciliation.sql` tính công nợ bằng số dư trước dòng đầu theo thứ tự ghi nhận cộng tổng `debt_change`. Trigger kiểm tra ledger chạy trên INSERT/UPDATE, không chạy trên DELETE. Ledger còn có lớp chặn thao tác API thông thường từ migration 0007, nhưng thao tác của chủ database không được bảo vệ bằng lớp kiểm tra DELETE của 0074.

`js/domain/customer-debt.js` phân biệt ngày chứng từ với thứ tự ghi nhận. Đơn và phiếu có thể được ghi lùi ngày; điều chỉnh ngày phiếu còn có thể thêm bút toán giá trị 0 (0063, 0068).

Mô phỏng bằng đúng hàm/trigger 0074: số dư hiện tại 150; xóa các dòng có ngày nghiệp vụ trước 01/10 để lại phép tính ledger 120. DELETE vẫn thành công; giao dịch mới tiếp theo bị chặn vì sai chuỗi. Đây là lý do không dùng `WHERE transaction_date < cutoff` độc lập cho ledger.

### 2. Sổ quỹ mất phần số dư hình thành từ giao dịch đã xóa

`migrations/0051_cashbook_window_egress.sql` tính phát sinh trước kỳ theo từng phương thức `cash`, `bank`, `wallet`, có quy tắc loại phiếu hủy/đảo và xét trạng thái hiệu lực. `js/components/so_quy.js` kết hợp số này với số dư gốc.

Mô phỏng bằng đúng RPC 0051: phát sinh tiền mặt trước kỳ từ 100 thành 0 sau khi xóa phiếu cũ. Giữ nguyên `starting_balances` hiện tại không tự bù lại phần này. Ghi thêm một phiếu thu giả để bù sẽ làm sai tổng thu và báo cáo.

### 3. DELETE có thể tạo lại bản sao nội dung vừa xóa trong nhật ký

`rpc_log_audit_trail` trong migration 0004 chép `to_jsonb(OLD)` vào `audit_logs` khi DELETE. Bộ nén 0052 vẫn giữ `customer_name`, nhiều số tiền và chi tiết hàng. Activity log cũng ghi tên đối tượng và thay đổi. Migration 0079 còn giữ chi tiết lịch sử hồ sơ khách hàng.

Mô phỏng bằng đúng hàm audit và bộ nén: tên khách, tên mặt hàng, số lượng và giá của đơn đã xóa vẫn xuất hiện trong audit mới.

Migration 0077 đổi thời hạn audit/activity thành **15 ngày**; việc dọn hiện gắn với chèn nhật ký và lúc áp dụng migration, không phải một lịch đảm bảo chạy đúng giờ khi hệ thống không phát sinh ghi. Chờ hết 15 ngày không giải quyết yêu cầu xóa nội dung ngay sau một lần purge.

### 4. Có bản sao đầy đủ trong lịch sử sửa đơn và các cột JSON

`order_amendments.old_data/new_data` (0057) chứa toàn bộ bản đơn trước/sau, bao gồm `items`. Chức năng xem nguồn công nợ sử dụng những bản này (0099). Còn có `orders.items`, `draft_orders.items`, `order_items`, `sales_return_items`, `customers.debt_history`, snapshot công nợ hóa đơn, audit/activity, các bảng đánh dấu đảo/ẩn bút toán.

Xóa theo `created_at` của nhật ký là chưa đủ: nhật ký mới trong tháng 10 có thể chứa nội dung của đơn tháng 9. Phải lần theo tập chứng từ bị xóa và nội dung snapshot liên quan. Bản chụp bảng lương và các trường ghi chú/tham chiếu cũng cần kiểm kê; không suy luận rằng chúng chắc chắn chứa hoặc chắc chắn không chứa dữ liệu cần xóa chỉ dựa vào tên cột.

### 5. Kho có FK chặn xóa đơn và có hàng chờ đồng bộ

0088: `inventory_movements.order_id` và `inventory_order_positions.order_id` tham chiếu `orders` bằng `ON DELETE RESTRICT`. 0089 bổ sung `inventory_pending_orders` có FK tương tự. Mô phỏng FK thực xác nhận xóa đơn bị chặn.

Không được đổi sang CASCADE đại trà hoặc coi purge là hủy đơn: hủy đơn có thể hoàn tồn và đảo công nợ. Purge chỉ loại bỏ lịch sử đã chốt; số lượng tồn kho hiện tại phải không đổi. Hàng chờ chưa áp dụng phải được xử lý/đối chiếu bằng luồng kho hiện hành trước khi xét xóa. BOM và sản xuất có chuỗi chứng từ riêng (0092), không tự gộp vào nút xóa đơn.

### 6. Công nợ nhà cung cấp có thể lệch ở lần tính lại sau này

`p4_recompute_supplier` (0009, còn được gọi từ luồng mua mới trong 0102) tính lại tổng mua/tổng thanh toán và công nợ từ các bảng chi tiết. Chỉ giữ nguyên `suppliers.debt` rồi xóa lịch sử không đủ. Nếu phạm vi có phiếu mua/chi nhà cung cấp, cần số dư và tổng tích lũy chuyển kỳ tương ứng; nếu chưa hỗ trợ thì phải chặn nhóm chứng từ đó.

### 7. Trình duyệt giữ lịch sử ngay cả sau khi database đã xóa

`js/services/supabase.js`: cache đơn cục bộ tối đa 120 đơn/750.000 ký tự, cache sổ quỹ, cache khách hàng theo tài khoản; có fallback khi đọc cloud thất bại. `hydrateCustomerDebtHistory` trộn lịch sử tải về vào lịch sử cũ; tải lại một cửa sổ thời gian không tự xóa các cửa sổ cũ. `resetAuthenticatedBusinessState` không xóa toàn bộ khóa cache theo tài khoản và đơn/sổ quỹ.

`js/services/pricing-cache.js` còn có IndexedDB cho bảng giá được cấp quyền; cần giữ phạm vi riêng vì đây là dữ liệu hiện tại, không mặc nhiên thuộc lịch sử cần purge.

Điểm tốt đã có: `syncLocalToCloud` hiện tải lại cloud; luồng upload cache cũ đã bị tắt. `importBackupFromExcel` hiện chỉ dry-run; hàm import ghi đè cũ cũng đã bị tắt. Không kết luận các luồng đã tắt đang tự khôi phục dữ liệu. Tuy nhiên chưa có phiên bản lưu giữ dữ liệu để vô hiệu hóa toàn bộ cache sau purge và chặn yêu cầu từ trình duyệt cũ.

### 8. Sao lưu hiện có không thay thế được quy trình khôi phục có kiểm soát

Excel backup hiện liệt kê một số bảng nghiệp vụ nhưng không có mọi bảng mới: lịch sử sửa đơn, các bảng đánh dấu sửa/đảo, kho/BOM, cùng nhiều bảng lương. Backup này không đủ để khẳng định có thể khôi phục toàn vẹn trước một lần purge mới.

Các script pg_dump và nhiều file backup đã tồn tại trong workspace; một số xuất dữ liệu dạng SQL/JSON/CSV không mã hóa. `.gitignore` ngăn commit thư mục backup nhưng không mã hóa file trên máy. Một số migration/script sửa lỗi còn có tham chiếu chứng từ và số tiền lịch sử. Những bản ngoài Supabase cần chính sách lưu riêng; lần rà soát này không xóa hoặc mở nội dung khách hàng trong các file backup đó.

`scripts/reset-business-data.sql` xóa cả khách hàng và đặt công nợ nhà cung cấp về 0. Không tái sử dụng script reset này cho yêu cầu hiện tại.

## Thiết kế tối thiểu cần có trước khi bật nút xóa

### A. Đóng kỳ và lập tập xóa chính xác

- Một mốc theo tháng ở UTC+7; chỉ tiến về phía trước. Phiên bản đầu không hỗ trợ xóa một tháng nằm giữa những tháng còn giữ.
- Kiểm tra cả ngày nghiệp vụ, thứ tự ghi nhận và toàn bộ liên kết sửa/đảo/chuyển khách/thu tiền/trả hàng/kho. Không chọn ngày riêng rẽ cho từng bảng rồi DELETE độc lập.
- Với phiên bản đầu, phần ledger loại bỏ phải là tiền tố liên tục theo thứ tự ghi nhận của từng khách, nằm trong tập chứng từ được phép xóa; nếu điều kiện không đạt thì chặn. Đừng sửa lại snapshot lịch sử của chứng từ còn giữ để ép cho phép xóa.
- Liên kết qua mốc chưa được thiết kế và kiểm thử phải chặn toàn bộ lần chạy. Giữ thêm một chứng từ ngoại lệ cần được hiển thị rõ trong một chế độ riêng; không gọi kết quả đó là xóa sạch kỳ.
- Chặn tạo/sửa/chuyển ngày về kỳ đã đóng ở database, bao gồm RPC và đường ghi trực tiếp còn được cấp quyền. Màn hình bảo trì 0039 chỉ chặn nhân viên, vẫn cho Admin; cần khóa database có phạm vi phù hợp để ngăn cả giao dịch Admin đang chạy. Worker/hàng chờ cũng phải được xét.

### B. Số dư chuyển kỳ là nguồn dữ liệu chính thức mới

Tối thiểu cần các dữ liệu có kiểu chặt chẽ, không có JSON chứa chứng từ:

- Khách: ID khách hiện hữu, mốc kỳ, số dư có dấu, tổng mua/trả/doanh thu lũy kế cần bảo toàn.
- Sổ quỹ: mốc kỳ và số dư theo phương thức/tài khoản thực tế mà ứng dụng hỗ trợ. Không tự gộp nhiều tài khoản nếu schema thực tế phân biệt chúng.
- Nhà cung cấp nếu nằm trong phạm vi: số dư và tổng tích lũy mua/trả tiền chuyển kỳ.
- Kho nếu loại bỏ lịch sử kho: số lượng theo SKU/kho và mốc đối chiếu. Không thay đổi `inventory_balances` như thể đang nhập/xuất thực tế.
- Một bản ghi công việc tối thiểu: mã lần chạy, người thực hiện, mốc xóa, số lượng, phiên bản schema, trạng thái và kết quả kiểm tra. Không lưu toàn bộ danh sách hàng, tên khách, nội dung phiếu trong biên bản.

Quan hệ bắt buộc cho từng khách:

`debt_hiện_tại = opening_checkpoint + SUM(debt_change_còn_giữ)`

Phải tính checkpoint từ số dư mở cũ và tập phát sinh thật bị loại bỏ, sau đó đối chiếu độc lập với số dư hiện tại trừ tổng còn giữ. Không dùng một vế để tạo rồi cũng dùng chính phép tính đó làm bằng chứng duy nhất. Giữ nợ âm/tiền dư, không ép về 0. Khách không có ledger và khách đã ngừng hoạt động cũng phải được xét.

0074, các RPC số dư, in hóa đơn, báo cáo, tính lại nhà cung cấp và giao diện lịch sử phải dùng được checkpoint. Không tái sử dụng trường baseline nhập Excel một cách mơ hồ vì lần import sau có thể điều chỉnh baseline đó.

### C. Chứng từ qua kỳ

Đơn tháng 9 có phiếu thu/trả hàng/điều chỉnh tháng 10 là trường hợp chặn mặc định của phiên bản đầu. Không mặc định cắt liên kết vì có thể làm sai `paid_amount`, `debt_amount`, giới hạn trả hàng và cách hủy/sửa phiếu.

Muốn xóa triệt để cả nhóm này về sau phải có luồng chuyển nghĩa vụ còn lại sang kỳ mới được kiểm thử riêng, lưu tối thiểu số tiền/quyền xử lý thật sự cần thiết. Cần nêu rõ dữ liệu tối thiểu nào vẫn còn. Không thể vừa xóa toàn bộ chi tiết đơn cũ vừa giữ nguyên khả năng in/sửa/trả hàng từ chính chi tiết đã mất.

Sau khi chứng từ cũ đã xóa, điều chỉnh mới được thực hiện bằng chứng từ kỳ mở và quyền phù hợp. Thu tiền công nợ chuyển sang vẫn được phép; không cần đơn lịch sử nếu đây là thu công nợ khách hàng độc lập.

### D. Thực thi và chống dữ liệu xuất hiện lại

- Quyền thực thi dành riêng cho Admin đã xác thực lại; thực thi xóa qua luồng bảo trì phía server, không cấp DELETE hàng loạt cho client hoặc đưa khóa đặc quyền vào trình duyệt.
- Xem trước gắn với phiên bản dữ liệu. Khi thực thi phải kiểm tra lại dưới khóa; preview cũ không được dùng để xóa tập mới phát sinh.
- Checkpoint, xóa chi tiết, xử lý audit và cập nhật mốc lưu giữ phải commit nguyên khối. Với dung lượng lớn, chọn đơn vị công việc đã được chứng minh độc lập hoặc tiến từng mốc tháng; không chia các bảng phụ thuộc thành nhiều giao dịch HTTP và vẫn hứa rollback toàn bộ.
- Không vô hiệu hóa tất cả trigger/FK. Chỉ thêm hành vi audit riêng cho purge do luồng đặc quyền kiểm soát, không ghi lại payload từng dòng. Phải dọn cả log đã có liên quan, không chỉ log có ngày cũ.
- Mất kết nối giữa chừng phải đọc lại trạng thái lần chạy ở server; không tự chạy lại thao tác xóa khi client không biết đã commit hay chưa.
- Tăng `retention_epoch` sau purge. Mọi phiên phải lấy epoch hiện tại trước khi dùng dữ liệu nhạy cảm hoặc ghi. Epoch thay đổi phải xóa cache lịch sử trong RAM/localStorage, các khóa theo người dùng và các cửa sổ cũ; đọc lại dữ liệu được phép giữ. Không dựa hoàn toàn vào thông báo Realtime DELETE.
- RPC phải chặn yêu cầu từ phiên/epoch cũ. Kiểm soát khóa chống lặp đã bị xóa cùng chứng từ: có thể giữ dấu kỹ thuật tối thiểu không chứa payload và buộc epoch trong hợp đồng RPC mới. Chỉ kiểm tra ngày chứng từ chưa đủ vì một số RPC dùng `now()` khi không gửi ngày.
- Không reset sequence mã chứng từ. Không cho restore/import/backfill cũ đưa lại dữ liệu trước mốc đã xóa. Quy trình khôi phục backup cũ phải áp dụng lại mốc purge trước khi mở cho người dùng.

### E. Bảo mật và dung lượng là hai bước xác minh riêng

Sau DELETE, phải kiểm tra nội dung không còn qua API, RPC xem nguồn, bảng snapshot, audit/activity và cache do ứng dụng quản lý. Trình duyệt đã offline hoặc file Excel/PDF đã tải ra ngoài không thể được server thu hồi chắc chắn; cần quản lý các thiết bị/file đó riêng. Việc giữ hồ sơ khách hàng và công nợ hiện tại vẫn giữ thông tin nhạy cảm hiện tại theo đúng yêu cầu, không đồng nghĩa ẩn danh toàn bộ hệ thống.

Backup khôi phục nên mã hóa, giới hạn người giữ khóa và có hạn lưu được ấn định trước; không tạo thêm nhiều bản plaintext vô thời hạn. Thời gian hết hạn backup cần cân bằng khả năng phục hồi và mục tiêu bảo mật. Backup/PITR/WAL và bản sao hạ tầng có vòng đời riêng. DELETE hoặc VACUUM không phải cam kết xóa không thể phục hồi ở cấp thiết bị/hạ tầng.

Về dung lượng:

1. Đã đo bảng, index và TOAST thực tế: ba bảng nhật ký chiếm khoảng 119,40 MB, tương đương 63,92% database. Riêng archive cũ chiếm 66,72 MB. Đây là nhóm ưu tiên hơn việc xóa nghiệp vụ tài chính; chưa thể hứa số MB thu hồi thêm khi rewrite các bảng log còn hoạt động.
2. DELETE tạo phiên bản chết và WAL, có thể cần thêm khoảng trống tạm thời. Đừng chờ database gần đầy mới xử lý.
3. `VACUUM (ANALYZE)` thường cho phép tái sử dụng chỗ trống; không bảo đảm giảm kích thước file trên đĩa.
4. Nếu cần giảm kích thước vật lý, cân nhắc `VACUUM FULL` cho đúng bảng sau khi đo. Nó khóa bảng và cần dung lượng để viết lại bảng/index; chạy ngoài transaction purge, trong cửa sổ bảo trì và có giới hạn chờ khóa. Chưa đề xuất chạy tự động hàng tháng hoặc cho mọi bảng.
5. Đo lại database/index/TOAST, dead tuples và trạng thái WAL/replication. Dung lượng database khác dung lượng disk cấp phát và khác Storage; giảm dữ liệu không mặc nhiên hạ dung lượng đĩa đã cấp phát/chi phí.

Kiểm tra trực tiếp `storage.buckets` và `storage.objects` hiện trả về 0: không có object Storage để dọn ở thời điểm kiểm tra. File đã xuất ra ngoài hoặc ở dịch vụ khác không thuộc kết quả này. Nếu sau này có file Storage, phải xóa bằng API Storage phù hợp; không DELETE trực tiếp metadata rồi cho rằng object đã được xóa.

## Thứ tự thực hiện được khuyến nghị

1. **Kiểm kê chỉ đọc production: đã thực hiện.** Đã đối chiếu schema/trigger/function, đo dung lượng, kiểm tra số dư và các nhóm liên kết qua mốc; xem cả trang backup/PITR và Storage. Khi triển khai vẫn phải kiểm tra lại dưới khóa vì dữ liệu có thể thay đổi. File `scripts/audit-monthly-data-retention.sql` là truy vấn kiểm kê bổ trợ, không phải kế hoạch xóa tự động hoặc bằng chứng toàn bộ đồ thị đã an toàn.
2. **Triển khai checkpoint và khóa kỳ trước:** cập nhật các luồng tính lại/hiển thị/ghi, cache epoch và chống lặp; khi chưa bật xóa thì hành vi hiện tại vẫn phải đúng.
3. **Diễn tập trên dữ liệu phục hồi trong môi trường hạn chế truy cập:** kiểm tra trước/sau và cả giao dịch tiếp theo; đối chiếu quyền, số dư, lịch sử, các nguồn JSON, kho và báo cáo. Dọn môi trường diễn tập sau khi hết nhu cầu.
4. **Lần đầu chạy thủ công ngoài giờ:** chọn mốc dựa trên số liệu thực và kết quả diễn tập, Admin xem trước tập xóa, sao lưu có kiểm chứng và mã hóa, khóa ghi rồi thực thi nguyên khối.
5. **Xác minh và thu hồi dung lượng có chọn lọc:** kiểm tra API/cache/log, kiểm tra số dư, cập nhật mốc lưu giữ, sau đó mới quyết định vacuum/rewrite theo đo đạc. Có thể tự động hóa sau khi cơ chế đã ổn định; lần rà soát này không tạo automation.

## Điều kiện kiểm thử phải đạt trước production

- Từng khách giữ đúng nợ dương, 0, nợ âm; khách không ledger, khách ngừng hoạt động, từng phương thức quỹ và từng SKU đều giữ đúng số dư.
- Ghi mới một đơn, thu nợ chuyển kỳ, trả trước và hủy/sửa giao dịch còn giữ sau purge phải đúng, không chỉ kiểm tra ngay lúc xóa.
- Đơn bị sửa/chuyển khách, điều chỉnh bị hoàn tác, phiếu nhiều lần sửa, ghi lùi ngày, sửa ngày mà giá trị 0, hủy/đảo qua mốc, trả hàng tạo tiền dư và phiếu mua tính lại đều được phủ.
- Không còn FK mồ côi; hàng chờ kho được giải quyết; purge không tự hoàn tồn hoặc làm mất lương/hoa hồng chưa chốt.
- Không tạo lại nội dung trong audit; truy vấn nguồn cũ không lộ snapshot; các cửa sổ cache và khóa theo người dùng đều bị vô hiệu hóa đúng.
- Preview cũ, hai Admin chạy cùng lúc, request lặp, timeout/đứt mạng ở thời điểm commit và khôi phục backup cũ đều có kết quả rõ ràng, không tạo lại chứng từ.
- Số dòng/tập chứng từ thực xóa khớp preview đã kiểm tra dưới khóa; bộ kiểm tra tài chính chạy bắt buộc trên tập bị ảnh hưởng, kể cả khi DELETE không kích hoạt trigger 0074 hiện tại.

## Kết quả xác minh trong lần rà soát này

Đã chạy `outputs/retention-review/verify-existing-risks.mjs` trong database PGlite ở RAM, chỉ dữ liệu giả, dùng các đoạn SQL thật của migration. Bốn rủi ro đã tái hiện: công nợ lệch do xóa theo ngày nghiệp vụ; audit chép lại nội dung đã xóa; mất số dư quỹ trước kỳ; FK kho chặn xóa đơn. SQL kiểm kê chỉ đọc cũng thực thi thành công trên schema mô phỏng với 16 kết quả lệnh.

Kết quả mô phỏng lưu tại `outputs/retention-review/synthetic-results.json`. Đây là bằng chứng tái hiện hành vi các hàm/ràng buộc đã đọc, **không phải diễn tập purge hoàn chỉnh**. Kết quả kiểm tra production thật bổ sung ở phần tiếp theo.

## Kết quả production và quyết định cụ thể

### Dung lượng lúc 09:08:57, UTC+7

Đơn vị MB thập phân, đã tính cả index/TOAST bằng `pg_total_relation_size`; tổng database bằng `pg_database_size`.

| Nhóm | Byte thực đo | MB |
|---|---:|---:|
| Toàn database | 186.789.011 | 186,79 |
| `activity_logs_archive_pre_20260804` | 66.723.840 | 66,72 |
| `audit_logs` | 28.057.600 | 28,06 |
| `activity_logs` | 24.616.960 | 24,62 |
| `orders` + `order_items` | 13.328.384 | 13,33 |
| `customer_debt_transactions` | 5.136.384 | 5,14 |
| `order_amendments` | 2.949.120 | 2,95 |
| `cashbook_transactions` | 2.260.992 | 2,26 |
| `payments` | 884.736 | 0,88 |

Ba bảng log chiếm 119.398.400 byte, khoảng 63,92% database. Không diễn giải toàn bộ dung lượng này là dữ liệu thừa có thể xóa: hai bảng log đang hoạt động chứa lịch sử trong 15 ngày gần nhất.

### Archive là mục tiêu dọn đầu tiên

- Có **19.309 dòng**, thời gian từ 02/08 đến 03/08/2026; tất cả có payload lịch sử. Trong đó **18.697 dòng thuộc module khách hàng**. Đây là dữ liệu lịch sử có ý nghĩa bảo mật dù không còn hiện trong màn hình log 15 ngày.
- Đã kiểm tra: **0 FK tham chiếu vào, 0 trigger người dùng, 0 dependency catalog dạng normal**; chỉ thấy index, constraint/default và TOAST riêng của bảng.
- Không tìm thấy hàm/view trong database tham chiếu tên bảng; không tìm thấy tham chiếu trong mã chạy ứng dụng của workspace. Không có policy cho `anon`/`authenticated` hoặc quyền SELECT của hai role này; service role/chủ database vẫn đọc được. Không có trong Realtime publication đã kiểm tra.
- Hàm dọn log hiện tại chỉ nhắm `audit_logs` và `activity_logs`, **không dọn archive**. Archive không tự mất theo thời hạn 15 ngày.

**Đề xuất thao tác ở giai đoạn triển khai, chưa thực hiện:** sau backup có kiểm chứng và kiểm tra lại dependency, làm rỗng chính xác bảng archive bằng `TRUNCATE ONLY ... RESTRICT`, trong transaction ngắn có thời hạn chờ khóa, giữ cấu trúc bảng và không dùng CASCADE. Cách này tránh ghi DELETE audit từng dòng và thu hồi phần lớn dung lượng cấp phát của bảng/index/TOAST mà không cần VACUUM FULL cho bảng đó. Cần kiểm tra lại rằng không có ON TRUNCATE trigger/dependency mới trước khi chạy. Bản ghi công việc chỉ lưu thống kê, không sao chép lại payload archive.

Đây là lựa chọn ít rủi ro nghiệp vụ hơn chuyển kỳ công nợ: không cần đụng tới khách hàng, đơn, phiếu thu, ledger hay tồn kho. Không khẳng định có thể kiểm kê mọi script hoặc công cụ ngoài database/workspace đang đọc archive; nếu có tích hợp ngoài thì phải xác nhận phạm vi đó trước.

### Nhật ký đang hoạt động

- Hàm production đúng là thời hạn **15 ngày**, có trigger dọn sau INSERT. Không tìm thấy cron chuyên dọn audit/activity/archive; hai cron hiện thấy là dọn đơn nháp và retry đồng bộ kho.
- Khi kiểm tra không có dòng log đang hoạt động quá hạn 15 ngày. Vì vậy **chạy lại DELETE quá hạn ngay lúc này gần như không giải phóng thêm dữ liệu sống**.
- Hai bảng đang dùng khoảng 22,03 MB index. Nhiều index có lượt sử dụng thực, không được gỡ hàng loạt chỉ vì lớn.
- Tổng kích thước nội dung dòng tại một truy vấn trước snapshot cuối: audit 13,92 MB, activity 8,81 MB. Đây không phải kích thước sau VACUUM FULL, cũng không phải phép đo bloat chính xác.
- Nên thêm lịch dọn độc lập hằng ngày cho thời hạn hiện có; tiếp tục giới hạn payload, không tạo archive đầy đủ mới. Chỉ rewrite/reindex chọn lọc sau khi đo nhu cầu và chuẩn bị thời gian khóa. Không TRUNCATE hai bảng log đang dùng chỉ để lấy lại dung lượng.

### Công nợ và liên kết qua kỳ

- **1.747 khách**, **1.358 khách có ledger**; **0 lệch số dư tổng theo công thức 0074**, **0 dòng sai phép tính trước + phát sinh = sau**. Đây không phải chứng minh mọi chứng từ nguồn đều đúng, nhưng loại trừ các sai lệch đang xét cho cơ chế chuyển kỳ.
- Có **354 khách nợ âm/tiền dư**, phải giữ nguyên dấu. Không có khách không ledger mà có dư nợ khác 0 ở truy vấn kiểm tra trước snapshot cuối.
- Không tìm thấy chuỗi công nợ mồ côi, chi tiết đơn mồ côi, tham chiếu ledger sang đơn/phiếu thu không tồn tại trong các truy vấn đã chạy. Công nợ nhà cung cấp cũng không lệch công thức hiện tại.
- `customers.debt_history` trong database hiện có **0 hồ sơ chứa lịch sử khác mảng rỗng**; đây chưa phải nguồn dữ liệu lớn cần dọn. Cache trình duyệt vẫn là vấn đề riêng.

| Trường hợp | Xóa trước 01/09 | Xóa trước 01/10 |
|---|---:|---:|
| Đơn cũ | 1.100 | 2.135 |
| Phiếu sổ quỹ cũ | 546 | 1.206 |
| Trả hàng sau mốc cho đơn trước mốc | 9 | 0 |
| Lần sửa sau mốc cho đơn trước mốc | 4 | 3 |
| Bút toán ngày nghiệp vụ cũ nhưng ghi nhận sau mốc | 33 | 12 |
| Khách có tập xóa theo ngày nghiệp vụ không phải tiền tố thứ tự ghi nhận | 13 | 3 |
| Bút toán đảo qua mốc | 4 | 3 |

Đây là số liệu kiểm tra liên kết trong một truy vấn trước snapshot cuối. Đơn/phiếu thuộc tháng hiện tại vẫn đang phát sinh. **Không thể xóa sạch trước tháng 10 bằng lọc ngày đơn giản**, ngay cả khi chỉ có 3 khách vướng thứ tự ghi nhận: vẫn cần xử lý bút toán, snapshot và các luồng hủy/sửa giữ lại. Cũng không được dùng `status='settled'` như bằng chứng đơn đã thu đủ tiền; trong ứng dụng trạng thái này còn biểu thị đơn đã chốt.

### Kho, bảo mật dữ liệu cũ và backup

- Kho tích hợp chưa kích hoạt (`activated_at` NULL, `sync_enabled=false`), chưa có movement/position. Tuy vậy còn **678 bản ghi outbox pending** ở lúc kiểm tra, chưa có lần thử; bảng cấu hình tích hợp kho ngoài có 0 dòng. Không kết luận đây là 678 giao dịch đã lỗi. Các hàng này không tham chiếu đơn trước hai mốc đã thử, nhưng vẫn là dependency thật cần đưa vào cơ chế purge cho các tháng về sau.
- `public.users` cũ còn 35 dòng, **29 trường password không rỗng**. Chỉ đếm, không đọc giá trị hoặc kết luận kiểu mã hóa. `anon` và `authenticated` hiện không có quyền SELECT; các hàm đã tìm thấy tham chiếu trực tiếp bảng này cũng không cho hai role thực thi. Đây là việc làm sạch thông tin xác thực cũ cần xử lý riêng sau kiểm tra đường Auth/trigger, không tùy tiện xóa cả bảng hoặc làm ảnh hưởng đăng nhập hiện tại.
- Trang Backups xác nhận tổ chức/project đang dùng **Free**, không có project backups được cung cấp qua tính năng đó; trang PITR yêu cầu nâng gói. Vì vậy không được dựa vào nút restore trên Supabase như phương án cứu dữ liệu của đợt xóa. Cần bản sao lưu ngoài do mình quản lý, mã hóa và diễn tập phục hồi. Không diễn giải điều này thành bảo đảm nhà cung cấp không giữ bản sao hạ tầng nào.
- Storage hiện **0 bucket, 0 object**. Không cần đưa xóa object Storage vào đợt dọn hiện tại; các file backup/Excel/PDF ngoài project vẫn cần chính sách hạn lưu riêng.
- Registry có 99 phiên bản/bản ghi, cao nhất nhóm số là 0105 nhưng không trùng hoàn toàn danh sách file trong repo. Outbox và trigger kho ngoài đang tồn tại dù registry không có các số 0085/0086. Vì thế triển khai phải đối chiếu catalog/hàm thật, không dùng riêng số phiên bản để suy luận dependency hoặc áp dụng lại migration.

### Cơ chế tốt nhất sau khi đã có số liệu thật

1. **Đợt dọn đầu:** backup ngoài có kiểm chứng, xóa nội dung đúng bảng archive 66,72 MB, giữ nguyên dữ liệu nghiệp vụ. Đối chiếu số dư trước/sau và dung lượng thực. Đây là bước ưu tiên về cả dung lượng và giảm lưu bản sao hồ sơ cũ.
2. **Duy trì log:** giữ thời hạn rõ ràng, bổ sung lịch dọn độc lập, giảm payload và kiểm tra index/rewrite khi có bằng chứng cần thiết. Không lưu archive mới vô thời hạn và không hứa thu hồi cả 52,67 MB log đang dùng.
3. **Tính năng xóa nghiệp vụ theo tháng:** thực hiện thiết kế checkpoint/khóa kỳ/cache epoch đã mô tả; preflight phải xử lý các trường hợp thực tế trong bảng trên. Mọi công nợ, kể cả tiền dư, giữ nguyên; không reset khách, mã đơn hoặc quỹ. Diễn tập và kiểm tra giao dịch tiếp theo trước khi xóa production.
4. **Loại bỏ bản sao theo cùng tập chứng từ:** amendment, nhật ký mới chứa chứng từ cũ và cache phải cùng tuân theo mốc purge. Bản sao lưu phục hồi có thời hạn giữ và quy trình áp dụng lại purge khi restore.

Chưa thực hiện bất cứ bước xóa, tạo lịch hay bảo trì ghi nào trong danh sách này. Không cần chuyển project hoặc sửa toàn bộ mô hình đơn hàng để đạt được khoản giảm dung lượng ưu tiên từ archive.

## Tài liệu đối chiếu

- [PostgreSQL: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html): MVCC, tái sử dụng chỗ trống, khóa/dung lượng cần cho VACUUM FULL.
- [PostgreSQL 17: TRUNCATE](https://www.postgresql.org/docs/17/sql-truncate.html): thu hồi dung lượng trực tiếp, khóa bảng, ONLY/RESTRICT, trigger và khả năng rollback trước commit.
- [Supabase: Deleting data and dropping objects safely](https://supabase.com/docs/guides/database/postgres/data-deletion): kiểm tra dependency, staging, backup, giới hạn thời gian khóa và thu hồi chỗ trống.
- [Supabase: Understanding Database and Disk Size](https://supabase.com/docs/guides/platform/database-size): database, index, WAL và kích thước đĩa là các đại lượng khác nhau.
- [Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups): backup/PITR và object Storage có vòng đời/phạm vi riêng.
