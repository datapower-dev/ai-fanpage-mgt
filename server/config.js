import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (e) {
    console.warn('Không đọc được .env:', e.message);
  }
}

const argv = process.argv.slice(2);
const demo = argv.includes('--demo') || process.env.DEMO === '1';

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  graphVersion: process.env.GRAPH_VERSION || 'v23.0',
  appId: process.env.FB_APP_ID || '',
  appSecret: process.env.FB_APP_SECRET || '',
  verifyToken: process.env.FB_VERIFY_TOKEN || 'fanpage-verify-token',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Demo dùng file riêng để không lẫn với dữ liệu thật
  dbPath: path.resolve(root, demo ? process.env.DEMO_DB_PATH || path.join('data', 'demo.db') : process.env.DB_PATH || path.join('data', 'fanpage.db')),
  syncIntervalSec: Number(process.env.SYNC_INTERVAL_SEC ?? 120),
  demo,
};
