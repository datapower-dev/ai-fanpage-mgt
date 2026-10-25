import { all, getSetting, run, nowIso } from './db.js';
import * as store from './store.js';
import { sendMessage, replyComment } from './messaging.js';

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFC')
    .trim();
}

export function matchRule(rule, text) {
  const t = normalize(text);
  const k = normalize(rule.keyword);
  switch (rule.match_type) {
    case 'any':
      return true;
    case 'exact':
      return t === k;
    case 'starts':
      return !!k && t.startsWith(k);
    case 'regex':
      try {
        return new RegExp(rule.keyword, 'iu').test(text || '');
      } catch {
        return false;
      }
    case 'contains':
    default:
      // Hỗ trợ nhiều từ khoá cách nhau bởi dấu phẩy hoặc |
      return k
        .split(/[,|]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .some((x) => t.includes(x));
  }
}

export function findRule(pageId, text, kind) {
  const rules = all(
    `SELECT * FROM auto_rules WHERE enabled=1 AND (page_id IS NULL OR page_id='' OR page_id=?)
       AND (apply_to=? OR apply_to='both') ORDER BY priority DESC, id ASC`,
    pageId,
    kind,
  );
  return rules.find((r) => matchRule(r, text)) || null;
}

export function renderTemplate(tpl, ctx = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => (ctx[key] !== undefined && ctx[key] !== '' ? ctx[key] : m === '{name}' ? 'bạn' : ''));
}

/** Kiểm tra có đang ngoài giờ làm việc theo cài đặt không. */
export function isOffHours(settings = getSetting('offhours')) {
  if (!settings?.enabled) return false;
  const now = new Date();
  const days = Array.isArray(settings.days) && settings.days.length ? settings.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(now.getDay())) return true; // ngày nghỉ
  const toMin = (s) => {
    const [h, m] = String(s || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const start = toMin(settings.start || '08:00');
  const end = toMin(settings.end || '18:00');
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return cur < start || cur >= end;
  return cur < start && cur >= end; // ca đêm (ví dụ 20:00 -> 06:00)
}

/**
 * Xử lý tin nhắn khách vừa đến (chỉ gọi từ webhook/demo, không gọi khi đồng bộ lịch sử).
 */
export async function handleIncomingMessage(page, psid, text, customer = {}) {
  const convId = store.convKey(page.id, psid);
  const ctx = { name: customer.name || '', page: page.name || '' };

  const rule = findRule(page.id, text, 'message');
  if (rule) {
    const reply = renderTemplate(rule.reply, ctx);
    if (reply) {
      await sendMessage(page, psid, { text: reply, source: 'auto' }).catch(() => {});
      run('UPDATE conversations SET last_auto_reply_at=? WHERE id=?', nowIso(), convId);
      store.logActivity('auto-reply', page.id, `${rule.name || rule.keyword} -> ${customer.name || psid}`);
      return { type: 'rule', rule };
    }
  }

  const off = getSetting('offhours');
  if (isOffHours(off) && off?.reply) {
    const conv = store.getConversation(convId);
    const last = conv?.last_auto_reply_at ? new Date(conv.last_auto_reply_at).getTime() : 0;
    if (Date.now() - last > 12 * 3600e3) {
      await sendMessage(page, psid, { text: renderTemplate(off.reply, ctx), source: 'auto' }).catch(() => {});
      run('UPDATE conversations SET last_auto_reply_at=? WHERE id=?', nowIso(), convId);
      store.logActivity('offhours-reply', page.id, customer.name || psid);
      return { type: 'offhours' };
    }
  }
  return null;
}

/** Xử lý bình luận mới (webhook/demo). */
export async function handleIncomingComment(page, comment) {
  const rule = findRule(page.id, comment.message, 'comment');
  if (!rule) return null;
  const reply = renderTemplate(rule.reply, { name: comment.from_name || '', page: page.name || '' });
  if (!reply) return null;
  try {
    await replyComment(page, comment, { message: reply, privateReply: !!rule.private_reply, source: 'auto' });
    return { type: 'rule', rule };
  } catch {
    return null;
  }
}
