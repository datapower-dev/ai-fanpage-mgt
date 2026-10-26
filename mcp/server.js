#!/usr/bin/env node
// MCP server cho Fanpage Manager: cho Claude đọc và trả lời tin nhắn/bình luận fanpage.
// Server này gọi REST API của Fanpage Manager đang chạy (FANPAGE_URL), nên mọi thao tác
// đi qua cùng một luồng với giao diện web (ghi CSDL, phát sự kiện thời gian thực, gọi Graph API).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* bỏ qua */
  }
}

const BASE = (process.env.FANPAGE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const PASSWORD = process.env.FANPAGE_PASSWORD || process.env.ADMIN_PASSWORD || '';
// Tự khởi động Fanpage Manager khi chưa chạy (chỉ với địa chỉ localhost). FANPAGE_AUTOSTART=0 để tắt.
const AUTOSTART = process.env.FANPAGE_AUTOSTART !== '0';

const isLocalBase = () => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE).hostname);
  } catch {
    return false;
  }
};

let starting = null;
/** Chạy server/index.js ở nền (tách khỏi MCP, ghi log vào data/server.log) rồi chờ sẵn sàng. */
function autostartServer() {
  if (starting) return starting;
  starting = (async () => {
    const port = new URL(BASE).port || '80';
    const logDir = path.join(root, 'data');
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'server.log'), 'a');
    const args = [path.join(root, 'server', 'index.js')];
    if (process.env.FANPAGE_DEMO === '1') args.push('--demo');
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, PORT: port },
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
    console.error(`[fanpage-mcp] Đã tự khởi động Fanpage Manager (pid ${child.pid}) tại ${BASE}, log: data/server.log`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const r = await fetch(BASE + '/api/me', { headers: PASSWORD ? { authorization: `Bearer ${PASSWORD}` } : {} });
        if (r.status < 500) return true;
      } catch {
        /* chưa sẵn sàng */
      }
    }
    throw new Error('Fanpage Manager không khởi động được, xem data/server.log');
  })().finally(() => {
    setTimeout(() => (starting = null), 5000);
  });
  return starting;
}

async function api(p, opts = {}) {
  try {
    return await apiOnce(p, opts);
  } catch (e) {
    if (e.code === 'NOT_RUNNING' && AUTOSTART && isLocalBase()) {
      await autostartServer();
      return apiOnce(p, opts);
    }
    throw e;
  }
}

