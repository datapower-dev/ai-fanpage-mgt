// Đăng, xem và xoá bài viết trên fanpage.
import { graph } from './graph.js';
import { nowIso } from './db.js';
import * as store from './store.js';
import { describeError, isDemoPage } from './messaging.js';

const MIN_SCHEDULE_MS = 10 * 60e3; // Facebook: hẹn giờ tối thiểu 10 phút
const MAX_SCHEDULE_MS = 75 * 86400e3; // và tối đa 75 ngày

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

/**
 * Đăng bài lên trang.
 * input = { message, link, image_url, scheduled_at (ISO), source }
 */
export async function createPost(page, input = {}) {
  const message = String(input.message || '').trim();
  const link = String(input.link || '').trim();
  const imageUrl = String(input.image_url || '').trim();
  const source = input.source === 'mcp' ? 'mcp' : 'app';
  if (!message && !link && !imageUrl) throw fail('Bài viết cần có nội dung, link hoặc ảnh');
  if (link && imageUrl) throw fail('Mỗi bài chỉ dùng link hoặc ảnh, không dùng cả hai');
  for (const u of [link, imageUrl]) {
    if (u && !/^https?:\/\//i.test(u)) throw fail('Link và ảnh phải là URL bắt đầu bằng http:// hoặc https://');
  }

  let scheduledUnix = null;
  let scheduledIso = null;
  if (input.scheduled_at) {
    const t = new Date(input.scheduled_at).getTime();
    if (Number.isNaN(t)) throw fail('Thời điểm hẹn đăng không hợp lệ');
    const delta = t - Date.now();
    if (delta < MIN_SCHEDULE_MS) throw fail('Facebook chỉ cho hẹn giờ đăng sau ít nhất 10 phút');
    if (delta > MAX_SCHEDULE_MS) throw fail('Facebook chỉ cho hẹn giờ đăng trong vòng 75 ngày');
    scheduledUnix = Math.floor(t / 1000);
    scheduledIso = new Date(t).toISOString();
  }

  let postId;
  let fbPost = null;
  if (isDemoPage(page)) {
    postId = `${page.id}_post_${Date.now()}`;
  } else {
    try {
      if (imageUrl) {
        const r = await graph.createPhotoPost(page.id, page.access_token, { url: imageUrl, caption: message, scheduledUnix });
        postId = r.post_id || `${page.id}_${r.id}`;
      } else {
        const r = await graph.createFeedPost(page.id, page.access_token, { message, link, scheduledUnix });
        postId = r.id;
      }
      try {
        fbPost = await graph.getPost(postId, page.access_token);
      } catch {
        /* bài hẹn giờ có thể chưa đọc được ngay */
      }
    } catch (e) {
      const err = describeError(e);
      store.logActivity('post-failed', page.id, err);
      throw Object.assign(new Error(err), { status: 502 });
    }
  }

  const row = store.upsertPost(page.id, {
    id: postId,
    message,
    created_time: fbPost?.created_time || nowIso(),
    permalink_url: fbPost?.permalink_url || (isDemoPage(page) ? 'https://www.facebook.com/' : ''),
    full_picture: fbPost?.full_picture || imageUrl || '',
    _status: scheduledUnix ? 'scheduled' : 'published',
    _scheduled_time: scheduledIso,
    _source: source,
  });
  store.logActivity(
    scheduledUnix ? 'post-scheduled' : 'post-published',
    page.id,
    `${source === 'mcp' ? '[Claude] ' : ''}${message.slice(0, 80) || link || imageUrl}${scheduledIso ? ` · hẹn ${scheduledIso}` : ''}`,
  );
  return row;
}

/** Xem chi tiết bài, có thể làm mới số liệu và bình luận từ Facebook. */
export async function getPostDetail(postId, { refresh = false } = {}) {
  let post = store.getPost(postId);
  if (!post) throw fail('Không tìm thấy bài viết', 404);
  const page = store.getPage(post.page_id);
  let refreshed = false;
  let refreshError = null;
  if (refresh && page && !isDemoPage(page)) {
    try {
      const fb = await graph.getPost(postId, page.access_token);
      store.upsertPost(page.id, {
        ...fb,
        _status: fb.is_published === false ? 'scheduled' : 'published',
        _scheduled_time: fb.scheduled_publish_time ? new Date(fb.scheduled_publish_time * 1000).toISOString() : null,
        _source: post.source,
      });
      const comments = await graph.comments(postId, page.access_token, 300);
      for (const c of comments) store.upsertComment(page.id, { ...c, postId });
      refreshed = true;
    } catch (e) {
      refreshError = describeError(e);
    }
    post = store.getPost(postId);
  }
  const comments = store.listComments({ postId, limit: 500 }).reverse();
  return { post, comments, refreshed, refresh_error: refreshError };
}

export async function deletePost(postId) {
  const post = store.getPost(postId);
  if (!post) throw fail('Không tìm thấy bài viết', 404);
  const page = store.getPage(post.page_id);
  if (page && !isDemoPage(page)) {
    try {
      await graph.deletePost(postId, page.access_token);
    } catch (e) {
      throw Object.assign(new Error(describeError(e)), { status: 502 });
    }
  }
  store.setPostStatus(postId, 'deleted');
  store.logActivity('post-deleted', post.page_id, (post.message || postId).slice(0, 80));
}
