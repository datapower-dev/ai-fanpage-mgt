# Ghi chú nghiên cứu Chatwoot (tháng 10/2026)

Mục đích: tham khảo thiết kế cho Fanpage Manager. Nguồn: github.com/chatwoot/chatwoot, developers.chatwoot.com, chatwoot.com/hc.

## Chatwoot là gì, khi nào nên dùng

- Nền tảng hỗ trợ khách hàng đa kênh mã nguồn mở (MIT cho bản Community, thư mục `enterprise/` có giấy phép riêng).
- Stack: Ruby on Rails, Vue, PostgreSQL (có pgvector), Redis, Sidekiq, cần SMTP và object storage.
- Yêu cầu tối thiểu khi tự cài: 4 GB RAM, Docker Compose (rails + sidekiq + postgres + redis), reverse proxy Nginx.
- Phù hợp khi: đội CSKH nhiều người, nhiều kênh (website chat, email, WhatsApp, Instagram, Messenger), cần báo cáo SLA, CSAT, phân quyền.
- **Không hỗ trợ bình luận Facebook**: kênh Facebook chỉ xử lý tin nhắn Messenger (issue #2096, #9724). Đây là lý do Fanpage Manager tự xây phần bình luận.

## Mô hình dữ liệu đáng học

| Chatwoot | Fanpage Manager |
|---|---|
| Conversation.status: open / pending / resolved / snoozed, tự mở lại khi khách nhắn tiếp | open / replied / done, tự mở lại khi khách nhắn sau khi "done" |
| Message.message_type incoming / outgoing / activity + cờ `private` (ghi chú nội bộ) | `from_type` customer / page / note |
| `first_reply_created_at`, `waiting_since` để tính SLA | `response_seconds` trên từng tin trả lời, `last_customer_msg_at` |
| Canned responses: gõ `/shortcode`, biến `{{contact.first_name}}` | Câu trả lời nhanh: gõ `/phím-tắt`, biến `{name}`, `{page}` |
| Automation rules: event + conditions + actions, chống vòng lặp | Luật từ khoá cho tin nhắn và bình luận, có ưu tiên |
| MessageWindowService: 24 giờ (7 ngày với HUMAN_AGENT) | `can_reply`, `reply_window_left_sec`, chọn message tag khi ngoài cửa sổ |
| Labels, Teams, Assignee | Nhãn, người phụ trách |

## Tích hợp Facebook của Chatwoot

- Webhook fields: `messages, messaging_postbacks, message_deliveries, message_reads, message_echoes`.
- Quyền App Review: `pages_messaging, pages_show_list, pages_manage_metadata, business_management, pages_read_engagement`.
- Token hỏng: kênh chuyển sang `authorization_error`, có nút cấp quyền lại.

## API và MCP

- Application API: `/api/v1/accounts/{account_id}/conversations`, `/messages`, `toggle_status`, `assignments`, `labels`, `canned_responses`, `automation_rules`, `reports`.
- Không có MCP chính thức trong tổ chức chatwoot (hướng chính thức là Chatwoot CLI + agent skill).
- MCP cộng đồng: `fazer-ai/mcp-chatwoot` (rất nhiều tool), `hugoblanc/chatwoot-mcp` (4 tool cơ bản).
- Nếu sau này chuyển sang Chatwoot, có thể dùng các MCP cộng đồng trên thay cho `mcp/server.js` của dự án này.