async function apiOnce(p, { method = 'GET', body, query } = {}) {
  const url = new URL(BASE + '/api' + p);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { 'x-fanpage-client': 'mcp' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (PASSWORD) headers.authorization = `Bearer ${PASSWORD}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    const err = new Error(
      `Không kết nối được Fanpage Manager tại ${BASE} (${e.cause?.code || e.message}). Hãy chạy "npm start" (hoặc "npm run demo") trước, hoặc đặt FANPAGE_URL.`,
    );
    if (['ECONNREFUSED', 'ECONNRESET'].includes(e.cause?.code)) err.code = 'NOT_RUNNING';
    throw err;
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (res.status === 401) throw new Error('Sai mật khẩu: đặt FANPAGE_PASSWORD (hoặc ADMIN_PASSWORD) trùng với server.');
  if (!res.ok) throw new Error([data.error || `HTTP ${res.status}`, data.hint].filter(Boolean).join(' — '));
  return data;
}

const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});
const errResult = (e) => ({ content: [{ type: 'text', text: `Lỗi: ${e.message}` }], isError: true });
const tool = (fn) => async (args) => {
  try {
    return await fn(args || {});
  } catch (e) {
    return errResult(e);
  }
};

const STATUS = { open: 'cần trả lời', replied: 'đã trả lời', done: 'đã xong' };
const vnTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour12: false }) : '—');
const dur = (s) => (s == null ? '—' : s < 3600 ? `${Math.round(s / 60)} phút` : `${(s / 3600).toFixed(1)} giờ`);

function convLine(c) {
  const bits = [
    `[${c.id}]`,
    c.customer_name || `Khách ${c.psid}`,
    `(${c.page_name})`,
    `— ${STATUS[c.status] || c.status}`,
    c.unread ? `· ${c.unread} chưa đọc` : '',
    c.assigned ? `· phụ trách: ${c.assigned}` : '',
    c.tags?.length ? `· nhãn: ${c.tags.join(', ')}` : '',
    c.can_reply === false ? '· NGOÀI CỬA SỔ 24H' : '',
    `· ${vnTime(c.updated_time)}`,
  ];
  return `${bits.filter(Boolean).join(' ')}\n    "${(c.snippet || '').slice(0, 160)}"`;
}
function msgLine(m) {
  const who = m.from_type === 'customer' ? 'KHÁCH' : m.from_type === 'note' ? `GHI CHÚ (${m.from_id})` : m.source === 'auto' ? 'TRANG (tự động)' : 'TRANG';
  const att = (m.attachments || []).map((a) => ` [${a.type}: ${a.url || a.title}]`).join('');
  const err = m.status === 'failed' ? ` [GỬI LỖI: ${m.error}]` : '';
  return `${vnTime(m.created_time)} ${who}: ${m.text || ''}${att}${err}`;
}
function commentLine(c) {
  const flags = [c.replied ? 'đã trả lời' : 'chưa trả lời', c.is_hidden ? 'đang ẩn' : ''].filter(Boolean).join(', ');
  return `[${c.id}] ${c.from_name || 'Người dùng'} (${c.page_name || c.page_id}, ${vnTime(c.created_time)}, ${flags})\n    Bài: "${(c.post_message || '').slice(0, 80)}"\n    Bình luận: "${c.message}"`;
}

const server = new McpServer(
  { name: 'fanpage-manager', version: '0.1.0' },
  {
    instructions: `Công cụ quản lý fanpage Facebook (hộp thư Messenger + bình luận) của người dùng.
Quy trình gợi ý: fanpage_overview -> list_conversations(status="open") -> get_conversation -> send_message. Bài viết: list_posts -> get_post; đăng bài: create_post.
- ID hội thoại có dạng "<page_id>:<psid>".
- send_message gửi THẬT tới khách hàng trên Messenger, reply_comment đăng THẬT công khai trên Facebook. Hãy soạn câu trả lời và xin xác nhận của người dùng trước khi gửi, trừ khi họ đã yêu cầu rõ ràng là cứ gửi.
- Facebook chỉ cho gửi tin thường trong 24 giờ kể từ tin cuối của khách (can_reply). Ngoài cửa sổ này cần message tag hợp lệ; nếu không, dùng add_note để ghi chú nội bộ.
- Biến {name} (tên khách) và {page} (tên trang) được thay tự động trong nội dung gửi.
- Trả lời bằng ngôn ngữ của khách (thường là tiếng Việt), lịch sự, ngắn gọn.
- Nếu chưa có trang nào, gọi facebook_login để lấy link đăng nhập cho người dùng (Claude không đăng nhập thay được). Người dùng đưa App ID/Secret hoặc token thì dùng configure_facebook_app / connect_pages_with_token.
- create_post đăng bài CÔNG KHAI: luôn cho người dùng xem bản cuối và xin xác nhận trước khi đăng.`,
  },
);

/* ---------- Đọc ---------- */
server.registerTool(
  'fanpage_overview',
  {
    title: 'Tổng quan fanpage',
    description: 'Số liệu tổng quan: hội thoại cần trả lời, tin chưa đọc, bình luận chờ xử lý, thời gian phản hồi trung bình, danh sách trang.',
    inputSchema: { page_id: z.string().optional().describe('Lọc theo một trang (bỏ trống = tất cả)') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ page_id }) => {
    const [s, pages] = await Promise.all([api('/stats', { query: { page_id } }), api('/pages')]);
    const text = [
      `Cần trả lời: ${s.open} hội thoại (${s.overdue_1h} chờ quá 1 giờ)`,
      `Tin chưa đọc: ${s.unread}`,
      `Bình luận chờ xử lý: ${s.pending_comments}`,
      `Tin khách hôm nay: ${s.msgs_today} (24h: ${s.msgs_24h})`,
      `Phản hồi trung bình 7 ngày: ${dur(s.avg_response_seconds)}`,
      `Lượt thích: ${s.fans}, theo dõi: ${s.followers}`,
      '',
      `Trang (${pages.length}):`,
      ...pages.map((p) => `- ${p.name} [${p.id}]${p.enabled ? '' : ' (đã tắt)'}${p.last_error ? ` LỖI: ${p.last_error}` : ''} · đồng bộ: ${vnTime(p.last_sync)}`),
    ].join('\n');
    return ok(text, { stats: s, pages });
  }),
);

server.registerTool(
  'connection_status',
  {
    title: 'Tình trạng kết nối',
    description: 'Kiểm tra kết nối Facebook: đã cấu hình App chưa, số trang đã kết nối, URL webhook, lần cuối nhận webhook. Dùng khi chưa có trang hoặc gửi tin bị lỗi.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async () => {
    const c = await api('/connect');
    const lines = [
      `Fanpage Manager: ${BASE}${c.demo ? ' (CHẾ ĐỘ DEMO, dữ liệu giả)' : ''}`,
      `App Facebook: ${c.has_app_id ? `App ID ${c.app_id}` : 'CHƯA nhập App ID'} · App Secret: ${c.has_app_secret ? 'đã có' : 'CHƯA có'}`,
      `Trang đã kết nối: ${c.pages}`,
      `Đăng nhập Facebook: mở ${BASE}/#/connect và bấm "Đăng nhập với Facebook"`,
      `Redirect URI cần khai báo trong app Facebook: ${c.oauth_redirect_uri}`,
      `Webhook: ${c.webhook_url}${c.base_is_https ? '' : ' (Facebook cần HTTPS công khai, hãy đặt URL công khai)'} · lần cuối nhận: ${c.last_webhook_at ? vnTime(c.last_webhook_at) : 'chưa bao giờ'}`,
    ];
    return ok(lines.join('\n'), c);
  }),
);

