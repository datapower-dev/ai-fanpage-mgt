import { config } from './config.js';
import { graph } from './graph.js';
import { nowIso, toIso, run } from './db.js';
import * as store from './store.js';
import { describeError, isDemoPage } from './messaging.js';

const running = new Set();

function mapAttachments(list) {
  return (list?.data || []).map((a) => ({
    type: a.video_data ? 'video' : a.image_data ? 'image' : 'file',
    url: a.video_data?.url || a.image_data?.url || a.file_url || '',
    title: a.name || '',
  }));
}

/**
 * Đồng bộ một trang từ Graph API: thông tin trang, hội thoại + tin nhắn, bài viết + bình luận.
 * deep=true lấy nhiều dữ liệu hơn (dùng khi mới thêm trang).
 */
export async function syncPage(page, { deep = false } = {}) {
  if (isDemoPage(page)) return { skipped: 'demo' };
  if (running.has(page.id)) return { skipped: 'running' };
  running.add(page.id);
  const token = page.access_token;
  const result = { conversations: 0, messages: 0, posts: 0, comments: 0 };
  try {
    const info = await graph.pageInfo(page.id, token);
    store.upsertPage({ ...info, access_token: '' });

    const convs = await graph.conversations(page.id, token, deep ? 200 : 50);
    for (const conv of convs) {
      const participant = (conv.participants?.data || []).find((x) => String(x.id) !== String(page.id));
      if (!participant) continue;
      const psid = String(participant.id);
      const convId = store.ensureConversation(page.id, psid, { fbConvId: conv.id, name: participant.name });
      store.upsertCustomer(page.id, psid, { name: participant.name });
      const local = store.getConversation(convId);
      const fbUpdated = toIso(conv.updated_time);
      if (!deep && local?.updated_time && local.updated_time >= fbUpdated && local.snippet) continue;

      const msgs = await graph.conversationMessages(conv.id, token, deep ? 100 : 25);
      msgs.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
      for (const m of msgs) {
        const fromType = String(m.from?.id) === String(page.id) ? 'page' : 'customer';
        const r = store.insertMessage({
          id: m.id,
          pageId: page.id,
          psid,
          fromType,
          fromId: m.from?.id,
          text: m.message || '',
          attachments: mapAttachments(m.attachments),
          createdTime: m.created_time,
          status: fromType === 'page' ? 'sent' : 'received',
          source: 'sync',
          customerName: fromType === 'customer' ? m.from?.name : undefined,
        });
        if (r.inserted) result.messages++;
      }
      if (conv.unread_count === 0) {
        // Facebook báo đã đọc hết -> không hiển thị là chưa đọc ở đây
        run('UPDATE conversations SET read_at=?, unread=0 WHERE id=?', fbUpdated, convId);
      }
      result.conversations++;
    }

    const posts = await graph.posts(page.id, token, deep ? 50 : 15);
    for (const p of posts) {
      store.upsertPost(page.id, p);
      result.posts++;
      const total = p.comments?.summary?.total_count ?? 0;
      if (total > 0) {
        const comments = await graph.comments(p.id, token, deep ? 500 : 200);
        for (const c of comments) {
          const r = store.upsertComment(page.id, { ...c, postId: p.id });
          if (r.inserted) result.comments++;
        }
      }
    }

    store.setPageMeta(page.id, { last_sync: nowIso(), last_error: null });
    store.logActivity(
      'sync',
      page.id,
      `Đồng bộ ${page.name}: ${result.conversations} hội thoại, +${result.messages} tin, ${result.posts} bài, +${result.comments} bình luận`,
    );
    return result;
  } catch (e) {
    const err = describeError(e);
    store.setPageMeta(page.id, { last_error: err });
    store.logActivity('sync-error', page.id, err);
    throw e;
  } finally {
    running.delete(page.id);
  }
}

export async function syncAll({ deep = false } = {}) {
  for (const page of store.listEnabledPages()) {
    try {
      await syncPage(page, { deep });
    } catch (e) {
      console.error(`[sync] ${page.name}:`, e.message);
    }
  }
}

export function startScheduler() {
  if (config.demo || !config.syncIntervalSec || config.syncIntervalSec <= 0) return;
  setTimeout(() => syncAll(), 5000).unref();
  setInterval(() => syncAll(), config.syncIntervalSec * 1000).unref();
  console.log(`[sync] Đồng bộ định kỳ mỗi ${config.syncIntervalSec}s`);
}
