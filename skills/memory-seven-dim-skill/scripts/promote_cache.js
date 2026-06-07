/**
 * promote_cache.js — 晋升脚本
 *
 * 扫描 cache_events, 把满足晋升条件的记录晋升到 seven_dimensions
 * 晋升条件: 同一 dimension + sub_key, 14 天内 weight >= 3
 *
 * 触发:
 *   路线 A: cron 每天凌晨 4:00 (兜底)
 *   路线 B: 主管 Agent 在路径1中顺手触发 (weight >= 3 且未过期)
 *
 * 用法:
 *   node skills/memory-seven-dim-skill/scripts/promote_cache.js
 */

const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3308', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'life_butler_db',
};

const WINDOW_DAYS = 14;
const MIN_WEIGHT = 3;

/**
 * 把证据列表扁平化
 */
function flattenEvidence(records) {
  const out = [];
  for (const r of records) {
    // evidence_list 是 JSON 数组
    if (Array.isArray(r.evidence_list)) {
      for (const e of r.evidence_list) out.push(e);
    } else if (typeof r.evidence_list === 'string') {
      try {
        const parsed = JSON.parse(r.evidence_list);
        if (Array.isArray(parsed)) out.push(...parsed);
        else if (parsed) out.push(parsed);
      } catch (_) {
        if (r.evidence_list.trim()) out.push(r.evidence_list);
      }
    }
    if (r.evidence) out.push(r.evidence);
  }
  // 去重保序
  const seen = new Set();
  const result = [];
  for (const e of out) {
    const key = typeof e === 'string' ? e : JSON.stringify(e);
    if (!seen.has(key)) { seen.add(key); result.push(e); }
  }
  return result;
}

async function runOnce() {
  const conn = await mysql.createConnection(DB_CONFIG);
  const promoted = [];
  try {
    await conn.beginTransaction();

    // 1. 扫描 14 天内,按 dimension+sub_key 分组
    const [rows] = await conn.query(
      `SELECT id, dimension, sub_key, content, evidence, evidence_list,
              agent_id, source_ref, weight, demoted
       FROM cache_events
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         AND demoted = 0
       ORDER BY created_at ASC
       FOR UPDATE`,
      [WINDOW_DAYS]
    );

    // 分组
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.dimension}::${r.sub_key}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }

    for (const [key, list] of groups) {
      const [dimension, sub_key] = key.split('::');
      // 累计 weight, 不到阈值的跳过
      const totalWeight = list.reduce((s, r) => s + (r.weight || 1), 0);
      if (totalWeight < MIN_WEIGHT) continue;
      const evidenceList = flattenEvidence(list);
      const content = list.map((r) => r.content).filter(Boolean).join(' | ');
      const agentId = list[0].agent_id;
      const sourceRef = list[0].source_ref;
      const cacheEventIds = list.map((r) => r.id);

      // 2. 查 seven_dimensions 是否已存在
      const [existing] = await conn.query(
        `SELECT id, confidence, evidence_list, content FROM seven_dimensions
         WHERE dimension = ? AND sub_key = ? FOR UPDATE`,
        [dimension, sub_key]
      );

      let targetType, targetId, newConfidence;
      if (existing.length === 0) {
        // 插入新行
        newConfidence = Math.min(10, totalWeight);
        const [ins] = await conn.query(
          `INSERT INTO seven_dimensions
            (dimension, sub_key, content, evidence, evidence_list, agent_id, source_ref, confidence, status, promoted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
          [
            dimension, sub_key, content,
            evidenceList.join('\n'),
            JSON.stringify(evidenceList),
            agentId, sourceRef, newConfidence,
          ]
        );
        targetId = ins.insertId;
        targetType = 'new_insert';
      } else {
        // 更新已有: 累加 confidence, 合并 evidence
        const old = existing[0];
        const oldEvidence = (() => {
          if (Array.isArray(old.evidence_list)) return old.evidence_list;
          if (typeof old.evidence_list === 'string') {
            try { return JSON.parse(old.evidence_list) || []; } catch (_) { return []; }
          }
          return [];
        })();
        const merged = [...oldEvidence];
        const seen = new Set(merged.map((e) => typeof e === 'string' ? e : JSON.stringify(e)));
        for (const e of evidenceList) {
          const k2 = typeof e === 'string' ? e : JSON.stringify(e);
          if (!seen.has(k2)) { seen.add(k2); merged.push(e); }
        }
        newConfidence = Math.min(10, (old.confidence || 0) + Math.ceil(totalWeight / 2));
        const mergedContent = [old.content, content].filter(Boolean).join(' | ');
        await conn.query(
          `UPDATE seven_dimensions
           SET content = ?, evidence_list = ?, evidence = ?, confidence = ?, status = 'active', updated_at = NOW()
           WHERE id = ?`,
          [
            mergedContent,
            JSON.stringify(merged),
            merged.join('\n'),
            newConfidence,
            old.id,
          ]
        );
        targetId = old.id;
        targetType = 'update';
      }

      // 3. 记录 promote_log
      await conn.query(
        `INSERT INTO promote_log (cache_event_ids, target_id, target_type, created_at)
         VALUES (?, ?, ?, NOW())`,
        [JSON.stringify(cacheEventIds), targetId, targetType]
      );

      // 4. 删除已晋升的 cache_events
      await conn.query(
        `DELETE FROM cache_events WHERE id IN (?)`,
        [cacheEventIds]
      );

      promoted.push({
        dimension, sub_key, target_id: targetId, target_type: targetType,
        cache_event_count: cacheEventIds.length, new_confidence: newConfidence,
      });
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }

  return { promoted_count: promoted.length, promoted };
}

if (require.main === module) {
  runOnce()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[promote_cache] failed:', err);
      process.exit(1);
    });
}

module.exports = { runOnce };
