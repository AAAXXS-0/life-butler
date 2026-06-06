---
name: memory-seven-dim
description: "七维记忆系统 Skill。规范口味偏好/消费习惯/关系网络/时间规律/遗忘清单/认知风格/健康情况七维画像的写入、晋升、降级、查询流程。"
---

# 七维记忆系统 Skill

> 七维记忆回答"信息是什么、有什么用"，与回答"信息何时存在"的五层记忆完全独立，并行运行。
>
> **核心原则：任何 agent 都可以写入 cache；主管 agent 负责降级管理；证据链必须可追溯。**

---

## 七维维度

| 维度 | 记什么 | 主管 Agent |
|------|--------|-----------|
| 口味偏好 | 辣/清淡/海鲜/过敏源 | Trip Agent |
| 消费习惯 | 花钱频率/金额/场景 | Account Agent |
| 关系网络 | 联系人/关系/接触频率 | Schedule Agent |
| 时间规律 | 作息/工作节奏/空闲时段 | Schedule Agent |
| 遗忘清单 | 说过两次想吃还没去 | Schedule Agent |
| 认知风格 | 喜欢详细解释 vs 一句话结论、逻辑 vs 感觉 | Coordinator |
| 健康情况 | 睡眠/运动/过敏/疾病 | Coordinator |

---

## 文件结构

```
skills/memory-seven-dim/
├── SKILL.md                    ← 本文件
├── scripts/
│   ├── promote_cache.js        → 晋升脚本（定时 + 主管Agent顺手）
│   ├── query_profile.js        → 查询画像脚本
│   └── demote_dimension.js     → 降级脚本（仅主管Agent调用）
├── references/
│   ├── db_schema.sql            → MySQL 建表 SQL（待补充）
│   └── path4_demotion_flow.md   → 降级流程详解（待补充）
└── assets/
    └── （预留）
```

---

## 数据库（待补充建表）

- **库名**：`life_butler_db`
- **表1**：`cache_events`（未验证侧写，第一层）
- **表2**：`seven_dimensions`（已验证画像，第二层）
- **表3**：`promote_log`（晋升日志）
- **表4**：`emergency_events`（突发事件临时覆盖层）

详见 `references/db_schema.sql`（待补充）。

---

## 路径1：写入侧写

> Agent 在对话/操作中发现用户侧写时执行。先写五层详细记忆，再写七维 cache。

### 写入顺序（关键！）

```
① 先写五层详细记忆（memory/days/YYYY-MM-DD.md）
   写入完成后得到文件绝对路径 + 行号

② 再写 cache_events（MySQL）
   source_ref = "memory/days/2026-06-03.md-第45行-摘要"
```

### 四种合并情况

| cache | dimension | 操作 |
|-------|-----------|------|
| 无 | 无 | 新增一条 cache_events，weight=1 |
| 有 | 无 | 证据追加到该条 evidence_list，weight+1 |
| 无 | 有 | 证据追加到 dimension 对应条目的 evidence_list，confidence+1 |
| 有 | 有 | 不可能（promote 后 cache 已清，不会同时存在） |

### 写入字段（cache_events）

| 字段 | 值 |
|------|-----|
| dimension | 七维之一 |
| sub_key | 具体子项（如"辣度"/"海鲜"） |
| content | 侧写内容 |
| evidence_list | JSON数组，含原始对话原文 |
| agent_id | 写入的 Agent |
| source_ref | 五层记忆文件路径 + 行号锚点 |
| weight | 1（首次）/ weight+1（合并） |
| created_at | NOW() |
| expires_at | created_at + 14天 |

---

## 路径2：Promote 晋升

> 同一 sub_key 在 14 天内出现 ≥3 条 → 从 cache 晋升到 dimension。

### 路线A：定时脚本（每天一次，兜底）

```bash
node skills/memory-seven-dim/scripts/promote_cache.js
```

### 路线B：主管 Agent 顺手（实时）

主管 Agent 在路径1执行中，发现某 cache 条目 weight≥3 且未过期 → 顺手执行 promote，不等 cron。

### 字段搬迁原则

- 共用基础字段：cache → dimension 原封不动复制
- confidence 在已存在时叠加，不覆盖
- created_at 保持原值（保留首次观测时间）

---

## 路径3：查询调用

> Coordinator 决策前统一查询，注入 context。

```
① 查 emergency_events（ACTIVE）
   → 有 → 用 override_value 覆盖七维结果
   → 无 → 继续

② 查 seven_dimensions（ACTIVE）

③ 决策优先级合并
   emergency_events (ACTIVE) > seven_dimensions (active) > cache_events

④ 认知风格画像作为 context 的一部分传给被调 Agent
```

```bash
node skills/memory-seven-dim/scripts/query_profile.js <dimension> [sub_key]
```

---

## 路径4：降级（仅主管 Agent 可操作）

> 发现与 dimension 现有侧写明显矛盾的观测时执行。

**4 步流程：**

