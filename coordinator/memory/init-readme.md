# Coordinator 初始化文档

## 首次启动流程

1. 读取本文件
2. 发送用户初始化问卷（见 `coordinator/scripts/user-init-questionnaire.html` 的问卷内容）
   - 基础模块 Q1-Q7 + 财务模块 Q8-Q13（用户可跳过财务模块）
3. 用户完成后，将 `answers` JSON 写入 `coordinator/data/init_questionnaire.json`
4. **Coordinator 读取 JSON，生成 MySQL INSERT 写入 `seven_dimensions` 表**（agent_id='init'）
   - 字段映射：见下方「选项 → 侧写 映射表」（如缺失则参考 `skills/init-questionnaire-skill/SKILL.md`，该 skill 已迁至此处）
   - Q12 选 A 时：追问目标金额/截止日期，写入 `effort_goals` 到 Account 的 accounts.json
5. 在 `coordinator/memory/seven_dim_cache.json` 写入标记 `init_completed: true`
6. **删除本文件**
7. **删除 coordinator/AGENTS.md 中所有包含 "首次启动" 的段落**

## JSON 输入位置

`coordinator/data/init_questionnaire.json`

**格式**：
```json
{
  "version": "1.0",
  "submitted_at": "<ISO时间>",
  "financial_module": "completed|skipped",
  "answers": {
    "Q1": { "selected": "B", "text": null },
    "Q2": { "selected": ["A", "B"], "text": null },
    "Q3": { "selected": "A", "text": null },
    "Q4": { "selected": "C", "text": null },
    "Q5": { "selected": "B", "text": null },
    "Q6": { "selected": "A", "text": null },
    "Q7": { "selected": "B", "text": null },
    "Q8": { "selected": "C", "text": null },
    "Q9": { "selected": ["A", "C"], "text": null },
    "Q10": { "selected": "B", "text": null },
    "Q11": { "selected": ["A", "B"], "text": null },
    "Q12": { "selected": "A", "text": "冰岛极光之旅" },
    "Q13": { "selected": "A", "text": null }
  },
  "effort_goals": [
    {
      "name": "冰岛极光之旅",
      "estimated_cost": 30000,
      "target_date": "2027-12-01",
      "monthly_needed": 2500
    }
  ]
}
```

## MySQL 写入格式

Coordinator 读取 JSON 后，对每个非 null 的 answer 生成 INSERT：

```sql
INSERT INTO seven_dimensions (
  dimension, sub_key, content, evidence, evidence_list,
  agent_id, source_ref, confidence, status, promoted_at, updated_at
) VALUES (
  '<dimension>', '<sub_key>', '<content>',
  '问卷 Qx 选 <option>',
  JSON_ARRAY(JSON_OBJECT(
    'agent_id','init',
    'content','问卷 Qx 选 <option>',
    'created_at','<timestamp>'
  )),
  'init',
  'coordinator/data/init_questionnaire.json#Qx',
  3,
  'active',
  NOW(),
  NOW()
) ON DUPLICATE KEY UPDATE
  content = VALUES(content),
  evidence = VALUES(evidence),
  evidence_list = VALUES(evidence_list),
  updated_at = NOW();
```

**Q12 选了 A**（有努力目标）时，Coordinator 额外委托 Account Agent 写入 `effort_goals.goals[]`：
```json
{
  "from": "coordinator",
  "type": "task_delegate",
  "action": "add_effort_goal",
  "params": {
    "name": "<Q12_text>",
    "estimated_cost": "<追问获取>",
    "target_date": "<追问获取>",
    "source": "init"
  }
}
```

## 本地缓存标记

写入 MySQL 完成后，在 `coordinator/memory/seven_dim_cache.json` 写入：
```json
{
  "init_completed": true,
  "init_timestamp": "<ISO时间>"
}
```