/**
 * mockend 事件发生器 (cron 每 30 分钟)
 *
 * 职责: 随机变更 MySQL 状态表 + 记 events 行
 *   - node_status / edge_status (动态状态)
 *   - nodes.queue_count (餐厅排队人数)
 *   - weather (全市天气)
 *
 * 事件类型 (events.type 字段):
 *   1  天气转晴       (good)
 *   2  天气转雨       (bad)
 *   3  天气转沙尘暴   (bad)
 *   4  天气转台风     (bad)
 *   5  排队 +10       (bad)
 *   6  排队 -10       (good)
 *   7  POI 限流       (bad)
 *   8  餐厅满座       (bad)
 *   9  道路封闭       (bad)
 *  10  交通拥堵       (bad)
 *  11  地铁延误       (bad)
 *  12  no_op         (-)
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3308', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'life_butler_db',
};

// 事件类型 (code, weight, is_good)
const EVENTS = [
  { code: 'weather_sunny',    type: 1,  weight: 8,  is_good: 1, target_type: 'city' },
  { code: 'weather_rainy',    type: 2,  weight: 10, is_good: 0, target_type: 'city' },
  { code: 'weather_sandstorm', type: 3, weight: 4,  is_good: 0, target_type: 'city' },
  { code: 'weather_typhoon',  type: 4,  weight: 2,  is_good: 0, target_type: 'city' },
  { code: 'queue_increase',   type: 5,  weight: 8,  is_good: 0, target_type: 'node' },
  { code: 'queue_decrease',   type: 6,  weight: 8,  is_good: 1, target_type: 'node' },
  { code: 'poi_crowded',      type: 7,  weight: 12, is_good: 0, target_type: 'node' },
  { code: 'restaurant_full',  type: 8,  weight: 12, is_good: 0, target_type: 'node' },
  { code: 'road_closed',      type: 9,  weight: 10, is_good: 0, target_type: 'edge' },
  { code: 'traffic_jam',      type: 10, weight: 15, is_good: 0, target_type: 'edge' },
  { code: 'metro_delay',      type: 11, weight: 8,  is_good: 0, target_type: 'edge' },
  { code: 'no_op',            type: 12, weight: 3,  is_good: 0, target_type: 'none' },
];

const WEATHER_CODE_TO_STATUS = {
  weather_sunny: 'sunny',
  weather_rainy: 'rainy',
  weather_sandstorm: 'sandstorm',
  weather_typhoon: 'typhoon',
};

const WEATHER_TEMP_RANGE = { sunny: [20, 30], rainy: [15, 22], sandstorm: [10, 18], typhoon: [18, 25] };

function pickWeighted() {
  const total = EVENTS.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of EVENTS) {
    r -= e.weight;
    if (r <= 0) return e;
  }
  return EVENTS[EVENTS.length - 1];
}

function newEventId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

async function applyWeatherEvent(conn, evt) {
  const status = WEATHER_CODE_TO_STATUS[evt.code];
  const [min, max] = WEATHER_TEMP_RANGE[status];
  const temp = Math.floor(Math.random() * (max - min + 1)) + min;
  await conn.query(
    'UPDATE weather SET status = ?, temperature = ?, updated_at = NOW() WHERE city = ?',
    [status, temp, '北京']
  );
  return { target: '北京', title: `北京天气 → ${status} (${temp}°C)`, detail: `天气变化为 ${status}, 温度 ${temp}°C` };
}

async function applyQueueEvent(conn, evt, delta) {
  // 选一个 restaurant 改 queue_count
  const [rows] = await conn.query(
    "SELECT id, name, queue_count FROM nodes WHERE type = 'restaurant' ORDER BY RAND() LIMIT 1"
  );
  if (rows.length === 0) return null;
  const node = rows[0];
  // 排队 +10 在 [0, 200] 范围钳制
  const newCount = Math.max(0, Math.min(200, node.queue_count + delta));
  await conn.query('UPDATE nodes SET queue_count = ? WHERE id = ?', [newCount, node.id]);
  return {
    target: node.id,
    title: `${node.name} 排队人数 ${node.queue_count} → ${newCount}`,
    detail: `排队人数从 ${node.queue_count} 变到 ${newCount}`,
  };
}

async function applyPoiEvent(conn, status, reason) {
  const [rows] = await conn.query(
    "SELECT id, name FROM nodes WHERE type IN ('attraction','restaurant') ORDER BY RAND() LIMIT 1"
  );
  if (rows.length === 0) return null;
  const node = rows[0];
  await conn.query(
    `INSERT INTO node_status (node_id, status, reason) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), updated_at = CURRENT_TIMESTAMP`,
    [node.id, status, reason]
  );
  return { target: node.id, title: `${node.name} → ${status}`, detail: reason };
}

async function applyEdgeEvent(conn, status, reason) {
  const [rows] = await conn.query(
    "SELECT id, type FROM edges ORDER BY RAND() LIMIT 1"
  );
  if (rows.length === 0) return null;
  const edge = rows[0];
  await conn.query(
    `INSERT INTO edge_status (edge_id, status, reason) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), updated_at = CURRENT_TIMESTAMP`,
    [edge.id, status, reason]
  );
  return { target: edge.id, title: `边 ${edge.id} (${edge.type}) → ${status}`, detail: reason };
}

async function runOnce() {
  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const evt = pickWeighted();
    if (evt.code === 'no_op') {
      console.log('[event_generator] no_op (skipped)');
      return { event: 'no_op' };
    }

    let applied = null;

    if (evt.target_type === 'city') {
      applied = await applyWeatherEvent(conn, evt);
    } else if (evt.code === 'queue_increase') {
      applied = await applyQueueEvent(conn, evt, 10);
    } else if (evt.code === 'queue_decrease') {
      applied = await applyQueueEvent(conn, evt, -10);
    } else if (evt.code === 'poi_crowded') {
      applied = await applyPoiEvent(conn, 'limited', '客流激增');
    } else if (evt.code === 'restaurant_full') {
      applied = await applyPoiEvent(conn, 'full', '临时满座');
    } else if (evt.code === 'road_closed') {
      applied = await applyEdgeEvent(conn, 'closed', '道路施工');
    } else if (evt.code === 'traffic_jam') {
      applied = await applyEdgeEvent(conn, 'congested', '交通拥堵');
    } else if (evt.code === 'metro_delay') {
      applied = await applyEdgeEvent(conn, 'congested', '地铁延误');
    }

    if (!applied) {
      console.log(`[event_generator] ${evt.code} skipped (no target)`);
      return { event: evt.code, skipped: true };
    }

    // 记 events
    const eventId = newEventId('evt');
    await conn.query(
      `INSERT INTO events (id, type, target_type, target_id, severity, is_good, title, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        evt.type,
        evt.target_type,
        applied.target,
        evt.is_good ? 'low' : 'medium',
        evt.is_good,
        applied.title,
        applied.detail,
      ]
    );

    const tag = evt.is_good ? '✓good' : '✗bad';
    console.log(`[event_generator] ${tag} ${evt.code} (${evt.type}): ${applied.title}`);
    return { event: evt.code, type: evt.type, is_good: !!evt.is_good, target: applied.target };
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  runOnce()
    .then((r) => {
      console.log('[event_generator] result:', JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[event_generator] failed:', err);
      process.exit(1);
    });
}

module.exports = { runOnce, EVENTS };