1. **矛盾侧写入 cache**（标注"矛盾侧写"）
2. **Coordinator 询问用户原因**
3. **综合判断**：理由性回应 → 路径5；无回应 → 视为矛盾；真的失效 → 直接降级
4. **降级操作**（主管 Agent 执行）
   - 删除 cache 矛盾条目
   - 被降级侧写入 cache（expires_at = +1年）
   - 矛盾证据追加到被降级侧写的 evidence_list
   - seven_dimensions status → 'demoted'，demoted_at = NOW()

详见 `references/path4_demotion_flow.md`（待补充）。

---

## 路径5：突发事件（Coordinator 主管）

> 用户直接提到或路径4触发后自然转入。

### 写入字段

- event_id = `{dimension}_{timestamp}`
- dimension / override_key / override_value
- start_date = TODAY，end_date = start_date + duration_days
- check_interval_days = 默认2，next_check_date = start_date + interval
- status = 'active'，resume_profile = true
- source = 'user_direct' / 'user_behavior_conflict'

### 查看流程（Coordinator 路由前）

```
查 emergency_events（ACTIVE）
  → 有快到期/已到期事件？
      ↓YES              ↓NO
  先问用户：         注入到路由消息中
  "您的口腔溃疡
  现在好了吗？"
      ↓
  好了 → 删除事件
  还没 → 延期（end_date延后）
```

---

## 路径6：遗忘清单不过 cache

> 直接写入 seven_dimensions，不走 promote 逻辑。

```bash
node skills/memory-seven-dim/scripts/add_forgotten_item.js <事项> <用户原话>
```

- dimension = '遗忘清单'，sub_key = 事项
- confidence = 初始1（长期记忆，不需要高置信度）
- promoted_at = NOW()（直接晋升）

主动服务：Coordinator / Schedule Agent 偶尔查看遗忘清单，判断用户当前空闲则生成提醒话术。

---

## 路径7：聊天模式

> 用户意图不明显时进入聊天模式，只更新五层，不写七维 cache。
> 聊天结束后用 sessions_spawn 起 subagent 扫 days，侧写走路径1。

### 为什么用 subagent

Subagent 本身是 LLM，不需写脚本调 LLM API（一个 LLM 委托另一个 LLM 绕弯）。

优点：
- 隔离 context，不污染主 agent
- 后台任务可用便宜模型（MiniMax-M2.7）
- 错误处理：subagent 推理失败可自己重试
- 异步执行，不阻塞主流程

### Subagent 使用规范

> **完整规范**：`skills/subagent-skill/SKILL.md`（含 sessions_spawn 参数、taskName 命名、错误处理、跨 skill 引用）

### Subagent 提示词

Coordinator 在聊天结束后调 sessions_spawn ：

```
你是 chat_mode_profile_scanner subagent。任务：扫描
memory/days/YYYY-MM-DD.md（YYYY-MM-DD 由调用方传入），识别聊天模式下
产生的侧写信号。

步骤：
1. 读 memory/days/YYYY-MM-DD.md
2. 识别聊天段落（按时间戳间隔 / 分隔符判断）
3. 作为 LLM 自己做语义分析，识别有效侧写信号
4. 发现有效侧写 → 走路径1：
   - 先写五层（追加到 days 文件，source_ref 指向行号）
   - 再写 cache_events（INSERT 到 MySQL life_butler_db）
5. 重复步骤 3-4 直到扫完当天所有聊天段落
6. 输出报告：扫了几个段落、识别到几个侧写、写入了哪些 cache_events

注意：
- 只扫描调用方传入的 YYYY-MM-DD 这一天
- 证据 source_ref 格式：memory/days/2026-06-05.md-第45行
- weight 初始为 1，后续出现同 dim+sub_key 会自动 +1
- 不需要调任何外部脚本，一切走 mysql2 直接写库
- 聊天模式才需要扫描，任务模式由执行 Agent 实时写七维
```

**taskName**：`chat-mode-scanner`（见 subagent-skill 命名约定）

**model 推荐**：`minimax/MiniMax-M2.7`（后台扫描用便宜模型）

### 触发时机

- **实时触发**：Coordinator 聊天结束立刻调

### 提示词设计原则

- 明确说"作为 LLM 自己做语义分析"——不调 LLM API
- 明确步骤、子步骤、输出格式
- 明确"不需要调任何外部脚本"——避免 subagent 反过来调脚本
- 上下文信息（YYYY-MM-DD）由调用方传入，不在 prompt 里硬编码

---

## 已定参数

| 参数 | 值 |
|------|-----|
| 触发阈值 X | 3次 |
| 时间窗口 Y | 14天 |
| 降级后 cache 观察期 | 1年 |
| 普通 cache 过期 | 14天 |
| 遗忘清单 | 不过 cache，直接写入 dimension |
| 晋升 cron | 每天凌晨 4:00（兜底） |
| 主管 Agent 触发 | 直接调用 node 脚本（路线B实时） |

---

## 注意事项

- **先五层再七维**：五层 days 文件是 evidence 的最终溯源，source_ref 需要行号锚点
- **任何 agent 可写 cache**：主管 agent 只管降级，不管写权限
- **真冲突定义**：同一个人、同一维度、两条互相矛盾的结论才需要处理
- **证据链必须可追溯**：每条记录必须能指向原始对话/操作
