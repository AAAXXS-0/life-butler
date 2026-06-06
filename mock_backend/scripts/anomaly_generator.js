/**
 * 异常发生器 (cron 每 30 分钟)
 *
 * 职责: 随机变更 MySQL 中 node_status / edge_status 表的动态状态,并写入 events 表
 * 注意: 不发通知,detector 负责发现差异
 *
 * 事件概率分布:
 *   node 事件:
 *     - poi_crowded  (15%) status=limited, reason='客流激增'
 *     - poi_closed   (5%)  status=closed,  reason='临时关闭'
 *     - weather_bad  (10%) status=limited, reason='极端天气'
 *     - event_held   (10%) status=full,    reason='临时活动'
 *     - no_op        (10%) 什么也不做
 *   edge 事件:
 *     - road_closed  (15%) status=closed,     reason='道路施工'
 *     - traffic_jam  (20%) status=congested,  reason='交通拥堵'
 *     - metro_delay  (15%) status=congested,  reason='信号故障'
 *
 * 注意点:
 *   - 不加图结构,只改动态状态
 *   - 写入 events 表记一条
 *   - 50% 概率选 node / 50% 概率选 edge
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'life_butler_db',
};

// 事件类型 1-7 (按 type 字段存储)
const NODE_EVENTS = [
  { code: 'poi_crowded', weight: 15, status: 'limited', reason: '客流激增', severity: 'medium', title: 'POI 客流激增' },
  { code: 'poi_closed',  weight: 5,  status: 'closed',  reason: '临时关闭', severity: 'high',   title: 'POI 临时关闭' },
  { code: 'weather_bad', weight: 10, status: 'limited', reason: '极端天气', severity: 'medium', title: '极端天气' },
  { code: 'event_held',  weight: 10, status: 'full',    reason: '临时活动', severity: 'low',    title: '临时活动' },
  { code: 'no_op',       weight: 10, status: null,      reason: null,      severity: 'low',    title: '无操作' },
];

const EDGE_EVENTS = [
  { code: 'road_closed', weight: 15, status: 'closed',    reason: '道路施工',  severity: 'high',   title: '道路施工' },
  { code: 'traffic_jam', weight: 20, status: 'congested', reason: '交通拥堵',  severity: 'medium', title: '交通拥堵' },
  { code: 'metro_delay', weight: 15, status: 'congested', reason: '信号故障',  severity: 'medium', title: '地铁延误' },
];

function pickWeighted(list) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of list) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return list[list.length - 1];
}

function newEventId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

async function withConn(fn) {
  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    return await fn(conn);
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}

async function pickRandomNode(conn) {
  const [rows] = await conn.query('SELECT id, name, type FROM nodes ORDER BY RAND() LIMIT 1');
  return rows[0] || null;
}

async function pickRandomEdge(conn) {
  const [rows] = await conn.query('SELECT id, type FROM edges ORDER BY RAND() LIMIT 1');
  return rows[0] || null;
}

async function runOnce() {
  await withConn(async (conn) => {
    // 50/50 决定是 node 还是 edge 事件
    const isNode = Math.random() < 0.5;
    if (isNode) {
      const node = await pickRandomNode(conn);
      if (!node) {
        console.warn('[anomaly_generator] no nodes in DB, skip');
        return;
      }
      const evt = pickWeighted(NODE_EVENTS);
      if (evt.code === 'no_op') {
        // 不写状态变更,但也不记事件
        return;
      }
      // 写入 node_status (INSERT ... ON DUPLICATE KEY UPDATE 模式)
      await conn.query(
        `INSERT INTO node_status (node_id, status, reason) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), updated_at = CURRENT_TIMESTAMP`,
        [node.id, evt.status, evt.reason]
      );
      // 记 event
      const eventId = newEventId('evt_node');
      await conn.query(
        `INSERT INTO events (id, type, target_type, target_id, severity, title, detail)
         VALUES (?, ?, 'node', ?, ?, ?, ?)`,
        [
          eventId,
          evt.code === 'poi_crowded' ? 1 : evt.code === 'poi_closed' ? 2 : evt.code === 'weather_bad' ? 3 : 4,
          node.id,
          evt.severity,
          evt.title,
          `${node.name} (${node.id}) - ${evt.reason}`,
        ]
      );
      console.log(`[anomaly_generator] node ${node.id} -> ${evt.status} (${evt.code})`);
    } else {
      const edge = await pickRandomEdge(conn);
      if (!edge) {
        console.warn('[anomaly_generator] no edges in DB, skip');
        return;
      }
      const evt = pickWeighted(EDGE_EVENTS);
      await conn.query(
        `INSERT INTO edge_status (edge_id, status, reason) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), updated_at = CURRENT_TIMESTAMP`,
        [edge.id, evt.status, evt.reason]
      );
      const eventId = newEventId('evt_edge');
      await conn.query(
        `INSERT INTO events (id, type, target_type, target_id, severity, title, detail)
         VALUES (?, ?, 'edge', ?, ?, ?, ?)`,
        [
          eventId,
          evt.code === 'road_closed' ? 5 : evt.code === 'traffic_jam' ? 6 : 7,
          edge.id,
          evt.severity,
          evt.title,
          `edge ${edge.id} (${edge.type}) - ${evt.reason}`,
        ]
      );
      console.log(`[anomaly_generator] edge ${edge.id} -> ${evt.status} (${evt.code})`);
    }
  });
}

if (require.main === module) {
  runOnce()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[anomaly_generator] failed:', err);
      process.exit(1);
    });
}

module.exports = { runOnce };
