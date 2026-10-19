# Rà soát tìm sản phẩm khi lập đơn — 19/10/2026

## Kết luận từ production

Dự án `coebrkerpcgwckkwxlfo` đã có 0090, 0095 và 0096. Có 1.072 dòng sản
phẩm, trong đó 1.015 SKU đang bán. Không có SKU đang bán nào chỉ có
`packaging_name` mà thiếu `package_type`; lỗi bao bì trước đó không giải thích
trường hợp production này. RPC tìm mã, tên và tải quy cách trả kết quả khi
chạy dưới quyền một profile Sale đang hoạt động.

Đã tái hiện trên website: chọn khách có nhãn **NANO10 MB**, tìm **Sơn lót**,
giao diện báo **Không tìm thấy sản phẩm**.

Truy vấn đọc dưới quyền Sale xác nhận:

| Dữ liệu | Kết quả |
| --- | ---: |
| SKU NANO10 MB đang bán, tên chứa Sơn lót | 35 |
| SKU trong trang RPC đầu tiên | 38 |
| COVA NANO trong trang đầu | 21 |
| MUTSUTEC NANO trong trang đầu | 17 |
| NANO10 MB trong trang đầu | 0 |
| RPC báo còn trang tiếp theo | Có |

RPC áp dụng giới hạn 40 dòng và 32 KiB trước khi giao diện lọc hãng của khách.
Giới hạn dung lượng khiến trang này chỉ còn 38 dòng. Frontend đang phát hành
ở commit `860dd8b` còn ẩn khả năng tải tiếp khi không có dòng phù hợp. Các
commit sửa phân trang đã có trong local main nhưng chưa nằm trong origin/main.
Phiên Sale thường bắt đầu với danh mục cục bộ rỗng do cơ chế lean bootstrap,
nên phụ thuộc hoàn toàn vào kết quả RPC này.

Đối chiếu thuật toán tìm kiếm, sắp xếp trên toàn bộ 1.015 SKU: không có SKU
nào bị đẩy quá dòng 40 khi nhập đúng mã đầy đủ; 32 SKU nằm sau dòng 40 khi
tìm theo tên đầy đủ. Đối chiếu này không thay thế phép thử dung lượng phản
hồi hay phiên đăng nhập thực tế của từng nhân viên.

## Bản sửa

- **0097** thêm `rpc_egress_search_invoice_products`: lọc nhãn khách và ngoại
  lệ FESTIVA trước khi giới hạn dòng/dung lượng. Tiếp tục dùng SECURITY INVOKER,
  profile đang hoạt động, RLS, cursor và giới hạn tối đa 50 dòng/32 KiB.
- Frontend gửi mã nhãn chuẩn, giữ RPC cũ làm phương án tương thích khi database
  chưa có 0097. Khi còn trang, luôn cho tải thêm kể cả trang hiện tại không có
  SKU cùng nhãn khách.
- Dùng cả tài khoản, khách và nhãn để nhận diện yêu cầu đang tìm; phản hồi cũ
  không ghi đè khi đổi khách hoặc đổi từ khóa.
- Sửa click “Tải thêm” bị hiểu nhầm là click ra ngoài do dòng vừa bấm đã bị
  render lại. Dùng đường đi ban đầu của sự kiện để giữ danh sách mở.
- Phân biệt lỗi tải/mất mạng và kết quả tìm rỗng; thông báo nhãn khách khi mã
  chỉ thuộc một hãng khác.
- Ưu tiên mã SKU phụ, mã vạch và cụm quy cách khớp đúng. Sửa kiểm thử quy cách
  `Lon 6,3` từng bị xếp sau mã `BA-46-LON` có trọng lượng 5,3 kg do khớp các
  chữ số rời ở nhiều trường.
- Giữ tương thích bao bì của 0096 và đổi toàn bộ URL module sang
  `20261019-invoice-product-search-v1` để trình duyệt tải cùng một phiên bản.

## Kiểm thử đã hoàn thành

**61 kiểm thử liên quan đã qua:** 9 kiểm thử database bằng PGlite và 52 kiểm
thử ứng dụng, pricing, bootstrap, chọn lại khách, cache và import singleton.
Kiểm tra cú pháp JavaScript và `git diff --check` cũng đã qua.

Các trường hợp database gồm: lọc nhãn trước trang đầu, FESTIVA, tên không dấu
và đảo từ, mã phụ/mã vạch, bao bì dự phòng, tìm sau dòng 1.000, cursor qua
nhiều trang, phản hồi dài tiếng Việt dưới 32 KiB, anonymous và tài khoản bị khóa.

Đã thử trình duyệt bằng dữ liệu tổng hợp, phiên Sale, danh mục cục bộ **0 SKU**:
tìm theo tên → chọn dòng → mở đủ Lon/Thùng → thêm đúng SKU và giá; mã không
dấu/chữ thường; đổi hãng khách; database chỉ có 0096 → tải thêm; mất mạng.
Không có lỗi console trong các bước này. Bộ dựng thử dùng client mẫu, không
kết nối database thật và không có nút lưu đơn.

Lệnh chạy:

```powershell
node --experimental-default-type=module --test tests/egress-bounded-lookup-database.test.mjs tests/invoice-product-lookup.test.mjs tests/product-catalog.test.mjs tests/module-singleton-regression.test.mjs tests/egress-optimization.test.mjs tests/sale-pricing-bootstrap.test.mjs tests/pricing.test.mjs tests/invoice-customer-reselection.test.mjs tests/conditional-pricing-snapshot.test.mjs
node scripts/invoice-search-preview.mjs
```

## Phát hành

1. Áp dụng `migrations/0097_invoice_product_brand_search.sql` sau 0096.
2. Chạy `scripts/audit-invoice-product-search.sql` để đối chiếu RPC cũ/mới dưới
   quyền Sale trên dữ liệu thật; truy vấn kết thúc bằng ROLLBACK.
3. Phát hành frontend `20261019-invoice-product-search-v1`, tải lại trang và
   thử lại khách NANO10 MB với “Sơn lót”, mã `NT-Đ1-THUNG`, quy cách và giá.

Chỉ chạy 0097 sẽ chưa sửa giao diện cũ vì nó vẫn gọi RPC cũ. Khi chưa phát
hành, không mô tả lỗi trên website là đã được khắc phục hoàn toàn.
