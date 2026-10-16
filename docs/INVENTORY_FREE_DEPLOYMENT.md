# Kho tích hợp và ngân sách Supabase Free

Yêu cầu ngày 14/10/2026 bổ sung kho vào ứng dụng bán hàng. Quy định kho “ngoài
phạm vi” trong tài liệu lịch sử không áp dụng cho phần mở rộng được yêu cầu này.
Các yêu cầu xác thực, giao dịch, sao lưu và kiểm thử staging vẫn áp dụng.

## Trạng thái migration 14/10/2026

0088 đã được áp dụng vào dự án `coebrkerpcgwckkwxlfo` sau khi xử lý truy vấn
SQL Editor bị cắt ở dòng 160, giữa hàm `rpc_inventory_post`. Đã thay bằng toàn
bộ file 365 dòng, kiểm tra khớp nội dung, chạy thành công và xác minh registry
ghi `0088`, ba RPC, năm bảng bật RLS, ngân sách phản hồi 400.000.000 byte.
Kho vẫn chưa kích hoạt tự trừ tồn, balances và movements đều có 0 dòng.
Không chạy lại 0088 trên dự án này. Không có dữ liệu thử được ghi vào production;
bộ kiểm thử SQL trên Supabase staging đã qua, nhưng chưa có đủ kiểm thử giao diện
theo ba vai trò trên staging. Phát hành frontend và đối chiếu tồn đầu kỳ được
theo dõi riêng bên dưới.

Ngày 15/10 xác minh production đã ghi **0089** trong `schema_migrations`, có
`rpc_inventory_set_sync(boolean,boolean)` và cột `sync_enabled`. Sau bản sao lưu
production, `0090` đã chạy thành công; registry ghi đủ 0088–0090 và năm RPC
tìm kiếm/chi tiết/họ sản phẩm được kiểm tra hiện diện. Kho vẫn chưa kích hoạt
(`activated_at` NULL), balances và movements đều 0; migration không chạm dữ
liệu đơn. Staging `ncyaatorabwoxzozvyre` đã có 0088–0090. Không chạy lại các
migration này trên database đã có chúng.

## Bật/tắt đồng bộ theo đơn hàng

- Admin dùng nút **Bật đồng bộ kho / Tắt đồng bộ kho** ngay đầu màn hình kho.
  Kế toán vẫn thao tác phiếu kho, nhưng không đổi được trạng thái đồng bộ.
- Lần đầu cần kiểm kê tồn đầu kỳ và xác nhận đối chiếu. Migration không tự bật.
  Bật lại sau tạm dừng giữ nguyên `activated_at`; đơn trước mốc này không bị
  phát lại. Không tự sửa cột này để bật/tắt.
- Khi tắt, bán/sửa/hoàn/hủy đơn vẫn ghi tài chính bình thường. Tồn kho tạm dừng
  cập nhật từ đơn, mỗi đơn thay đổi chỉ có một dòng trong hàng đợi.
- Khi bật lại, xử lý trạng thái cuối của tối đa 50 đơn trong một transaction.
  Nếu còn đơn chờ, đồng bộ vẫn tắt, nút hiển thị số còn lại để bấm lượt tiếp.
  Khi hết hàng đợi mới bật đồng bộ tự động. Retry không trừ tồn hai lần.
- Nếu thiếu tồn, cả lượt xử lý rollback, hàng đợi giữ nguyên và đồng bộ vẫn
  tắt. Nhập bổ sung số hàng thực tế còn thiếu rồi thử lại. Không xuất kho tay
  để bù các đơn đang chờ. Kiểm kê bị chặn khi còn hàng đợi để tránh tính hai lần.
- Đơn đang được kết nối khác sửa sẽ được bỏ qua trong lượt bật lại; xử lý ở
  lượt tiếp theo. Có audit thời điểm và Admin bật/tắt. Không polling/cron.
- Khi ngân sách đọc đã hết, Admin vẫn có thể tắt bằng RPC (hoặc nút nếu màn
  hình đã tải trạng thái trước đó); thao tác tắt cộng dự phòng vào bộ đếm đến
  ngưỡng thay vì rollback. Đây là ngoại lệ phản hồi ngắn, không mở đọc dữ liệu.

## Phạm vi và dữ liệu

- Một Kho chính, dùng SKU ở `products`; không sao chép danh mục, không phục hồi
  module nguyên liệu/sản xuất cũ.
