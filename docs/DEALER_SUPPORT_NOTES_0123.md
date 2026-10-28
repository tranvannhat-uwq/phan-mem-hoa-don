# Ghi chú đơn hàng trong lịch sử hàng cấp — 0123

Bảng hiển thị bốn cột: Ngày, Sản phẩm, Số lượng (cái), Ghi chú đơn hàng. Bỏ cột hãng/công ty, đã trả và trạng thái. Số lượng trong bảng và phần tổng hợp dùng nhãn “cái”; không sửa đơn vị gốc của SKU hoặc chuyển đổi giá trị số lượng.

RPC lấy ghi chú qua đúng `order_items.id` đã băm thành `source_key`, với điều kiện khách hàng trùng khớp. Chỉ bổ sung ghi chú cho trang được yêu cầu. Ghi chú dùng `textContent`, hỗ trợ xuống dòng và không diễn giải HTML.

Thêm `dealer_support_history.order_notes` để lưu ghi chú trong cùng giao dịch giữ lịch sử. Hàm bảo toàn tiếp tục dùng `p118_purge_support_lines()` để loại các chứng từ được giữ lại cho đối soát. Giữ nguyên kiểm tra số lượng, liên kết trả hàng và quyền truy cập. Đơn đã xóa trước khi có trường này không thể tự khôi phục ghi chú; giao diện hiện “—”.

Migration kiểm tra hash hai hàm hiện tại trước khi thay đổi. Đã cài 0123 trên SoViet ngày 28/10/2026; đối chiếu sau cài đặt: mã hàm khớp bản kiểm thử, ACL giữ nguyên. Số đơn, dòng công nợ và dòng lịch sử lưu trữ không đổi. Không gọi RPC dọn dữ liệu trên production.

Hash nguồn sau cài, đã bỏ CR:

- `p114_preserve_support`: `a5a5c33a187aa416121f189f1ae4e359`
- `rpc_dealer_support_history`: `587060a2be7029503ad976d5a5fceacf`

Kiểm thử gồm đúng ghi chú từng đơn, giữ ghi chú sau khi xóa nguồn trong database giả lập, phân quyền, phân trang, rollback, giữ chứng từ lỗi và khôi phục backup. Ảnh kiểm tra giao diện sử dụng dữ liệu giả lập trong `outputs/dealer-support-notes-preview.png` (không đưa ảnh vào Git).
