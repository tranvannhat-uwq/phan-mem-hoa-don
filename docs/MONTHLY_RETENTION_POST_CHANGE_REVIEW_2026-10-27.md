# Kiểm tra xóa dữ liệu theo tháng sau các thay đổi chức năng

Ngày rà soát: 27/10/2026, UTC+7. Mã ứng dụng: `dcfecc3`; có cập nhật một kỳ vọng kiểm thử cũ trong lần rà soát này.

## Kết luận và phạm vi bằng chứng

**Chưa phát hiện hồi quy của chức năng xóa tháng trong mã nguồn và database thử nghiệm đã áp dụng migration đến 0117. Hai commit tách trang nhận hàng trả và bỏ trả hàng khỏi lịch sử đơn không thay SQL purge, các RPC dọn dữ liệu, bộ mã hóa bản sao hoặc cơ chế chuyển kỳ.**

**Đã kiểm tra trực tiếp Supabase SoViet production sau khi người dùng mở SQL Editor trong trình duyệt tích hợp.** Các truy vấn mới chạy bằng `BEGIN ... READ ONLY` và kết thúc `ROLLBACK`, lúc 15:53–15:57 ngày 27/10/2026 UTC+7. Trước đó công cụ không đọc được URL Opera; giới hạn truy cập đó đã được giải quyết bằng trình duyệt tích hợp. Các bài thử thực thi xóa/phục hồi bên dưới vẫn chỉ chạy trên PostgreSQL/PGlite cục bộ với dữ liệu giả.

Không bật bảo trì, tạo job/bản sao, chạy migration hoặc xóa dữ liệu trên production. Có thực thi xóa, hủy và phục hồi trên database thử nghiệm trong bộ kiểm thử.

## Kết quả trực tiếp trên production

**Mã và triển khai khớp; lần dọn tháng hiện bị chặn bởi 4 đơn cũ chưa gắn hồ sơ khách, thuộc phạm vi giữ lịch sử hàng cấp.**

| Kiểm tra | Kết quả production lúc 15:54:38 UTC+7 |
|---|---|
| Migration | Đủ 0106–0117; không thiếu 0115–0117 như nghi vấn từ catalog cũ. |
| Hợp đồng hàm | 50/50 khớp thân hàm, SECURITY DEFINER, volatility, cấu hình và quyền EXECUTE. |
| Hồ sơ và đơn | 1.750 khách; 3.268 đơn. |
| Công nợ | 0 khách lệch sổ; 0 bút toán sai phép tính; 0 NCC lệch công thức số dư. |
| Trigger | Fingerprint đúng hợp đồng đã đăng ký. |
| RPC đọc | Status/preview, dashboard, báo cáo nhân viên, sổ quỹ, trả độc lập và cấu hình SKU đều chạy được dưới quyền authenticated trong READ ONLY. |
| Phân quyền | Bảng job/lịch sử SKU và helper nội bộ không mở quyền API; anon không có quyền thực thi dọn. |
| Chuyển kỳ | Epoch 0, cutoff đã dọn null, không có job chuẩn bị/thực thi. |
| SKU | Đã xác nhận danh sách; 31 SKU được chọn. |
| Mốc dọn dự kiến | Trước 01/09/2026 UTC+7. Preview dự kiến 1.100 đơn, 6 phiếu trả, 546 chứng từ quỹ, 528 thanh toán, 3.224 bút toán, 1 phiếu mua, 19.309 nhật ký archive; giữ 50 dòng lịch sử hàng cấp. Đây là số đếm kế hoạch, chưa xóa. |
| Chuẩn bị dọn | `can_prepare=false`; chỉ có một thông báo chặn về nguồn hàng cấp thiếu khách hoặc sai số lượng. |

### Nguyên nhân chính xác của điều kiện chặn

Truy vấn chỉ đọc lúc 15:55:23 xác định 4/50 dòng thuộc 4 đơn tháng 8 đều có `customer_id IS NULL`. Cả bốn dòng là **QUẠT MÀU BÉ**, số lượng 1, số đã trả 0, không có số lượng phiếu trả đang hoạt động vượt số đã trả. Không phải lỗi số lượng hoặc lỗi hủy/trả hàng vừa sửa.

