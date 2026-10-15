# Kế hoạch giảm egress để vận hành trên Supabase Free

Ngày lập: 15/10/2026. Phạm vi: ứng dụng bán hàng hiện tại và kho tích hợp đang
chuẩn bị phát hành. Thực hiện năm bước dưới đây **theo thứ tự**; chỉ sang bước
sau khi đo và kiểm thử xong bước trước.

## Mốc sử dụng và mục tiêu

Dashboard Usage của tổ chức `shywczwakbduopfoavti` ngày 15/10, chu kỳ
21/9–21/10, mọi dự án: egress **2,985/5 GB (60%)**, cached egress **0/5 GB**,
database **0,186/0,5 GB (37%)**, Realtime **72.432/2.000.000 tin (4%)** và
25 MAU. Dashboard có thể trễ đến một giờ. Mốc này mô tả tổng tổ chức, chưa
chứng minh endpoint nào tiêu thụ bao nhiêu byte.

Sau sao lưu production cùng ngày, dashboard hiển thị **3,045/5 GB egress (61%)**,
**0,187/0,5 GB database**, 73.963 tin Realtime và 25 MAU. Bản dump qua kết nối
database có thể chưa phản ánh hết vì Usage trễ tối đa một giờ. Cộng dự phòng
0,15 GB cho lượt sao lưu này, tốc độ trung bình từ đầu chu kỳ khoảng 0,127
GB/ngày trong sáu ngày còn lại và trần 0,4 GB của kho cho ra dự báo bảo thủ
khoảng **4,36 GB**, dưới 5 GB. Đây là dự báo dựa trên nhịp cũ, phải đo lại khi
lưu lượng bán hàng thay đổi.

Mục tiêu vận hành: dự báo egress cuối chu kỳ **dưới 4 GB**, giữ khoảng **1 GB**
dự phòng cho biến động sử dụng và sao lưu. Ngưỡng 4 GB là mục tiêu nội bộ,
không phải hạn mức hay cảnh báo tự động của Supabase. Ngân sách 400 MB của RPC
kho chỉ giới hạn phản hồi kho do ứng dụng kiểm soát, không giới hạn các dịch vụ
khác. Theo dõi database riêng với trần Free 0,5 GB.

Baseline cần ghi cho **lần đăng nhập đầu và lần mở lại đã có cache** cho
Admin/Kế toán/Sale bằng cùng kịch bản: đăng nhập,
mở màn hình đơn, tìm khách/SKU, xem lịch sử và báo cáo, mở kho, tạm dừng/quay lại
tab. Thu **số request, byte phản hồi, thời gian và endpoint** theo vai trò; không
lưu nội dung khách hàng hoặc token. Chụp Usage tổ chức, tỷ lệ Database/Auth/
Realtime, Top Paths và khoảng thời gian đo. Đối chiếu lại cùng kịch bản sau
từng bước. Nếu cần dữ liệu mẫu lớn, dùng local PostgreSQL/PGlite và staging
riêng; giữ thử nghiệm cloud ngắn vì staging cùng tổ chức chia sẻ quota.

| Bước | Thay đổi có thứ tự | Trạng thái và điều kiện chốt |
| --- | --- | --- |
| **1. Tải lúc đăng nhập** | Bỏ tải toàn bộ sản phẩm/khách trong `leanBootstrap`. Tìm khách/SKU trên đơn dùng RPC có giới hạn 30/40 dòng, tra chi tiết theo ID và tải họ biến thể khi cần. Màn hình danh sách lớn chỉ tải khi mở. Migration `0090` giới hạn kết quả và payload, dùng keyset cursor và quyền RLS. | **Đã áp dụng `0090` trên staging và production.** Chưa chuyển toàn bộ danh sách sản phẩm/khách, lịch sử, báo cáo và xuất sang phân trang/tổng hợp server; kết quả tìm kiếm phải kiểm tra trên tập dữ liệu lớn. Chưa đo trước/sau cùng kịch bản trình duyệt. Chỉ chốt bước này sau khi kiểm tra tìm kiếm sau dòng 1.000, RLS Admin/Kế toán/Sale, chốt/sửa đơn, giá, công nợ và kho trên staging và production. |
| **2. Kiểm tra bảo trì** | Giảm nhịp nền từ 15 giây xuống 60 giây; giữ kiểm tra lúc đăng nhập, tab hiện lại, online và pageshow. Dùng Web Locks cùng timestamp theo project/tài khoản, fallback bằng localStorage lease, và BroadcastChannel để gửi trạng thái bảo trì giữa tab. | **Đã làm trong mã local; chưa đo nhiều tab và chưa xác nhận staging.** Xác minh tối đa một kiểm tra mỗi phút trên cùng thiết bị, tab ẩn không hỏi, tab chủ đóng thì tab khác tiếp tục, đổi tài khoản/mất mạng và bật bảo trì trong phiên. |
| **3. Realtime** | Đếm sự kiện theo loại trong bộ đo cục bộ. Sale không đăng ký cashbook, số dư đầu kỳ và nhóm lương. Đọc bù theo panel; tìm kiếm hóa đơn giữ truy vấn giới hạn khi kết nối lại, dashboard chỉ làm mới truy vấn tổng hợp. | **Đã giảm 3 đăng ký cho Sale và sửa đường đọc bù trong mã local.** Các vai trò vẫn đăng ký bảng theo vai trò, chưa theo panel. Bộ đếm sự kiện không đo byte WebSocket; cần so Usage Supabase và thử hai tab, ngắt mạng, tab ẩn, cập nhật quyền trước khi chốt. |
| **4. Dữ liệu mỗi phản hồi** | Đổi truy vấn nóng sang cột tóm tắt; chỉ lấy chi tiết khi mở. Lịch sử dùng lọc, thứ tự ổn định và phân trang server; xuất/sao lưu chỉ chạy theo thao tác và theo lô. | **Chưa hoàn thành.** Một số màn hình quản trị và lịch sử vẫn tải các trang đầy đủ khi mở. Cần đo cùng tác vụ trước/sau, kiểm tra không thiếu/trùng dòng và thử sao lưu/khôi phục. |
| **5. Dùng lại dữ liệu đã tải** | Cache theo tài khoản/vai trò/bộ lọc; gom request giống nhau; chỉ làm mới phạm vi vừa đổi; giữ phiên bản bảng giá và cache ngắn dashboard/kho; xóa trạng thái khi đổi tài khoản hoặc đăng xuất. | **Đã có một phần:** reset dữ liệu nghiệp vụ theo phiên, bỏ cache khách không phân vùng, giới hạn đo HTTP cục bộ. Chưa thống nhất cache và dedupe toàn ứng dụng; cần thử đổi tài khoản, dữ liệu cũ, mất mạng, giá, công nợ, tồn và quyền. |

