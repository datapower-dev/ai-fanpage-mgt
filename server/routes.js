import { Router } from 'express';
import { config } from './config.js';
import { all, get, run, getSetting, setSetting } from './db.js';
import { graph, GraphError } from './graph.js';
import * as store from './store.js';
import { sendMessage, replyComment, hideComment, deleteComment, markSeen, describeError, isDemoPage } from './messaging.js';
import { syncPage } from './sync.js';
import { simulateIncoming, simulateComment } from './demo.js';
import { renderTemplate } from './autoreply.js';
import { createPost, getPostDetail, deletePost } from './posts.js';
import { connectionStatus, saveAppConfig, clearAppSecret, importPagesFromUserToken } from './facebook.js';

export const api = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function pageOr404(id) {
  const page = store.getPage(id);
  if (!page) throw bad('Không tìm thấy trang', 404);
  return page;
}

/* ---------- Hệ thống ---------- */
api.get('/me', (req, res) => {
  res.json({
    demo: config.demo,
    graph_version: config.graphVersion,
    has_app_secret: !!config.appSecret,
    has_app_id: !!config.appId,
    verify_token_default: config.verifyToken === 'fanpage-verify-token',
    webhook_path: '/webhook',
    sync_interval_sec: config.syncIntervalSec,
    auth_enabled: !!config.adminPassword,
  });
});

/* ---------- Kết nối Facebook / Claude ---------- */
api.get('/connect', (req, res) => res.json(connectionStatus(req)));
api.put('/connect/app', (req, res) => {
  if (config.demo) throw bad('Chế độ demo không kết nối Facebook thật. Hãy chạy "npm start".', 400);
  saveAppConfig(req.body || {});
  store.logActivity('app-config-saved', null, 'Đã lưu cấu hình ứng dụng Facebook');
  res.json(connectionStatus(req));
});
api.delete('/connect/app-secret', (req, res) => {
  clearAppSecret();
  res.json(connectionStatus(req));
});

/* ---------- Trang ---------- */
api.get('/pages', (req, res) => res.json(store.listPages()));

api.post(
  '/pages',
  wrap(async (req, res) => {
    const { access_token, id, name } = req.body || {};
    if (config.demo && !access_token) {
      const pid = id || `demo_page_${Date.now()}`;
      return res.json(store.upsertPage({ id: pid, name: name || 'Trang demo', access_token: 'demo' }));
    }
    if (!access_token) throw bad('Thiếu access_token của trang');
    const info = await graph.pageInfo(id || 'me', access_token);
    if (!info?.id) throw bad('Token không phải Page Access Token hợp lệ');
    const page = store.upsertPage({ ...info, access_token });
    let subscribed = false;
    try {
      await graph.subscribeApp(info.id, access_token);
      subscribed = true;
      store.setPageMeta(info.id, { subscribed: 1 });
    } catch (e) {
      store.logActivity('subscribe-failed', info.id, describeError(e));
    }
    store.logActivity('page-added', info.id, info.name);
    syncPage(store.getPage(info.id), { deep: true }).catch(() => {});
    res.json({ ...page, subscribed });
  }),
);

api.post(
  '/pages/import',
  wrap(async (req, res) => {
    const { user_token } = req.body || {};
    if (!user_token) throw bad('Thiếu user_token');
    res.json(await importPagesFromUserToken(String(user_token).trim()));
  }),
);

api.patch('/pages/:id', (req, res) => {
  pageOr404(req.params.id);
  const fields = {};
  if (req.body?.enabled !== undefined) fields.enabled = req.body.enabled ? 1 : 0;
  if (req.body?.access_token) fields.access_token = String(req.body.access_token);
  store.setPageMeta(req.params.id, fields);
  res.json(store.publicPage(store.getPage(req.params.id)));
});

api.delete('/pages/:id', (req, res) => {
  pageOr404(req.params.id);
  store.deletePage(req.params.id);
  store.logActivity('page-removed', req.params.id, '');
  res.json({ ok: true });
});

api.post(
  '/pages/:id/sync',
  wrap(async (req, res) => {
    const page = pageOr404(req.params.id);
    const result = await syncPage(page, { deep: req.query.deep === '1' || req.body?.deep === true });
    res.json({ ok: true, result, page: store.publicPage(store.getPage(page.id)) });
  }),
);

api.post(
  '/pages/:id/subscribe',
  wrap(async (req, res) => {
    const page = pageOr404(req.params.id);
    if (isDemoPage(page)) return res.json({ ok: true, demo: true });
    const r = await graph.subscribeApp(page.id, page.access_token);
    store.setPageMeta(page.id, { subscribed: 1 });
    res.json({ ok: true, result: r });
  }),
);

/* ---------- Thống kê ---------- */
api.get('/stats', (req, res) => res.json(store.stats(req.query.page_id || null)));
api.get('/activity', (req, res) => res.json(store.listActivity(Number(req.query.limit) || 50)));