server.registerTool(
  'list_pages',
  {
    title: 'Danh sách trang',
    description: 'Liệt kê các fanpage đã kết nối kèm ID, số lượt thích, trạng thái đồng bộ.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async () => {
    const pages = await api('/pages');
    return ok(
      pages.map((p) => `- ${p.name} [${p.id}] · ${p.category || ''} · 👍 ${p.fan_count} · webhook: ${p.subscribed ? 'có' : 'chưa'}${p.last_error ? ` · LỖI: ${p.last_error}` : ''}`).join('\n') || 'Chưa có trang nào.',
      { pages },
    );
  }),
);

server.registerTool(
  'list_conversations',
  {
    title: 'Danh sách hội thoại',
    description: 'Liệt kê hội thoại Messenger, mới nhất trước. Lọc theo trạng thái: open (cần trả lời), unread, replied, done, all.',
    inputSchema: {
      status: z.enum(['open', 'unread', 'replied', 'done', 'all']).default('open'),
      page_id: z.string().optional(),
      query: z.string().optional().describe('Tìm theo tên khách hoặc nội dung'),
      limit: z.number().int().min(1).max(200).default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ status = 'open', page_id, query, limit = 20 }) => {
    const rows = await api('/conversations', { query: { status, page_id, q: query, limit } });
    return ok(rows.length ? `${rows.length} hội thoại:\n` + rows.map(convLine).join('\n') : 'Không có hội thoại phù hợp.', {
      conversations: rows,
    });
  }),
);

server.registerTool(
  'get_conversation',
  {
    title: 'Xem hội thoại',
    description: 'Xem toàn bộ tin nhắn của một hội thoại (kể cả ghi chú nội bộ), thông tin khách, nhãn, cửa sổ 24 giờ.',
    inputSchema: {
      conversation_id: z.string().describe('ID dạng "<page_id>:<psid>"'),
      limit: z.number().int().min(1).max(500).default(50).describe('Số tin gần nhất'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ conversation_id, limit = 50 }) => {
    const d = await api(`/conversations/${encodeURIComponent(conversation_id)}`, { query: { limit: 500 } });
    const c = d.conversation;
    const msgs = d.messages.slice(-limit);
    const head = [
      `Khách: ${c.customer_name || c.psid} · Trang: ${c.page_name}`,
      `Trạng thái: ${STATUS[c.status]} · Phụ trách: ${c.assigned || '—'} · Nhãn: ${c.tags.join(', ') || '—'}`,
      `Cửa sổ 24h: ${c.can_reply ? `còn ${dur(c.reply_window_left_sec)}` : 'ĐÃ ĐÓNG (cần message tag để gửi)'}`,
      c.note ? `Ghi chú về khách: ${c.note}` : '',
      `--- ${msgs.length}/${d.messages.length} tin gần nhất ---`,
    ].filter(Boolean);
    return ok([...head, ...msgs.map(msgLine)].join('\n'), { conversation: c, customer: d.customer, messages: msgs });
  }),
);

server.registerTool(
  'search_messages',
  {
    title: 'Tìm hội thoại',
    description: 'Tìm hội thoại theo tên khách hoặc nội dung tin nhắn gần nhất (mọi trạng thái).',
    inputSchema: { query: z.string().min(1), page_id: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ query, page_id, limit = 20 }) => {
    const rows = await api('/conversations', { query: { status: 'all', q: query, page_id, limit } });
    return ok(rows.length ? rows.map(convLine).join('\n') : 'Không tìm thấy.', { conversations: rows });
  }),
);

server.registerTool(
  'list_comments',
  {
    title: 'Danh sách bình luận',
    description: 'Liệt kê bình luận trên bài viết của fanpage. Mặc định chỉ bình luận của khách chưa được trả lời và chưa ẩn.',
    inputSchema: {
      pending_only: z.boolean().default(true),
      page_id: z.string().optional(),
      limit: z.number().int().min(1).max(300).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ pending_only = true, page_id, limit = 30 }) => {
    const rows = (await api('/comments', { query: { pending: pending_only ? 1 : 0, page_id, limit } })).filter((c) => !c.is_page);
    return ok(rows.length ? `${rows.length} bình luận:\n` + rows.map(commentLine).join('\n') : 'Không có bình luận nào chờ xử lý.', {
      comments: rows,
    });
  }),
);

