// Kết nối Facebook: cấu hình App (lưu trong CSDL hoặc .env), đăng nhập OAuth, nhập fanpage.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getSetting, setSetting, nowIso } from './db.js';
import { graph } from './graph.js';
import * as store from './store.js';
import { describeError } from './messaging.js';
import { syncPage } from './sync.js';

/** Quyền cần xin khi đăng nhập Facebook. */
export const FB_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
];

const fromEnv = { appId: config.appId, appSecret: config.appSecret, verifyToken: config.verifyToken, publicUrl: config.publicUrl };

/** Áp dụng cấu hình App lưu trong CSDL (ưu tiên hơn .env). Gọi lúc khởi động và sau khi lưu. */
export function applyStoredAppConfig() {
  const s = getSetting('fb_app', {}) || {};
  config.appId = s.appId || fromEnv.appId;
  config.appSecret = s.appSecret || fromEnv.appSecret;
  config.verifyToken = s.verifyToken || fromEnv.verifyToken;
  config.publicUrl = (s.publicUrl || fromEnv.publicUrl || '').replace(/\/$/, '');
}

export function saveAppConfig({ appId, appSecret, verifyToken, publicUrl } = {}) {
  const cur = getSetting('fb_app', {}) || {};
  const next = { ...cur };
  if (appId !== undefined) next.appId = String(appId).trim();
  // Ô bí mật để trống = giữ nguyên giá trị cũ
  if (appSecret) next.appSecret = String(appSecret).trim();
  if (verifyToken !== undefined && String(verifyToken).trim()) next.verifyToken = String(verifyToken).trim();
  if (publicUrl !== undefined) next.publicUrl = String(publicUrl).trim().replace(/\/$/, '');
  if (next.publicUrl && !/^https?:\/\//i.test(next.publicUrl)) throw Object.assign(new Error('URL công khai phải bắt đầu bằng https://'), { status: 400 });
  setSetting('fb_app', next);
  applyStoredAppConfig();
}

export function clearAppSecret() {
  const cur = getSetting('fb_app', {}) || {};
  delete cur.appSecret;
  setSetting('fb_app', cur);
  applyStoredAppConfig();
}

/** URL gốc để Facebook gọi về: ưu tiên PUBLIC_URL, nếu không lấy theo request. */
export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = req.get('x-forwarded-proto')?.split(',')[0] || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

export function connectionStatus(req) {
  const base = baseUrl(req);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);
  return {
    app_id: config.appId,
    has_app_id: !!config.appId,
    has_app_secret: !!config.appSecret,
    verify_token: config.verifyToken,
    verify_token_default: config.verifyToken === 'fanpage-verify-token',
    public_url: config.publicUrl,
    base_url: base,
    base_is_local: isLocal,
    base_is_https: base.startsWith('https://'),
    oauth_redirect_uri: `${base}/auth/facebook/callback`,
    webhook_url: `${base}/webhook`,
    scopes: FB_SCOPES,
    graph_version: config.graphVersion,
    last_webhook_at: getSetting('last_webhook_at', null),
    last_mcp_at: getSetting('last_mcp_at', null),
    pages: store.listPages().length,
    demo: config.demo,
    root: config.root.replace(/\\/g, '/'),
    port: config.port,
    node_path: process.execPath.replace(/\\/g, '/'),
  };
}

/* ---------- Nhập trang từ User Token (dùng cho cả OAuth và dán token) ---------- */
export async function importPagesFromUserToken(userToken) {
  let token = userToken;
  let longLived = false;
  if (config.appId && config.appSecret) {
    try {
      const ll = await graph.longLivedUserToken(userToken);
      if (ll?.access_token) {
        token = ll.access_token;
        longLived = true;
      }
    } catch (e) {
      store.logActivity('token-exchange-failed', null, describeError(e));
    }
  }
  const pages = await graph.myPages(token);
  const added = [];
  const warnings = [];
  for (const p of pages) {
    if (!p.access_token) {
      warnings.push(`${p.name}: không có quyền quản lý trang`);
      continue;
    }
    store.upsertPage(p);
    try {
      await graph.subscribeApp(p.id, p.access_token);
      store.setPageMeta(p.id, { subscribed: 1 });
    } catch (e) {
      store.setPageMeta(p.id, { subscribed: 0 });
      warnings.push(`${p.name}: chưa đăng ký được webhook (${describeError(e)})`);
      store.logActivity('subscribe-failed', p.id, describeError(e));
    }
    added.push(store.publicPage(store.getPage(p.id)));
    syncPage(store.getPage(p.id), { deep: true }).catch(() => {});
  }
  store.logActivity('pages-imported', null, `${added.length} trang${longLived ? ' (token dài hạn)' : ''}`);
  return { count: added.length, pages: added, long_lived: longLived, warnings };
}

/* ---------- OAuth: Đăng nhập với Facebook ---------- */
const pendingStates = new Map(); // state -> { at, redirect }

export function oauthStart(req, res) {
  if (!config.appId || !config.appSecret) {
    return res.redirect('/#/connect?fb_error=' + encodeURIComponent('Chưa nhập App ID và App Secret của ứng dụng Facebook'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  for (const [k, v] of pendingStates) if (Date.now() - v.at > 15 * 60e3) pendingStates.delete(k);
  const redirectUri = `${baseUrl(req)}/auth/facebook/callback`;
  pendingStates.set(state, { at: Date.now(), redirectUri });
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', FB_SCOPES.join(','));
  res.redirect(url.toString());
}

export async function oauthCallback(req, res) {
  const back = (params) => res.redirect('/#/connect?' + new URLSearchParams(params).toString());
  const { code, state, error, error_description: desc } = req.query;
  if (error) return back({ fb_error: desc || error });
  const pending = state && pendingStates.get(String(state));
  if (!pending) return back({ fb_error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn, hãy thử lại.' });
  pendingStates.delete(String(state));
  if (!code) return back({ fb_error: 'Facebook không trả về mã xác thực.' });
  try {
    const tok = await graph.get('oauth/access_token', {
      params: {
        client_id: config.appId,
        client_secret: config.appSecret,
        redirect_uri: pending.redirectUri,
        code: String(code),
      },
    });
    if (!tok?.access_token) throw new Error('Không đổi được mã sang access token');
    const r = await importPagesFromUserToken(tok.access_token);
    setSetting('fb_connected_at', nowIso());
    if (!r.count) return back({ fb_error: 'Đăng nhập thành công nhưng không có fanpage nào được cấp quyền. Hãy chọn trang khi Facebook hỏi.' });
    return back({ fb_ok: String(r.count), fb_warn: r.warnings.join(' | ') });
  } catch (e) {
    store.logActivity('oauth-failed', null, describeError(e));
    return back({ fb_error: describeError(e) });
  }
}
