# Lịch sử hàng cấp đại lý

Phiên bản: migration 0114, frontend `20261027-support-v3`.

## Cách dùng

1. Admin vào **Cấu hình → Giữ lịch sử hàng cấp đại lý**. Quạt màu/ấm chén được đánh dấu gợi ý ở lần đầu. Kiểm tra đúng SKU, hãng và công ty; tìm thêm các mặt hàng muốn giữ.
2. Bấm **Lưu danh sách và xác nhận**. Lựa chọn được giữ khi tìm kiếm/đổi trang; mỗi lần lưu tối đa 500 thay đổi. Có thể sửa danh sách sau này. Hệ thống chặn tạo lần dọn khi danh sách chưa được xác nhận.
3. Mở hồ sơ khách để xem **Lịch sử hàng cấp**: ngày, sản phẩm, hãng/công ty, số lượng, số đã trả và trạng thái. Có tổng theo SKU và phân trang.
4. Chốt đơn như hiện tại. Khi dọn dữ liệu cũ, hệ thống tự giữ phần thông tin tối thiểu của SKU đã chọn trong cùng giao dịch. Không phải lập thêm phiếu hỗ trợ hay duyệt chương trình.

## Thông tin được giữ

Khách được tham chiếu bằng ID; SKU có ID riêng, mã/tên/đơn vị tại thời điểm lưu, hãng/công ty; số lượng, lượng trả đã liên kết, ngày nghiệp vụ và trạng thái đơn hủy. Một dấu băm nguồn giúp chống trùng khi thử lại. Không giữ giá, giá vốn, dòng hàng khác, ghi chú đơn, nội dung hóa đơn hoặc bản sao điện thoại/địa chỉ.

Danh mục được chọn theo SKU, **không suy đoán bằng giá**. Mọi dòng của SKU đó được theo dõi, kể cả giá 0 đồng, giá vài đồng hoặc giá bán bình thường. Hai SKU trùng tên/mã nhưng khác hãng vẫn được phân biệt. Đây là ghi nhận theo đơn, không phải xác nhận khách đã nhận hàng thực tế.

Đơn chưa xóa được đọc trực tiếp; dòng đã xóa được đọc từ bản lưu nhỏ. Tổng không cộng trùng hai nguồn. Đơn hủy còn tra được nhưng không cộng vào tổng cấp hiệu lực. Bỏ chọn SKU ngừng theo dõi nguồn chưa lưu/những lần dọn sau; bản đã lưu vẫn còn. Phải chọn SKU trước khi xóa nguồn; không thể dựng lại số lượng từ công nợ/doanh số sau đó.

## Trả hàng qua kỳ

Số trả là số đã liên kết trên đơn gốc. Phiếu trả còn lưu nhưng đơn gốc đã xóa giữ một liên kết nội bộ tới bản lưu hàng cấp; hủy phiếu trả đó cập nhật lượng trả trong cùng giao dịch. Khi phiếu trả cũng thuộc kỳ xóa, số lượng đã ghi nhận được giữ trong bản lưu.

Phiếu trả độc lập không tự được gán vào lần cấp cũ. Hàng 0 đồng không được đưa vào phiếu trả tài chính chỉ để tạo bút toán tiền. Chức năng này phục vụ tra cứu, không bổ sung quy trình thu hồi hàng hay hạn mức thưởng theo doanh số.

## Bảo toàn và quyền truy cập

- Lưu trước khi xóa nguồn, trong giao dịch dọn. Thiếu khách, số lượng không hợp lệ hoặc lưu thiếu sẽ chặn/rollback toàn bộ lần dọn.
- Lỗi cuối giao dịch rollback cả bản lưu, liên kết trả hàng, chứng từ, số chuyển kỳ và trạng thái job.
- Không ghi thêm công nợ, doanh số, phiếu quỹ hoặc xuất/nhập kho khi lưu lịch sử.
- Thay đổi danh sách SKU làm bản chuẩn bị cũ hết hiệu lực qua fingerprint; cần tải bản sao mới.
- Hai bảng mới được đưa vào khóa phạm vi, fingerprint và bản sao mã hóa; công cụ phục hồi hỗ trợ schema 0114. Đã diễn tập phục hồi bản có lịch sử hàng cấp và liên kết phiếu trả.
- Bảng/helper không được đọc/gọi trực tiếp từ API. Admin cấu hình; các vai trò tra khách theo quyền hiện có và bảo trì. Không lưu lịch sử hàng cấp vào localStorage; bỏ phản hồi cũ khi đổi khách, tài khoản, project hoặc phiên dữ liệu.
- Bản lưu tham chiếu khách bằng FK RESTRICT, không bị xóa theo đơn. Xóa cứng hồ sơ khách cần xử lý chính sách lịch sử riêng; không tự cascade mất dữ liệu.

Đây là ngoại lệ giữ một phần lịch sử trên Supabase ngoài hai tháng. Thời hạn giữ riêng cần theo nhu cầu tra cứu của doanh nghiệp.

## Kiểm thử và triển khai

Nhóm mới kiểm tra giá 0/giá thấp, SKU trùng mã/tên khác hãng, phân quyền/bảo trì, bản chuẩn bị cũ, đơn hủy, trả hàng qua kỳ/hủy trả, rollback, dọn kỳ tiếp theo, số lượng nguồn không hợp lệ, phản hồi giao diện đến muộn và phục hồi file mã hóa.

Chạy `npm run test:retention`; bộ kiểm thử đầy đủ gần nhất: **687 qua, 2 bỏ qua, 0 lỗi**. Schema legacy và toàn bộ installer dạng CRLF cũng được kiểm tra.

Đích đã có 0106–0113 chỉ áp dụng 0114; không chạy lại nhóm cũ. `scripts/build-retention-upgrade.mjs` tạo installer 0106–0114 cho đích chưa có cả nhóm. Cài đặt không gọi dọn hoặc tạo file phục hồi.
