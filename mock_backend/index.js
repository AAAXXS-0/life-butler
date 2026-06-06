/**
 * Mock Backend - 图数据查询模块 (CommonJS)
 *
 * 库名: life_butler_db
 * 表: nodes / edges / node_status / edge_status / events
 *
 * 关键点:
 *  - nodes.city 在 props JSON 里,走 JSON_EXTRACT(props, '$.city')
 *  - nodes.tags  在 props JSON 数组里,走 JSON_CONTAINS(props->'$.tags', JSON_QUOTE(?))
 *  - 最短路径使用自实现 Dijkstra,跳过 closed 节点/边
 *  - DB 断连自动重试
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// ============== 配置 ==============
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'life_butler_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
  multipleStatements: false,
  charset: 'utf8mb4',
};

// ============== 连接池(懒加载 + 断连重试) ==============
let pool = null;
let reconnecting = false;

function getPool() {
  if (pool) return pool;
  pool = mysql.createPool(DB_CONFIG);
  // 监听连接错误,触发重连
  pool.on('connection', (conn) => {
    conn.on('error', (err) => {
      console.error('[mock_backend] MySQL connection error:', err.code || err.message);
      if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.fatal) {
        scheduleReconnect();
      }
    });
  });
  return pool;
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(() => {
    console.log('[mock_backend] Reconnecting to MySQL...');
    if (pool) {
      try { pool.end(); } catch (_) { /* ignore */ }
      pool = null;
    }
    reconnecting = false;
  }, 1000);
}

/**
 * 带重试的查询包装器
 * @param {Function} fn - 接收 connection 返回 Promise
 * @param {number} retries
 */
async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn(getPool());
    } catch (err) {
      lastErr = err;
      const transient = ['ECONNRESET', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST',
        'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'POOL_CLOSED'];
      if (!transient.includes(err.code) && err.fatal !== true) throw err;
      if (pool) {
        try { await pool.end(); } catch (_) { /* ignore */ }
        pool = null;
      }
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr;
}

// ============== SQL 构造器 ==============
function buildNodeWhere(filter) {
  const parts = [];
  const params = [];
  if (filter.type) {
    parts.push('n.type = ?');
    params.push(filter.type);
  }
  if (filter.city) {
    parts.push("JSON_EXTRACT(n.props, '$.city') = ?");
    params.push(filter.city);
  }
  if (Array.isArray(filter.tags) && filter.tags.length > 0) {
    const tagConds = filter.tags.map(() => "JSON_CONTAINS(n.props->'$.tags', JSON_QUOTE(?))");
    parts.push('(' + tagConds.join(' OR ') + ')');
    params.push(...filter.tags);
  }
  if (filter.category) {
    // category 兼容:既可能在 props.category, 也可能是 tags 里的一个
    parts.push("(JSON_EXTRACT(n.props, '$.category') = ? OR JSON_CONTAINS(n.props->'$.tags', JSON_QUOTE(?)))");
    params.push(filter.category, filter.category);
  }
  if (typeof filter.max_price === 'number') {
    parts.push('CAST(JSON_EXTRACT(n.props, \'$.price\') AS DECIMAL(10,2)) <= ?');
    params.push(filter.max_price);
  }
  if (typeof filter.min_rating === 'number') {
    parts.push('CAST(JSON_EXTRACT(n.props, \'$.rating\') AS DECIMAL(3,1)) >= ?');
    params.push(filter.min_rating);
  }
  if (Array.isArray(filter.exclude_status) && filter.exclude_status.length > 0) {
    const ph = filter.exclude_status.map(() => '?').join(',');
    parts.push(`(ns.status IS NULL OR ns.status NOT IN (${ph}))`);
    params.push(...filter.exclude_status);
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

// ============== 对外接口 ==============

/**
 * 查节点(含实时状态)
 * @param {Object} filter - { type, city, tags[], category, max_price, min_rating, exclude_status[] }
 * @returns {Array} [{ id, type, name, lat, lng, props, status, status_reason }]
 */
async function query_nodes(filter = {}) {
  const { sql: where, params } = buildNodeWhere(filter);
  const orderBy = ' ORDER BY CAST(JSON_EXTRACT(n.props, \'$.rating\') AS DECIMAL(3,1)) DESC';
  const sql = `
    SELECT n.id, n.type, n.name, n.lat, n.lng, n.props,
           n.queue_count, n.is_indoor,
           ns.status AS status, ns.reason AS status_reason
    FROM nodes n
    LEFT JOIN node_status ns ON ns.node_id = n.id
    ${where}
    ${orderBy}
    LIMIT 500
  `;
  return withRetry(async (p) => {
    const [rows] = await p.query(sql, params);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      lat: typeof r.lat === 'string' ? parseFloat(r.lat) : r.lat,
      lng: typeof r.lng === 'string' ? parseFloat(r.lng) : r.lng,
      props: typeof r.props === 'string' ? JSON.parse(r.props) : r.props,
      queue_count: r.queue_count || 0,
      is_indoor: r.is_indoor || 0,
      status: r.status || 'open',
      status_reason: r.status_reason || null,
    }));
  });
}

