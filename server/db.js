import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  category TEXT DEFAULT '',
  picture TEXT DEFAULT '',
  link TEXT DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  fan_count INTEGER DEFAULT 0,
  followers_count INTEGER DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscribed INTEGER NOT NULL DEFAULT 0,
  last_sync TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  page_id TEXT NOT NULL,
  psid TEXT NOT NULL,
  name TEXT DEFAULT '',
  picture TEXT DEFAULT '',
  first_seen TEXT,
  last_seen TEXT,
  PRIMARY KEY (page_id, psid)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,              -- page_id:psid
  page_id TEXT NOT NULL,
  psid TEXT NOT NULL,
  fb_conv_id TEXT,
  customer_name TEXT DEFAULT '',
  snippet TEXT DEFAULT '',
  updated_time TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', -- open | replied | done
  assigned TEXT DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT DEFAULT '',
  read_at TEXT,
  done_at TEXT,
  last_customer_msg_at TEXT,
  last_page_msg_at TEXT,
  last_auto_reply_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_page_updated ON conversations(page_id, updated_time DESC);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,              -- Facebook mid hoặc id tự sinh
  conv_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  from_type TEXT NOT NULL,          -- customer | page
  from_id TEXT,
  text TEXT DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received', -- received | sent | failed
  error TEXT,
  source TEXT DEFAULT 'webhook',    -- webhook | sync | app | auto | demo
  response_seconds INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_time ON messages(conv_id, created_time);
CREATE INDEX IF NOT EXISTS idx_msg_page_time ON messages(page_id, created_time);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  message TEXT DEFAULT '',
  created_time TEXT,
  permalink_url TEXT DEFAULT '',
  picture TEXT DEFAULT '',
  likes INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_page ON posts(page_id, created_time DESC);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  parent_id TEXT,
  from_id TEXT,
  from_name TEXT DEFAULT '',
  message TEXT DEFAULT '',
  created_time TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_page INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_time);
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(page_id, created_time DESC);

CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcut TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auto_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT,                     -- NULL = áp dụng mọi trang
  enabled INTEGER NOT NULL DEFAULT 1,
  name TEXT DEFAULT '',
  match_type TEXT NOT NULL DEFAULT 'contains', -- contains | exact | starts | regex | any
  keyword TEXT NOT NULL DEFAULT '',
  reply TEXT NOT NULL DEFAULT '',
  apply_to TEXT NOT NULL DEFAULT 'message',    -- message | comment | both
  private_reply INTEGER NOT NULL DEFAULT 0,    -- với bình luận: gửi thêm tin nhắn riêng
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  page_id TEXT,
  detail TEXT DEFAULT ''
);
`);

export const nowIso = () => new Date().toISOString();

export function toIso(v) {
  if (!v) return nowIso();
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}

// node:sqlite không nhận undefined/boolean -> chuẩn hoá tham số
const norm = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export function all(sql, ...params) {
  return db.prepare(sql).all(...norm(params));
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...norm(params));
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...norm(params));
}

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key=?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}
export function setSetting(key, value) {
  run(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    JSON.stringify(value),
  );
}
