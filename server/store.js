import crypto from 'node:crypto';
import { all, get, run, nowIso, toIso } from './db.js';
import { emit } from './events.js';

export const convKey = (pageId, psid) => `${pageId}:${psid}`;
export const newId = (prefix = 'm') => `${prefix}_${crypto.randomUUID()}`;

/* ---------------- Pages ---------------- */

const PAGE_PUBLIC =
  'id,name,category,picture,link,fan_count,followers_count,enabled,subscribed,last_sync,last_error,created_at';

export function listPages() {
  return all(`SELECT ${PAGE_PUBLIC} FROM pages ORDER BY name`);
}
export function listEnabledPages() {
  return all('SELECT * FROM pages WHERE enabled=1 ORDER BY name');
}
export function getPage(id) {
  return get('SELECT * FROM pages WHERE id=?', id);
}
export function publicPage(p) {
  if (!p) return null;
  const { access_token, ...rest } = p;
  return { ...rest, has_token: !!access_token };
}

export function upsertPage(p) {
  run(
    `INSERT INTO pages(id,name,category,picture,link,access_token,fan_count,followers_count,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       category=COALESCE(NULLIF(excluded.category,''),pages.category),
       picture=COALESCE(NULLIF(excluded.picture,''),pages.picture),
       link=COALESCE(NULLIF(excluded.link,''),pages.link),
       access_token=COALESCE(NULLIF(excluded.access_token,''),pages.access_token),
       fan_count=COALESCE(excluded.fan_count,pages.fan_count),
       followers_count=COALESCE(excluded.followers_count,pages.followers_count)`,
    String(p.id),
    p.name || '',
    p.category || '',
    p.picture?.data?.url || p.picture || '',
    p.link || '',
    p.access_token || '',
    p.fan_count ?? null,
    p.followers_count ?? null,
    nowIso(),
  );
  const row = publicPage(getPage(String(p.id)));
  emit('page', row);
  return row;
}
export function setPageMeta(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE pages SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => fields[k]), id);
  emit('page', publicPage(getPage(id)));
}
export function deletePage(id) {
  run('DELETE FROM messages WHERE page_id=?', id);
  run('DELETE FROM conversations WHERE page_id=?', id);
  run('DELETE FROM customers WHERE page_id=?', id);
  run('DELETE FROM comments WHERE page_id=?', id);
  run('DELETE FROM posts WHERE page_id=?', id);
  run('DELETE FROM pages WHERE id=?', id);
  emit('page-removed', { id });
}

/* ---------------- Customers ---------------- */

export function upsertCustomer(pageId, psid, { name, picture } = {}) {
  const now = nowIso();
  run(
    `INSERT INTO customers(page_id,psid,name,picture,first_seen,last_seen) VALUES(?,?,?,?,?,?)
     ON CONFLICT(page_id,psid) DO UPDATE SET
       name=COALESCE(NULLIF(excluded.name,''),customers.name),
       picture=COALESCE(NULLIF(excluded.picture,''),customers.picture),
       last_seen=excluded.last_seen`,
    pageId,
    psid,
    name || '',
    picture || '',
    now,
    now,
  );
  if (name) run('UPDATE conversations SET customer_name=? WHERE id=?', name, convKey(pageId, psid));
}
export function getCustomer(pageId, psid) {
  return get('SELECT * FROM customers WHERE page_id=? AND psid=?', pageId, psid);
}

/* ---------------- Conversations ---------------- */

export function getConversation(id) {
  const c = get('SELECT * FROM conversations WHERE id=?', id);
  if (c) c.tags = JSON.parse(c.tags || '[]');
  return c;
}

export function ensureConversation(pageId, psid, { fbConvId, name } = {}) {
  const id = convKey(pageId, psid);
  const existing = get('SELECT id FROM conversations WHERE id=?', id);
  if (!existing) {
    run(
      `INSERT INTO conversations(id,page_id,psid,fb_conv_id,customer_name,created_at,updated_time)
       VALUES(?,?,?,?,?,?,?)`,
      id,
      pageId,
      psid,
      fbConvId || null,
      name || '',
      nowIso(),
      nowIso(),
    );
  } else {
    if (fbConvId) run('UPDATE conversations SET fb_conv_id=? WHERE id=? AND fb_conv_id IS NULL', fbConvId, id);
    if (name) run("UPDATE conversations SET customer_name=? WHERE id=? AND customer_name=''", name, id);
  }
  return id;
}