- Nhập/xuất nhiều SKU, kiểm kê số tồn thực tế, tồn tối thiểu, tìm kiếm và lịch sử.
- Admin/Kế toán thao tác; Sale không được đọc kho qua RPC hoặc bảng trực tiếp.
- Sau đối chiếu tồn đầu kỳ, Admin bật ghi nhận cho đơn mới. Chốt/sửa/hoàn/hủy
  dùng các dòng `order_items` chuẩn ở cuối transaction; thiếu tồn rollback cả
  nghiệp vụ tài chính. Retry không tạo phiếu hoặc trừ tồn hai lần.
- Đơn trước mốc bật không được phát lại. Hoàn/hủy/sửa đơn cũ phải đối chiếu và
  ghi phiếu kho riêng. Không bật khi còn giao dịch chốt đơn đang xử lý.
- Phiếu kho chỉ ghi số lượng. Phiếu mua hàng và Sổ quỹ tiếp tục ghi tài chính;
  phiếu mua không tự động cộng kho để tránh nhập hai lần.

### Giới hạn trang Tồn kho 0091

`0091_inventory_page_limit.sql` thêm bộ lọc `limit` 1–50 dòng vào RPC kho. Sau
khi chạy migration, frontend yêu cầu 15 SKU/trang cho Tồn kho; tìm kiếm vẫn lọc
toàn bộ danh mục trong PostgreSQL rồi phân trang bằng cursor. Lịch sử nhập/xuất
và các client cũ tiếp tục dùng tối đa 50 dòng/trang. SQL áp dụng giới hạn trước
khi tạo JSON nên không tải ngầm 50 dòng để chỉ hiển thị 15. RPC vẫn áp dụng giới
hạn 32 KiB và cùng ngân sách đọc 400 MB/chu kỳ. Chạy 0091 trên staging, kiểm tra
trang đầu, trang kế, tìm SKU ngoài trang đầu và vai trò; sau đó mới chạy trên
production. Không chạy lại 0088/0089/0090.

Ngày 16/10, dự án staging `ncyaatorabwoxzozvyre` đã có 0088–0090 và không có
đơn hàng, hồ sơ hay phiếu kho. Chạy 0091 thành công; fixture rollback-only
`migrations/tests/0091_inventory_page_limit_integration.sql` xác nhận 35 SKU
được phân trang 15/15/5 và tìm được SKU thứ 35. Sau ROLLBACK, số đơn, hồ sơ và
sản phẩm thử đều bằng 0; registry giữ 0091.

Production `coebrkerpcgwckkwxlfo` đã áp dụng 0091 sau khi sao lưu ngày 16/10
tại `D:\Desktop\soviet-backups\20261016-before-0091`. Bản custom dump, full SQL
và schema SQL đều có checksum SHA-256 hợp lệ; `pg_restore --list` đọc được 1.309
mục trong archive. Truy vấn sau migration xác nhận hàm có giới hạn trang, registry
có 0091, còn số đơn và sản phẩm giữ nguyên 2.769/1.071.

Bảng mới: `inventory_control`, `inventory_balances`, `inventory_documents`,
`inventory_movements`, `inventory_order_positions`, `inventory_pending_orders`
(0089). Nguồn chính là PostgreSQL;
cache kho chỉ nằm trong RAM và xóa khi đăng xuất. RLS bật, thu hồi quyền bảng
trực tiếp; RPC xác thực bằng `auth.uid()` và profile trong database.

## Dự kiến sử dụng Free

Mốc dashboard 14/10: database 0,185/0,5 GB; egress 2,965/5 GB trong chu kỳ
21/9–21/10. Dự báo egress bán hàng khoảng 3,9 GB nếu tốc độ trung bình giữ nguyên.

| Biện pháp | Ngưỡng |
|---|---|
| Một trang dữ liệu | Tối đa 50 dòng và 32 KiB JSON UTF-8 |
| Một lần xem lịch sử | Tối đa 31 ngày, phân trang theo khóa |
| Cache trang | 60 giây, tối đa 8 trang trong RAM |
| Ngân sách phản hồi RPC kho | 400 MB mỗi chu kỳ, chung tất cả người dùng |
| Cách tính đọc | 2 × số byte JSON + 8.192 byte dự phòng mỗi phản hồi |
| Metadata bật/tắt và hàng đợi | Thêm 1.024 byte/lần đọc, trong cùng ngân sách 400 MB |
| Phiếu ghi / retry / bật kho | 8.704 byte dự phòng mỗi phản hồi thành công |
| Database gần ngưỡng | Từ 399 MB dừng ghi kho |
| Riêng các bảng kho gần ngưỡng | Từ 63,9 MB dừng ghi kho |