/**
 * 查边(含实时状态)
 * @param {Object} filter - { from_node, to_node, type }
 */
async function query_edges(filter = {}) {
  const parts = [];
  const params = [];
  if (filter.from_node) { parts.push('e.from_node = ?'); params.push(filter.from_node); }
  if (filter.to_node) { parts.push('e.to_node = ?'); params.push(filter.to_node); }
  if (filter.type) { parts.push('e.type = ?'); params.push(filter.type); }
  const where = parts.length ? ' WHERE ' + parts.join(' AND ') : '';
  const sql = `
    SELECT e.id, e.from_node, e.to_node, e.type, e.distance_m, e.duration_min, e.metro_line,
           es.status AS status, es.reason AS status_reason
    FROM edges e
    LEFT JOIN edge_status es ON es.edge_id = e.id
    ${where}
  `;
  return withRetry(async (p) => {
    const [rows] = await p.query(sql, params);
    return rows.map((r) => ({
      id: r.id,
      from_node: r.from_node,
      to_node: r.to_node,
      type: r.type,
      distance_m: r.distance_m,
      duration_min: r.duration_min,
      metro_line: r.metro_line,
      status: r.status || 'open',
      status_reason: r.status_reason || null,
    }));
  });
}

/**
 * 拉取状态(供 Dijkstra 排除 closed 用)
 * - blockedNodes: 节点 status=closed/full 不可走
 * - blockedEdges: 边 status=closed 不可走
 * - congestedEdges: 边 status=congested 加权 1.5x
 */
async function fetchStatusSets() {
  return withRetry(async (p) => {
    const [closedNodes] = await p.query(
      "SELECT node_id AS id FROM node_status WHERE status IN ('closed','full')"
    );
    const [closedEdges] = await p.query(
      "SELECT edge_id AS id FROM edge_status WHERE status = 'closed'"
    );
    const [congested] = await p.query(
      "SELECT edge_id AS id FROM edge_status WHERE status = 'congested'"
    );
    return {
      blockedNodes: new Set(closedNodes.map((r) => r.id)),
      blockedEdges: new Set(closedEdges.map((r) => r.id)),
      congestedEdges: new Set(congested.map((r) => r.id)),
    };
  });
}

/**
 * 最短路径 (Dijkstra, 忽略 closed 节点/边)
 * @param {string} origin_id
 * @param {string} dest_id
 * @param {Array<string>} edge_types - ['walk','metro','drive']
 * @returns {Object|null} { path, edges, total_distance_m, total_duration_min }
 */