const postLine = (p) => {
  const status = p.status === 'scheduled' ? `HẸN ĐĂNG ${vnTime(p.scheduled_time)}` : vnTime(p.created_time);
  return `[${p.id}] ${status} (${p.page_name}) 👍${p.likes} 💬${p.comments_count} ↗${p.shares} · chờ xử lý: ${p.pending_comments ?? 0}${p.source === 'mcp' ? ' · đăng bởi Claude' : ''}\n    "${(p.message || '').slice(0, 160)}"${p.permalink_url ? `\n    ${p.permalink_url}` : ''}`;
};

server.registerTool(
  'list_posts',
  {
    title: 'Danh sách bài viết',
    description: 'Liệt kê bài viết gần đây (kể cả bài hẹn giờ) với số cảm xúc, bình luận, chia sẻ và số bình luận chờ xử lý.',
    inputSchema: { page_id: z.string().optional(), limit: z.number().int().min(1).max(100).default(15) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ page_id, limit = 15 }) => {
    const rows = await api('/posts', { query: { page_id, limit } });
    return ok(rows.map(postLine).join('\n') || 'Chưa có bài viết.', { posts: rows });
  }),
);

server.registerTool(
  'get_post',
  {
    title: 'Đọc bài viết',
    description: 'Đọc toàn bộ nội dung một bài viết kèm tất cả bình luận và phản hồi của trang. refresh=true để lấy số liệu và bình luận mới nhất từ Facebook.',
    inputSchema: {
      post_id: z.string().describe('ID bài viết, dạng "<page_id>_<post_id>"'),
      refresh: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async ({ post_id, refresh = false }) => {
    const d = await api(`/posts/${encodeURIComponent(post_id)}`, { query: { refresh: refresh ? 1 : 0 } });
    const p = d.post;
    const lines = [
      `Bài [${p.id}] trên ${p.page_name} · ${p.status === 'scheduled' ? `hẹn đăng ${vnTime(p.scheduled_time)}` : `đăng ${vnTime(p.created_time)}`}`,
      `👍 ${p.likes} · 💬 ${p.comments_count} · ↗ ${p.shares}${p.permalink_url ? ` · ${p.permalink_url}` : ''}${p.picture ? `\nẢnh: ${p.picture}` : ''}`,
      d.refresh_error ? `(Không làm mới được từ Facebook: ${d.refresh_error})` : d.refreshed ? '(Đã làm mới từ Facebook)' : '',
      '--- Nội dung ---',
      p.message || '(không có chữ)',
      `--- ${d.comments.length} bình luận ---`,
      ...d.comments.map(
        (c) =>
          `${c.parent_id ? '    ↳ ' : ''}[${c.id}] ${c.is_page ? 'TRANG' : c.from_name || 'Người dùng'} (${vnTime(c.created_time)}${c.is_hidden ? ', đang ẩn' : ''}${!c.is_page && !c.replied ? ', chưa trả lời' : ''}): ${c.message}`,
      ),
    ].filter(Boolean);
    return ok(lines.join('\n'), d);
  }),
);

server.registerTool(
  'create_post',
  {
    title: 'Đăng bài lên fanpage',
    description:
      'Đăng bài CÔNG KHAI lên fanpage: chữ, kèm link HOẶC ảnh (URL công khai), có thể hẹn giờ (10 phút đến 75 ngày). Luôn cho người dùng xem nội dung cuối cùng và xin xác nhận trước khi gọi.',
    inputSchema: {
      page_id: z.string(),
      message: z.string().max(60000).default('').describe('Nội dung bài'),
      link: z.string().url().optional().describe('Link chia sẻ kèm bài (không dùng cùng image_url)'),
      image_url: z.string().url().optional().describe('URL ảnh công khai (jpg/png) để đăng bài ảnh'),
      scheduled_at: z.string().optional().describe('Thời điểm hẹn đăng, ISO 8601 có múi giờ, ví dụ 2026-11-01T09:00:00+07:00'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ page_id, message = '', link, image_url, scheduled_at }) => {
    const r = await api(`/pages/${encodeURIComponent(page_id)}/posts`, {
      method: 'POST',
      body: { message, link, image_url, scheduled_at, source: 'mcp' },
    });
    const p = r.post;
    return ok(
      `${p.status === 'scheduled' ? `Đã hẹn đăng lúc ${vnTime(p.scheduled_time)}` : 'Đã đăng bài'} lên ${p.page_name}.\nID: ${p.id}${p.permalink_url ? `\nLink: ${p.permalink_url}` : ''}`,
      { post: p },
    );
  }),
);

server.registerTool(
  'delete_post',
  {
    title: 'Xoá bài viết',
    description: 'XOÁ VĨNH VIỄN một bài viết (hoặc huỷ bài hẹn giờ) trên fanpage. Không thể hoàn tác. Chỉ dùng khi người dùng yêu cầu rõ ràng.',
    inputSchema: { post_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ post_id }) => {
    await api(`/posts/${encodeURIComponent(post_id)}`, { method: 'DELETE' });
    return ok(`Đã xoá bài ${post_id}.`);
  }),
);

