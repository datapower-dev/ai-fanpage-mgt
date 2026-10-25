---
description: Soạn câu trả lời cho các tin nhắn và bình luận fanpage đang chờ, chờ duyệt rồi mới gửi
argument-hint: "[page_id hoặc ghi chú thêm]"
---

Dùng các công cụ MCP `fanpage-manager` để xử lý khách đang chờ trên fanpage. $ARGUMENTS

1. Gọi `connection_status`. Nếu chưa có trang nào, hướng dẫn tôi mở màn hình Kết nối rồi dừng.
2. Gọi `list_quick_replies` để nắm thông tin chuẩn của shop (giá, phí ship, đổi trả, địa chỉ).
3. Gọi `list_conversations` với status "open". Với từng hội thoại, gọi `get_conversation`.
4. Soạn một câu trả lời ngắn, lịch sự, bằng ngôn ngữ của khách. Không bịa giá hay chính sách không có trong câu trả lời mẫu hoặc lịch sử hội thoại. Thiếu thông tin thì ghi rõ cần tôi bổ sung gì.
5. Hội thoại ngoài cửa sổ 24 giờ (`can_reply` false): đề xuất ghi chú nội bộ thay vì gửi.
6. Gọi `list_comments` và soạn trả lời cho bình luận chưa xử lý. Đánh dấu bình luận nào có vẻ là spam.
7. Trình bày thành bảng: khách, nội dung khách hỏi, câu trả lời đề xuất, hành động (gửi, ghi chú, ẩn).

KHÔNG gọi `send_message`, `reply_comment`, `hide_comment` hay `delete_comment` cho đến khi tôi duyệt. Sau khi tôi duyệt, gửi đúng những mục được duyệt và báo lại kết quả từng mục.
