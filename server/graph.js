import { config } from './config.js';

export class GraphError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'GraphError';
    this.code = info.code;
    this.subcode = info.error_subcode;
    this.type = info.type;
    this.status = info.status;
    this.fbtrace = info.fbtrace_id;
  }
  /** Diễn giải lỗi phổ biến sang tiếng Việt cho người dùng. */
  get hint() {
    if (this.code === 190) return 'Access token hết hạn hoặc không hợp lệ. Hãy đăng nhập Facebook lại ở màn hình Kết nối hoặc tạo token mới.';
    if (this.code === 10 && /outside of allowed window/i.test(this.message))
      return 'Đã quá 24 giờ kể từ tin nhắn cuối của khách. Facebook không cho gửi tin thường, cần dùng message tag hợp lệ.';
    if (this.code === 10 || this.code === 200) return 'Ứng dụng/Token thiếu quyền (pages_messaging, pages_manage_metadata, pages_read_engagement...).';
    if (this.code === 551) return 'Người này hiện không nhận được tin nhắn (đã chặn trang hoặc tắt nhận tin).';
    if (this.code === 4 || this.code === 17 || this.code === 32) return 'Đã chạm giới hạn tần suất gọi API, thử lại sau ít phút.';
    if (this.code === 100) return 'Tham số không hợp lệ hoặc đối tượng không tồn tại.';
    return '';
  }
}

const base = () => `https://graph.facebook.com/${config.graphVersion}`;

async function request(method, p, { token, params = {}, body } = {}) {
  const url = new URL(`${base()}/${String(p).replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (token) url.searchParams.set('access_token', token);
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    throw new GraphError(e.message || `Graph API trả về HTTP ${res.status}`, { ...e, status: res.status });
  }
  return json;
}

async function paginate(p, opts, max = 500) {
  const out = [];
  let page = await request('GET', p, opts);
  out.push(...(page.data || []));
  while (page.paging?.next && out.length < max) {
    const res = await fetch(page.paging.next);
    page = await res.json();
    if (page.error) throw new GraphError(page.error.message, page.error);
    out.push(...(page.data || []));
  }
  return out.slice(0, max);
}

const PAGE_FIELDS = 'id,name,category,fan_count,followers_count,picture{url},link';

export const graph = {
  get: (p, o) => request('GET', p, o),
  post: (p, o) => request('POST', p, o),
  del: (p, o) => request('DELETE', p, o),
  paginate,

  /** Thông tin trang. `me` dùng được khi token là Page Access Token. */
  pageInfo(pageId, token) {
    return request('GET', pageId || 'me', { token, params: { fields: PAGE_FIELDS } });
  },
  /** Danh sách trang mà user token quản lý, kèm page access token. */
  myPages(userToken) {
    return paginate('me/accounts', {
      token: userToken,
      params: { fields: 'id,name,access_token,category,picture{url},fan_count,followers_count,link', limit: 100 },
    });
  },
  conversations(pageId, token, limit = 50) {
    return paginate(
      `${pageId}/conversations`,
      {
        token,
        params: {
          platform: 'messenger',
          fields: 'id,updated_time,unread_count,snippet,participants,can_reply',
          limit: Math.min(limit, 100),
        },
      },
      limit,
    );
  },
  conversationMessages(convId, token, limit = 50) {
    return paginate(
      `${convId}/messages`,
      {
        token,
        params: {
          fields: 'id,message,from,created_time,attachments{id,mime_type,name,image_data,video_data,file_url}',
          limit: Math.min(limit, 100),
        },
      },
      limit,
    );
  },
  userProfile(psid, token) {
    return request('GET', psid, { token, params: { fields: 'first_name,last_name,name,profile_pic' } });
  },
  sendText(pageId, token, psid, text, { tag } = {}) {
    const body = { recipient: { id: psid }, message: { text }, messaging_type: tag ? 'MESSAGE_TAG' : 'RESPONSE' };
    if (tag) body.tag = tag;
    return request('POST', `${pageId}/messages`, { token, body });
  },
  sendAttachment(pageId, token, psid, type, url) {
    return request('POST', `${pageId}/messages`, {
      token,
      body: {
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { attachment: { type, payload: { url, is_reusable: false } } },
      },
    });
  },
  senderAction(pageId, token, psid, action) {
    return request('POST', `${pageId}/messages`, { token, body: { recipient: { id: psid }, sender_action: action } });
  },
  /** Gửi tin nhắn riêng cho người bình luận (private reply). */
  privateReply(pageId, token, commentId, text) {
    return request('POST', `${pageId}/messages`, {
      token,
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
  },
  posts(pageId, token, limit = 25) {
    return paginate(
      `${pageId}/posts`,
      {
        token,
        params: {
          fields:
            'id,message,story,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
          limit: Math.min(limit, 100),
        },
      },
      limit,
    );
  },
  comments(postId, token, limit = 200) {
    return paginate(
      `${postId}/comments`,
      {
        token,
        params: {
          fields: 'id,message,from,created_time,parent{id},is_hidden,comment_count',
          filter: 'stream',
          order: 'reverse_chronological',
          limit: 100,
        },
      },
      limit,
    );
  },
  /** Đăng bài chữ/link lên trang. scheduledUnix: thời điểm hẹn đăng (giây), bỏ trống = đăng ngay. */
  createFeedPost(pageId, token, { message, link, scheduledUnix } = {}) {
    const body = { message };
    if (link) body.link = link;
    if (scheduledUnix) {
      body.published = false;
      body.scheduled_publish_time = scheduledUnix;
    }
    return request('POST', `${pageId}/feed`, { token, body });
  },
  /** Đăng ảnh (từ URL công khai) kèm chú thích. Trả về { id: photo_id, post_id }. */
  createPhotoPost(pageId, token, { url, caption, scheduledUnix } = {}) {
    const body = { url, caption };
    if (scheduledUnix) {
      body.published = false;
      body.scheduled_publish_time = scheduledUnix;
    }
    return request('POST', `${pageId}/photos`, { token, body });
  },
  getPost(postId, token) {
    return request('GET', postId, {
      token,
      params: {
        fields:
          'id,message,story,created_time,permalink_url,full_picture,shares,is_published,scheduled_publish_time,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
      },
    });
  },
  deletePost(postId, token) {
    return request('DELETE', postId, { token });
  },
  replyComment(commentId, token, message) {
    return request('POST', `${commentId}/comments`, { token, body: { message } });
  },
  hideComment(commentId, token, hidden) {
    return request('POST', commentId, { token, body: { is_hidden: !!hidden } });
  },
  deleteComment(commentId, token) {
    return request('DELETE', commentId, { token });
  },
  subscribeApp(pageId, token) {
    return request('POST', `${pageId}/subscribed_apps`, {
      token,
      body: { subscribed_fields: ['messages', 'messaging_postbacks', 'message_reads', 'message_deliveries', 'feed'] },
    });
  },
  /** Đổi short-lived user token sang long-lived (60 ngày). */
  longLivedUserToken(shortToken) {
    return request('GET', 'oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: config.appId,
        client_secret: config.appSecret,
        fb_exchange_token: shortToken,
      },
    });
  },
};
