// Fanpage Manager — giao diện một trang, JavaScript thuần.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

const state = {
  me: {},
  pages: [],
  pageFilter: localGet('pageFilter') || '',
  view: 'dashboard',
  convs: [],
  convFilter: localGet('convFilter') || 'all',
  convQuery: '',
  selConv: null,
  thread: null,
  quickReplies: [],
  settings: { tags: [], agents: [] },
  commentFilter: 'pending',
  noteMode: false,
  notify: localGet('notify') === '1',
};

function localGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* bỏ qua */
  }
}

/* ---------------- API ---------------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `Lỗi HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'err' ? 7000 : 3500);
}
const fail = (e) => toast(e.message + (e.data?.hint ? ` — ${e.data.hint}` : ''), 'err');

/* ---------------- Time helpers ---------------- */
function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} ngày`;
  return new Date(iso).toLocaleDateString('vi-VN');
}
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) => new Date(iso).toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN') : '—');
function fmtDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} giây`;
  if (sec < 3600) return `${Math.round(sec / 60)} phút`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}
const num = (n) => Number(n || 0).toLocaleString('vi-VN');
const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(-2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';
const avatar = (name, pic, cls = '') =>
  `<span class="avatar ${cls}">${pic ? `<img src="${esc(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(name))}</span>`;
const STATUS_LABEL = { open: 'Cần trả lời', replied: 'Đã trả lời', done: 'Đã xong' };

/* ---------------- Router ---------------- */
const views = { dashboard: renderDashboard, inbox: renderInbox, comments: renderComments, pages: renderPages, automation: renderAutomation, activity: renderActivity };

function route() {
  const [, view = 'dashboard', ...rest] = location.hash.split('/');
  state.view = views[view] ? view : 'dashboard';
  if (state.view === 'inbox' && rest.length) state.selConv = decodeURIComponent(rest.join('/'));
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  views[state.view]();
}
window.addEventListener('hashchange', route);

/* ---------------- Badges & pages ---------------- */
async function refreshBadges() {
  try {
    const s = await api(`/stats${state.pageFilter ? `?page_id=${encodeURIComponent(state.pageFilter)}` : ''}`);
    const b1 = $('#badgeInbox');
    b1.hidden = !s.open;
    b1.textContent = s.open;
    const b2 = $('#badgeComments');
    b2.hidden = !s.pending_comments;
    b2.textContent = s.pending_comments;
    document.title = s.unread ? `(${s.unread}) Fanpage Manager` : 'Fanpage Manager';
    return s;
  } catch {
    return null;
  }
}
async function loadPages() {
  state.pages = await api('/pages');
  const sel = $('#pageFilter');
  sel.innerHTML =
    '<option value="">Tất cả trang</option>' + state.pages.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (state.pageFilter && !state.pages.some((p) => p.id === state.pageFilter)) state.pageFilter = '';
  sel.value = state.pageFilter;
}
$('#pageFilter').addEventListener('change', (e) => {
  state.pageFilter = e.target.value;
  localSet('pageFilter', state.pageFilter);
  state.selConv = null;
  refreshBadges();
  route();
});

/* ================= DASHBOARD ================= */
async function renderDashboard() {
  const main = $('#main');
  main.innerHTML = `<div class="view"><div class="view-head"><h1>Tổng quan</h1><span class="spacer"></span>
    <span class="muted small" id="dashUpdated"></span></div><div id="dash">Đang tải…</div></div>`;
  const pq = state.pageFilter ? `?page_id=${encodeURIComponent(state.pageFilter)}` : '';
  try {
    const [s, convs, activity] = await Promise.all([
      api('/stats' + pq),
      api(`/conversations?status=open&limit=8${state.pageFilter ? `&page_id=${encodeURIComponent(state.pageFilter)}` : ''}`),
      api('/activity?limit=12'),
    ]);
    if (state.view !== 'dashboard') return;
    $('#dashUpdated').textContent = 'Cập nhật ' + new Date().toLocaleTimeString('vi-VN');
    const noPages = !state.pages.length;
    $('#dash').innerHTML = `
      ${noPages ? `<div class="card" style="margin-bottom:16px"><h2>Bắt đầu</h2><p>Chưa có trang nào. Vào <a href="#/pages">Trang</a> để kết nối fanpage bằng access token.</p></div>` : ''}
      <div class="kpis">
        ${kpi('Cần trả lời', s.open, `${s.overdue_1h} hội thoại chờ quá 1 giờ`, s.overdue_1h > 0)}
        ${kpi('Tin chưa đọc', s.unread)}
        ${kpi('Bình luận chờ xử lý', s.pending_comments, '', s.pending_comments > 0)}
        ${kpi('Tin khách hôm nay', s.msgs_today, `${s.msgs_24h} tin trong 24 giờ`)}
        ${kpi('Phản hồi trung bình', fmtDuration(s.avg_response_seconds), '7 ngày gần nhất')}
        ${kpi('Lượt thích trang', num(s.fans), `${num(s.followers)} người theo dõi`)}
      </div>
      <div class="dash-grid">
        <div class="card">
          <h2>Tin nhắn 14 ngày gần nhất</h2>
          <div class="legend"><span><i style="background:var(--series-1)"></i>Khách gửi</span><span><i style="background:var(--series-2)"></i>Trang trả lời</span></div>
          <div class="chart-wrap" id="chart"></div>
          <details class="small" style="margin-top:8px"><summary class="muted">Xem dạng bảng</summary>
            <table class="tbl"><thead><tr><th>Ngày</th><th>Khách gửi</th><th>Trang trả lời</th></tr></thead><tbody>
            ${s.daily.map((d) => `<tr><td>${d.day.split('-').reverse().join('/')}</td><td>${d.customer}</td><td>${d.page}</td></tr>`).join('')}
            </tbody></table></details>
        </div>
        <div class="card">
          <h2>Đang chờ trả lời</h2>
          ${
            convs.length
              ? `<ul class="list-plain">${convs
                  .map(
                    (c) => `<li class="clickable" data-conv="${esc(c.id)}">${avatar(c.customer_name, c.customer_picture, 'sm')}
                <div style="min-width:0;flex:1"><div><b>${esc(c.customer_name || c.psid)}</b> <span class="muted small">· ${timeAgo(c.last_customer_msg_at || c.updated_time)}</span></div>
                <div class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.snippet)}</div></div></li>`,
                  )
                  .join('')}</ul>`
              : '<div class="empty">Không có hội thoại nào đang chờ 🎉</div>'
          }
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2>Hoạt động gần đây</h2>
        ${activityList(activity)}
      </div>`;
    drawChart($('#chart'), s.daily);
    $$('#dash [data-conv]').forEach((el) => el.addEventListener('click', () => (location.hash = `#/inbox/${encodeURIComponent(el.dataset.conv)}`)));
  } catch (e) {
    $('#dash').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function kpi(label, value, hint = '', alert = false) {
  return `<div class="kpi ${alert ? 'alert' : ''}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}

function drawChart(el, daily) {
  const W = Math.max(320, el.clientWidth || 600);
  const H = 220;
  const pad = { l: 32, r: 8, t: 8, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = Math.max(4, ...daily.map((d) => Math.max(d.customer, d.page)));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [0, niceMax / 2, niceMax];
  const slot = iw / daily.length;
  const bw = Math.max(3, Math.min(14, (slot - 8) / 2));
  const y = (v) => pad.t + ih - (v / niceMax) * ih;
  const bar = (x, v, color) => {
    if (!v) return '';
    const top = y(v);
    const h = pad.t + ih - top;
    const r = Math.min(4, h, bw / 2);
    // Bo góc trên 4px, đáy phẳng bám trục
    return `<path d="M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z" fill="${color}"/>`;
  };
  let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Biểu đồ tin nhắn theo ngày" style="display:block">`;
  for (const t of ticks) {
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-width="1"/>`;
    svg += `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--text-3)">${t}</text>`;
  }
  daily.forEach((d, i) => {
    const cx = pad.l + slot * i + slot / 2;
    svg += bar(cx - bw - 1, d.customer, 'var(--series-1)');
    svg += bar(cx + 1, d.page, 'var(--series-2)');
    if (i % 2 === 0 || daily.length <= 7) {
      const [, m, dd] = d.day.split('-');
      svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--text-3)">${dd}/${m}</text>`;
    }
    svg += `<rect x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${ih}" fill="transparent" data-i="${i}" class="hit"/>`;
  });
  svg += `</svg><div class="tooltip" hidden></div>`;
  el.innerHTML = svg;
  const tip = $('.tooltip', el);
  $$('.hit', el).forEach((r) => {
    r.addEventListener('mouseenter', () => {
      const d = daily[+r.dataset.i];
      tip.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${d.day.split('-').reverse().join('/')}</div>
        <div class="t-row"><span><i style="background:var(--series-1)"></i>Khách gửi</span><b>${d.customer}</b></div>
        <div class="t-row"><span><i style="background:var(--series-2)"></i>Trang trả lời</span><b>${d.page}</b></div>`;
      tip.hidden = false;
      r.setAttribute('fill', 'var(--surface-2)');
      r.setAttribute('fill-opacity', '0.5');
      const x = +r.getAttribute('x') + slot / 2;
      tip.style.left = `${Math.min(x + 10, W - 160)}px`;
      tip.style.top = '10px';
    });
    r.addEventListener('mouseleave', () => {
      tip.hidden = true;
      r.setAttribute('fill', 'transparent');
    });
  });
}

function activityList(rows) {
  if (!rows.length) return '<div class="empty">Chưa có hoạt động</div>';
  const pageName = (id) => state.pages.find((p) => p.id === id)?.name || '';
  return `<ul class="list-plain">${rows
    .map(
      (a) => `<li><span class="muted small" style="width:110px;flex-shrink:0">${fmtDT(a.ts)}</span>
      <span class="chip">${esc(a.type)}</span><span style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(a.detail)}${
        a.page_id && pageName(a.page_id) ? ` <span class="muted small">· ${esc(pageName(a.page_id))}</span>` : ''
      }</span></li>`,
    )
    .join('')}</ul>`;
}

/* ================= INBOX ================= */
async function renderInbox() {
  const main = $('#main');
  main.innerHTML = `
    <div class="inbox ${state.selConv ? 'has-sel' : ''}" id="inbox">
      <section class="conv-col">
        <div class="conv-tools">
          <input type="search" id="convSearch" placeholder="Tìm tên khách, nội dung…" value="${esc(state.convQuery)}">
          <div class="seg" id="convFilter">
            ${[['all', 'Tất cả'], ['unread', 'Chưa đọc'], ['open', 'Cần trả lời'], ['replied', 'Đã trả lời'], ['done', 'Xong']]
              .map(([v, l]) => `<button data-v="${v}" class="${state.convFilter === v ? 'on' : ''}">${l}</button>`)
              .join('')}
          </div>
        </div>
        <div class="conv-list" id="convList"><div class="empty">Đang tải…</div></div>
      </section>
      <section class="thread-col" id="threadCol"><div class="empty" style="margin:auto">Chọn một hội thoại để xem</div></section>
      <aside class="side-col" id="sideCol"></aside>
    </div>`;
  $('#convFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.convFilter = b.dataset.v;
    localSet('convFilter', state.convFilter);
    $$('#convFilter button').forEach((x) => x.classList.toggle('on', x === b));
    loadConvs();
  });
  let t;
  $('#convSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.convQuery = e.target.value.trim();
      loadConvs();
    }, 250);
  });
  if (!state.quickReplies.length) api('/quick-replies').then((q) => (state.quickReplies = q)).catch(() => {});
  api('/settings').then((s) => (state.settings = s)).catch(() => {});
  await loadConvs();
  if (state.selConv) openConv(state.selConv);
}

async function loadConvs() {
  const params = new URLSearchParams({ status: state.convFilter, limit: '200' });
  if (state.pageFilter) params.set('page_id', state.pageFilter);
  if (state.convQuery) params.set('q', state.convQuery);
  try {
    state.convs = await api(`/conversations?${params}`);
    drawConvList();
  } catch (e) {
    $('#convList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function convItem(c) {
  const multi = !state.pageFilter && state.pages.length > 1;
  return `<div class="conv ${c.unread ? 'unread' : ''} ${state.selConv === c.id ? 'sel' : ''}" data-id="${esc(c.id)}">
    ${avatar(c.customer_name, c.customer_picture)}
    <div style="min-width:0">
      <div class="name">${esc(c.customer_name || 'Khách ' + c.psid.slice(-6))}</div>
      <div class="snip">${esc(c.snippet)}</div>
      <div class="sub"><span class="status ${c.status}">${STATUS_LABEL[c.status] || c.status}</span>
        ${multi ? `<span>· ${esc(c.page_name)}</span>` : ''}
        ${c.assigned ? `<span>· 👤 ${esc(c.assigned)}</span>` : ''}
        ${c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    </div>
    <div class="meta"><span>${timeAgo(c.updated_time)}</span>${c.unread ? '<span class="unread-dot" title="Chưa đọc"></span>' : ''}</div>
  </div>`;
}
function drawConvList() {
  const el = $('#convList');
  if (!el) return;
  el.innerHTML = state.convs.length ? state.convs.map(convItem).join('') : '<div class="empty">Không có hội thoại</div>';
  $$('.conv', el).forEach((n) =>
    n.addEventListener('click', () => {
      location.hash = `#/inbox/${encodeURIComponent(n.dataset.id)}`;
    }),
  );
}

async function openConv(id) {
  state.selConv = id;
  $('#inbox')?.classList.add('has-sel');
  $$('.conv').forEach((n) => n.classList.toggle('sel', n.dataset.id === id));
  try {
    state.thread = await api(`/conversations/${encodeURIComponent(id)}`);
  } catch (e) {
    $('#threadCol').innerHTML = `<div class="empty" style="margin:auto">${esc(e.message)}</div>`;
    return;
  }
  drawThread(true);
  drawSide();
  if (state.thread.conversation.unread) {
    api(`/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' }).then(refreshBadges).catch(() => {});
  }
}

function msgHtml(m) {
  const cls = m.from_type === 'customer' ? 'in' : m.from_type === 'note' ? 'note' : 'out';
  const atts = (m.attachments || [])
    .map((a) =>
      a.type === 'image' && a.url
        ? `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(a.url)}" alt="ảnh" loading="lazy" referrerpolicy="no-referrer"></a>`
        : `<a class="att" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">📎 ${esc(a.title || a.type || 'Tệp đính kèm')}</a>`,
    )
    .join('');
  const src = { auto: '⚡ Tự động', mcp: '🤖 Claude' }[m.source] || '';
  const meta = [
    fmtTime(m.created_time),
    m.from_type === 'note' ? `📝 Ghi chú nội bộ · ${esc(m.from_id || '')}` : '',
    cls === 'out' && src ? src : '',
    cls === 'out' && m.status === 'failed' ? '⚠ Gửi lỗi' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<div class="msg ${cls} ${m.status === 'failed' ? 'failed' : ''}" data-mid="${esc(m.id)}">
    <div class="bubble">${m.text ? linkify(m.text) : ''}${atts}</div>
    <div class="meta">${meta}</div>
    ${m.status === 'failed' && m.error ? `<div class="err">${esc(m.error)}</div>` : ''}
  </div>`;
}

function drawThread(scroll) {
  const col = $('#threadCol');
  if (!col || !state.thread) return;
  const { conversation: c, messages } = state.thread;
  let lastDay = '';
  const body = messages
    .map((m) => {
      const d = m.created_time.slice(0, 10);
      const sep = d !== lastDay ? `<div class="day-sep">${fmtDate(m.created_time)}</div>` : '';
      lastDay = d;
      return sep + msgHtml(m);
    })
    .join('');
  const windowWarn = !c.can_reply
    ? `<div class="window-warn">⚠ Đã quá 24 giờ kể từ tin nhắn cuối của khách. Facebook chỉ cho gửi khi có <b>message tag</b> hợp lệ (ví dụ HUMAN_AGENT cần được duyệt quyền). Chọn tag bên dưới nếu phù hợp, hoặc dùng ghi chú nội bộ.</div>`
    : c.reply_window_left_sec < 3 * 3600
      ? `<div class="window-warn">⏳ Còn ${fmtDuration(c.reply_window_left_sec)} trong cửa sổ trả lời 24 giờ.</div>`
      : '';
  col.innerHTML = `
    <div class="thread-head">
      <button class="btn sm mobile-back" id="backBtn">←</button>
      ${avatar(c.customer_name, c.customer_picture, 'sm')}
      <div style="min-width:0;flex:1"><div class="title">${esc(c.customer_name || c.psid)}</div>
      <div class="muted small">${esc(c.page_name)} · <span class="status ${c.status}">${STATUS_LABEL[c.status]}</span></div></div>
      ${c.status !== 'done' ? `<button class="btn sm" id="doneBtn">✓ Đánh dấu xong</button>` : `<button class="btn sm" id="reopenBtn">↺ Mở lại</button>`}
    </div>
    <div class="thread" id="thread">${body || '<div class="empty">Chưa có tin nhắn</div>'}</div>
    <div class="composer ${state.noteMode ? 'note-mode' : ''}" id="composer">
      ${windowWarn}
      <div class="qr-pop" id="qrPop" hidden></div>
      <textarea id="replyText" placeholder="${state.noteMode ? 'Ghi chú nội bộ (khách không thấy)…' : 'Nhập tin nhắn… Gõ / để chọn câu trả lời nhanh. Enter để gửi, Shift+Enter xuống dòng.'}"></textarea>
      <div class="row">
        <div class="row">
          <div class="seg"><button id="modeReply" class="${state.noteMode ? '' : 'on'}">Trả lời</button><button id="modeNote" class="${state.noteMode ? 'on' : ''}">📝 Ghi chú</button></div>
          <button class="btn sm" id="attachBtn" title="Đính kèm ảnh/tệp qua URL">📎</button>
          <select id="tagSel" style="width:auto" title="Message tag (chỉ dùng khi ngoài cửa sổ 24 giờ)" ${c.can_reply ? 'hidden' : ''}>
            <option value="">Không dùng tag</option>
            <option value="HUMAN_AGENT">HUMAN_AGENT (7 ngày)</option>
            <option value="ACCOUNT_UPDATE">ACCOUNT_UPDATE</option>
            <option value="POST_PURCHASE_UPDATE">POST_PURCHASE_UPDATE</option>
            <option value="CONFIRMED_EVENT_UPDATE">CONFIRMED_EVENT_UPDATE</option>
          </select>
        </div>
        <button class="btn primary" id="sendBtn">${state.noteMode ? 'Lưu ghi chú' : 'Gửi'}</button>
      </div>
      <input type="url" id="attachUrl" placeholder="URL ảnh hoặc tệp (https://…)" style="margin-top:8px" hidden>
    </div>`;
  const th = $('#thread');
  if (scroll) th.scrollTop = th.scrollHeight;
  $('#backBtn').onclick = () => {
    state.selConv = null;
    location.hash = '#/inbox';
  };
  $('#doneBtn')?.addEventListener('click', () => setConvStatus('done'));
  $('#reopenBtn')?.addEventListener('click', () => setConvStatus('open'));
  $('#modeReply').onclick = () => {
    state.noteMode = false;
    drawThread(true);
  };
  $('#modeNote').onclick = () => {
    state.noteMode = true;
    drawThread(true);
  };
  $('#attachBtn').onclick = () => {
    const u = $('#attachUrl');
    u.hidden = !u.hidden;
    if (!u.hidden) u.focus();
  };
  $('#sendBtn').onclick = sendReply;
  setupComposer();
  $('#replyText').focus();
}

function setupComposer() {
  const ta = $('#replyText');
  const pop = $('#qrPop');
  let items = [];
  let idx = 0;
  const close = () => {
    pop.hidden = true;
    items = [];
  };
  const pick = (qr) => {
    ta.value = ta.value.replace(/(^|\s)\/[^\s/]*$/, '$1') + qr.body;
    close();
    ta.focus();
  };
  const show = () => {
    const m = ta.value.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!m) return close();
    const q = m[1].toLowerCase();
    items = state.quickReplies.filter((r) => r.shortcut.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)).slice(0, 8);
    if (!items.length) return close();
    idx = Math.min(idx, items.length - 1);
    pop.innerHTML = items
      .map((r, i) => `<div class="qr-item ${i === idx ? 'on' : ''}" data-i="${i}"><b>/${esc(r.shortcut)}</b>${esc(r.title)}<div>${esc(r.body)}</div></div>`)
      .join('');
    pop.hidden = false;
    $$('.qr-item', pop).forEach((n) => n.addEventListener('mousedown', (e) => (e.preventDefault(), pick(items[+n.dataset.i]))));
  };
  ta.addEventListener('input', () => {
    idx = 0;
    show();
  });
  ta.addEventListener('keydown', (e) => {
    if (!pop.hidden && items.length) {
      if (e.key === 'ArrowDown') return e.preventDefault(), (idx = (idx + 1) % items.length), show();
      if (e.key === 'ArrowUp') return e.preventDefault(), (idx = (idx - 1 + items.length) % items.length), show();
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pick(items[idx]);
      if (e.key === 'Escape') return close();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendReply();
    }
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
}

let sending = false;
async function sendReply() {
  if (sending) return;
  const ta = $('#replyText');
  const text = ta.value.trim();
  const attachment_url = $('#attachUrl')?.value.trim() || '';
  if (!text && !attachment_url) return;
  sending = true;
  const btn = $('#sendBtn');
  btn.disabled = true;
  const id = state.selConv;
  try {
    if (state.noteMode) {
      await api(`/conversations/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { text } });
    } else {
      await api(`/conversations/${encodeURIComponent(id)}/reply`, {
        method: 'POST',
        body: { text, attachment_url, tag: $('#tagSel')?.value || undefined },
      });
    }
    ta.value = '';
    if ($('#attachUrl')) $('#attachUrl').value = '';
    if (state.selConv === id) {
      state.thread = await api(`/conversations/${encodeURIComponent(id)}`);
      drawThread(true);
      drawSide();
    }
  } catch (e) {
    fail(e);
    if (state.selConv === id) {
      state.thread = await api(`/conversations/${encodeURIComponent(id)}`).catch(() => state.thread);
      drawThread(true);
    }
  } finally {
    sending = false;
    if ($('#sendBtn')) $('#sendBtn').disabled = false;
  }
}