/* ---------- Đăng nhập / kết nối page ---------- */
server.registerTool(
  'facebook_login',
  {
    title: 'Đăng nhập Facebook để kết nối page',
    description:
      'Trả về đường link để người dùng tự đăng nhập Facebook và chọn fanpage cấp quyền (Claude không đăng nhập thay được). Kèm danh sách việc còn thiếu (App ID/Secret, Redirect URI) nếu chưa sẵn sàng.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async () => {
    const c = await api('/connect');
    if (c.demo) return ok(`Fanpage Manager đang chạy CHẾ ĐỘ DEMO nên không kết nối Facebook thật được. Dừng server và chạy "npm start", rồi gọi lại công cụ này.`, c);
    const todo = [];
    if (!c.has_app_id || !c.has_app_secret) {
      todo.push(
        'Tạo app tại https://developers.facebook.com/apps (loại Business, thêm Facebook Login for Business và Messenger), rồi cung cấp App ID và App Secret (dùng configure_facebook_app hoặc nhập ở màn hình Kết nối).',
      );
    }
    todo.push(`Trong app Facebook → Facebook Login → Settings → Valid OAuth Redirect URIs, thêm: ${c.oauth_redirect_uri}`);
    const lines = [
      `Đã kết nối: ${c.pages} trang.`,
      c.has_app_id && c.has_app_secret
        ? `Mở link sau trong trình duyệt, đăng nhập Facebook và chọn các fanpage cần quản lý:\n${c.base_url}/auth/facebook/start`
        : 'Chưa thể đăng nhập vì thiếu cấu hình App.',
      `Hoặc mở màn hình Kết nối: ${c.base_url}/#/connect`,
      '',
      'Việc cần làm:',
      ...todo.map((t, i) => `${i + 1}. ${t}`),
      '',
      `Quyền sẽ xin: ${c.scopes.join(', ')}`,
      'Sau khi người dùng đăng nhập xong, gọi list_pages để xác nhận.',
    ];
    return ok(lines.join('\n'), { ...c, login_url: `${c.base_url}/auth/facebook/start`, connect_url: `${c.base_url}/#/connect` });
  }),
);

