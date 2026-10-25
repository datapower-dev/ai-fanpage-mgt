# Fanpage Manager

Bộ công cụ tự cài để theo dõi và quản lý fanpage Facebook: hộp thư Messenger, bình luận bài viết, trả lời tự động, kèm MCP server để Claude đọc và trả lời khách hàng.

- Chạy bằng Node.js, lưu dữ liệu trong một file SQLite. Không cần Docker, PostgreSQL hay Redis.
- Quản lý nhiều trang trong cùng một giao diện.
- Nhận tin nhắn và bình luận theo thời gian thực qua webhook, kèm đồng bộ định kỳ bằng Graph API.

## Tính năng

| Nhóm | Chi tiết |
|---|---|
| Tổng quan | Hội thoại cần trả lời, tin chưa đọc, bình luận chờ xử lý, thời gian phản hồi trung bình, biểu đồ 14 ngày |
| Hộp thư | Lọc theo trạng thái, tìm kiếm, trả lời, đính kèm ảnh/tệp qua URL, ghi chú nội bộ, nhãn, người phụ trách, cảnh báo cửa sổ 24 giờ, message tag |
| Bình luận | Danh sách bình luận chưa trả lời, trả lời công khai, gửi kèm tin nhắn riêng (private reply), ẩn/hiện, xoá |
| Tự động hoá | Luật trả lời theo từ khoá cho tin nhắn và bình luận, câu trả lời nhanh gõ bằng `/`, trả lời ngoài giờ làm việc |
| Thời gian thực | Cập nhật tức thì qua Server-Sent Events, âm báo và thông báo trình duyệt |
| Claude (MCP) | 23 công cụ để Claude xem, trả lời, gắn nhãn, xử lý bình luận, tạo luật tự động, và 2 prompt mẫu |

## Chạy thử ngay (không cần Facebook)

Yêu cầu Node.js 22.13 trở lên (dự án dùng `node:sqlite` có sẵn trong Node).

```bash
npm install
```

```bash
npm run demo
```

Mở http://localhost:3000. Chế độ demo tạo hai trang mẫu cùng hội thoại và bình luận giả. Nút "Giả lập tin nhắn" và "Giả lập bình luận" ở thanh bên dùng để thử trả lời tự động và cập nhật trực tiếp. Dữ liệu demo nằm riêng trong `data/demo.db`, tách khỏi dữ liệu thật ở `data/fanpage.db`. Xoá file demo để tạo lại dữ liệu mẫu.

## Kết nối fanpage thật

### 1. Tạo ứng dụng Facebook

1. Vào https://developers.facebook.com/apps, tạo app loại **Business**.
2. Thêm sản phẩm **Messenger** (và **Webhooks** nếu chưa có).
3. Ghi lại **App ID** và **App Secret** ở mục Settings → Basic.

### 2. Cấu hình `.env`

```bash
cp .env.example .env
```

Điền `FB_APP_ID`, `FB_APP_SECRET`, đổi `FB_VERIFY_TOKEN` thành một chuỗi bí mật, và đặt `ADMIN_PASSWORD` nếu server mở ra Internet.

### 3. Chạy server

```bash
npm start
```

### 4. Lấy token và thêm trang

1. Mở Graph API Explorer (developers.facebook.com/tools/explorer), chọn app vừa tạo.
2. Tạo User Token với các quyền: `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`.
3. Trong giao diện, vào **Trang**. Dán User Token vào ô "Nhập tất cả trang từ User Token", hoặc dán Page Access Token của từng trang.
4. Hệ thống tự đăng ký webhook cho trang và đồng bộ lịch sử tin nhắn, bài viết, bình luận.

Khi đã đặt `FB_APP_ID` và `FB_APP_SECRET`, User Token được đổi sang loại dài hạn. Page Token lấy từ token dài hạn sẽ không hết hạn.

### 5. Cấu hình webhook (để nhận tin tức thì)

Facebook chỉ gửi webhook tới URL công khai HTTPS. Trên máy cá nhân, tạo đường hầm bằng Cloudflare Tunnel hoặc ngrok:

```bash
cloudflared tunnel --url http://localhost:3000
```

Trong app Facebook → Messenger → Settings → Webhooks:

- **Callback URL:** `https://<địa-chỉ-tunnel>/webhook`
- **Verify Token:** giá trị `FB_VERIFY_TOKEN` trong `.env`
- **Trường đăng ký:** `messages`, `messaging_postbacks`, `message_echoes`, `feed`

Không có webhook thì hệ thống vẫn chạy nhờ đồng bộ định kỳ mỗi `SYNC_INTERVAL_SEC` giây. Tuy vậy, trả lời tự động chỉ chạy với sự kiện đến qua webhook.

### 6. Giới hạn của Facebook cần biết

