import crypto from 'node:crypto';
import { config } from './config.js';
import { setSetting, nowIso } from './db.js';
import * as store from './store.js';
import { ensureCustomerProfile } from './messaging.js';
import { handleIncomingComment, handleIncomingMessage } from './autoreply.js';

let warnedNoSecret = false;

/** GET /webhook — Facebook xác minh URL. */
export function verifyHandler(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.verifyToken) {
    store.logActivity('webhook-verified', null, 'Facebook đã xác minh webhook');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verify token không đúng');
}

export function verifySignature(req) {
  if (!config.appSecret) {
    if (!warnedNoSecret) {
      console.warn('[webhook] FB_APP_SECRET chưa đặt: bỏ qua kiểm tra chữ ký (không an toàn khi chạy thật).');
      warnedNoSecret = true;
    }
    return true;
  }
  const sig = req.get('x-hub-signature-256') || '';
  if (!sig.startsWith('sha256=') || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.appSecret).update(req.rawBody).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** POST /webhook — nhận sự kiện. Trả 200 ngay, xử lý sau. */
export function receiveHandler(req, res) {
  if (!verifySignature(req)) {
    store.logActivity('webhook-bad-signature', null, 'Chữ ký không hợp lệ');
    return res.status(401).send('Bad signature');
  }
  res.status(200).send('EVENT_RECEIVED');
  setSetting('last_webhook_at', nowIso());
  const body = req.body;
  if (!body || (body.object !== 'page' && body.object !== 'instagram')) return;
  for (const entry of body.entry || []) {
    processEntry(entry).catch((e) => {
      console.error('[webhook] lỗi xử lý entry:', e);
      store.logActivity('webhook-error', entry?.id, e.message);
    });
  }
}

export async function processEntry(entry) {
  const pageId = String(entry.id);
  const page = store.getPage(pageId);
  if (!page) {
    store.logActivity('webhook-unknown-page', pageId, 'Nhận sự kiện của trang chưa được thêm vào hệ thống');
    return;
  }
  for (const ev of entry.messaging || []) await handleMessaging(page, ev);
  for (const ch of entry.changes || []) {
    if (ch.field === 'feed') await handleFeed(page, ch.value || {});
  }
}

export async function handleMessaging(page, ev) {
  if (ev.message) {
    const isEcho = !!ev.message.is_echo;
    const psid = isEcho ? ev.recipient?.id : ev.sender?.id;
    if (!psid) return;
    const attachments = (ev.message.attachments || []).map((a) => ({
      type: a.type,
      url: a.payload?.url || '',
      title: a.title || a.payload?.title || '',
    }));
    const r = store.insertMessage({
      id: ev.message.mid,
      pageId: page.id,
      psid,
      fromType: isEcho ? 'page' : 'customer',
      fromId: isEcho ? page.id : psid,
      text: ev.message.text || (ev.message.sticker_id ? '[Sticker]' : ''),
      attachments,
      createdTime: ev.timestamp,
      status: isEcho ? 'sent' : 'received',
      source: 'webhook',
    });
    if (!isEcho && r.inserted) {
      const customer = await ensureCustomerProfile(page, psid);
      await handleIncomingMessage(page, psid, ev.message.text || '', customer || {});
    }
    return;
  }
  if (ev.postback) {
    const psid = ev.sender?.id;
    if (!psid) return;
    const text = ev.postback.title || ev.postback.payload || '[Postback]';
    const r = store.insertMessage({
      pageId: page.id,
      psid,
      fromType: 'customer',
      fromId: psid,
      text,
      createdTime: ev.timestamp,
      source: 'webhook',
    });
    if (r.inserted) {
      const customer = await ensureCustomerProfile(page, psid);
      await handleIncomingMessage(page, psid, text, customer || {});
    }
  }
  // ev.read / ev.delivery / ev.reaction: hiện bỏ qua
}

export async function handleFeed(page, v) {
  if (v.item === 'comment') {
    if (v.verb === 'remove') {
      if (v.comment_id) store.setCommentFlags(v.comment_id, { removed: 1 });
      return;
    }
    if (!v.comment_id || !v.post_id) return;
    if (!store.getPost(v.post_id)) {
      store.upsertPost(page.id, {
        id: v.post_id,
        message: v.post?.message || '',
        created_time: v.created_time,
        permalink_url: v.post?.permalink_url || '',
      });
    }
    const parentId = v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null;
    const r = store.upsertComment(page.id, {
      id: v.comment_id,
      postId: v.post_id,
      parentId,
      from: v.from,
      message: v.message || '',
      created_time: v.created_time,
      is_hidden: false,
    });
    if (r.inserted && v.verb === 'add' && v.from?.id !== page.id) {
      store.logActivity('comment', page.id, `${v.from?.name || 'Ai đó'}: ${(v.message || '').slice(0, 80)}`);
      await handleIncomingComment(page, r.comment);
    }
    return;
  }
  if ((v.item === 'post' || v.item === 'status' || v.item === 'photo' || v.item === 'video') && v.verb === 'add' && v.post_id) {
    store.upsertPost(page.id, {
      id: v.post_id,
      message: v.message || '',
      created_time: v.created_time,
      permalink_url: v.link || '',
    });
  }
}
