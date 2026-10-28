# Thêm khách hàng từ tài khoản kinh doanh

Nút thêm ở danh sách khách trước đây mở nguyên form quản trị và gọi `dbSaveCustomer`, tức upsert trực tiếp vào `customers`. RLS chỉ cho Admin/Kế toán ghi theo đường này. Form còn bắt buộc bảng giá dù tài khoản kinh doanh có thể chưa được cấp bảng giá để chọn.

Tài khoản kinh doanh tạo mới qua `rpc_create_quick_customer` đã có trên máy chủ. RPC tự gán người quản lý theo profile đăng nhập, không nhận số dư tài chính từ trình duyệt và giữ nguyên giới hạn sửa/xóa khách. Admin/Kế toán tiếp tục lưu hồ sơ qua đường cũ.

Form dùng bố cục mới với thông tin liên hệ, mã tự động và người phụ trách. Khi kinh doanh tạo khách, các trường quản trị về mã nhập tay, công nợ, bảng giá và bàn giao người quản lý được ẩn; không còn yêu cầu một bảng giá không hiển thị. Việc chọn giá khi lên đơn vẫn theo phân quyền giá hiện có.

Khóa gửi trong lúc lưu, giữ dữ liệu nhập khi có lỗi và dùng khách trả về từ máy chủ để cập nhật danh sách. Kết quả muộn không đóng nhầm form vừa mở lại hoặc nhập dữ liệu vào phiên đã đăng xuất. Luồng này không bật chế độ thêm nhanh trên hóa đơn, nên không đổi khách hoặc dòng hàng đang soạn.

Không cần migration hoặc mở thêm quyền database. Kiểm thử database giả lập xác nhận kinh doanh bị chặn INSERT trực tiếp nhưng tạo được qua RPC, người quản lý không thể giả mạo và số dư vẫn bằng 0. Kiểm thử giao diện dùng dữ liệu giả lập tại `tests/sale-customer-form-harness.html`.