async function get_shortest_path(origin_id, dest_id, edge_types = ['walk', 'metro', 'drive']) {
  if (!origin_id || !dest_id) return null;
  if (origin_id === dest_id) {
    return { path: [origin_id], edges: [], total_distance_m: 0, total_duration_min: 0 };
  }

  // 拉全图(过滤 edge_types)
  const placeholders = edge_types.map(() => '?').join(',');
  const sql = `
    SELECT e.id, e.from_node, e.to_node, e.type, e.distance_m, e.duration_min
    FROM edges e
    WHERE e.type IN (${placeholders})
  `;
  const edges = await withRetry((p) => p.query(sql, edge_types).then(([rows]) => rows));

  const { blockedNodes, blockedEdges, congestedEdges } = await fetchStatusSets();

  if (blockedNodes.has(origin_id) || blockedNodes.has(dest_id)) {
    return null; // 起点或终点被关闭
  }

  // 构邻接表(一次性应用所有状态,不再 N+1 查询)
  const adj = new Map();
  for (const e of edges) {
    if (blockedEdges.has(e.id)) continue; // 跳过 closed 边

    // 无向图(路网)
    const w = (e.duration_min || 0) * (congestedEdges.has(e.id) ? 1.5 : 1.0);
    if (!adj.has(e.from_node)) adj.set(e.from_node, []);
    if (!adj.has(e.to_node)) adj.set(e.to_node, []);
    adj.get(e.from_node).push({ to: e.to_node, weight: w, edgeId: e.id, distance: e.distance_m });
    adj.get(e.to_node).push({ to: e.from_node, weight: w, edgeId: e.id, distance: e.distance_m });
  }

  // Dijkstra
  const dist = new Map();
  const prev = new Map();
  const prevEdge = new Map();
  const visited = new Set();
  const pq = new MinPriorityQueue();
  dist.set(origin_id, 0);
  pq.push({ node: origin_id, d: 0 });

  while (!pq.isEmpty()) {
    const { node, d } = pq.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === dest_id) break;
    const neighbors = adj.get(node) || [];
    for (const nb of neighbors) {
      if (visited.has(nb.to)) continue;
      if (blockedNodes.has(nb.to)) continue;
      const nd = d + nb.weight;
      if (!dist.has(nb.to) || nd < dist.get(nb.to)) {
        dist.set(nb.to, nd);
        prev.set(nb.to, node);
        prevEdge.set(nb.to, nb.edgeId);
        pq.push({ node: nb.to, d: nd });
      }
    }
  }

  if (!dist.has(dest_id)) return null;

  // 回溯路径
  const path = [];
  const edgeIds = [];
  let cur = dest_id;
  while (cur) {
    path.unshift(cur);
    const p = prev.get(cur);
    const e = prevEdge.get(cur);
    if (e) edgeIds.unshift(e);
    if (!p) break;
    cur = p;
  }
  if (path[0] !== origin_id) return null;

  // 计算总距离
  let totalDist = 0;
  for (let i = 0; i < edgeIds.length; i++) {
    const e = edges.find((x) => x.id === edgeIds[i]);
    if (e) totalDist += e.distance_m || 0;
  }

  return {
    path,
    edges: edgeIds,
    total_distance_m: totalDist,
    total_duration_min: Math.round(dist.get(dest_id)),
  };
}

/**
 * 备选路径: 跑 N 次 shortest path,每次屏蔽主路径中的一条边
 * @param {string} origin_id
 * @param {string} dest_id
 * @param {Array} edge_types
 * @param {number} count
 */
async function get_alternative_paths(origin_id, dest_id, edge_types, count = 3) {
  const main = await get_shortest_path(origin_id, dest_id, edge_types);
  if (!main || !main.edges || main.edges.length === 0) {
    return main ? [main] : [];
  }

  const alternatives = [main];
  const seen = new Set([main.edges.join(',')]);

  for (let i = 0; i < main.edges.length && alternatives.length - 1 < count; i++) {
    // 屏蔽第 i 条边后重算
    const blockedEdge = main.edges[i];
    const alt = await get_shortest_path_excluding(origin_id, dest_id, edge_types, [blockedEdge]);
    if (!alt || !alt.edges || alt.edges.length === 0) continue;
    const key = alt.edges.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(alt);
  }

  return alternatives;
}

/**
 * 排除指定边的最短路径(给 alternative 用)
 */
