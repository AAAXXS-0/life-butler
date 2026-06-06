/**
 * demote_dimension.js — 降级脚本
 *
 * 将指定 dimension/sub_key 从已验证画像降级到 cache 观察
 * 仅限主管 Agent 调用
 *
 * 降级流程 4 步:
 *   1. 删除 cache 中标注"矛盾"的条目
 *   2. 被降级侧写入 cache (expires_at = created_at + 1年)
 *   3. 矛盾侧写 evidence_list 追加到被降级侧写 evidence_list,最后标注 {"type": "降级依据", ...}
 *   4. seven_dimensions.status -> 'demoted', demoted_at = NOW()
 *
 * 用法:
 *   node skills/memory-seven-dim-skill/scripts/demote_dimension.js <dimension> <sub_key> <conflict_content>
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

const DEMOTED_EXPIRE_YEARS = 1;

function newCacheEventId() {
  return `ce_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

async function demote(dimension, subKey, conflictContent) {
  if (!dimension || !subKey) throw new Error('dimension and sub_key required');
  if (!conflictContent) throw new Error('conflict_content required');

  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    await conn.beginTransaction();

    // 1. 拉 seven_dimensions 当前行
    const [rows] = await conn.query(
      `SELECT id, content, evidence, evidence_list, agent_id, source_ref, confidence, status
       FROM seven_dimensions
       WHERE dimension = ? AND sub_key = ?
       FOR UPDATE`,
      [dimension, subKey]
    );
    if (rows.length === 0) {
      throw new Error(`no seven_dimensions row for ${dimension}::${subKey}`);
    }
    const old = rows[0];
    if (old.status === 'demoted') {
      // 已是 demoted,不再重复处理
      await conn.commit();
      return { already_demoted: true, dimension, sub_key: subKey };
    }

    // 2. 删除 cache 中标注"矛盾"的条目 (evidence_list 中包含 conflict_content 关键词的)
    const [delResult] = await conn.query(
      `DELETE FROM cache_events
       WHERE dimension = ? AND sub_key = ?
         AND (JSON_SEARCH(evidence_list, 'one', ?) IS NOT NULL
              OR content LIKE CONCAT('%', ?, '%'))`,
      [dimension, subKey, conflictContent, conflictContent]
    );

    // 3. 把原 seven_dimensions 写到 cache (被降级侧),expires_at = +1年
    const oldEvidence = (() => {
      if (Array.isArray(old.evidence_list)) return old.evidence_list;
      if (typeof old.evidence_list === 'string') {
        try { return JSON.parse(old.evidence_list) || []; } catch (_) { return []; }
      }
      return [];
    })();
    // 矛盾侧写 evidence_list 追加到被降级侧 evidence_list,最后标注"降级依据"
    const downgradeNote = {
      type: '降级依据',
      dimension,
      sub_key: subKey,
      conflict_content: conflictContent,
      downgraded_at: new Date().toISOString(),
    };
    const demotedEvidence = [...oldEvidence, downgradeNote];
    const newCacheId = newCacheEventId();
    const [ins] = await conn.query(
      `INSERT INTO cache_events
        (dimension, sub_key, content, evidence, evidence_list, agent_id, source_ref, weight, demoted, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL ? YEAR))`,
      [
        dimension, subKey,
        old.content,
        JSON.stringify(demotedEvidence),
        JSON.stringify(demotedEvidence),
        old.agent_id || 'demote_script',
        old.source_ref,
        old.confidence || 1,
        DEMOTED_EXPIRE_YEARS,
      ]
    );

    // 4. 更新 seven_dimensions: status=demoted, demoted_at=NOW
    await conn.query(
      `UPDATE seven_dimensions
       SET status = 'demoted', demoted_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [old.id]
    );

    await conn.commit();
    return {
      demoted: true,
      dimension,
      sub_key: subKey,
      cache_insert_id: ins.insertId,
      deleted_cache_rows: delResult.affectedRows,
      demoted_evidence_count: demotedEvidence.length,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  const dimension = process.argv[2];
  const subKey = process.argv[3];
  const conflictContent = process.argv[4];
  demote(dimension, subKey, conflictContent)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[demote_dimension] failed:', err);
      process.exit(1);
    });
}

module.exports = { demote };
