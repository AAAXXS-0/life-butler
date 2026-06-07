/**
 * mockend 坏事检测器 (cron 每 10 分钟)
 *
 * 职责: 从 MySQL events 表读最近 1 小时的新事件, 只推坏事 (is_good=0) 给 trip-agent
 * 好事 (is_good=1) 直接丢弃: 天气变晴 / 排队减少
 *
 * 数据流:
 *   events 表 (generator 写入, is_good 标记)
 *     ↓ 拉最近 N 分钟 + is_good=0
 *   shared/trip-agent/YYYY-MM-DD.json (带 fcntl 写锁)
 *     ↓ openclaw cron run butler-trip-agent-wake
 *   trip-agent 被唤醒处理 replan
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3308', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'life_butler_db',
};

const STATE_DIR = path.resolve(__dirname, '..', 'state');
const LAST_KNOWN_PATH = path.join(STATE_DIR, 'last_event_id.json');
const SHARED_DIR = path.resolve(__dirname, '..', '..', 'shared', 'trip-agent');
const TRIP_AGENT_WAKE_ID = process.env.TRIP_AGENT_WAKE_ID || 'butler-trip-agent-wake';
const LOOKBACK_MINUTES = parseInt(process.env.EVENT_LOOKBACK_MIN || '40', 10); // 比 generator 频率大以防漏

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function atomicWriteJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function readLastKnown() {
  if (!fs.existsSync(LAST_KNOWN_PATH)) return { last_event_id: 0 };
  try {
    return JSON.parse(fs.readFileSync(LAST_KNOWN_PATH, 'utf8'));
  } catch (err) {
    return { last_event_id: 0 };
  }
}

/**
 * 拉最近 N 分钟的所有新事件（好+坏）
 */
async function fetchNewEvents(conn, lastEventId) {
  const [rows] = await conn.query(
    `SELECT id, type, target_type, target_id, severity, is_good, title, detail, created_at
     FROM events
     WHERE id > ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
     ORDER BY id ASC`,
    [String(lastEventId), LOOKBACK_MINUTES]
  );
  return rows;
}

function appendInbox(message) {
  ensureDir(SHARED_DIR);
  const filePath = path.join(SHARED_DIR, `${todayStr()}.json`);
  let inbox = [];
  if (fs.existsSync(filePath)) {
    try { inbox = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { inbox = []; }
    if (!Array.isArray(inbox)) inbox = [];
  }
  // 简单文件锁: spin wait 50ms
  const lockFile = filePath + '.lock';
  const start = Date.now();
  while (fs.existsSync(lockFile) && Date.now() - start < 5000) {
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) { /* busy */ }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  try {
    inbox.push(message);
    atomicWriteJson(filePath, inbox);
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) { /* ignore */ }
  }
}

function wakeTripAgent() {
  try {
    execSync(`openclaw cron run ${TRIP_AGENT_WAKE_ID}`, { stdio: 'inherit' });
  } catch (err) {
    console.warn(`[event_detector] openclaw cron run failed: ${err.message}`);
  }
}

async function runOnce() {
  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const last = readLastKnown();
    const lastId = last.last_event_id || 0;
    const all = await fetchNewEvents(conn, lastId);

    if (all.length === 0) {
      console.log('[event_detector] no new events');
      return { new: 0, bad: 0 };
    }

    // 过滤坏事
    const bad = all.filter((e) => e.is_good === 0);
    const good = all.filter((e) => e.is_good === 1);

    // 更新 last_known 到最大 id
    const maxId = all[all.length - 1].id;
    atomicWriteJson(LAST_KNOWN_PATH, { last_event_id: maxId, updated_at: new Date().toISOString() });

    if (good.length > 0) {
      console.log(`[event_detector] ${good.length} good events filtered: ${good.map(g => g.title).join('; ')}`);
    }

    if (bad.length === 0) {
      console.log(`[event_detector] only good events, nothing to push`);
      return { new: all.length, bad: 0, filtered_good: good.length };
    }

    // 构造 inbox 消息
    const message = {
      type: 'info_share',
      from: 'mock-detector',
      to: 'trip-agent',
      timestamp: new Date().toISOString(),
      content: {
        type: 'bad_events',
        events: bad,
      },
    };
    appendInbox(message);
    wakeTripAgent();

    console.log(`[event_detector] ${bad.length} bad events → trip-agent notified`);
    return { new: all.length, bad: bad.length, filtered_good: good.length };
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  runOnce()
    .then((r) => {
      console.log('[event_detector] result:', JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[event_detector] failed:', err);
      process.exit(1);
    });
}

module.exports = { runOnce };