| Mã đơn | Trạng thái | Dòng sản phẩm | Khách trùng tên chính xác trong danh mục |
|---|---|---|---|
| HD-20260806-00000100 | Đã chốt | item-5 | 0 |
| HD-20260810-00000239 | Đã chốt | item-1 | 1 |
| HD-20260813-00000421 | Đã chốt | item-1 | 1 |
| HD-20260822-00000806 | Đã hủy | item-1 | 0 |

Đọc thêm lúc 15:56:28: cả bốn đơn có tên khách trong snapshot nhưng thiếu liên kết hồ sơ; tổng phải trả bằng 0. Hai đơn có một hồ sơ trùng tên chính xác, hai đơn không có; chỉ khớp tên chưa đủ để tự gán khách. Không tìm thấy dòng hàng cấp thiếu khách ở tháng khác trong tập nguồn đang kiểm tra.

Migration 0114 yêu cầu mọi dòng được lưu lịch sử đại lý phải có khách vì bảng `dealer_support_history.customer_id` có NOT NULL/FK. Kiểm tra này bao gồm cả đơn đã hủy để lưu đúng lịch sử cấp/hủy. Vì vậy tính năng giữ lịch sử SKU đang ngăn dọn toàn kỳ khi gặp các đơn cũ này. Hai thay đổi giao diện trả hàng không tạo ra hay sửa những liên kết đó.

**Cách xử lý cần đối soát:** xác định khách nhận đúng của từng đơn nếu đây là hàng cấp đại lý, rồi mới xem xét sửa liên kết bằng luồng đã kiểm chứng. Nếu là đơn khách lẻ thực sự không có hồ sơ, cần thống nhất cách lưu lịch sử loại đơn đó trước khi sửa quy tắc. Không tự gán theo tên, bỏ chọn SKU hoặc tắt guard để ép dọn. Lần rà soát này không sửa bốn đơn và không thay điều kiện chặn.

Chứng cứ mới trong `outputs/retention-review/`:

- `post-navigation-production-contract.json`
- `post-navigation-production-smoke.json`
- `post-navigation-production-support-blockers.json`
- `post-navigation-production-blocker-context.json`
- `post-navigation-production-summary.json` và `post-navigation-production-summary.png`: chạy lại đối chiếu tổng hợp lúc 15:57:42 UTC+7, vẫn 50 hàm không khác biệt, không lệch sổ và đang bị chặn.

## Các thay đổi đã đối chiếu

| Thay đổi | Quan hệ với xóa tháng | Kết quả rà soát |
|---|---|---|
| Tách Nhận hàng trả thành trang riêng | Chuyển vị trí DOM và nhánh render, tải sản phẩm/khách, giữ quyền Admin/Kế toán | Không thay cách lưu `sales_returns`, sổ nợ, kho hay RPC nhận/hủy trả. |
| Bỏ trả hàng trong Lịch sử đơn | Gỡ nút tạo/xem/hủy phiếu và form cũ | Giữ dữ liệu phiếu đã có, bảng tra phiếu trả, tính tài chính và điều kiện chặn sửa đơn có trả hàng. Không xóa hàm in đang được trang riêng sử dụng. |
| Xuất Excel nhà cung cấp | Đọc và xuất dữ liệu giao diện | Không có thay đổi SQL dọn dữ liệu. |
| 0114 — Giữ lịch sử hàng cấp đại lý | Có thay đổi luồng purge | Lưu số lượng SKU được chọn trước khi bỏ đơn nguồn; giữ liên kết đảo số lượng khi hủy trả. Chưa xác nhận chọn SKU thì chủ động chặn chuẩn bị dọn. |
| 0115 — Nhập số dư khách | Liên quan số dư và ngày gần nhất sau khi đơn cũ đã xóa | Dữ liệu nhập thiếu/null/rỗng giữ giá trị trước đó. Kiểm thử nhập lại, số 0 rõ ràng và số dư có dấu đều đạt. |
| 0116 — Sửa thu chi và quyền helper | Liên quan chứng từ còn giữ sau chuyển kỳ | Giữ bút toán điều chỉnh; sửa/hủy thu tiền còn giữ không ăn vào số chuyển kỳ cũ. Không đổi thân trigger hay SQL purge. |
| 0117 — Phân trang báo cáo nhân viên | Liên quan báo cáo sau khi xóa nguồn | Giữ số mở kỳ theo công ty, trả hàng độc lập/qua kỳ và biểu đồ; kiểm thử nâng cấp từ báo cáo legacy CRLF rồi purge đạt. |