async function get_shortest_path_excluding(origin_id, dest_id, edge_types, excludeEdgeIds) {
  const placeholders = edge_types.map(() => '?').join(',');
  const sql = `
    SELECT e.id, e.from_node, e.to_node, e.type, e.distance_m, e.duration_min
    FROM edges e
    WHERE e.type IN (${placeholders})
  `;
  const edges = await withRetry((p) => p.query(sql, edge_types).then(([rows]) => rows));
  const { blockedNodes, blockedEdges, congestedEdges } = await fetchStatusSets();
  const excludeSet = new Set([...excludeEdgeIds, ...blockedEdges]);

  const adj = new Map();
  for (const e of edges) {
    if (excludeSet.has(e.id)) continue;
    const w = (e.duration_min || 0) * (congestedEdges.has(e.id) ? 1.5 : 1.0);
    if (!adj.has(e.from_node)) adj.set(e.from_node, []);
    if (!adj.has(e.to_node)) adj.set(e.to_node, []);
    adj.get(e.from_node).push({ to: e.to_node, weight: w, edgeId: e.id, distance: e.distance_m });
    adj.get(e.to_node).push({ to: e.from_node, weight: w, edgeId: e.id, distance: e.distance_m });
  }

  const dist = new Map();
  const prev = new Map();
  const prevEdge = new Map();
  const visited = new Set();
  const pq = new MinPriorityQueue();
  dist.set(origin_id, 0);
  pq.push({ node: origin_id, d: 0 });
  while (!pq.isEmpty()) {
    const { node, d } = pq.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === dest_id) break;
    const neighbors = adj.get(node) || [];
    for (const nb of neighbors) {
      if (visited.has(nb.to)) continue;
      if (blockedNodes.has(nb.to)) continue;
      const nd = d + nb.weight;
      if (!dist.has(nb.to) || nd < dist.get(nb.to)) {
        dist.set(nb.to, nd);
        prev.set(nb.to, node);
        prevEdge.set(nb.to, nb.edgeId);
        pq.push({ node: nb.to, d: nd });
      }
    }
  }
  if (!dist.has(dest_id)) return null;
  const path = [];
  const edgeIds = [];
  let cur = dest_id;
  while (cur) {
    path.unshift(cur);
    const e = prevEdge.get(cur);
    if (e) edgeIds.unshift(e);
    const p = prev.get(cur);
    if (!p) break;
    cur = p;
  }
  if (path[0] !== origin_id) return null;
  let totalDist = 0;
  for (let i = 0; i < edgeIds.length; i++) {
    const e = edges.find((x) => x.id === edgeIds[i]);
    if (e) totalDist += e.distance_m || 0;
  }
  return {
    path, edges: edgeIds,
    total_distance_m: totalDist,
    total_duration_min: Math.round(dist.get(dest_id)),
  };
}

/**
 * 查询行程范围内生效的事件
 * @param {Array<string>} node_ids
 */
async function get_active_events(node_ids = []) {
  if (node_ids.length === 0) return [];
  const placeholders = node_ids.map(() => '?').join(',');
  // events 表没存有效期字段,这里假设 created_at 在 24h 内算 active
  const sql = `
    SELECT id, type, target_type, target_id, severity, title, detail, created_at
    FROM events
    WHERE (target_type = 'node' AND target_id IN (${placeholders}))
       OR (target_type = 'edge')
    ORDER BY created_at DESC
    LIMIT 50
  `;
  // edge 事件暂时不过滤,需要的话调用方再按 edge 关系筛
  return withRetry(async (p) => {
    const [rows] = await p.query(sql, node_ids);
    return rows;
  });
}

// ============== 简单二叉堆实现的优先队列 ==============
class MinPriorityQueue {
  constructor() { this.data = []; }
  push(item) {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }
  pop() {
    if (this.data.length === 0) return null;
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }
  isEmpty() { return this.data.length === 0; }
  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].d < this.data[parent].d) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else break;
    }
  }
  _sinkDown(i) {
    const n = this.data.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.data[l].d < this.data[smallest].d) smallest = l;
      if (r < n && this.data[r].d < this.data[smallest].d) smallest = r;
      if (smallest !== i) {
        [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
        i = smallest;
      } else break;
    }
  }
}

/**
 * 查询某城市当前天气
 * @param {string} city
 * @returns {Object|null} { city, status, temperature, updated_at }
 */
async function get_weather(city) {
  if (!city) return null;
  return withRetry(async (p) => {
    const [rows] = await p.query(
      'SELECT city, status, temperature, updated_at FROM weather WHERE city = ?',
      [city]
    );
    return rows[0] || null;
  });
}

// ============== 优雅关闭 ==============
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  query_nodes,
  query_edges,
  get_shortest_path,
  get_alternative_paths,
  get_active_events,
  get_weather,
  close,
  // 暴露给单测
  _withRetry: withRetry,
  _MinPriorityQueue: MinPriorityQueue,
};