server.registerTool(
  'configure_facebook_app',
  {
    title: 'Cấu hình ứng dụng Facebook',
    description:
      'Lưu App ID, App Secret, Verify Token webhook và URL công khai vào Fanpage Manager (lưu trên máy người dùng). Chỉ dùng giá trị người dùng cung cấp. Bỏ trống trường nào thì giữ giá trị cũ.',
    inputSchema: {
      app_id: z.string().optional(),
      app_secret: z.string().optional(),
      verify_token: z.string().optional(),
      public_url: z.string().optional().describe('URL HTTPS công khai của server, ví dụ từ cloudflared'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tool(async ({ app_id, app_secret, verify_token, public_url }) => {
    const c = await api('/connect/app', {
      method: 'PUT',
      body: { appId: app_id, appSecret: app_secret, verifyToken: verify_token, publicUrl: public_url },
    });
    return ok(
      `Đã lưu. App ID: ${c.app_id || '—'} · App Secret: ${c.has_app_secret ? 'đã có' : 'chưa có'}\nRedirect URI cần khai báo: ${c.oauth_redirect_uri}\nWebhook: ${c.webhook_url}`,
      c,
    );
  }),
);

server.registerTool(
  'connect_pages_with_token',
  {
    title: 'Kết nối page bằng access token',
    description:
      'Kết nối fanpage bằng token người dùng đưa (lấy từ Graph API Explorer). user_token: nhập mọi trang người đó quản lý. page_token: kết nối một trang. Hệ thống tự đăng ký webhook và đồng bộ dữ liệu.',
    inputSchema: {
      user_token: z.string().optional(),
      page_token: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ user_token, page_token }) => {
    if (!user_token && !page_token) throw new Error('Cần user_token hoặc page_token');
    if (user_token) {
      const r = await api('/pages/import', { method: 'POST', body: { user_token } });
      return ok(
        `Đã kết nối ${r.count} trang${r.long_lived ? ' (token dài hạn)' : ''}: ${r.pages.map((p) => p.name).join(', ') || '—'}${r.warnings?.length ? `\nCảnh báo: ${r.warnings.join(' | ')}` : ''}\nĐang đồng bộ dữ liệu ở nền.`,
        r,
      );
    }
    const p = await api('/pages', { method: 'POST', body: { access_token: page_token } });
    return ok(`Đã kết nối trang ${p.name} [${p.id}]${p.subscribed === false ? ' (chưa đăng ký được webhook)' : ''}. Đang đồng bộ dữ liệu ở nền.`, { page: p });
  }),
);

server.registerTool(
  'subscribe_page_webhook',
  {
    title: 'Đăng ký webhook cho page',
    description: 'Đăng ký ứng dụng nhận sự kiện (tin nhắn, bình luận) của một trang. Dùng khi trang báo "chưa đăng ký webhook".',
    inputSchema: { page_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ page_id }) => {
    await api(`/pages/${encodeURIComponent(page_id)}/subscribe`, { method: 'POST' });
    return ok('Đã đăng ký webhook cho trang.');
  }),
);

server.registerTool(
  'list_quick_replies',
  {
    title: 'Câu trả lời mẫu',
    description: 'Danh sách câu trả lời nhanh (mẫu) mà shop đã soạn sẵn. Nên tham khảo để trả lời đúng giọng và thông tin (giá, phí ship, đổi trả…).',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async () => {
    const rows = await api('/quick-replies');
    return ok(rows.map((q) => `/${q.shortcut} — ${q.title}: ${q.body}`).join('\n') || 'Chưa có câu trả lời mẫu.', { quick_replies: rows });
  }),
);

server.registerTool(
  'list_auto_rules',
  {
    title: 'Luật trả lời tự động',
    description: 'Danh sách luật trả lời tự động theo từ khoá cho tin nhắn/bình luận.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async () => {
    const rows = await api('/rules');
    return ok(
      rows
        .map((r) => `#${r.id} ${r.enabled ? '[BẬT]' : '[TẮT]'} ${r.name} · ${r.match_type}: "${r.keyword}" · áp dụng: ${r.apply_to}${r.private_reply ? ' + inbox riêng' : ''} · ưu tiên ${r.priority}\n    -> ${r.reply}`)
        .join('\n') || 'Chưa có luật.',
      { rules: rows },
    );
  }),
);

