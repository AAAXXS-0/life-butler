/**
 * 异常检测器 (cron 每 10 分钟)
 *
 * 职责: 扫 MySQL 当前状态,对比上次基线 (last_known.json),有变化推 trip-agent
 *
 * 流程:
 *  1. 读 MySQL 当前状态 (node_status + edge_status)
 *  2. 读 last_known.json (本地文件)
 *  3. 首次运行 -> 存当前状态到 last_known.json,退出
 *  4. 非首次 -> diff (对比当前 vs last_known)
 *  5. 无差异 -> 退出
 *  6. 有差异 -> 构造 inbox 消息 -> 追加到 shared/trip-agent/YYYY-MM-DD.json (带 fcntl 写锁)
 *                -> openclaw cron run <trip-agent-wake-id>
 *                -> 更新 last_known.json
 *
 * 关键文件:
 *  - mock_backend/state/last_known.json  detector 唯一的本地文件,作为 diff 基线
 *  - shared/trip-agent/YYYY-MM-DD.json   detector 写入,trip-agent 收件箱
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'life_butler_db',
};

const STATE_DIR = path.resolve(__dirname, '..', 'state');
const LAST_KNOWN_PATH = path.join(STATE_DIR, 'last_known.json');
const SHARED_DIR = path.resolve(__dirname, '..', '..', 'shared', 'trip-agent');
const TRIP_AGENT_WAKE_ID = process.env.TRIP_AGENT_WAKE_ID || 'trip-agent-wake';

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

function nowIso() {
  return new Date().toISOString();
}

/**
 * 原子写文件: 写到 tmp,再 rename
 */
function atomicWriteJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * 读当前 MySQL 状态
 */
async function fetchCurrentState() {
  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const [nodes] = await conn.query('SELECT node_id, status, reason FROM node_status');
    const [edges] = await conn.query('SELECT edge_id, status, reason FROM edge_status');
    const nodeMap = {};
    for (const r of nodes) {
      nodeMap[r.node_id] = { status: r.status, reason: r.reason };
    }
    const edgeMap = {};
    for (const r of edges) {
      edgeMap[r.edge_id] = { status: r.status, reason: r.reason };
    }
    return { nodes: nodeMap, edges: edgeMap };
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}

/**
 * 读 last_known.json
 */
function readLastKnown() {
  if (!fs.existsSync(LAST_KNOWN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LAST_KNOWN_PATH, 'utf8'));
  } catch (err) {
    console.warn('[anomaly_detector] last_known.json corrupted, treat as first run:', err.message);
    return null;
  }
}

/**
 * diff 对比
 * 返回 { node_changes: [...], edge_changes: [...] }
 *  - node_changes: [{ node_id, old: {status, reason}|null, new: {status, reason} }]
 *  - edge_changes: [{ edge_id, old, new }]
 */
function diffStates(prev, cur) {
  const nodeChanges = [];
  const edgeChanges = [];

  // 节点 diff
  const allNodeIds = new Set([...Object.keys(prev.nodes), ...Object.keys(cur.nodes)]);
  for (const id of allNodeIds) {
    const oldS = prev.nodes[id] || null;
    const newS = cur.nodes[id] || null;
    if (JSON.stringify(oldS) !== JSON.stringify(newS)) {
      nodeChanges.push({ node_id: id, old: oldS, new: newS });
    }
  }
  // 边 diff
  const allEdgeIds = new Set([...Object.keys(prev.edges), ...Object.keys(cur.edges)]);
  for (const id of allEdgeIds) {
    const oldS = prev.edges[id] || null;
    const newS = cur.edges[id] || null;
    if (JSON.stringify(oldS) !== JSON.stringify(newS)) {
      edgeChanges.push({ edge_id: id, old: oldS, new: newS });
    }
  }
  return { node_changes: nodeChanges, edge_changes: edgeChanges };
}

/**
 * 追加 inbox 消息 (使用 fcntl 写锁)
 */
function appendInbox(message) {
  ensureDir(SHARED_DIR);
  const date = todayStr();
  const filePath = path.join(SHARED_DIR, `${date}.json`);

  let inbox = [];
  if (fs.existsSync(filePath)) {
    try { inbox = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { inbox = []; }
    if (!Array.isArray(inbox)) inbox = [];
  }

  // 简单文件锁: 轮询等待锁释放（最多 5s）
  const lockFile = filePath + '.lock';
  const start = Date.now();
  while (fs.existsSync(lockFile) && Date.now() - start < 5000) {
    // spin wait 50ms
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

/**
 * 唤醒 trip-agent
 */
function wakeTripAgent() {
  try {
    execSync(`openclaw cron run ${TRIP_AGENT_WAKE_ID}`, { stdio: 'inherit' });
  } catch (err) {
    console.warn(`[anomaly_detector] openclaw cron run failed: ${err.message}`);
  }
}

async function runOnce() {
  const cur = await fetchCurrentState();
  const prev = readLastKnown();

  if (!prev) {
    // 首次运行,存基线
    ensureDir(STATE_DIR);
    atomicWriteJson(LAST_KNOWN_PATH, cur);
    console.log('[anomaly_detector] first run, baseline saved');
    return { first_run: true };
  }

  const diff = diffStates(prev, cur);
  const totalChanges = diff.node_changes.length + diff.edge_changes.length;
  if (totalChanges === 0) {
    console.log('[anomaly_detector] no changes');
    return { changes: 0 };
  }

  // 构造 inbox 消息
  const message = {
    type: 'info_share',
    from: 'mock-detector',
    to: 'trip-agent',
    timestamp: nowIso(),
    content: {
      type: 'anomaly_diff',
      diff,
    },
  };
  appendInbox(message);
  wakeTripAgent();

  // 更新基线
  atomicWriteJson(LAST_KNOWN_PATH, cur);

  console.log(`[anomaly_detector] ${totalChanges} changes -> trip-agent notified`);
  return { changes: totalChanges, diff };
}

if (require.main === module) {
  runOnce()
    .then((r) => {
      console.log('[anomaly_detector] result:', JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[anomaly_detector] failed:', err);
      process.exit(1);
    });
}

module.exports = { runOnce, diffStates };
