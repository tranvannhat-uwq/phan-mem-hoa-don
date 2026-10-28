# Phân trang danh sách — 28/10/2026

## Bổ sung

| Danh sách | Cách lấy dữ liệu | Phân trang |
| --- | --- | --- |
| Báo cáo công nợ | RPC hiện có, truyền `limit`/`offset`, dùng `total` từ máy chủ | 20 / 50 / 100 dòng; đầu, trước, nhập trang, sau, cuối |
| Báo cáo trả hàng theo sản phẩm, khách hàng, nhân viên | RPC hiện có, truyền `limit`/`offset`, dùng `total` từ máy chủ | Như trên; đổi nhóm quay về trang đầu |
| Tài khoản người dùng | Chia danh sách sau khi lọc, giữ ID sửa/xóa | Như trên; STT liên tục giữa các trang |
| Hãng sơn | Chia danh sách đã tải | Như trên |
| Ma trận bảng giá | Chia SKU sau khi lọc | Như trên; giữ các giá sửa chưa lưu trong `pendingChanges` |
| Bảng lương | Chia kết quả tính từ database | Như trên; tổng lương tính trên cả kỳ, chuyển trang không gọi tính lại |
| Nhóm sản phẩm tính lương | Chia danh sách đã sắp xếp | Như trên |
| Lịch sử công nợ trong thông tin khách | Tính chuỗi số dư đầy đủ trước khi chia trang | Như trên; đổi khách hoặc ẩn/hiện điều chỉnh quay về trang đầu |
| Popup lịch sử công nợ từ báo cáo | Chia lịch sử đã tính số dư | Như trên |
| Báo cáo KPI đang hoãn | Chia kết quả RPC nếu được mở lại | Có sẵn bộ điều khiển; giữ trạng thái hoãn tính năng |

Báo cáo nhân viên đã có 25 người/trang và chi tiết 50 chứng từ/trang. Bổ sung số trang, khóa nút trong lúc tải và quay về trang hợp lệ khi số kết quả giảm. Xuất Excel lấy tiếp mọi trang, thay vì cắt ở 100 người đầu.

## Đã có phân trang

Sản phẩm, khách hàng, nhà cung cấp, lịch sử đơn hàng, sổ quỹ, phiếu mua, phiếu trả độc lập, kho, định mức/sản xuất, lịch sử hoạt động, chứng từ giữ để đối soát, cấu hình SKU hàng cấp và lịch sử hàng cấp.

## Phạm vi hiển thị

Các ô tổng hợp trên dashboard (top sản phẩm, đơn gần nhất) giữ giới hạn của ô tổng hợp. Dòng sản phẩm đang nhập trong chứng từ, bản in, chi tiết của một chứng từ và bản xem trước import không phải danh sách hồ sơ độc lập. Các hàm quản lý nguyên liệu/sản xuất cũ trong `goods.js` không còn được gọi từ trang Hàng hóa; trang này dùng danh sách phiếu mua đã phân trang.

Không cần migration database. Tổng công nợ và các tổng báo cáo vẫn lấy từ toàn bộ phạm vi lọc trên máy chủ. Không cắt dữ liệu nguồn dùng để tính tổng hoặc xuất Excel.