server.registerTool(
  'recent_activity',
  {
    title: 'Nhật ký hoạt động',
    description: 'Nhật ký gần đây: đồng bộ, lỗi gửi tin, trả lời tự động, webhook…',
    inputSchema: { limit: z.number().int().min(1).max(200).default(30) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tool(async ({ limit = 30 }) => {
    const rows = await api('/activity', { query: { limit } });
    return ok(rows.map((a) => `${vnTime(a.ts)} [${a.type}] ${a.detail}`).join('\n') || 'Trống.', { activity: rows });
  }),
);

/* ---------- Ghi / hành động ---------- */
server.registerTool(
  'send_message',
  {
    title: 'Gửi tin nhắn cho khách',
    description:
      'Gửi tin nhắn Messenger THẬT từ fanpage tới khách trong một hội thoại. Hỗ trợ biến {name}, {page}. Chỉ gửi được trong 24 giờ kể từ tin cuối của khách, trừ khi dùng message tag hợp lệ.',
    inputSchema: {
      conversation_id: z.string(),
      text: z.string().min(1).max(2000),
      attachment_url: z.string().url().optional().describe('URL ảnh/tệp công khai để đính kèm'),
      tag: z
        .enum(['HUMAN_AGENT', 'ACCOUNT_UPDATE', 'POST_PURCHASE_UPDATE', 'CONFIRMED_EVENT_UPDATE'])
        .optional()
        .describe('Chỉ dùng khi ngoài cửa sổ 24h và đúng mục đích của tag'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ conversation_id, text, attachment_url, tag }) => {
    const r = await api(`/conversations/${encodeURIComponent(conversation_id)}/reply`, {
      method: 'POST',
      body: { text, attachment_url, tag, source: 'mcp' },
    });
    return ok(`Đã gửi tới ${r.conversation.customer_name || conversation_id}: "${r.message.text}"`, { message: r.message });
  }),
);

server.registerTool(
  'add_note',
  {
    title: 'Thêm ghi chú nội bộ',
    description: 'Thêm ghi chú nội bộ vào hội thoại (khách KHÔNG thấy). Dùng để tóm tắt, bàn giao, hoặc nháp câu trả lời cho nhân viên duyệt.',
    inputSchema: { conversation_id: z.string(), text: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  tool(async ({ conversation_id, text }) => {
    await api(`/conversations/${encodeURIComponent(conversation_id)}/notes`, { method: 'POST', body: { text, author: 'Claude' } });
    return ok('Đã thêm ghi chú nội bộ.');
  }),
);

server.registerTool(
  'update_conversation',
  {
    title: 'Cập nhật hội thoại',
    description: 'Đổi trạng thái (open/replied/done), người phụ trách, nhãn (ghi đè toàn bộ danh sách) hoặc ghi chú về khách.',
    inputSchema: {
      conversation_id: z.string(),
      status: z.enum(['open', 'replied', 'done']).optional(),
      assigned: z.string().optional().describe('Tên nhân viên, chuỗi rỗng để bỏ giao'),
      tags: z.array(z.string()).optional(),
      note: z.string().optional().describe('Ghi chú cố định về khách (SĐT, địa chỉ…), ghi đè ghi chú cũ'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tool(async ({ conversation_id, ...patch }) => {
    const c = await api(`/conversations/${encodeURIComponent(conversation_id)}`, { method: 'PATCH', body: patch });
    return ok(`Đã cập nhật: ${convLine(c)}`, { conversation: c });
  }),
);

server.registerTool(
  'mark_read',
  {
    title: 'Đánh dấu đã đọc',
    description: 'Đánh dấu hội thoại đã đọc (gửi "đã xem" tới khách trên Messenger).',
    inputSchema: { conversation_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ conversation_id }) => {
    await api(`/conversations/${encodeURIComponent(conversation_id)}/read`, { method: 'POST' });
    return ok('Đã đánh dấu đã đọc.');
  }),
);

server.registerTool(
  'reply_comment',
  {
    title: 'Trả lời bình luận',
    description: 'Đăng trả lời CÔNG KHAI dưới bình luận trên Facebook, tuỳ chọn gửi thêm tin nhắn riêng (private reply) cho người bình luận.',
    inputSchema: {
      comment_id: z.string(),
      message: z.string().min(1).max(8000),
      private_reply: z.boolean().default(false).describe('Gửi thêm nội dung này qua Messenger cho người bình luận'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ comment_id, message, private_reply = false }) => {
    const r = await api(`/comments/${encodeURIComponent(comment_id)}/reply`, { method: 'POST', body: { message, private_reply } });
    return ok(`Đã trả lời bình luận${r.private_sent ? ' và gửi tin nhắn riêng' : ''}: "${r.reply?.message || message}"`, r);
  }),
);

server.registerTool(
  'hide_comment',
  {
    title: 'Ẩn/hiện bình luận',
    description: 'Ẩn bình luận (chỉ người viết và bạn bè họ còn thấy) hoặc hiện lại. Dùng cho spam, quảng cáo, ngôn từ xấu.',
    inputSchema: { comment_id: z.string(), hidden: z.boolean().default(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ comment_id, hidden = true }) => {
    await api(`/comments/${encodeURIComponent(comment_id)}/hide`, { method: 'POST', body: { hidden } });
    return ok(hidden ? 'Đã ẩn bình luận.' : 'Đã hiện lại bình luận.');
  }),
);

server.registerTool(
  'mark_comment_handled',
  {
    title: 'Đánh dấu bình luận đã xử lý',
    description: 'Đánh dấu bình luận là đã xử lý (không cần trả lời) để bỏ khỏi danh sách chờ, chỉ trong hệ thống này.',
    inputSchema: { comment_id: z.string(), handled: z.boolean().default(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tool(async ({ comment_id, handled = true }) => {
    await api(`/comments/${encodeURIComponent(comment_id)}/mark`, { method: 'POST', body: { replied: handled } });
    return ok('Đã cập nhật.');
  }),
);

server.registerTool(
  'delete_comment',
  {
    title: 'Xoá bình luận',
    description: 'XOÁ VĨNH VIỄN bình luận trên Facebook. Không thể hoàn tác. Chỉ dùng khi người dùng yêu cầu rõ ràng; thông thường nên dùng hide_comment.',
    inputSchema: { comment_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ comment_id }) => {
    await api(`/comments/${encodeURIComponent(comment_id)}`, { method: 'DELETE' });
    return ok('Đã xoá bình luận.');
  }),
);

server.registerTool(
  'sync_page',
  {
    title: 'Đồng bộ trang',
    description: 'Kéo dữ liệu mới nhất (hội thoại, tin nhắn, bài viết, bình luận) từ Facebook Graph API cho một trang.',
    inputSchema: { page_id: z.string(), deep: z.boolean().default(false).describe('Lấy nhiều lịch sử hơn (chậm hơn)') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ page_id, deep = false }) => {
    const r = await api(`/pages/${encodeURIComponent(page_id)}/sync`, { method: 'POST', body: { deep } });
    const x = r.result || {};
    return ok(x.skipped ? `Bỏ qua (${x.skipped}).` : `Đồng bộ xong: ${x.conversations} hội thoại, +${x.messages} tin, ${x.posts} bài, +${x.comments} bình luận.`, r);
  }),
);

server.registerTool(
  'create_auto_rule',
  {
    title: 'Tạo luật trả lời tự động',
    description: 'Tạo luật tự động trả lời khi tin nhắn/bình luận khớp từ khoá. Nhiều từ khoá cách nhau bằng dấu phẩy. Biến {name}, {page}.',
    inputSchema: {
      name: z.string(),
      keyword: z.string().describe('Từ khoá; bỏ trống nếu match_type="any"'),
      reply: z.string().min(1),
      match_type: z.enum(['contains', 'exact', 'starts', 'regex', 'any']).default('contains'),
      apply_to: z.enum(['message', 'comment', 'both']).default('message'),
      private_reply: z.boolean().default(false).describe('Với bình luận: gửi thêm tin nhắn riêng'),
      priority: z.number().int().default(0),
      page_id: z.string().optional().describe('Bỏ trống = áp dụng mọi trang'),
      enabled: z.boolean().default(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  tool(async (args) => {
    const r = await api('/rules', { method: 'POST', body: args });
    return ok(`Đã tạo luật #${r.id} "${r.name}".`, { rule: r });
  }),
);

server.registerTool(
  'update_auto_rule',
  {
    title: 'Sửa luật trả lời tự động',
    description: 'Sửa hoặc bật/tắt một luật trả lời tự động. Chỉ truyền các trường cần đổi.',
    inputSchema: {
      rule_id: z.number().int(),
      name: z.string().optional(),
      keyword: z.string().optional(),
      reply: z.string().optional(),
      match_type: z.enum(['contains', 'exact', 'starts', 'regex', 'any']).optional(),
      apply_to: z.enum(['message', 'comment', 'both']).optional(),
      private_reply: z.boolean().optional(),
      priority: z.number().int().optional(),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tool(async ({ rule_id, ...patch }) => {
    const r = await api(`/rules/${rule_id}`, { method: 'PUT', body: patch });
    return ok(`Đã cập nhật luật #${r.id} (${r.enabled ? 'bật' : 'tắt'}).`, { rule: r });
  }),
);

server.registerTool(
  'delete_auto_rule',
  {
    title: 'Xoá luật trả lời tự động',
    description: 'Xoá một luật trả lời tự động.',
    inputSchema: { rule_id: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  tool(async ({ rule_id }) => {
    await api(`/rules/${rule_id}`, { method: 'DELETE' });
    return ok(`Đã xoá luật #${rule_id}.`);
  }),
);

server.registerTool(
  'create_quick_reply',
  {
    title: 'Tạo câu trả lời mẫu',
    description: 'Thêm câu trả lời nhanh để nhân viên chèn bằng /phím-tắt.',
    inputSchema: { shortcut: z.string().min(1), title: z.string().optional(), body: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  tool(async (args) => {
    const r = await api('/quick-replies', { method: 'POST', body: args });
    return ok(`Đã tạo /${r.shortcut}.`, { quick_reply: r });
  }),
);

/* ---------- Prompt mẫu ---------- */
server.registerPrompt(
  'tra-loi-tin-nhan-cho',
  {
    title: 'Xử lý tin nhắn đang chờ',
    description: 'Duyệt các hội thoại cần trả lời, soạn câu trả lời và chờ người dùng duyệt trước khi gửi.',
    argsSchema: { page_id: z.string().optional() },
  },
  ({ page_id }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Hãy dùng công cụ fanpage-manager để: 1) gọi list_quick_replies để nắm thông tin chuẩn của shop; 2) list_conversations status="open"${page_id ? ` page_id="${page_id}"` : ''}; 3) với từng hội thoại, get_conversation và soạn một câu trả lời ngắn gọn, lịch sự bằng tiếng Việt. Trình bày danh sách các câu trả lời đề xuất cho tôi duyệt, KHÔNG gửi cho đến khi tôi đồng ý. Hội thoại nào đã ngoài cửa sổ 24 giờ thì đề xuất ghi chú nội bộ thay vì gửi.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  'bao-cao-ngay',
  {
    title: 'Báo cáo chăm sóc khách hàng',
    description: 'Tóm tắt tình hình fanpage: số liệu, chủ đề khách hỏi nhiều, hội thoại tồn đọng, bình luận cần xử lý.',
    argsSchema: {},
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Dùng fanpage-manager: gọi fanpage_overview, list_conversations (status="all", limit=50), list_comments. Viết báo cáo ngắn bằng tiếng Việt gồm: số liệu chính, 3-5 chủ đề khách hỏi nhiều nhất, các hội thoại tồn đọng lâu nhất (kèm ID), bình luận cần xử lý gấp, và đề xuất luật trả lời tự động hoặc câu trả lời mẫu mới.',
        },
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[fanpage-mcp] sẵn sàng, kết nối tới ${BASE}`);
