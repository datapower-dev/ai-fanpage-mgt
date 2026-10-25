import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import './db.js';
import { api, errorHandler } from './routes.js';
import { sseHandler } from './events.js';
import { verifyHandler, receiveHandler } from './webhook.js';
import { startScheduler } from './sync.js';
import { seedDemo } from './demo.js';
import { applyStoredAppConfig, oauthStart, oauthCallback } from './facebook.js';
import { setSetting, nowIso } from './db.js';

applyStoredAppConfig();

const app = express();
app.disable('x-powered-by');

// Giữ raw body để kiểm tra chữ ký webhook
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Webhook của Facebook: không yêu cầu mật khẩu
app.get('/webhook', verifyHandler);
app.post('/webhook', receiveHandler);
// Facebook chuyển hướng về đây sau khi đăng nhập (được bảo vệ bằng mã state)
app.get('/auth/facebook/callback', oauthCallback);

// Bảo vệ phần còn lại bằng Basic Auth nếu có ADMIN_PASSWORD
const sameSecret = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
app.use((req, res, next) => {
  if (!config.adminPassword) return next();
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    if (sameSecret(pass, config.adminPassword)) return next();
  }
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (bearer && sameSecret(bearer, config.adminPassword)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Fanpage Manager", charset="UTF-8"');
  res.status(401).send('Cần mật khẩu quản trị');
});

app.get('/auth/facebook/start', oauthStart);

// Ghi nhận lần cuối Claude gọi qua MCP (để màn hình Kết nối hiển thị trạng thái)
let lastMcpWrite = 0;
app.use('/api', (req, res, next) => {
  if (req.get('x-fanpage-client') === 'mcp' && Date.now() - lastMcpWrite > 10_000) {
    lastMcpWrite = Date.now();
    setSetting('last_mcp_at', nowIso());
  }
  next();
});

app.get('/api/events', sseHandler);
app.use('/api', api);
app.use('/api', errorHandler);
app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

if (config.demo) {
  const created = seedDemo();
  console.log(`[demo] Chế độ demo${created ? ': đã tạo dữ liệu mẫu' : ''}`);
}

app.listen(config.port, () => {
  console.log(`Fanpage Manager đang chạy: http://localhost:${config.port}`);
  console.log(`Webhook: http://localhost:${config.port}/webhook (cần URL công khai HTTPS khi dùng thật)`);
  if (!config.appSecret && !config.demo) console.log('Cảnh báo: chưa đặt FB_APP_SECRET, webhook không kiểm tra chữ ký.');
  startScheduler();
});
