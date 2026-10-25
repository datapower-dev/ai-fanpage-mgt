# Fanpage Manager

Công cụ tự cài để quản lý fanpage Facebook: hộp thư Messenger, bình luận, trả lời tự động, kèm MCP server cho Claude. Giao diện, tài liệu và câu trả lời cho người dùng viết bằng tiếng Việt.

## Chạy

- `npm install` rồi `npm start` (dữ liệu thật ở `data/fanpage.db`) hoặc `npm run demo` (dữ liệu giả ở `data/demo.db`).
- Giao diện: http://localhost:3000. Màn hình **Kết nối** (`#/connect`) để nhập App Facebook, đăng nhập Facebook chọn fanpage, xem hướng dẫn webhook và cấu hình Claude.
- Yêu cầu Node.js 22.13 trở lên (`node:sqlite`). Không cần bước build.

## Dùng Claude với fanpage (MCP)

- Server MCP `fanpage-manager` khai báo trong `.mcp.json`, mã ở `mcp/server.js`. Nó gọi REST API của Fanpage Manager và **tự khởi động** server nếu chưa chạy (log ở `data/server.log`).
- `send_message` và `reply_comment` gửi THẬT tới khách. Luôn soạn nháp và xin người dùng duyệt trước khi gửi, trừ khi họ nói rõ là cứ gửi.
- Ngoài cửa sổ 24 giờ (`can_reply = false`) không gửi tin thường được: dùng `add_note` hoặc message tag đúng mục đích.
- Chưa có trang nào: gọi `connection_status` và hướng dẫn người dùng mở `#/connect`.
- Lệnh tắt: `/tra-loi-khach`, `/bao-cao-fanpage`.

## Cấu trúc mã

- `server/` Express + SQLite: `facebook.js` (cấu hình App, OAuth, nhập trang), `graph.js` (Graph API), `webhook.js`, `sync.js`, `messaging.js`, `autoreply.js`, `store.js`, `routes.js` (REST `/api`), `demo.js`.
- `public/` giao diện HTML/CSS/JS thuần, một file `app.js`.
- `mcp/server.js` MCP server (SDK `@modelcontextprotocol/sdk`, zod 4).

## Quy ước

- Tham số SQLite đi qua `all/get/run` trong `db.js` (tự đổi `undefined` thành `null`).
- Mọi nội dung từ khách phải qua `esc()` khi đưa vào HTML.
- Không commit `.env`, `data/`, file zip.
- Kiểm thử nhanh bằng `npm run demo` rồi gọi API hoặc các công cụ MCP.