Lưu ý về thao tác với phiếu cũ: trang riêng hiện liệt kê `source_kind='independent'`. Phiếu cũ còn gắn đơn không có nút quản lý trong lịch sử nữa theo yêu cầu giao diện. Khi purge tách một phiếu còn giữ khỏi đơn nguồn bị xóa, SQL chuyển phiếu đó thành độc lập và trang riêng sẽ liệt kê được. Điều này không thay giá trị phiếu hay công nợ.

## Kiểm tra database và tính toàn vẹn

Đã đọc luồng SQL 0106–0117 và thực thi bộ kiểm thử trên database dựng từ các migration hiện tại:

| Nhóm | Đã kiểm tra |
|---|---|
| Mốc xóa | Giữ tháng hiện tại và tháng trước theo UTC+7, kể cả qua năm và sát nửa đêm. Tại 27/10/2026, mốc xóa là trước 01/09/2026. |
| Hồ sơ và công nợ | So toàn bộ trường hiện tại của khách trừ mảng lịch sử cần dọn; số dư có dấu, doanh số lũy kế và các baseline không bị tính lại từ đơn còn giữ. Sổ lệch hoặc bút toán sai phép tính chặn dọn. |
| Số mở kỳ | Cộng đúng bút toán thực sự bị xóa vào số mở, kể cả ngày lùi và thứ tự ghi sổ không liên tục; giữ công nợ theo công ty và tổng thu tiền. |
| Trả hàng qua kỳ | Phiếu còn giữ được tách nguồn và giữ giá trị; nhận trả/hủy trả sau purge tiếp tục khớp sổ. Phiếu hoàn tiền lịch sử đảo đúng phần nợ và tiền ban đầu. |
| Kho | Tồn hiện tại được so trước/sau; nhận trả/hủy trả nguyên tử, thiếu tồn thì từ chối toàn bộ. Đơn cũ chờ đồng bộ kho hoặc liên kết kho qua kỳ chưa được hỗ trợ chặn dọn. |
| Nhà cung cấp và quỹ | Giữ số cuối NCC, số mua/đã thanh toán chuyển kỳ và phép tính sau thanh toán mới; tiền mặt/ngân hàng/ví không đổi tổng. |
| Dữ liệu phụ | Xử lý liên kết thanh toán, bút toán đảo, bản sửa, hoa hồng; loại bản sao lịch sử nhúng trong nhật ký; kiểm tra archive và lịch sử SKU. |
| Transaction | Sai hash/xác nhận, bản sao cũ, dữ liệu đổi sau sao lưu, thiếu quyền/bảo trì, FK/trigger chưa hỗ trợ đều bị chặn. Lỗi cuối transaction rollback cả xóa, checkpoint, archive và job. |
| Request và phiên | Gửi lại job hoàn tất không xóa lần hai; epoch cũ bị từ chối; cache tài chính được dọn và ứng dụng tải lại sau chuyển kỳ. |
| Sao lưu/phục hồi | Mã hóa/giải mã và SHA-256, sai mật khẩu/file/job, phục hồi vào đích trống cùng schema; từ chối đích đã có dữ liệu. |
| RPC chỉ đọc | Dashboard, báo cáo, sổ quỹ và danh sách trả độc lập chạy được trong `READ ONLY` trước/sau purge dưới quyền ứng dụng. |

## Kết quả kiểm thử chạy mới

