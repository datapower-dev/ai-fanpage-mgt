---
description: Báo cáo tình hình chăm sóc khách hàng trên fanpage
argument-hint: "[page_id]"
---

Dùng các công cụ MCP `fanpage-manager` (chỉ đọc, không gửi gì) để viết báo cáo ngắn bằng tiếng Việt. $ARGUMENTS

1. Gọi `fanpage_overview`, `list_conversations` (status "all", limit 50), `list_comments` và `list_auto_rules`.
2. Báo cáo gồm:
   - Số liệu chính: cần trả lời, chờ quá 1 giờ, bình luận chờ, thời gian phản hồi trung bình.
   - Ba đến năm chủ đề khách hỏi nhiều nhất, mỗi chủ đề một câu ví dụ.
   - Các hội thoại tồn đọng lâu nhất, kèm ID hội thoại.
   - Bình luận cần xử lý gấp (khiếu nại, hỏi mua).
   - Đề xuất luật trả lời tự động hoặc câu trả lời mẫu mới. Chỉ tạo khi tôi đồng ý.