- **Cửa sổ 24 giờ:** trang chỉ được gửi tin thường trong 24 giờ kể từ tin cuối của khách. Ngoài cửa sổ này cần message tag đúng mục đích. Tag `HUMAN_AGENT` (7 ngày) phải được Facebook duyệt.
- **App Review:** khi app ở chế độ Development, chỉ người có vai trò trong app mới nhắn được tới trang. Muốn nhận tin của mọi khách cần quyền Advanced Access cho `pages_messaging` qua App Review. Nếu chỉ dùng cho trang của chính bạn, Standard Access có thể đã đủ.
- **Private reply:** mỗi bình luận chỉ được gửi một tin nhắn riêng, trong vòng 7 ngày kể từ khi bình luận.

## Kết nối Claude qua MCP

MCP server (`mcp/server.js`) gọi REST API của Fanpage Manager. Vì vậy server chính phải đang chạy (`npm start` hoặc `npm run demo`).

### Claude Code

File `.mcp.json` ở thư mục gốc đã cấu hình sẵn. Mở Claude Code trong thư mục này và chấp nhận MCP server `fanpage-manager` khi được hỏi. Hoặc thêm thủ công:

```bash
claude mcp add fanpage-manager -e FANPAGE_URL=http://localhost:3000 -- node C:/Claude/facebook/mcp/server.js
```

### Claude Desktop

Thêm vào `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fanpage-manager": {
      "command": "node",
      "args": ["C:/Claude/facebook/mcp/server.js"],
      "env": { "FANPAGE_URL": "http://localhost:3000", "FANPAGE_PASSWORD": "" }
    }
  }
}
```

Đặt `FANPAGE_PASSWORD` trùng `ADMIN_PASSWORD` nếu server có mật khẩu.

### Công cụ MCP

| Nhóm | Công cụ |
|---|---|
| Xem | `fanpage_overview`, `list_pages`, `list_conversations`, `get_conversation`, `search_messages`, `list_comments`, `list_posts`, `list_quick_replies`, `list_auto_rules`, `recent_activity` |
| Tin nhắn | `send_message`, `add_note`, `update_conversation`, `mark_read` |
| Bình luận | `reply_comment`, `hide_comment`, `mark_comment_handled`, `delete_comment` |
| Quản trị | `sync_page`, `create_auto_rule`, `update_auto_rule`, `delete_auto_rule`, `create_quick_reply` |

Prompt mẫu: `tra-loi-tin-nhan-cho` soạn câu trả lời cho tin đang chờ để bạn duyệt, `bao-cao-ngay` tóm tắt tình hình chăm sóc khách hàng.

Ví dụ yêu cầu cho Claude:

- "Xem các tin nhắn đang chờ trên fanpage và soạn câu trả lời cho tôi duyệt."
- "Ẩn các bình luận spam quảng cáo trên bài viết mới nhất."
- "Tạo luật tự động trả lời khi khách hỏi phí ship."

Tin gửi qua Claude được đánh dấu "🤖 Claude" trong giao diện. `send_message` và `reply_comment` gửi thật tới khách, nên hướng dẫn trong MCP yêu cầu Claude xin xác nhận trước khi gửi.

## Cấu trúc thư mục

```
server/
  index.js      Khởi động Express, webhook, xác thực, file tĩnh
  config.js     Đọc .env
  db.js         Lược đồ SQLite
  graph.js      Gọi Facebook Graph API, diễn giải lỗi sang tiếng Việt
  webhook.js    Xác minh và xử lý sự kiện webhook (tin nhắn, bình luận)
  sync.js       Đồng bộ định kỳ từ Graph API
  messaging.js  Gửi tin, trả lời/ẩn/xoá bình luận
  autoreply.js  Luật trả lời tự động, ngoài giờ
  store.js      Truy vấn dữ liệu, thống kê
  routes.js     REST API (/api/...)
  events.js     Server-Sent Events
  demo.js       Dữ liệu demo và giả lập
public/         Giao diện web (HTML/CSS/JS thuần, không cần build)
mcp/server.js   MCP server cho Claude
docs/           Ghi chú nghiên cứu Chatwoot
```

## So sánh với Chatwoot

Chatwoot là nền tảng CSKH đa kênh mạnh hơn nhiều, nhưng cần PostgreSQL, Redis, Sidekiq và tối thiểu 4 GB RAM. Chatwoot cũng **không hỗ trợ bình luận Facebook**. Fanpage Manager nhẹ hơn, tập trung vào fanpage và có sẵn phần bình luận. Xem thêm [docs/chatwoot-notes.md](docs/chatwoot-notes.md).

## Bảo mật

- Đặt `ADMIN_PASSWORD` khi server truy cập được từ Internet. Giao diện dùng Basic Auth, MCP dùng Bearer token cùng mật khẩu.
- Đặt `FB_APP_SECRET` để kiểm tra chữ ký `X-Hub-Signature-256` của webhook.
- Access token lưu dạng thuần trong `data/fanpage.db`. Giữ file này an toàn và không đưa lên git (đã có trong `.gitignore`).
