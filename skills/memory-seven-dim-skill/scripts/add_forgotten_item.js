/**
 * add_forgotten_item.js — 遗忘清单写入脚本
 *
 * 遗忘清单不过 cache,直接写入 seven_dimensions
 * - 不走 promote 逻辑
 * - confidence = 1 (长期记忆,不需要高置信度)
 * - promoted_at = NOW() (直接晋升)
 *
 * 用法:
 *   node skills/memory-seven-dim-skill/scripts/add_forgotten_item.js "<事项>" "<用户原话>"
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

const FORGOTTEN_DIMENSION = 'forgotten';
const FORGOTTEN_CONFIDENCE = 1;

function newItemId() {
  return `forg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

async function addForgottenItem(content, evidence) {
  if (!content) throw new Error('content (item description) required');

  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    // 使用 sub_key = content 的 hash 前缀(避免长字符串)
    const subKey = `forg_${crypto.createHash('md5').update(content).digest('hex').slice(0, 12)}`;
    const evidenceList = evidence ? [evidence] : [];
    const evidenceText = evidence || content;

    // 直接写入 seven_dimensions,不走 cache 晋升
    const [ins] = await conn.query(
      `INSERT INTO seven_dimensions
        (dimension, sub_key, content, evidence, evidence_list, agent_id, source_ref, confidence, status, promoted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'forgotten_manager', ?, ?, 'active', NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         content = VALUES(content),
         evidence = VALUES(evidence),
         evidence_list = VALUES(evidence_list),
         updated_at = NOW()`,
      [
        FORGOTTEN_DIMENSION,
        subKey,
        content,
        evidenceText,
        JSON.stringify(evidenceList),
        `forgotten_list:${newItemId()}`,
        FORGOTTEN_CONFIDENCE,
      ]
    );

    return {
      written: true,
      dimension: FORGOTTEN_DIMENSION,
      sub_key: subKey,
      content,
      evidence: evidenceText,
      insertId: ins.insertId || null,
    };
  } finally {
    try { await conn.end(); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  const content = process.argv[2];
  const evidence = process.argv[3] || '';
  addForgottenItem(content, evidence)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[add_forgotten_item] failed:', err);
      process.exit(1);
    });
}

module.exports = { addForgottenItem };