async function setConvStatus(status) {
  try {
    await api(`/conversations/${encodeURIComponent(state.selConv)}`, { method: 'PATCH', body: { status } });
    state.thread = await api(`/conversations/${encodeURIComponent(state.selConv)}`);
    drawThread(false);
    drawSide();
    refreshBadges();
  } catch (e) {
    fail(e);
  }
}

function drawSide() {
  const side = $('#sideCol');
  if (!side || !state.thread) return;
  const { conversation: c, customer, messages } = state.thread;
  const inCount = messages.filter((m) => m.from_type === 'customer').length;
  const outCount = messages.filter((m) => m.from_type === 'page').length;
  const agents = state.settings.agents || [];
  const allTags = [...new Set([...(state.settings.tags || []), ...c.tags])];
  side.innerHTML = `
    <div class="profile">${avatar(c.customer_name, customer?.picture || c.customer_picture)}
      <div style="font-weight:650">${esc(c.customer_name || 'Khách chưa rõ tên')}</div>
      <div class="muted small">PSID: <span class="code">${esc(c.psid)}</span></div>
    </div>
    <div class="side-section"><h3>Trạng thái</h3>
      <div class="seg" id="stSeg">${['open', 'replied', 'done'].map((s) => `<button data-s="${s}" class="${c.status === s ? 'on' : ''}">${STATUS_LABEL[s]}</button>`).join('')}</div>
    </div>
    <div class="side-section"><h3>Người phụ trách</h3>
      <select id="assignSel"><option value="">— Chưa giao —</option>${[...new Set([...agents, c.assigned].filter(Boolean))]
        .map((a) => `<option ${a === c.assigned ? 'selected' : ''}>${esc(a)}</option>`)
        .join('')}</select>
      ${agents.length ? '' : '<div class="muted small">Thêm danh sách nhân viên ở mục Tự động hoá → Cài đặt.</div>'}
    </div>
    <div class="side-section"><h3>Nhãn</h3>
      <div class="tags">${allTags
        .map((t) => `<button class="chip" data-tag="${esc(t)}" style="${c.tags.includes(t) ? 'background:var(--accent-soft);border-color:var(--accent);color:var(--text)' : ''}">${c.tags.includes(t) ? '✓ ' : ''}${esc(t)}</button>`)
        .join('')}</div>
      <input type="text" id="newTag" placeholder="Thêm nhãn mới + Enter">
    </div>
    <div class="side-section"><h3>Ghi chú về khách</h3>
      <textarea id="convNote" placeholder="Số điện thoại, địa chỉ, sở thích…">${esc(c.note || '')}</textarea>
    </div>
    <div class="side-section"><h3>Thông tin</h3>
      <dl class="kv">
        <dt>Trang</dt><dd>${esc(c.page_name)}</dd>
        <dt>Bắt đầu</dt><dd>${fmtDT(customer?.first_seen || c.created_at)}</dd>
        <dt>Tin khách</dt><dd>${inCount}</dd>
        <dt>Tin trang</dt><dd>${outCount}</dd>
        <dt>Cửa sổ 24h</dt><dd>${c.can_reply ? `Còn ${fmtDuration(c.reply_window_left_sec)}` : 'Đã đóng'}</dd>
      </dl>
    </div>`;
  const patch = async (body) => {
    try {
      await api(`/conversations/${encodeURIComponent(c.id)}`, { method: 'PATCH', body });
      state.thread = await api(`/conversations/${encodeURIComponent(c.id)}`);
      drawSide();
      if (body.status) {
        drawThread(false);
        refreshBadges();
      }
    } catch (e) {
      fail(e);
    }
  };
  $('#stSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) patch({ status: b.dataset.s });
  };
  $('#assignSel').onchange = (e) => patch({ assigned: e.target.value });
  $$('[data-tag]', side).forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.tag;
      patch({ tags: c.tags.includes(t) ? c.tags.filter((x) => x !== t) : [...c.tags, t] });
    }),
  );
  $('#newTag').onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) patch({ tags: [...new Set([...c.tags, e.target.value.trim()])] });
  };
  let nt;
  $('#convNote').oninput = (e) => {
    clearTimeout(nt);
    nt = setTimeout(() => api(`/conversations/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: { note: e.target.value } }).catch(fail), 600);
  };
}

/* ================= COMMENTS ================= */
async function renderComments() {
  $('#main').innerHTML = `<div class="view">
    <div class="view-head"><h1>Bình luận</h1>
      <div class="seg" id="cmtFilter">${[['pending', 'Chờ xử lý'], ['all', 'Tất cả']].map(([v, l]) => `<button data-v="${v}" class="${state.commentFilter === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="spacer"></span><span class="muted small">Bình luận của khách chưa được trang trả lời sẽ nằm trong "Chờ xử lý"</span></div>
    <div class="card" style="padding:0" id="cmtList"><div class="empty">Đang tải…</div></div></div>`;
  $('#cmtFilter').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.commentFilter = b.dataset.v;
    renderComments();
  };
  await loadComments();
}

async function loadComments() {
  const params = new URLSearchParams({ limit: '300' });
  if (state.pageFilter) params.set('page_id', state.pageFilter);
  if (state.commentFilter === 'pending') params.set('pending', '1');
  try {
    const rows = await api(`/comments?${params}`);
    // Lấy cả phản hồi của trang để hiển thị dưới bình luận gốc
    const all = state.commentFilter === 'pending' ? [] : rows;
    const top = rows.filter((c) => !c.is_page && (state.commentFilter === 'pending' || !c.parent_id || true));
    const repliesOf = (id) => all.filter((r) => r.parent_id === id);
    const el = $('#cmtList');
    if (!el) return;
    if (!top.length) {
      el.innerHTML = `<div class="empty">${state.commentFilter === 'pending' ? 'Không còn bình luận nào chờ xử lý 🎉' : 'Chưa có bình luận'}</div>`;
      return;
    }
    const multi = !state.pageFilter && state.pages.length > 1;
    el.innerHTML = top
      .map(
        (c) => `<div class="cmt ${c.is_hidden ? 'hidden' : ''}" data-id="${esc(c.id)}">
        ${avatar(c.from_name, '', 'sm')}
        <div style="min-width:0">
          <div class="post-ref">${multi ? `<b>${esc(c.page_name)}</b> · ` : ''}Bài viết: ${c.permalink_url ? `<a href="${esc(c.permalink_url)}" target="_blank" rel="noopener noreferrer">${esc((c.post_message || '(không có nội dung)').slice(0, 90))}</a>` : esc((c.post_message || '').slice(0, 90))}</div>
          <div><b>${esc(c.from_name || 'Người dùng Facebook')}</b> <span class="muted small">· ${timeAgo(c.created_time)}${c.parent_id ? ' · trả lời bình luận khác' : ''}${c.replied ? ' · <span style="color:var(--good-ink)">✓ đã trả lời</span>' : ''}${c.is_hidden ? ' · đã ẩn' : ''}</span></div>
          <div class="body">${linkify(c.message)}</div>
          ${repliesOf(c.id).length ? `<div class="replies">${repliesOf(c.id).map((r) => `<div class="${r.is_page ? 'page-reply' : ''}"><b>${esc(r.from_name)}</b>: ${esc(r.message)}</div>`).join('')}</div>` : ''}
          <div class="reply-box">
            <input type="text" placeholder="Trả lời công khai… (gõ /phím tắt để chèn câu trả lời nhanh)" class="cmt-input">
            <button class="btn primary sm cmt-send">Trả lời</button>
          </div>
          <div class="row" style="margin-top:6px">
            <label class="small"><input type="checkbox" class="cmt-private"> Gửi kèm tin nhắn riêng (inbox)</label>
            <span class="spacer" style="flex:1"></span>
            <button class="btn sm cmt-mark">${c.replied ? 'Bỏ đánh dấu' : '✓ Đã xử lý'}</button>
            <button class="btn sm cmt-hide">${c.is_hidden ? 'Hiện' : 'Ẩn'}</button>
            <button class="btn sm danger cmt-del">Xoá</button>
          </div>
        </div></div>`,
      )
      .join('');
    $$('.cmt', el).forEach((node) => {
      const id = node.dataset.id;
      const c = top.find((x) => x.id === id);
      const input = $('.cmt-input', node);
      input.addEventListener('input', () => {
        const m = input.value.match(/(?:^|\s)\/(\S+)$/);
        if (!m) return;
        const qr = state.quickReplies.find((r) => r.shortcut.toLowerCase() === m[1].toLowerCase());
        if (qr) input.value = input.value.replace(/(?:^|\s)\/\S+$/, (s) => (s.startsWith(' ') ? ' ' : '') + qr.body);
      });
      const send = async () => {
        if (!input.value.trim()) return;
        try {
          const r = await api(`/comments/${encodeURIComponent(id)}/reply`, {
            method: 'POST',
            body: { message: input.value.trim(), private_reply: $('.cmt-private', node).checked },
          });
          toast(r.private_sent ? 'Đã trả lời và gửi tin nhắn riêng' : 'Đã trả lời bình luận', 'ok');
          loadComments();
          refreshBadges();
        } catch (e) {
          fail(e);
        }
      };
      $('.cmt-send', node).onclick = send;
      input.onkeydown = (e) => e.key === 'Enter' && send();
      $('.cmt-mark', node).onclick = () =>
        api(`/comments/${encodeURIComponent(id)}/mark`, { method: 'POST', body: { replied: !c.replied } }).then(() => (loadComments(), refreshBadges())).catch(fail);
      $('.cmt-hide', node).onclick = () =>
        api(`/comments/${encodeURIComponent(id)}/hide`, { method: 'POST', body: { hidden: !c.is_hidden } }).then(() => (loadComments(), refreshBadges())).catch(fail);
      $('.cmt-del', node).onclick = () => {
        if (!confirm('Xoá vĩnh viễn bình luận này trên Facebook?')) return;
        api(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => (toast('Đã xoá', 'ok'), loadComments(), refreshBadges())).catch(fail);
      };
    });
  } catch (e) {
    $('#cmtList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ================= PAGES ================= */
async function renderPages() {
  await loadPages().catch(() => {});
  const me = state.me;
  const origin = location.origin;
  $('#main').innerHTML = `<div class="view">
    <div class="view-head"><h1>Trang</h1><span class="spacer"></span><button class="btn" id="syncAll">⟳ Đồng bộ tất cả</button></div>
    <div class="cards">
      ${
        state.pages.length
          ? state.pages
              .map(
                (p) => `<div class="card page-card" data-id="${esc(p.id)}">
          ${avatar(p.name, p.picture)}
          <div style="min-width:0">
            <div style="font-weight:650">${esc(p.name)} ${p.enabled ? '' : '<span class="chip">đã tắt</span>'} ${p.subscribed ? '<span class="chip">webhook ✓</span>' : '<span class="chip">chưa đăng ký webhook</span>'}</div>
            <div class="page-stats"><span>${esc(p.category || '')}</span><span>👍 ${num(p.fan_count)}</span><span>👥 ${num(p.followers_count)}</span><span>ID: <span class="code">${esc(p.id)}</span></span></div>
            <div class="muted small">Đồng bộ lần cuối: ${fmtDT(p.last_sync)}</div>
            ${p.last_error ? `<div class="err-text">⚠ ${esc(p.last_error)}</div>` : ''}
          </div>
          <div class="row">
            <button class="btn sm" data-act="sync">⟳ Đồng bộ</button>
            <button class="btn sm" data-act="subscribe">Đăng ký webhook</button>
            <button class="btn sm" data-act="token">Đổi token</button>
            <button class="btn sm" data-act="toggle">${p.enabled ? 'Tắt' : 'Bật'}</button>
            <button class="btn sm danger" data-act="delete">Gỡ</button>
          </div></div>`,
              )
              .join('')
          : '<div class="card empty">Chưa kết nối trang nào</div>'
      }
      <div class="grid2">
        <div class="card">
          <h2>Thêm trang bằng Page Access Token</h2>
          <div class="field"><span class="field-label">Page Access Token</span><input type="password" id="pageToken" placeholder="EAAG…" autocomplete="off"></div>
          <div class="row" style="margin-top:10px"><button class="btn primary" id="addPage">Kết nối trang</button></div>
          <p class="muted small">Lấy trong Graph API Explorer: chọn App → User Token có quyền pages_messaging, pages_manage_metadata, pages_read_engagement, pages_manage_engagement, pages_show_list → chọn trang ở mục "Page Access Token".</p>
        </div>
        <div class="card">
          <h2>Nhập tất cả trang từ User Token</h2>
          <div class="field"><span class="field-label">User Access Token</span><input type="password" id="userToken" placeholder="EAAG…" autocomplete="off"></div>
          <div class="row" style="margin-top:10px"><button class="btn primary" id="importPages">Nhập các trang</button></div>
          <p class="muted small">${me.has_app_id ? 'Token sẽ được đổi sang loại dài hạn (60 ngày), và Page Token lấy từ đó không hết hạn.' : 'Đặt FB_APP_ID và FB_APP_SECRET trong .env để tự đổi sang token dài hạn.'}</p>
        </div>
      </div>
      <div class="card">
        <h2>Cấu hình Webhook trên Facebook</h2>
        <ol class="steps">
          <li>Webhook cần URL công khai <b>HTTPS</b>. Khi chạy trên máy cá nhân, dùng <span class="code">cloudflared tunnel --url http://localhost:${esc(location.port || 80)}</span> hoặc ngrok để có URL.</li>
          <li>Vào developers.facebook.com → App → Messenger → Settings (hoặc Webhooks) → <b>Callback URL</b>: <span class="code">https://&lt;tên-miền-của-bạn&gt;/webhook</span> <span class="muted small">(hiện tại: ${esc(origin)}/webhook)</span></li>
          <li><b>Verify Token</b>: giá trị <span class="code">FB_VERIFY_TOKEN</span> trong file .env ${me.verify_token_default ? '<span class="err-text">(bạn đang dùng giá trị mặc định, nên đổi)</span>' : ''}</li>
          <li>Đăng ký các trường: <span class="code">messages</span> <span class="code">messaging_postbacks</span> <span class="code">message_echoes</span> <span class="code">feed</span>. Nút "Đăng ký webhook" ở từng trang sẽ gọi subscribed_apps giúp bạn.</li>
          <li>${me.has_app_secret ? '✓ Đã đặt FB_APP_SECRET, chữ ký webhook được kiểm tra.' : '<span class="err-text">Chưa đặt FB_APP_SECRET: webhook không kiểm tra chữ ký. Nên đặt khi chạy thật.</span>'}</li>
          <li>Khi App ở chế độ Development, chỉ người có vai trò trong App mới nhắn được tới trang. Muốn nhận tin của mọi khách cần App Review cho quyền pages_messaging (hoặc dùng cho chính trang của bạn với Standard Access).</li>
        </ol>
      </div>
    </div></div>`;
  $('#syncAll').onclick = async () => {
    for (const p of state.pages.filter((x) => x.enabled)) {
      try {
        const r = await api(`/pages/${encodeURIComponent(p.id)}/sync`, { method: 'POST' });
        toast(r.result?.skipped ? `${p.name}: bỏ qua (${r.result.skipped})` : `${p.name}: đã đồng bộ`, 'ok');
      } catch (e) {
        fail(e);
      }
    }
    renderPages();
  };
  $('#addPage').onclick = async () => {
    const token = $('#pageToken').value.trim();
    if (!token && !state.me.demo) return toast('Nhập Page Access Token', 'err');
    try {
      const p = await api('/pages', { method: 'POST', body: { access_token: token } });
      toast(`Đã kết nối ${p.name}${p.subscribed === false ? ' (chưa đăng ký được webhook)' : ''}. Đang đồng bộ dữ liệu…`, 'ok');
      await loadPages();
      renderPages();
    } catch (e) {
      fail(e);
    }
  };
  $('#importPages').onclick = async () => {
    const token = $('#userToken').value.trim();
    if (!token) return toast('Nhập User Access Token', 'err');
    try {
      const r = await api('/pages/import', { method: 'POST', body: { user_token: token } });
      toast(`Đã nhập ${r.count} trang. Đang đồng bộ…`, 'ok');
      await loadPages();
      renderPages();
    } catch (e) {
      fail(e);
    }
  };
  $$('.page-card').forEach((card) => {
    const id = card.dataset.id;
    const p = state.pages.find((x) => x.id === id);
    card.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      try {
        if (act === 'sync') {
          e.target.disabled = true;
          const r = await api(`/pages/${encodeURIComponent(id)}/sync?deep=1`, { method: 'POST' });
          toast(r.result?.skipped ? `Bỏ qua: ${r.result.skipped}` : `Đồng bộ xong: ${r.result.conversations} hội thoại, +${r.result.messages} tin, +${r.result.comments} bình luận`, 'ok');
        } else if (act === 'subscribe') {
          await api(`/pages/${encodeURIComponent(id)}/subscribe`, { method: 'POST' });
          toast('Đã đăng ký webhook cho trang', 'ok');
        } else if (act === 'token') {
          const t = prompt('Dán Page Access Token mới cho ' + p.name);
          if (!t) return;
          await api(`/pages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { access_token: t.trim() } });
          toast('Đã cập nhật token', 'ok');
        } else if (act === 'toggle') {
          await api(`/pages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: !p.enabled } });
        } else if (act === 'delete') {
          if (!confirm(`Gỡ trang "${p.name}" và xoá toàn bộ dữ liệu đã lưu của trang này trong hệ thống? (Không ảnh hưởng dữ liệu trên Facebook)`)) return;
          await api(`/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('Đã gỡ trang', 'ok');
        }
        await loadPages();
        renderPages();
      } catch (err) {
        fail(err);
        renderPages();
      }
    });
  });
}

/* ================= AUTOMATION ================= */
async function renderAutomation() {
  $('#main').innerHTML = `<div class="view"><div class="view-head"><h1>Tự động hoá</h1></div><div class="cards" id="auto">Đang tải…</div></div>`;
  try {
    const [rules, qrs, settings] = await Promise.all([api('/rules'), api('/quick-replies'), api('/settings')]);
    state.quickReplies = qrs;
    state.settings = settings;
    const pageOpts = (sel) =>
      `<option value="">Mọi trang</option>${state.pages.map((p) => `<option value="${esc(p.id)}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    const MATCH = { contains: 'Chứa từ khoá', exact: 'Trùng khớp', starts: 'Bắt đầu bằng', regex: 'Regex', any: 'Mọi tin' };
    const APPLY = { message: 'Tin nhắn', comment: 'Bình luận', both: 'Cả hai' };
    const oh = settings.offhours || {};
    const DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    $('#auto').innerHTML = `
      <div class="card">
        <h2>Luật trả lời tự động</h2>
        <p class="muted small" style="margin-top:-6px">Áp dụng cho tin nhắn và bình luận mới đến qua webhook. Luật có độ ưu tiên cao hơn được xét trước, và chỉ luật khớp đầu tiên được dùng. Biến: <span class="code">{name}</span> tên khách, <span class="code">{page}</span> tên trang. Nhiều từ khoá cách nhau bằng dấu phẩy.</p>
        <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Bật</th><th>Tên</th><th>Điều kiện</th><th>Áp dụng</th><th>Trả lời</th><th>Ưu tiên</th><th></th></tr></thead><tbody>
        ${
          rules.length
            ? rules
                .map(
                  (r) => `<tr data-id="${r.id}"><td><input type="checkbox" class="r-en" ${r.enabled ? 'checked' : ''}></td>
            <td>${esc(r.name)}<div class="muted small">${esc(state.pages.find((p) => p.id === r.page_id)?.name || 'Mọi trang')}</div></td>
            <td>${MATCH[r.match_type] || r.match_type}${r.match_type !== 'any' ? `: <span class="code">${esc(r.keyword)}</span>` : ''}</td>
            <td>${APPLY[r.apply_to]}${r.private_reply ? '<div class="muted small">+ inbox riêng</div>' : ''}</td>
            <td class="wrap">${esc(r.reply)}</td><td>${r.priority}</td>
            <td><button class="btn sm r-edit">Sửa</button> <button class="btn sm danger r-del">Xoá</button></td></tr>`,
                )
                .join('')
            : '<tr><td colspan="7" class="muted">Chưa có luật</td></tr>'
        }</tbody></table></div>
        <h2 style="margin-top:16px" id="ruleFormTitle">Thêm luật</h2>
        <form id="ruleForm" class="grid2">
          <input type="hidden" name="id">
          <label class="field"><span class="field-label">Tên luật</span><input type="text" name="name" placeholder="Ví dụ: Hỏi giá"></label>
          <label class="field"><span class="field-label">Trang</span><select name="page_id">${pageOpts('')}</select></label>
          <label class="field"><span class="field-label">Kiểu so khớp</span><select name="match_type">${Object.entries(MATCH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field"><span class="field-label">Từ khoá</span><input type="text" name="keyword" placeholder="giá, bao nhiêu"></label>
          <label class="field"><span class="field-label">Áp dụng cho</span><select name="apply_to">${Object.entries(APPLY).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field"><span class="field-label">Độ ưu tiên</span><input type="number" name="priority" value="0"></label>
          <label class="field" style="grid-column:1/-1"><span class="field-label">Nội dung trả lời</span><textarea name="reply" required placeholder="Chào {name}, …"></textarea></label>
          <label class="small"><input type="checkbox" name="private_reply"> Với bình luận: gửi thêm tin nhắn riêng (private reply)</label>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="ruleReset">Huỷ</button><button class="btn primary">Lưu luật</button></div>
        </form>
      </div>

      <div class="card">
        <h2>Câu trả lời nhanh</h2>
        <p class="muted small" style="margin-top:-6px">Trong ô soạn tin, gõ <span class="code">/</span> + phím tắt để chèn. Hỗ trợ biến <span class="code">{name}</span>, <span class="code">{page}</span>.</p>
        <table class="tbl"><thead><tr><th>Phím tắt</th><th>Tiêu đề</th><th>Nội dung</th><th></th></tr></thead><tbody>
          ${qrs.map((q) => `<tr data-id="${q.id}"><td><span class="code">/${esc(q.shortcut)}</span></td><td>${esc(q.title)}</td><td class="wrap">${esc(q.body)}</td><td><button class="btn sm danger q-del">Xoá</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Chưa có</td></tr>'}
        </tbody></table>
        <form id="qrForm" class="grid2" style="margin-top:12px">
          <label class="field"><span class="field-label">Phím tắt</span><input type="text" name="shortcut" required placeholder="gia"></label>
          <label class="field"><span class="field-label">Tiêu đề</span><input type="text" name="title" placeholder="Báo giá"></label>
          <label class="field" style="grid-column:1/-1"><span class="field-label">Nội dung</span><textarea name="body" required></textarea></label>
          <div></div><div class="row" style="justify-content:flex-end"><button class="btn primary">Thêm</button></div>
        </form>
      </div>

      <div class="card">
        <h2>Trả lời ngoài giờ làm việc</h2>
        <form id="ohForm" class="grid2">
          <label class="small" style="grid-column:1/-1"><input type="checkbox" name="enabled" ${oh.enabled ? 'checked' : ''}> Bật tự động trả lời khi ngoài giờ (mỗi khách tối đa 1 lần / 12 giờ, chỉ khi không có luật nào khớp)</label>
          <label class="field"><span class="field-label">Giờ bắt đầu làm việc</span><input type="time" name="start" value="${esc(oh.start || '08:00')}"></label>
          <label class="field"><span class="field-label">Giờ kết thúc</span><input type="time" name="end" value="${esc(oh.end || '18:00')}"></label>
          <div class="field" style="grid-column:1/-1"><span class="field-label">Ngày làm việc</span><div class="row">${DAYS.map((d, i) => `<label class="small"><input type="checkbox" name="day" value="${i}" ${(oh.days || []).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
          <label class="field" style="grid-column:1/-1"><span class="field-label">Nội dung</span><textarea name="reply">${esc(oh.reply || '')}</textarea></label>
          <div></div><div class="row" style="justify-content:flex-end"><button class="btn primary">Lưu</button></div>
        </form>
      </div>

      <div class="card">
        <h2>Cài đặt nhóm</h2>
        <form id="teamForm" class="grid2">
          <label class="field"><span class="field-label">Nhân viên (mỗi dòng một người)</span><textarea name="agents">${esc((settings.agents || []).join('\n'))}</textarea></label>
          <label class="field"><span class="field-label">Nhãn gợi ý (mỗi dòng một nhãn)</span><textarea name="tags">${esc((settings.tags || []).join('\n'))}</textarea></label>
          <div></div><div class="row" style="justify-content:flex-end"><button class="btn primary">Lưu</button></div>
        </form>
      </div>`;

    const form = $('#ruleForm');
    const resetForm = () => {
      form.reset();
      form.id.value = '';
      $('#ruleFormTitle').textContent = 'Thêm luật';
    };
    $('#ruleReset').onclick = resetForm;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const body = { ...f, private_reply: !!f.private_reply, priority: Number(f.priority) || 0, page_id: f.page_id || null };
      try {
        if (f.id) await api(`/rules/${f.id}`, { method: 'PUT', body });
        else await api('/rules', { method: 'POST', body });
        toast('Đã lưu luật', 'ok');
        renderAutomation();
      } catch (err) {
        fail(err);
      }
    };
    $$('#auto tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      const r = rules.find((x) => String(x.id) === id);
      if (!r) return;
      $('.r-en', tr)?.addEventListener('change', (e) => api(`/rules/${id}`, { method: 'PUT', body: { enabled: e.target.checked } }).catch(fail));
      $('.r-del', tr)?.addEventListener('click', () => confirm('Xoá luật này?') && api(`/rules/${id}`, { method: 'DELETE' }).then(renderAutomation).catch(fail));
      $('.r-edit', tr)?.addEventListener('click', () => {
        for (const k of ['id', 'name', 'match_type', 'keyword', 'apply_to', 'priority', 'reply']) form[k].value = r[k] ?? '';
        form.page_id.value = r.page_id || '';
        form.private_reply.checked = !!r.private_reply;
        $('#ruleFormTitle').textContent = `Sửa luật #${r.id}`;
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    $$('.q-del').forEach((b) =>
      b.addEventListener('click', () => api(`/quick-replies/${b.closest('tr').dataset.id}`, { method: 'DELETE' }).then(renderAutomation).catch(fail)),
    );
    $('#qrForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/quick-replies', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        renderAutomation();
      } catch (err) {
        fail(err);
      }
    };
    $('#ohForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const offhours = {
        enabled: !!fd.get('enabled'),
        start: fd.get('start'),
        end: fd.get('end'),
        days: fd.getAll('day').map(Number),
        reply: fd.get('reply'),
      };
      try {
        await api('/settings', { method: 'PUT', body: { offhours } });
        toast('Đã lưu', 'ok');
      } catch (err) {
        fail(err);
      }
    };
    $('#teamForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const lines = (k) =>
        String(fd.get(k) || '')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean);
      try {
        await api('/settings', { method: 'PUT', body: { agents: lines('agents'), tags: lines('tags') } });
        toast('Đã lưu', 'ok');
      } catch (err) {
        fail(err);
      }
    };
  } catch (e) {
    $('#auto').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ================= ACTIVITY ================= */
async function renderActivity() {
  $('#main').innerHTML = `<div class="view"><div class="view-head"><h1>Nhật ký hoạt động</h1></div><div class="card" id="act">Đang tải…</div></div>`;
  try {
    $('#act').innerHTML = activityList(await api('/activity?limit=200'));
  } catch (e) {
    $('#act').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ================= REALTIME ================= */
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshBadges();
    if (state.view === 'dashboard') renderDashboard();
    if (state.view === 'comments') loadComments();
  }, 400);
}

function connectEvents() {
  const live = $('#live');
  const es = new EventSource('/api/events');
  es.onopen = () => {
    live.className = 'brand-sub live-on';
    live.lastElementChild.textContent = 'Đang theo dõi trực tiếp';
  };
  es.onerror = () => {
    live.className = 'brand-sub live-off';
    live.lastElementChild.textContent = 'Mất kết nối, đang thử lại…';
  };
  es.addEventListener('message', (ev) => {
    const { message: m, conversation: c } = JSON.parse(ev.data);
    if (state.pageFilter && c.page_id !== state.pageFilter) return;
    // Cập nhật danh sách hội thoại
    if (state.view === 'inbox' && $('#convList')) {
      const i = state.convs.findIndex((x) => x.id === c.id);
      if (i >= 0) state.convs.splice(i, 1);
      if (state.selConv === c.id) c.unread = 0;
      const pass =
        state.convFilter === 'all' || (state.convFilter === 'unread' ? c.unread > 0 : c.status === state.convFilter);
      const q = state.convQuery.toLowerCase();
      if (pass && (!q || `${c.customer_name} ${c.snippet}`.toLowerCase().includes(q))) state.convs.unshift(c);
      drawConvList();
    }
    // Cập nhật luồng tin đang mở
    if (state.selConv === c.id && state.thread && state.view === 'inbox' && $('#threadCol')) {
      const idx = state.thread.messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) state.thread.messages[idx] = m;
      else state.thread.messages.push(m);
      state.thread.conversation = { ...state.thread.conversation, ...c };
      const th = $('#thread');
      const atBottom = th && th.scrollHeight - th.scrollTop - th.clientHeight < 80;
      const draft = $('#replyText')?.value || '';
      drawThread(atBottom);
      if ($('#replyText')) $('#replyText').value = draft;
      drawSide();
      if (m.from_type === 'customer' && document.visibilityState === 'visible') {
        api(`/conversations/${encodeURIComponent(c.id)}/read`, { method: 'POST' }).catch(() => {});
      }
    }
    if (m.from_type === 'customer') {
      notify(`${c.customer_name || 'Khách hàng'} · ${c.page_name}`, m.text || '[Tệp đính kèm]', `#/inbox/${encodeURIComponent(c.id)}`);
    }
    scheduleRefresh();
  });
  es.addEventListener('comment', (ev) => {
    const c = JSON.parse(ev.data);
    if (c && !c.is_page && !c.replied && Date.now() - new Date(c.created_time).getTime() < 120e3) {
      notify(`💬 ${c.from_name || 'Bình luận mới'}`, c.message, '#/comments');
    }
    scheduleRefresh();
  });
  es.addEventListener('conversation', (ev) => {
    const c = JSON.parse(ev.data);
    const i = state.convs.findIndex((x) => x.id === c.id);
    if (i >= 0 && state.view === 'inbox') {
      state.convs[i] = { ...state.convs[i], ...c };
      drawConvList();
    }
    scheduleRefresh();
  });
  es.addEventListener('page', () => loadPages().catch(() => {}));
  es.addEventListener('page-removed', () => loadPages().catch(() => {}));
}

let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.25);
  } catch {
    /* bỏ qua */
  }
}
function notify(title, body, hash) {
  if (!state.notify) return;
  beep();
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const n = new Notification(title, { body: String(body).slice(0, 140), tag: hash });
    n.onclick = () => {
      window.focus();
      location.hash = hash;
      n.close();
    };
  }
}

/* ================= INIT ================= */
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme(localGet('theme'));
$('#themeToggle').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  localSet('theme', next);
  applyTheme(next);
  if (state.view === 'dashboard') renderDashboard();
};
function drawNotifyBtn() {
  $('#notifyToggle').textContent = state.notify ? '🔔 Thông báo: bật' : '🔕 Thông báo: tắt';
}
$('#notifyToggle').onclick = async () => {
  state.notify = !state.notify;
  if (state.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  localSet('notify', state.notify ? '1' : '0');
  drawNotifyBtn();
};
drawNotifyBtn();

$('#simMsg').onclick = () =>
  api('/demo/incoming', { method: 'POST', body: { pageId: state.pageFilter || undefined } })
    .then((r) => toast(`Tin mới từ khách${r.auto ? ' (đã tự động trả lời)' : ''}`, 'ok'))
    .catch(fail);
$('#simCmt').onclick = () =>
  api('/demo/comment', { method: 'POST', body: { pageId: state.pageFilter || undefined } })
    .then((r) => toast(`Bình luận mới${r.auto ? ' (đã tự động trả lời)' : ''}`, 'ok'))
    .catch(fail);

(async function init() {
  try {
    state.me = await api('/me');
    $('#demoBox').hidden = !state.me.demo;
    await loadPages();
  } catch (e) {
    fail(e);
  }
  refreshBadges();
  connectEvents();
  route();
  setInterval(refreshBadges, 60_000);
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => state.view === 'dashboard' && $('#chart') && renderDashboard(), 300);
  });
})();