- `npm run test:retention`: **47 đạt, 0 lỗi**.
- Toàn bộ `tests/*.test.mjs`, `--test-concurrency=1`: **697 đạt, 2 bỏ qua, 0 lỗi** trong 699 ca. Hai ca bỏ qua do mã mobile-app không nằm trong checkout này.
- Lần chạy toàn bộ đầu tiên phát hiện một kiểm thử còn yêu cầu `history-return-btn`, trái với yêu cầu vừa gỡ nút. Đã cập nhật kỳ vọng trong `tests/history-expandable-rows.test.mjs` rồi chạy lại toàn bộ; không phải lỗi SQL purge.
- Bộ SQL audit mới chạy nguyên file trong `READ ONLY` trên PGlite: **50 hàm khớp**, đủ migration 0106–0117, không lệch công nợ, fingerprint dữ liệu trước/sau giữ nguyên; các RPC đọc và kiểm tra quyền riêng tư đạt.
- Đã chạy SQL audit trên bản thử nghiệm legacy qua 0114: dùng hai thân hàm đã lưu từ cloud và dựng lại báo cáo legacy có hash khớp catalog. SQL phát hiện đúng ba migration còn thiếu, ba thân hàm khác biệt và quyền API cũ của trigger; dữ liệu trước/sau không đổi. Đây vẫn là mô phỏng cục bộ, không phải kết quả production mới.

Chứng cứ cục bộ, được Git bỏ qua:

- `outputs/retention-review/post-navigation-full-tests-final.log`
- `outputs/retention-review/post-navigation-audit-sql-verification.json`
- `outputs/retention-review/post-navigation-audit-legacy-sql-verification.json`
- `outputs/retention-review/post-navigation-saved-catalog-comparison.json`

## Đối chiếu catalog production đã lưu trước đây

Đã so 50 hợp đồng hàm hiện tại với file catalog production có thời điểm kiểm tra **10:31:47 ngày 27/10/2026 UTC+7**. So nội dung thân hàm đã bỏ CR, SECURITY DEFINER, volatility, search_path/timeout và quyền EXECUTE của authenticated/anon.

- **47/50 khớp**, gồm luồng purge, khóa/epoch, chuyển số dư, nhận/hủy trả độc lập và lịch sử SKU.
- Ba khác biệt là `rpc_import_customer_financial_baselines(jsonb)`, `rpc_amend_cashbook_transaction(text,jsonb)` và `rpc_get_employee_business_report(jsonb)`, đúng ba hàm được migration 0115–0117 sửa.
- Catalog đã lưu có 0106–0114 nhưng chưa có 0115–0117. Đây là bằng chứng tại thời điểm lưu, **không chứng minh production hiện tại vẫn thiếu ba migration đó**.
- File `database-fixes-exact-cloud-rehearsal.json` là diễn tập trên dữ liệu giả với thân hàm đã lấy từ cloud; trường `mode=INSTALLED` trong file đó không phải bằng chứng đã cài production.

## SQL dùng để kiểm tra lại production

Chạy nguyên file **`scripts/audit-retention-after-feature-changes.sql`** trong SQL Editor của đúng project Supabase, bằng phiên owner tin cậy. File dùng `BEGIN ... READ ONLY` và `ROLLBACK`, chỉ trả metadata/số đếm tổng hợp. Nó không gọi prepare, execute, bật bảo trì hay cài migration. Hai thiết lập JWT/header và ROLE chỉ tồn tại trong transaction để thử quyền đọc của ứng dụng.

Ba nhóm kết quả:

1. `retention_current_assessment`: phiên bản đã cài, mốc ngày, job, số lệch sổ, hợp đồng trigger, lựa chọn SKU và các điều kiện đang chặn.
2. `retention_function_contract`: đối chiếu đủ 50 hàm với bản đã kiểm thử. `differences=[]` là khớp; mọi khác biệt cần đọc và giải thích trước khi dùng để kết luận.
3. `retention_application_smoke`: RPC đọc chạy được dưới quyền ứng dụng; bảng job/lịch sử SKU và helper nội bộ không bị mở quyền API.

Nếu lỗi hoặc timeout, thực hiện `ROLLBACK`; không bỏ `READ ONLY` để ép chạy. Nếu thiếu 0115–0117, đối chiếu gói đã có trong `docs/DATABASE_AUDIT_FIXES_0115_0117.md`, không tự chạy lại toàn bộ migration cũ. Nếu danh sách SKU chưa xác nhận thì chặn chuẩn bị dọn là hành vi được thiết kế.

**Kết luận vận hành: mã nguồn, kiểm thử và 50 hợp đồng hàm trên production đều đạt. Xóa tháng hiện chưa chạy được vì 4 đơn tháng 8 thiếu liên kết khách trong phần giữ lịch sử hàng cấp; cần đối soát trường hợp này trước khi dọn. Không có dữ liệu thật nào bị sửa hoặc xóa trong lần rà soát.**
