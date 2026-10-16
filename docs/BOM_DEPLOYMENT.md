# BOM hai công đoạn trong kho tích hợp

Ngày 16/10/2026: thêm BOM phiên bản `0092`. Luồng nghiệp vụ là nhập nguyên liệu
và bao bì → sản xuất bán thành phẩm → đóng gói thành SKU trong `products` → bán
hàng theo SKU. BOM không tự kích hoạt khi chạy migration; chưa có công thức,
vật tư hay lệnh sản xuất nào được tạo trên production.

Đã áp dụng `0092` trên staging `ncyaatorabwoxzozvyre`, chạy fixture hai công đoạn
và xác nhận rollback để lại 0 vật tư, 0 phiên bản, 0 lệnh. Sau khi tạo dump
production tại `D:\Desktop\soviet-backups\20261016-before-0092`, đối chiếu SHA-256
cho cả ba file và đọc được 1.324 mục trong archive, đã áp dụng cùng migration
trên SoViet `coebrkerpcgwckkwxlfo`. Kiểm tra sau chạy: registry có `0092`, 7/7
bảng BOM bật RLS, đủ 6 RPC, vật tư và lệnh vẫn bằng 0. Đơn/sản phẩm có thể tăng
do người dùng đang làm việc trong lúc triển khai; migration không cập nhật các
bảng đơn hoặc sản phẩm.

## Cấu trúc và quy tắc

- `bom_items` chứa nguyên liệu (`raw`), bao bì (`packaging`) và bán thành phẩm
  (`semi`). Mỗi vật tư có đơn vị gốc, đơn vị mua và hệ số `purchase_to_base`.
  Số tồn và định mức luôn lưu bằng **đơn vị gốc**, tối đa 4 chữ số thập phân.
  Đơn vị gốc/hệ số bị khóa sau khi vật tư xuất hiện trong BOM hoặc ledger.
- `bom_versions` và `bom_lines` giữ bản nháp, bản đang áp dụng và các bản đã
  thay thế. Mỗi đầu ra có tối đa một nháp và một bản đang áp dụng. Công đoạn 1
  chỉ nhận nguyên liệu, xuất bán thành phẩm; công đoạn 2 dùng bán thành phẩm
  và bao bì, xuất một SKU đang hoạt động. Sửa công thức đã áp dụng tạo phiên bản
  mới; lệnh cũ giữ snapshot định mức và phiên bản đã dùng.
- `rpc_bom_run` kiểm tra tồn từng thành phần và ghi giảm đầu vào, tăng đầu ra
  trong cùng transaction. Nếu thiếu tồn, sai định mức hoặc quá 4 chữ số thập
  phân, toàn bộ lệnh rollback. `requestKey` chống ghi trùng khi thử lại. Ledger
  SKU dùng `inventory_movements` hiện có với `kind='production'`; bán hàng tiếp
  tục trừ SKU như trước. Không tự trừ nguyên liệu khi bán hàng.
- Admin cấu hình và áp dụng BOM. Admin/Kế toán ghi phiếu vật tư và lệnh sản
  xuất. Sale/anon không đọc hoặc ghi qua các bảng/RPC BOM. Tất cả bảng bật RLS
  và thu hồi quyền truy cập bảng trực tiếp.
- Công thức/nguyên liệu/sản xuất cũ trong `goods.js` không được nhập tự động
  hoặc nối lại với kho tích hợp. Trước khi nhập BOM thật, xuất danh sách cũ và
  đối chiếu mã, đơn vị, hệ số, tồn thực tế; nhập từng công thức đã kiểm duyệt.

## Ngân sách Free

Trang BOM chỉ tải khi mở từ Quản lý kho. Mỗi trang tối đa 15 dòng (RPC cho phép
1–30); tìm kiếm chạy trên server và phân trang bằng cursor. Chi tiết chỉ tải
khi mở một công thức. Không polling, cron, Realtime hoặc upload tệp.

`rpc_bom_window` giới hạn phản hồi 32 KiB và cộng `2 × bytes JSON + 8.192` vào
**cùng** `inventory_control.read_budget_used` 400 MB/chu kỳ đang dùng cho kho.
Mỗi RPC ghi cộng dự phòng 8.704 byte. Storage guard gộp các bảng SKU và BOM,
dừng ghi khi module đạt 63,9 MB hoặc database đạt 399 MB. Số `Kho` trên giao
diện bao gồm cả bảng BOM sau `0092`. Đây là bộ đếm bảo thủ của module, không
thay thế Usage thực tế của Supabase. Theo [tài liệu Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase),
Free hiện có 5 GB egress cho cả tổ chức và 500 MB database mỗi dự án; cần đo
Usage thực tế sau triển khai và sau mỗi chu kỳ.

## Trình tự triển khai

1. Xác nhận production đã có `0088`, `0089`, `0091`. Không chạy lại migration cũ.
   Sao lưu toàn bộ production và kiểm tra checksum/archive trước khi nâng cấp.
2. Chạy `migrations/0092_bom_two_stage.sql` trên staging
   `ncyaatorabwoxzozvyre`. Trên staging trống, chạy riêng
   `migrations/tests/0092_bom_two_stage_integration.sql`; fixture tạo dữ liệu
   giả trong transaction, kiểm tra hai công đoạn/rollback/retry/tìm kiếm và
   kết thúc bằng `ROLLBACK`.
3. Kiểm tra staging qua giao diện với Admin, Kế toán và Sale: tạo vật tư, nhập
   kho theo đơn vị mua, lưu/áp dụng BOM, sản xuất, thiếu tồn, phiên bản mới,
   bán/hoàn/hủy SKU, logout và tải lại. Đối chiếu số dòng/tồn sau fixture = 0.
4. Đo egress và database trên staging, đánh giá phần dự phòng Free. Chỉ khi
   các kiểm tra đạt mới chạy `0092` trên production. Sau migration, xác minh
   registry, RLS, RPC và số đơn/SKU trước-sau. Sau đó mới phát hành frontend.
5. Nhập BOM và tồn vật tư thật từng đợt sau khi đối chiếu dữ liệu cũ. Không
   nhập lại SKU thành phẩm bằng phiếu kho nếu đã cộng từ lệnh sản xuất.

Rollback khi chưa tạo BOM thật: khôi phục bản dump tương thích Supabase nếu cần;
không chạy `DROP TABLE` tùy tiện. Khi đã có lệnh sản xuất, giữ nguyên ledger và
phiên bản; có thể ngừng dùng màn BOM/frontend trong khi điều tra, không xóa lịch
sử hoặc sửa trực tiếp tồn. Migration chỉ thêm schema và mở rộng loại movement,
không sửa đơn hoặc tồn SKU cũ khi áp dụng.