/* ---------- Hội thoại ---------- */
api.get('/conversations', (req, res) => {
  res.json(
    store.listConversations({
      pageId: req.query.page_id || null,
      status: req.query.status || 'all',
      q: req.query.q || '',
      limit: Math.min(Number(req.query.limit) || 100, 500),
      offset: Number(req.query.offset) || 0,
    }),
  );
});

api.get('/conversations/:id', (req, res) => {
  const conv = store.getConversation(req.params.id);
  if (!conv) throw bad('Không tìm thấy hội thoại', 404);
  res.json({
    conversation: store.withJoins(conv),
    customer: store.getCustomer(conv.page_id, conv.psid),
    messages: store.listMessages(conv.id, Number(req.query.limit) || 200),
  });
});

api.post(
  '/conversations/:id/reply',
  wrap(async (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) throw bad('Không tìm thấy hội thoại', 404);
    const page = pageOr404(conv.page_id);
    const customer = store.getCustomer(conv.page_id, conv.psid);
    const text = renderTemplate(String(req.body?.text || ''), { name: customer?.name || conv.customer_name, page: page.name });
    const message = await sendMessage(page, conv.psid, {
      text,
      attachmentUrl: req.body?.attachment_url || '',
      tag: req.body?.tag || undefined,
      source: req.body?.source === 'mcp' ? 'mcp' : 'app',
    });
    store.markRead(conv.id);
    res.json({ ok: true, message, conversation: store.withJoins(store.getConversation(conv.id)) });
  }),
);

api.post('/conversations/:id/notes', (req, res) => {
  const conv = store.getConversation(req.params.id);
  if (!conv) throw bad('Không tìm thấy hội thoại', 404);
  const text = String(req.body?.text || '').trim();
  if (!text) throw bad('Ghi chú trống');
  const r = store.insertMessage({
    pageId: conv.page_id,
    psid: conv.psid,
    fromType: 'note',
    fromId: String(req.body?.author || 'admin'),
    text,
    createdTime: Date.now(),
    source: 'app',
  });
  res.json({ ok: true, message: r.message });
});

api.post(
  '/conversations/:id/read',
  wrap(async (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) throw bad('Không tìm thấy hội thoại', 404);
    const c = store.markRead(conv.id);
    const page = store.getPage(conv.page_id);
    if (page) markSeen(page, conv.psid);
    res.json(store.withJoins(c));
  }),
);

api.patch('/conversations/:id', (req, res) => {
  const c = store.patchConversation(req.params.id, req.body || {});
  if (!c) throw bad('Không tìm thấy hội thoại', 404);
  res.json(c);
});

/* ---------- Bài viết & bình luận ---------- */
api.get('/posts', (req, res) => res.json(store.listPosts(req.query.page_id || null, Number(req.query.limit) || 50)));
api.post(
  '/pages/:id/posts',
  wrap(async (req, res) => {
    const page = pageOr404(req.params.id);
    const post = await createPost(page, req.body || {});
    res.json({ ok: true, post });
  }),
);
api.get(
  '/posts/:id',
  wrap(async (req, res) => res.json(await getPostDetail(req.params.id, { refresh: req.query.refresh === '1' }))),
);
api.delete(
  '/posts/:id',
  wrap(async (req, res) => {
    await deletePost(req.params.id);
    res.json({ ok: true });
  }),
);
api.get('/posts/:id/comments', (req, res) => res.json(store.listComments({ postId: req.params.id, limit: 500 })));
api.get('/comments', (req, res) =>
  res.json(
    store.listComments({
      pageId: req.query.page_id || null,
      pending: req.query.pending === '1',
      limit: Math.min(Number(req.query.limit) || 200, 1000),
    }),
  ),
);

api.post(
  '/comments/:id/reply',
  wrap(async (req, res) => {
    const comment = store.getComment(req.params.id);
    if (!comment) throw bad('Không tìm thấy bình luận', 404);
    const page = pageOr404(comment.page_id);
    const message = renderTemplate(String(req.body?.message || ''), { name: comment.from_name, page: page.name });
    const r = await replyComment(page, comment, { message, privateReply: !!req.body?.private_reply });
    res.json({ ok: true, ...r, comment: store.getComment(comment.id) });
  }),
);

api.post(
  '/comments/:id/hide',
  wrap(async (req, res) => {
    const comment = store.getComment(req.params.id);
    if (!comment) throw bad('Không tìm thấy bình luận', 404);
    const page = pageOr404(comment.page_id);
    res.json(await hideComment(page, comment, req.body?.hidden !== false));
  }),
);

api.post('/comments/:id/mark', (req, res) => {
  const comment = store.getComment(req.params.id);
  if (!comment) throw bad('Không tìm thấy bình luận', 404);
  store.setCommentFlags(comment.id, { replied: req.body?.replied === false ? 0 : 1 });
  res.json(store.getComment(comment.id));
});