## Nhịp vận hành sau từng bước

Mỗi ngày đối chiếu egress đã dùng với số ngày còn lại trong chu kỳ. Dự báo bằng
`đã dùng + trung bình egress 7 ngày gần nhất × số ngày còn lại`; riêng tuần đầu
dùng thêm trung bình từ đầu chu kỳ. Ở dự báo **4 GB**: xem Top Paths và nguồn
egress; ở **4,5 GB**: giảm những lượt tải nền, báo cáo và xuất tự nguyện, vẫn
giữ kiểm tra giao dịch và sao lưu cần thiết. Đánh giá lại ngưỡng khi lưu lượng
bán hàng thay đổi. Supabase Usage tính nhiều loại lưu lượng (Database, Auth,
Realtime, Storage, Functions); cached egress là hạn mức riêng.

Đo mã local bằng cách mở DevTools, chạy
`window.billingEgressMetrics.reset()` ngay trước kịch bản (ở màn hình đăng nhập
nếu đo cả login), thực hiện đúng các thao tác cần đo, chờ request xong rồi chạy
`await window.billingEgressMetrics.snapshot()`. Kết quả có tổng và tuyến HTTP,
số request, byte phản hồi ước tính/mẫu, thời gian đến response headers và lỗi;
`window.billingEgressMetrics.reset()` xóa bộ đếm trong bộ nhớ tab. Chạy cùng
kịch bản theo vai trò và phân biệt đăng nhập mới với quay lại đã có cache. Nếu
`truncatedResponses` lớn hơn 0 hoặc thiếu `Content-Length`, số byte chỉ là ước
tính dưới. Bộ đo chỉ bao phủ HTTP đi qua Supabase client của ứng dụng, không gồm
WebSocket, tệp tĩnh/CDN hoặc tab khác. `realtime.total` đếm sự kiện, không quy
đổi thành byte. Đối chiếu với Usage/Top Paths Supabase sau khi dashboard cập nhật.

Chốt từng bước bằng kiểm thử local và staging về tính đúng dữ liệu, phân quyền,
đổi phiên, dữ liệu cũ và tác vụ tài chính. Ghi số đo trước/sau, phiên bản mã,
kết quả khôi phục và vị trí rollback. Staging `ncyaatorabwoxzozvyre` đã nhận
`0090` và bộ fixture SQL tìm kiếm/ủy quyền đã qua, với ROLLBACK. Production đã
có `0088`/`0089`/`0090`; frontend mới đang chờ phát hành. Kiểm thử
local toàn dự án đạt 568/570, không lỗi, 2 bài mobile bỏ qua vì checkout thiếu
mã tương ứng. Chưa có số đo trước/sau cùng kịch bản qua trình duyệt production;
phải dùng bộ đo cục bộ và đối chiếu Supabase Usage sau phát hành. Không dùng dữ
liệu khách hàng thật làm fixture.
Khi chuyển bước 1/4, cập nhật những kiểm thử cũ vốn đang giả định tải hết bảng
thành kiểm thử kết quả đúng qua nhiều trang; giữ kiểm thử cache bảng giá theo
phiên bản hiện có.

Các điểm bắt đầu trong mã: `js/services/supabase.js` (tải dữ liệu, phân trang,
lịch sử, bảng giá), `js/components/invoice.js` (tìm khách/SKU),
`js/components/users.js` (bảo trì), `js/services/realtime.js` (đăng ký và đọc bù),
`js/components/dashboard.js` (cache), `js/services/backup.js` (sao lưu).

Nguồn quota và cách đo: https://supabase.com/docs/guides/platform/manage-your-usage/egress
và https://supabase.com/pricing.
