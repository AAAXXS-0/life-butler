/**
 * query_profile.js — 查询画像脚本
 *
 * 查询用户七维画像,返回合并后的 profile
 * 查询优先级:
 *   1. emergency_events (ACTIVE) -> 用 override_value 覆盖
 *   2. seven_dimensions (active)
 *   3. cache_events
 *
 * 用法:
 *   node skills/memory-seven-dim-skill/scripts/query_profile.js <dimension> [sub_key]
 *
 * 不传 dimension: 返回所有七维
 * 传 dimension: 返回该维度的所有 sub_key
 * 传 dimension + sub_key: 返回该具体项
 */

const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'life_butler_db',
};

function parseEvidenceList(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
    catch (_) { return []; }
  }
  return [];
}

async function runQuery(dimension, subKey) {
  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const today = new Date().toISOString().slice(0, 10);

    // 1. 拉 emergency_events active
    const [emergency] = await conn.query(
      `SELECT dimension, override_key, override_value, source, start_date, end_date
       FROM emergency_events
       WHERE status = 'active'
         AND start_date <= ?
         AND end_date >= ?`,
      [today, today]
    );
    const emergencyByKey = new Map();
    for (const e of emergency) {
      const k = `${e.dimension}::${e.override_key}`;
      emergencyByKey.set(k, e);
    }

    // 2. 拉 seven_dimensions
    const dimWhere = [];
    const dimParams = [];
    if (dimension) { dimWhere.push('dimension = ?'); dimParams.push(dimension); }
    if (subKey)    { dimWhere.push('sub_key = ?');   dimParams.push(subKey); }
    const dimWhereSql = dimWhere.length ? 'WHERE ' + dimWhere.join(' AND ') : '';
    const [dimRows] = await conn.query(
      `SELECT id, dimension, sub_key, content, evidence, evidence_list, agent_id,
              source_ref, confidence, status, demoted_at, promoted_at, updated_at
       FROM seven_dimensions
       ${dimWhereSql}
       ORDER BY dimension, sub_key`,
      dimParams
    );

    // 3. 拉 cache_events (未过期)
    const cacheWhere = ['expires_at > NOW()', 'demoted = 0'];
    const cacheParams = [];
    if (dimension) { cacheWhere.push('dimension = ?'); cacheParams.push(dimension); }
    if (subKey)    { cacheWhere.push('sub_key = ?');    cacheParams.push(subKey); }
    const [cacheRows] = await conn.query(
      `SELECT id, dimension, sub_key, content, evidence, evidence_list, agent_id,
              source_ref, weight, created_at, expires_at
       FROM cache_events
       WHERE ${cacheWhere.join(' AND ')}
       ORDER BY dimension, sub_key, created_at DESC`,
      cacheParams
    );

    // 4. 合并: emergency > dimension > cache
    const result = {};

    for (const r of dimRows) {
      if (r.status === 'demoted') continue; // 跳过已降级
      const k = r.dimension;
      if (!result[k]) result[k] = {};
      const evidence = parseEvidenceList(r.evidence_list);
      const item = {
        sub_key: r.sub_key,
        content: r.content,
        evidence_list: evidence,
        confidence: r.confidence,
        source: 'seven_dimensions',
        agent_id: r.agent_id,
        source_ref: r.source_ref,
        promoted_at: r.promoted_at,
        updated_at: r.updated_at,
        emergency_override: null,
      };
      const eKey = `${r.dimension}::${r.sub_key}`;
      const em = emergencyByKey.get(eKey);
      if (em) {
        item.content = em.override_value;
        item.emergency_override = {
          source: em.source,
          start_date: em.start_date,
          end_date: em.end_date,
        };
        item.confidence = 10; // 紧急覆盖视作最高优先级
      }
      result[k][r.sub_key] = item;
    }

    // 合并 cache_events (当 dimension/sub_key 不在已验证画像中时)
    for (const c of cacheRows) {
      const k = c.dimension;
      if (!result[k]) result[k] = {};
      if (!result[k][c.sub_key]) {
        const evidence = parseEvidenceList(c.evidence_list);
        const item = {
          sub_key: c.sub_key,
          content: c.content,
          evidence_list: evidence,
          confidence: Math.min(5, c.weight || 1), // cache 的 confidence 较低
          source: 'cache_events',
          agent_id: c.agent_id,
          source_ref: c.source_ref,
          weight: c.weight,
          created_at: c.created_at,
          expires_at: c.expires_at,
          emergency_override: null,
        };
        const eKey = `${c.dimension}::${c.sub_key}`;
        const em = emergencyByKey.get(eKey);
        if (em) {
          item.content = em.override_value;
          item.emergency_override = {
            source: em.source,
            start_date: em.start_date,
            end_date: em.end_date,
          };
          item.confidence = 10;
        }
        result[k][c.sub_key] = item;
      }
    }

    return result;
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}

function formatOutput(profile) {
  // 兼容两种调用: 完整画像 / 单 sub_key 查询
  if (Object.keys(profile).length === 0) {
    return { dimensions: {}, note: 'empty profile' };
  }
  return { dimensions: profile };
}

if (require.main === module) {
  const dimension = process.argv[2] || null;
  const subKey = process.argv[3] || null;
  runQuery(dimension, subKey)
    .then((profile) => {
      console.log(JSON.stringify(formatOutput(profile), null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[query_profile] failed:', err);
      process.exit(1);
    });
}

module.exports = { runQuery };