api.delete(
  '/comments/:id',
  wrap(async (req, res) => {
    const comment = store.getComment(req.params.id);
    if (!comment) throw bad('Không tìm thấy bình luận', 404);
    const page = pageOr404(comment.page_id);
    await deleteComment(page, comment);
    res.json({ ok: true });
  }),
);

/* ---------- Trả lời nhanh ---------- */
api.get('/quick-replies', (req, res) => res.json(all('SELECT * FROM quick_replies ORDER BY shortcut')));
api.post('/quick-replies', (req, res) => {
  const { shortcut, title, body } = req.body || {};
  if (!shortcut || !body) throw bad('Cần shortcut và body');
  const r = run('INSERT INTO quick_replies(shortcut,title,body) VALUES(?,?,?)', String(shortcut).replace(/^\//, ''), title || shortcut, body);
  res.json(get('SELECT * FROM quick_replies WHERE id=?', r.lastInsertRowid));
});
api.put('/quick-replies/:id', (req, res) => {
  const { shortcut, title, body } = req.body || {};
  run('UPDATE quick_replies SET shortcut=COALESCE(?,shortcut), title=COALESCE(?,title), body=COALESCE(?,body) WHERE id=?', shortcut ?? null, title ?? null, body ?? null, req.params.id);
  res.json(get('SELECT * FROM quick_replies WHERE id=?', req.params.id));
});
api.delete('/quick-replies/:id', (req, res) => {
  run('DELETE FROM quick_replies WHERE id=?', req.params.id);
  res.json({ ok: true });
});

/* ---------- Luật trả lời tự động ---------- */
api.get('/rules', (req, res) => res.json(all('SELECT * FROM auto_rules ORDER BY priority DESC, id')));
api.post('/rules', (req, res) => {
  const b = req.body || {};
  if (!b.reply) throw bad('Cần nội dung reply');
  const r = run(
    'INSERT INTO auto_rules(page_id,enabled,name,match_type,keyword,reply,apply_to,private_reply,priority) VALUES(?,?,?,?,?,?,?,?,?)',
    b.page_id || null,
    b.enabled === false ? 0 : 1,
    b.name || '',
    b.match_type || 'contains',
    b.keyword || '',
    b.reply,
    b.apply_to || 'message',
    b.private_reply ? 1 : 0,
    Number(b.priority) || 0,
  );
  res.json(get('SELECT * FROM auto_rules WHERE id=?', r.lastInsertRowid));
});
api.put('/rules/:id', (req, res) => {
  const b = req.body || {};
  const cur = get('SELECT * FROM auto_rules WHERE id=?', req.params.id);
  if (!cur) throw bad('Không tìm thấy luật', 404);
  run(
    'UPDATE auto_rules SET page_id=?,enabled=?,name=?,match_type=?,keyword=?,reply=?,apply_to=?,private_reply=?,priority=? WHERE id=?',
    b.page_id !== undefined ? b.page_id || null : cur.page_id,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : cur.enabled,
    b.name ?? cur.name,
    b.match_type ?? cur.match_type,
    b.keyword ?? cur.keyword,
    b.reply ?? cur.reply,
    b.apply_to ?? cur.apply_to,
    b.private_reply !== undefined ? (b.private_reply ? 1 : 0) : cur.private_reply,
    b.priority !== undefined ? Number(b.priority) || 0 : cur.priority,
    req.params.id,
  );
  res.json(get('SELECT * FROM auto_rules WHERE id=?', req.params.id));
});
api.delete('/rules/:id', (req, res) => {
  run('DELETE FROM auto_rules WHERE id=?', req.params.id);
  res.json({ ok: true });
});

/* ---------- Cài đặt ---------- */
api.get('/settings', (req, res) => {
  res.json({
    offhours: getSetting('offhours', { enabled: false, start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5, 6], reply: '' }),
    agents: getSetting('agents', []),
    tags: getSetting('tags', ['hỏi giá', 'đã mua', 'khiếu nại', 'VIP']),
  });
});
api.put('/settings', (req, res) => {
  const b = req.body || {};
  if (b.offhours) setSetting('offhours', b.offhours);
  if (Array.isArray(b.agents)) setSetting('agents', b.agents.map(String));
  if (Array.isArray(b.tags)) setSetting('tags', b.tags.map(String));
  res.json({ ok: true });
});

/* ---------- Demo ---------- */
api.post(
  '/demo/incoming',
  wrap(async (req, res) => {
    if (!config.demo) throw bad('Chỉ dùng ở chế độ demo', 403);
    res.json(await simulateIncoming(req.body || {}));
  }),
);
api.post(
  '/demo/comment',
  wrap(async (req, res) => {
    if (!config.demo) throw bad('Chỉ dùng ở chế độ demo', 403);
    res.json(await simulateComment(req.body || {}));
  }),
);

/* ---------- Lỗi ---------- */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof GraphError) {
    return res.status(502).json({ error: err.message, hint: err.hint, code: err.code, subcode: err.subcode });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Lỗi không xác định', code: err.code });
}