Chu kỳ ngân sách kho bắt đầu ngày 21 theo Asia/Bangkok, khớp chu kỳ dashboard
đã kiểm tra. Nếu ngày thanh toán Supabase thay đổi cần sửa cấu hình chu kỳ trước
khi dùng dự báo này. Không có polling, cron, HTTP đồng bộ kho riêng, upload tệp
hay đăng ký Realtime cho các bảng kho.

Ví dụ 25 người × 5 trang/ngày × 30 ngày × phản hồi lớn nhất: 280,32 MB ước tính
(gồm phần metadata bật/tắt 0089).
Ngay cả khi hết ngân sách kho, mô hình tổng là 3,9 + 0,4 = **4,3 GB**, thấp hơn
5 GB và còn 0,7 GB dự phòng. Khi hết ngân sách, RPC kho trả lỗi ngắn thay vì tải
thêm; ghi phiếu cũng dừng. Khi chạm ngưỡng dung lượng, giao dịch trừ kho không
được bỏ qua âm thầm: chốt/sửa/hoàn/hủy cần dung lượng sẽ bị từ chối, giữ nguyên
dữ liệu và yêu cầu kiểm tra Usage.

Đây là ngân sách **ước tính phản hồi của module**, không phải bộ đếm egress của
Supabase. Nó không kiểm soát các module khác, Auth, bản sao lưu qua mạng, tác vụ
quản trị, retry ở tầng mạng hoặc thay đổi hạn mức nhà cung cấp. Phải kiểm tra
Usage thực tế sau staging và sau chu kỳ đầu. Không cam kết toàn hệ thống luôn
ở Free khi lượng sử dụng bán hàng tăng; cần giữ egress dự kiến dưới 4,5 GB.
Database hiện tại + ngân sách riêng kho khoảng 0,249 GB, nhưng dữ liệu bán hàng
và log cũng tiếp tục tăng. Không tự xóa log hoặc lịch sử để tiết kiệm dung lượng.

## Kiểm thử đã chạy

`npm run test:inventory`: 30 kiểm thử, gồm PostgreSQL thực trong PGlite. Một
suite áp dụng toàn bộ migration 0001–0084, 0088 và 0089, sau đó gọi RPC bán hàng thật:
chốt đơn bằng Sale, rollback khi thiếu tồn, sửa đơn, hoàn/hủy hoàn, hủy đơn và
đối chiếu công nợ/tồn. Suite còn lại kiểm tra quyền, retry, snapshot kiểm kê,
phân trang UTF-8, ngân sách đọc và cache theo phiên. Các kiểm thử 0089 bao gồm
phân quyền bật/tắt, đơn chờ chỉ một dòng, sửa/hoàn/hủy khi tắt, retry, rollback
thiếu tồn, hai lượt xử lý 52 đơn, lưu/xóa đơn nháp khi tắt, giữ mốc đầu kỳ và
tắt khi hết ngân sách đọc.

PGlite dùng Auth giả lập và một kết nối. Chưa xác nhận Supabase Auth qua HTTP,
PostgREST, áp lực nhiều kết nối đồng thời hoặc dung lượng/egress cloud sau triển
khai. Không thay thế kiểm thử trên Supabase staging.

Giao diện đã thử với dữ liệu giả lập: nhập +3, kiểm kê từ 13 xuống 8 và lịch sử
ghi +3/−5 tương ứng; lần bật đầu yêu cầu xác nhận, sau đó bật → tắt → bật lại.
Harness không kết nối Supabase.

Kiểm thử toàn dự án ngày 15/10: 568/570 qua, 0 lỗi, 2 bài bỏ qua do thiếu mã
mobile trong checkout. Staging chạy `0088_inventory_financial_integration.sql`
và `0090_bounded_lookup_integration.sql` thành công; cả hai bộ fixture đều
rollback. Sau thử nghiệm, staging không còn đơn, phiếu kho hay fixture nghiệp vụ.

Trước `0090`, sao lưu production bằng PostgreSQL 17 client gồm custom dump,
full SQL và schema SQL tại `D:\Desktop\soviet-backups\20261015-before-0090`.
Checksum của cả ba tệp và catalog 1.318 mục của archive hợp lệ. Khôi phục thử
trên PostgreSQL cục bộ lấy lại các bảng nghiệp vụ chính (2.729 đơn, 1.730 khách,
1.070 sản phẩm; không có lỗi COPY). Khôi phục toàn bộ không hoàn tất vì bản
PostgreSQL thường thiếu extension Supabase `pg_cron` và các đối tượng nền tảng;
đây không phải bản clone Supabase đầy đủ. Cần giữ archive gốc để khôi phục vào
môi trường Supabase tương thích khi cần. SQL Editor cũ giữ kết nối đã hết hạn sau
khi đổi mật khẩu; `0090` được chạy trong phiên SQL Editor mới và xác minh lại
bằng truy vấn chỉ đọc.