export function listConversations({ pageId, status, q, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (pageId) {
    where.push('c.page_id=?');
    params.push(pageId);
  }
  if (status && status !== 'all') {
    if (status === 'unread') where.push('c.unread>0');
    else {
      where.push('c.status=?');
      params.push(status);
    }
  }
  if (q) {
    where.push('(c.customer_name LIKE ? OR c.snippet LIKE ? OR c.psid LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sql = `SELECT c.*, p.name AS page_name, cu.picture AS customer_picture
     FROM conversations c
     LEFT JOIN pages p ON p.id=c.page_id
     LEFT JOIN customers cu ON cu.page_id=c.page_id AND cu.psid=c.psid
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.updated_time DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return all(sql, ...params).map((c) => ({ ...c, tags: JSON.parse(c.tags || '[]'), ...replyWindow(c) }));
}

export function listMessages(convId, limit = 200) {
  return all('SELECT * FROM messages WHERE conv_id=? ORDER BY created_time ASC LIMIT ?', convId, limit).map((m) => ({
    ...m,
    attachments: JSON.parse(m.attachments || '[]'),
  }));
}

/** Tính lại trạng thái hội thoại từ các tin nhắn đã lưu. */
export function recomputeConversation(convId) {
  const c = get('SELECT * FROM conversations WHERE id=?', convId);
  if (!c) return null;
  const last = get(
    "SELECT * FROM messages WHERE conv_id=? AND from_type<>'note' ORDER BY created_time DESC LIMIT 1",
    convId,
  );
  if (!last) return c;
  const lastCustomer = get(
    "SELECT MAX(created_time) AS t FROM messages WHERE conv_id=? AND from_type='customer'",
    convId,
  )?.t;
  const lastPage = get(
    "SELECT MAX(created_time) AS t FROM messages WHERE conv_id=? AND from_type='page' AND status<>'failed'",
    convId,
  )?.t;
  const unread = get(
    "SELECT COUNT(*) AS n FROM messages WHERE conv_id=? AND from_type='customer' AND created_time > COALESCE(?, '')",
    convId,
    c.read_at,
  ).n;

  let status = c.status;
  if (status === 'done') {
    if (lastCustomer && (!c.done_at || lastCustomer > c.done_at)) status = 'open';
  } else {
    status = lastCustomer && (!lastPage || lastCustomer > lastPage) ? 'open' : 'replied';
  }
  const snippet = last.text || (JSON.parse(last.attachments || '[]').length ? '[Tệp đính kèm]' : '');
  run(
    `UPDATE conversations SET snippet=?, updated_time=?, unread=?, status=?, last_customer_msg_at=?, last_page_msg_at=?
     WHERE id=?`,
    snippet.slice(0, 200),
    last.created_time,
    unread,
    status,
    lastCustomer || null,
    lastPage || null,
    convId,
  );
  const updated = getConversation(convId);
  emit('conversation', withJoins(updated));
  return updated;
}

/** Facebook chỉ cho gửi tin thường trong 24 giờ kể từ tin cuối của khách. */
export const REPLY_WINDOW_MS = 24 * 3600e3;
export function replyWindow(c) {
  const t = c?.last_customer_msg_at ? new Date(c.last_customer_msg_at).getTime() : 0;
  const left = t ? t + REPLY_WINDOW_MS - Date.now() : -1;
  return { can_reply: left > 0, reply_window_left_sec: left > 0 ? Math.round(left / 1000) : 0 };
}

export function withJoins(c) {
  if (!c) return c;
  const p = get('SELECT name FROM pages WHERE id=?', c.page_id);
  const cu = get('SELECT picture FROM customers WHERE page_id=? AND psid=?', c.page_id, c.psid);
  return { ...c, page_name: p?.name || '', customer_picture: cu?.picture || '', ...replyWindow(c) };
}

/**
 * Lưu một tin nhắn. Trả về true nếu là tin mới (chưa có trong CSDL).
 * m = { id, pageId, psid, fromType, fromId, text, attachments, createdTime, status, error, source }
 */
export function insertMessage(m) {
  const convId = ensureConversation(m.pageId, m.psid, { name: m.customerName });
  const created = toIso(m.createdTime);
  const id = m.id || newId();
  const exists = get('SELECT id FROM messages WHERE id=?', id);
  if (exists) return { inserted: false, convId, id };

  let responseSeconds = null;
  if (m.fromType === 'page' && m.status !== 'failed') {
    // Thời gian phản hồi = từ tin đầu tiên của khách chưa được trả lời đến tin này
    const lastPage = get(
      "SELECT MAX(created_time) AS t FROM messages WHERE conv_id=? AND from_type='page' AND status<>'failed' AND created_time<?",
      convId,
      created,
    )?.t;
    const firstPending = get(
      "SELECT MIN(created_time) AS t FROM messages WHERE conv_id=? AND from_type='customer' AND created_time<? AND created_time>COALESCE(?, '')",
      convId,
      created,
      lastPage,
    )?.t;
    if (firstPending) responseSeconds = Math.max(0, Math.round((new Date(created) - new Date(firstPending)) / 1000));
  }

  run(
    `INSERT INTO messages(id,conv_id,page_id,from_type,from_id,text,attachments,created_time,status,error,source,response_seconds)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    convId,
    m.pageId,
    m.fromType,
    m.fromId || (m.fromType === 'page' ? m.pageId : m.psid),
    m.text || '',
    JSON.stringify(m.attachments || []),
    created,
    m.status || (m.fromType === 'page' ? 'sent' : m.fromType === 'note' ? 'note' : 'received'),
    m.error || null,
    m.source || 'webhook',
    responseSeconds,
  );
  if (m.fromType === 'customer') upsertCustomer(m.pageId, m.psid, { name: m.customerName });
  const conv = recomputeConversation(convId);
  const row = get('SELECT * FROM messages WHERE id=?', id);
  row.attachments = JSON.parse(row.attachments || '[]');
  emit('message', { message: row, conversation: withJoins(conv) });
  return { inserted: true, convId, id, message: row };
}

export function updateMessage(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE messages SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => fields[k]), id);
  const row = get('SELECT * FROM messages WHERE id=?', id);
  if (row) {
    row.attachments = JSON.parse(row.attachments || '[]');
    const conv = recomputeConversation(row.conv_id);
    emit('message', { message: row, conversation: withJoins(conv) });
  }
}

export function markRead(convId) {
  run('UPDATE conversations SET read_at=?, unread=0 WHERE id=?', nowIso(), convId);
  const c = getConversation(convId);
  emit('conversation', withJoins(c));
  return c;
}

export function patchConversation(convId, { status, assigned, tags, note }) {
  const c = getConversation(convId);
  if (!c) return null;
  const sets = [];
  const params = [];
  if (status && ['open', 'replied', 'done'].includes(status)) {
    sets.push('status=?');
    params.push(status);
    if (status === 'done') {
      sets.push('done_at=?');
      params.push(nowIso());
    }
  }
  if (assigned !== undefined) {
    sets.push('assigned=?');
    params.push(String(assigned));
  }
  if (Array.isArray(tags)) {
    sets.push('tags=?');
    params.push(JSON.stringify(tags.map(String)));
  }
  if (note !== undefined) {
    sets.push('note=?');
    params.push(String(note));
  }
  if (sets.length) {
    params.push(convId);
    run(`UPDATE conversations SET ${sets.join(',')} WHERE id=?`, ...params);
  }
  const updated = withJoins(getConversation(convId));
  emit('conversation', updated);
  return updated;
}

/* ---------------- Posts & comments ---------------- */

export function upsertPost(pageId, p) {
  run(
    `INSERT INTO posts(id,page_id,message,created_time,permalink_url,picture,likes,comments_count,shares,updated_at,status,scheduled_time,source)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET message=excluded.message,
       permalink_url=COALESCE(NULLIF(excluded.permalink_url,''),posts.permalink_url),
       picture=COALESCE(NULLIF(excluded.picture,''),posts.picture), likes=excluded.likes, comments_count=excluded.comments_count,
       shares=excluded.shares, updated_at=excluded.updated_at, status=excluded.status,
       scheduled_time=COALESCE(excluded.scheduled_time,posts.scheduled_time)`,
    p.id,
    pageId,
    p.message || p.story || '',
    toIso(p.created_time),
    p.permalink_url || '',
    p.full_picture || '',
    p.reactions?.summary?.total_count ?? p.likes?.summary?.total_count ?? 0,
    p.comments?.summary?.total_count ?? 0,
    p.shares?.count ?? 0,
    nowIso(),
    p._status || 'published',
    p._scheduled_time || null,
    p._source || 'sync',
  );
  return getPost(p.id);
}
export function setPostStatus(id, status) {
  run('UPDATE posts SET status=?, updated_at=? WHERE id=?', status, nowIso(), id);
}
export function listPosts(pageId, limit = 50) {
  const sql = `SELECT p.*, pg.name AS page_name,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.is_page=0 AND c.replied=0 AND c.removed=0 AND c.is_hidden=0) AS pending_comments
     FROM posts p LEFT JOIN pages pg ON pg.id=p.page_id
     WHERE p.status<>'deleted' ${pageId ? 'AND p.page_id=?' : ''}
     ORDER BY COALESCE(p.scheduled_time, p.created_time) DESC LIMIT ?`;
  return pageId ? all(sql, pageId, limit) : all(sql, limit);
}
export function getPost(id) {
  return get('SELECT p.*, pg.name AS page_name FROM posts p LEFT JOIN pages pg ON pg.id=p.page_id WHERE p.id=?', id);
}

/** Lưu bình luận; trả về true nếu mới. */
export function upsertComment(pageId, c) {
  const exists = get('SELECT id FROM comments WHERE id=?', c.id);
  const fromId = c.from?.id || c.fromId || '';
  const isPage = fromId === pageId ? 1 : 0;
  run(
    `INSERT INTO comments(id,post_id,page_id,parent_id,from_id,from_name,message,created_time,is_hidden,is_page)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET message=excluded.message, is_hidden=excluded.is_hidden,
       from_name=COALESCE(NULLIF(excluded.from_name,''),comments.from_name)`,
    c.id,
    c.postId || c.post_id,
    pageId,
    c.parent?.id || c.parentId || null,
    fromId,
    c.from?.name || c.fromName || '',
    c.message || '',
    toIso(c.created_time || c.createdTime),
    c.is_hidden ? 1 : 0,
    isPage,
  );
  // Nếu trang trả lời (reply con) -> đánh dấu bình luận cha đã được trả lời
  if (isPage && (c.parent?.id || c.parentId)) {
    run('UPDATE comments SET replied=1 WHERE id=?', c.parent?.id || c.parentId);
  }
  const row = getComment(c.id);
  emit('comment', row);
  return { inserted: !exists, comment: row };
}
export function getComment(id) {
  return get(
    `SELECT c.*, p.message AS post_message, p.permalink_url FROM comments c LEFT JOIN posts p ON p.id=c.post_id WHERE c.id=?`,
    id,
  );
}
export function listComments({ pageId, postId, pending, limit = 200 } = {}) {
  const where = ['c.removed=0'];
  const params = [];
  if (pageId) {
    where.push('c.page_id=?');
    params.push(pageId);
  }
  if (postId) {
    where.push('c.post_id=?');
    params.push(postId);
  }
  if (pending) where.push('c.is_page=0 AND c.replied=0 AND c.is_hidden=0');
  params.push(limit);
  return all(
    `SELECT c.*, p.message AS post_message, p.permalink_url, pg.name AS page_name
     FROM comments c LEFT JOIN posts p ON p.id=c.post_id LEFT JOIN pages pg ON pg.id=c.page_id
     WHERE ${where.join(' AND ')} ORDER BY c.created_time DESC LIMIT ?`,
    ...params,
  );
}
export function setCommentFlags(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE comments SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => fields[k]), id);
  emit('comment', getComment(id));
}

/* ---------------- Activity ---------------- */

export function logActivity(type, pageId, detail) {
  run('INSERT INTO activity(ts,type,page_id,detail) VALUES(?,?,?,?)', nowIso(), type, pageId || null, detail || '');
  run('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 500)');
  emit('activity', { ts: nowIso(), type, page_id: pageId, detail });
}
export function listActivity(limit = 50) {
  return all('SELECT * FROM activity ORDER BY id DESC LIMIT ?', limit);
}

/* ---------------- Stats ---------------- */

export function stats(pageId) {
  const w = pageId ? 'WHERE page_id=?' : '';
  const p = pageId ? [pageId] : [];
  const dayAgo = new Date(Date.now() - 86400e3).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const open = get(`SELECT COUNT(*) AS n FROM conversations ${w ? w + ' AND' : 'WHERE'} status='open'`, ...p).n;
  const unread = get(`SELECT COALESCE(SUM(unread),0) AS n FROM conversations ${w}`, ...p).n;
  const total = get(`SELECT COUNT(*) AS n FROM conversations ${w}`, ...p).n;
  const msgsToday = get(
    `SELECT COUNT(*) AS n FROM messages ${w ? w + ' AND' : 'WHERE'} from_type='customer' AND created_time>=?`,
    ...p,
    todayStart.toISOString(),
  ).n;
  const msgs24h = get(
    `SELECT COUNT(*) AS n FROM messages ${w ? w + ' AND' : 'WHERE'} from_type='customer' AND created_time>=?`,
    ...p,
    dayAgo,
  ).n;
  const avgResp = get(
    `SELECT AVG(response_seconds) AS s FROM messages ${w ? w + ' AND' : 'WHERE'} response_seconds IS NOT NULL AND created_time>=?`,
    ...p,
    weekAgo,
  ).s;
  const pendingComments = get(
    `SELECT COUNT(*) AS n FROM comments ${w ? w + ' AND' : 'WHERE'} is_page=0 AND replied=0 AND is_hidden=0 AND removed=0`,
    ...p,
  ).n;
  const overdue = get(
    `SELECT COUNT(*) AS n FROM conversations ${w ? w + ' AND' : 'WHERE'} status='open' AND last_customer_msg_at<?`,
    ...p,
    new Date(Date.now() - 3600e3).toISOString(),
  ).n;

  // Tin nhắn theo ngày, 14 ngày gần nhất
  const since = new Date(Date.now() - 13 * 86400e3);
  since.setHours(0, 0, 0, 0);
  const rows = all(
    `SELECT substr(created_time,1,10) AS day, from_type, COUNT(*) AS n FROM messages
     ${w ? w + ' AND' : 'WHERE'} created_time>=? GROUP BY day, from_type`,
    ...p,
    since.toISOString(),
  );
  const daily = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(since.getTime() + i * 86400e3).toISOString().slice(0, 10);
    daily.push({
      day: d,
      customer: rows.find((r) => r.day === d && r.from_type === 'customer')?.n || 0,
      page: rows.find((r) => r.day === d && r.from_type === 'page')?.n || 0,
    });
  }
  const pages = listPages();
  const fans = pages.filter((x) => !pageId || x.id === pageId).reduce((s, x) => s + (x.fan_count || 0), 0);
  const followers = pages.filter((x) => !pageId || x.id === pageId).reduce((s, x) => s + (x.followers_count || 0), 0);

  return {
    open,
    unread,
    total,
    msgs_today: msgsToday,
    msgs_24h: msgs24h,
    avg_response_seconds: avgResp ? Math.round(avgResp) : null,
    pending_comments: pendingComments,
    overdue_1h: overdue,
    fans,
    followers,
    daily,
  };
}
