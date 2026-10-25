import { config } from './config.js';
import { graph, GraphError } from './graph.js';
import { get, nowIso } from './db.js';
import * as store from './store.js';

export const isDemoPage = (page) => config.demo || page?.access_token === 'demo';

function guessAttachmentType(url) {
  const u = url.toLowerCase().split('?')[0];
  if (/\.(png|jpe?g|gif|webp)$/.test(u)) return 'image';
  if (/\.(mp4|mov|webm)$/.test(u)) return 'video';
  if (/\.(mp3|wav|m4a|ogg)$/.test(u)) return 'audio';
  return 'file';
}

export function describeError(e) {
  if (e instanceof GraphError) return e.hint ? `${e.message} — ${e.hint}` : e.message;
  return e?.message || String(e);
}

/**
 * Gửi tin nhắn từ trang tới khách hàng và lưu vào CSDL.
 * Trả về bản ghi tin nhắn. Ném lỗi (đã lưu tin trạng thái failed) nếu Facebook từ chối.
 */
export async function sendMessage(page, psid, { text = '', attachmentUrl = '', source = 'app', tag } = {}) {
  const createdTime = nowIso();
  const attachments = attachmentUrl ? [{ type: guessAttachmentType(attachmentUrl), url: attachmentUrl }] : [];
  if (!text && !attachments.length) throw new Error('Nội dung tin nhắn trống');

  if (isDemoPage(page)) {
    const r = store.insertMessage({ pageId: page.id, psid, fromType: 'page', text, attachments, createdTime, status: 'sent', source });
    return r.message;
  }

  try {
    let mid = null;
    if (text) {
      const res = await graph.sendText(page.id, page.access_token, psid, text, { tag });
      mid = res.message_id || null;
    }
    if (attachments.length) {
      const res = await graph.sendAttachment(page.id, page.access_token, psid, attachments[0].type, attachmentUrl);
      mid = mid || res.message_id || null;
    }
    const r = store.insertMessage({ id: mid || undefined, pageId: page.id, psid, fromType: 'page', text, attachments, createdTime, status: 'sent', source });
    if (r.inserted) return r.message;
    // Echo từ webhook đã lưu trước -> bổ sung nguồn gửi
    store.updateMessage(r.id, { source, status: 'sent' });
    return getMessage(r.id);
  } catch (e) {
    const err = describeError(e);
    const r = store.insertMessage({ pageId: page.id, psid, fromType: 'page', text, attachments, createdTime, status: 'failed', error: err, source });
    store.logActivity('send-failed', page.id, `${psid}: ${err}`);
    const wrapped = new Error(err);
    wrapped.status = 502;
    wrapped.code = e.code;
    wrapped.messageRow = r.message;
    throw wrapped;
  }
}

export function getMessage(id) {
  const m = get('SELECT * FROM messages WHERE id=?', id);
  if (m) m.attachments = JSON.parse(m.attachments || '[]');
  return m;
}

/** Đánh dấu đã xem với khách (hiển thị "Đã xem" trên Messenger). Bỏ qua lỗi. */
export async function markSeen(page, psid) {
  if (isDemoPage(page)) return;
  try {
    await graph.senderAction(page.id, page.access_token, psid, 'mark_seen');
  } catch {
    /* không quan trọng */
  }
}

/** Trả lời bình luận công khai, tuỳ chọn gửi thêm tin nhắn riêng. */
export async function replyComment(page, comment, { message = '', privateReply = false, source = 'app' } = {}) {
  if (!message) throw new Error('Nội dung trả lời trống');
  const createdTime = nowIso();
  let publicId = null;
  let privateSent = false;

  if (isDemoPage(page)) {
    publicId = store.newId('c');
  } else {
    try {
      const res = await graph.replyComment(comment.id, page.access_token, message);
      publicId = res.id;
      if (privateReply) {
        try {
          await graph.privateReply(page.id, page.access_token, comment.id, message);
          privateSent = true;
        } catch (e) {
          store.logActivity('private-reply-failed', page.id, `${comment.id}: ${describeError(e)}`);
        }
      }
    } catch (e) {
      const err = describeError(e);
      store.logActivity('comment-reply-failed', page.id, `${comment.id}: ${err}`);
      const wrapped = new Error(err);
      wrapped.status = 502;
      throw wrapped;
    }
  }

  const r = store.upsertComment(page.id, {
    id: publicId,
    postId: comment.post_id,
    parentId: comment.id,
    from: { id: page.id, name: page.name },
    message,
    created_time: createdTime,
  });
  store.setCommentFlags(comment.id, { replied: 1 });
  store.logActivity(source === 'auto' ? 'auto-comment-reply' : 'comment-reply', page.id, `${comment.from_name || comment.from_id}: ${message.slice(0, 80)}`);
  return { reply: r.comment, private_sent: privateSent || (isDemoPage(page) && privateReply) };
}

export async function hideComment(page, comment, hidden) {
  if (!isDemoPage(page)) {
    try {
      await graph.hideComment(comment.id, page.access_token, hidden);
    } catch (e) {
      const wrapped = new Error(describeError(e));
      wrapped.status = 502;
      throw wrapped;
    }
  }
  store.setCommentFlags(comment.id, { is_hidden: hidden ? 1 : 0 });
  store.logActivity(hidden ? 'comment-hidden' : 'comment-unhidden', page.id, comment.id);
  return store.getComment(comment.id);
}

export async function deleteComment(page, comment) {
  if (!isDemoPage(page)) {
    try {
      await graph.deleteComment(comment.id, page.access_token);
    } catch (e) {
      const wrapped = new Error(describeError(e));
      wrapped.status = 502;
      throw wrapped;
    }
  }
  store.setCommentFlags(comment.id, { removed: 1 });
  store.logActivity('comment-deleted', page.id, comment.id);
}

/** Lấy tên/ảnh khách từ Graph nếu chưa có. Không ném lỗi. */
export async function ensureCustomerProfile(page, psid) {
  const existing = store.getCustomer(page.id, psid);
  if (existing?.name) return existing;
  if (isDemoPage(page)) return existing;
  try {
    const p = await graph.userProfile(psid, page.access_token);
    const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    store.upsertCustomer(page.id, psid, { name, picture: p.profile_pic || '' });
    const conv = store.getConversation(store.convKey(page.id, psid));
    if (conv) store.patchConversation(conv.id, {}); // phát sự kiện cập nhật tên
    return store.getCustomer(page.id, psid);
  } catch (e) {
    store.logActivity('profile-failed', page.id, `${psid}: ${describeError(e)}`);
    return existing;
  }
}