## Tạo staging trong Free

1. Tạo dự án Supabase Free riêng nếu tài khoản còn suất (Free tối đa hai dự án
   đang hoạt động). Người dùng tự nhập mật khẩu database; không gửi mật khẩu,
   secret key hoặc service role vào chat/mã nguồn. Dùng cùng khu vực Seoul.
2. Chạy `node scripts/build-inventory-staging.mjs` để tạo
   `outputs/inventory-staging-schema.sql`. Bundle gồm schema nghiệp vụ, kho
   `0088`, nút đồng bộ `0089`, RPC tìm kiếm giới hạn `0090`, phân trang `0091`
   và BOM `0092`. Chỉ chạy bundle
   trên dự án staging **trống**. Bundle có chốt chặn nếu đã có bảng đơn/profiles
   và không bao gồm đồng bộ kho riêng 0085–0087.
3. Chạy riêng `migrations/tests/0088_inventory_financial_integration.sql` trên
   staging. Nó chỉ nhận database không có đơn và kết thúc bằng ROLLBACK. Phải
   thấy cả kết quả `0088 inventory and financial invariants passed` và
   `0089 pause/resume invariants passed`.
4. Tạo tài khoản test qua Supabase Auth trên staging, phân quyền admin/accounting/
   sale bằng UUID chính xác. Chạy ứng dụng local với URL và publishable/anon key
   staging qua màn hình cấu hình; không dùng cấu hình live để thử phiếu/đơn.
5. Thử hai người chốt cùng SKU khi chỉ còn đủ một đơn; chỉ một giao dịch được
   chấp nhận. Thử retry cùng key, sửa/hoàn/hủy đơn và đối chiếu ledger. Kiểm tra
   Sale bị chặn RPC kho, đăng xuất xóa cache, dữ liệu trả về không quá 32 KiB.
   Với 0089: tắt, chốt/sửa/hoàn/hủy đơn, kiểm tra tồn tạm giữ nhưng công nợ đúng;
   bật lại và đối chiếu tồn. Thử hơn 50 đơn chờ, thiếu tồn khi bật lại, cấm kiểm
   kê khi có hàng đợi; Kế toán/Sale không đổi được trạng thái. Thử một người
   đang sửa đơn trong khi Admin bật lại, không deadlock hoặc mất hàng đợi. Với
   RPC `0090`, thử tìm khách/SKU có dấu và không dấu, xác minh giới hạn kết quả,
   tải chi tiết theo ID và kiểm tra dữ liệu Sale thấy tuân theo RLS.
6. Kiểm tra Usage của **All projects**: staging và production trong cùng tổ
   chức chia sẻ hạn mức egress. Staging không tạo thêm một hạn mức egress riêng.
   Sau kiểm thử, tạm dừng staging để tiết kiệm tài nguyên khi không dùng.

## Áp dụng dữ liệu thật

Production đã có `0088`/`0089`/`0090`; không chạy lại. Frontend version
`20261015-stock-sync-v1` đã được đẩy trong commit `c9971ba`; trang công khai
và các tệp JS/CSS mới trả HTTP 200, màn hình đăng nhập tải không có lỗi console.
Chưa thử một phiên đăng nhập thật sau phát hành. Migration không bật trừ kho và
không sửa số tồn/đơn lịch sử. Bản sao lưu và kết quả khôi phục cục bộ có giới
hạn nêu trên cần được lưu cùng biên bản phát hành.

Nếu đang dùng đồng bộ kho riêng, tạm dừng và đối chiếu trước khi bật kho tích
hợp. Nút bật kiểm tra trạng thái để ngăn cả hai kho cùng hoạt động. Nhập kiểm
kê cho toàn bộ SKU đang dùng, đối chiếu tồn thực tế/đơn cũ rồi mới bấm bật.

Sao lưu kho bằng **full database dump** của script backup hiện có. JSON backup
trên giao diện cũ chưa chứa ledger kho và không được dùng làm bản sao lưu duy
nhất cho kho. Không restore một phần `inventory_balances` riêng khỏi phiếu,
movement và vị trí đơn, vì sẽ làm lệch tồn.

Khi cần tạm dừng, Admin dùng **Tắt đồng bộ kho**. Giữ nguyên các bảng và trigger
để ghi hàng đợi. Không xóa lịch sử hoặc đưa `activated_at` về NULL rồi bật lại:
việc đó có thể bỏ qua các đơn đã phát sinh.
