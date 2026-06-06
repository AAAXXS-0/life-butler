# 02-Agent 职责

> 本文档汇总 5 个 Agent（Coordinator + Trip + Schedule + Account + Butler 主助手）的职责、技能、流程、通信
> 来源：各 agent 的 AGENTS.md（已对齐）
> 更新时间：2026-06-07

---

## 1. Coordinator

**位置**：`coordinator/`
**面对用户**：✅ 是
**核心职责**：意图识别 + 路由 + 组装回复

### 1.1 使用的 Skill

| Skill | 什么时候用 |引用章节 |
|-------|-----------|---------|
| `butler-comm-skill` | 委托 Trip/Schedule/Account | 见 AGENTS.md §委托流程 |
| `meal-skill` | 用户找吃的（直接调） | — |
| `fun-skill` | 用户找玩的（直接调） | — |
| `poi-skill` | 用户问地点（直接调） | — |
| `replan-skill` | 随机事件协调 | — |
| `memory-layers-skill` | 五层记忆 | — |
| `memory-seven-dim-skill` | 认知风格 + 健康情况 | 见 AGENTS.md §认知风格 / §健康情况 |

### 1.2 主管的七维维度

| 维度 | 记什么 |
|------|--------|
| **认知风格** | 详细 vs 简洁、逻辑 vs 感觉 |
| **健康情况** | 睡眠/运动/过敏/疾病 |

### 1.3 路由决策（语义分析）

```
用户消息
  ├─ [意图：财务] ──────────────────────────────→ Account Agent
  ├─ [意图：行程规划] ──────────────────────────→ Trip Agent（规划前读 Account）
  ├─ [意图：日程备忘] ──────────────────────────→ Schedule Agent
  ├─ [意图：餐饮查找] ──────────────────────────→ MealSkill（直接调）
  ├─ [意图：娱乐活动] ──────────────────────────→ FunSkill（直接调）
  ├─ [意图：地点查询] ──────────────────────────→ POISkill（直接调）
  ├─ [意图：组合需求] ──────────────────────────→ 多个 Agent + Gather Session
  └─ [意图：模糊] ────────────────────────────────→ 七维画像辅助，必要时追问
```

### 1.4 主动服务（Heartbeat）

每整点触发，按以下顺序检查：

| 顺序 | 检查项 | 判断逻辑 | 动作 |
|------|--------|---------|------|
| 1 | **emergency_events** | 有记录 → 立即处理 | 优先于其他主动服务 |
| 2 | **Account Agent 主动服务** | 见 Account §主动服务 | 触发通知 |
| 3 | **Schedule Agent 主动服务** | 见 Schedule §主动服务 | 触发通知 |
| 4 | **Trip Agent 主动服务** | 见 Trip §主动服务 | 触发通知 |

详细检查项见各 Agent 章节（§1.5）。

### 1.5 心跳检查项汇总

| Agent | 检查项 | 触发条件 | 动作 |
|-------|--------|---------|------|
| **Account** | 超预算 >80% | sum(transactions)/budget.total > 80% | 通知："本月餐饮已花 2800，预算 3000，快超了" |
| **Account** | 超预算 >100% | > 100% | 提醒："本月餐饮已超预算 200 元，注意调整" |
| **Account** | 7天无记录 | 当前时间 - 最后 transaction > 7天 | 询问补录 |
| **Account** | 大额支出异常 | 单笔 > 月预算 30% 且非旅行/大件 | 询问确认 |
| **Account** | 存钱目标进度 | goal距 deadline ≤30天 且进度 <50% | 提醒加速 |
| **Account** | 负债提醒 | wallets.total_liability > 0 且临近账单日 | 询问还款 |
| **Schedule** | 即将到来的日程 | 24h 内有 alarm=true 且 done=false | 提醒："明早9点望京有会" |
| **Schedule** | habit 长期未执行 | habit 最近 14 天 done 全为 false | 询问调整 |
| **Schedule** | 纪念日/生日 | 未来 3 天内有 anniversary/birthday | 提前3天提醒 |
| **Schedule** | 行程冲突预警 | 新行程与现有 event 时间重叠 | 告知用户 |
| **Schedule** | 遗忘清单激活 | 遗忘清单有内容 + 用户当前空闲 | 温和提醒 |
| **Trip** | 行程即将开始 | status=upcoming 且 start_date 在 24-48h 内 | 提醒准备行李 |
| **Trip** | 行程进行中 | status=ongoing | 每日简报 |
| **Trip** | 行程结束待汇总 | status=completed 且未触发 Account 汇总 | 通知 Account |
| **Trip** | 交通变更 | Mock Backend 推送延误/取消事件 | 告知用户 + 触发 replan |

---

## 2. Trip Agent

**位置**：`agents/trip-agent/`
**面对用户**：❌ 否（经 Coordinator）
**核心职责**：行程规划 + 动态调整 + 预算边界控制

### 2.1 使用的 Skill

| Skill | 什么时候用 | 引用章节 |
|-------|-----------|---------|
| `trip-skill` | 4阶段行程规划 | trip-skill 全文 |
| `butler-comm-skill` | 接收委托、回复 | butler-comm-skill「Agent 间通信」 |
| `memory-layers-skill` | 五层记忆 | memory-layers-skill |
| `memory-seven-dim-skill` | 口味偏好维度 | memory-seven-dim-skill「口味偏好」 |

### 2.2 主管的七维维度

| 维度 | 记什么 | 触发时机 |
|------|--------|---------|
| **口味偏好** | 辣/清淡/海鲜/过敏源/菜系偏好 | 发现口味信号 → 写 cache，≥3次晋升 |

### 2.3 数据结构（关键字段）

**trips.json**（行程存档唯一数据源）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 全局唯一 ID |
| `title` | string | 用户可读标题，如"北京4日游" |
| `trip_type` | enum | travel/business/family/honeymoon/other |
| `status` | enum | draft/planned/in_progress/completed/cancelled |
| `destination` | object | {city, city_code, country, district, detail} |
| `date_range` | object | {start, end, days_count, flexible} |
| `travelers` | array | [{id, name, role, age_group}] |
| `days` | array\<day\> | 每日行程数组（见下） |
| `budget` | object | {user_specified, total, by_category, daily_cap, actual_spent, warnings} |
| `schedule_refs` | array\<string\> | 关联的 schedule event ID 列表 |
| `account_refs` | array\<string\> | 行程期间产生的账目 ID 列表 |
| `source` | enum | coordinator（用户委托）/replan（重新规划）/proactive（主动服务） |
| `mode` | enum | chill（度假慢节奏）/mixed（出差+游玩，小时级精度） |
| `preferences_snapshot` | object | 用户偏好快照（规划时提取存档） |
| `warnings` | array\<string\> | 生成方案时的警告信息 |

**days[] 每日行程关键字段**

| 字段 | 说明 |
|------|------|
| `day_index` | 第几天 |
| `date` | 日期 YYYY-MM-DD |
| `segments` | {morning, lunch, afternoon, dinner, evening} 各含 type/poi_id/title/arrival/departure/alternatives |
| `accommodation` | {hotel_id, name, check_in, check_out, nights} |
| `daily_cost` | {total, by_category} |

**budget.warnings 示例**：
```
"方案估算总花费 5800 元，超出您月收入 800 元，约为月收入的 1.2 倍，是否确认？"
```

### 2.4 核心流程

#### 收到行程规划委托
```
1. 直接读 schedule.json（查时间冲突）——不走通信
2. 直接读 accounts.json + 七维记忆（查月收入/可支配/负债）——不走通信
3. trip-skill 四阶段：
   - 阶段一：理解意图
   - 阶段二：POI 筛选（从图模型查，含备选）
   - 阶段三：空间优化（Dijkstra 路径 + 备选）
   - 阶段四：生成 Markdown 文档
4. 写 trips.json
5. 直接写 schedule.json（event 碎片，source: "trip"）——不走通信
6. 通过 butler-comm 回复 Coordinator
```

#### 收到 Replan 委托
```
1. 读 temp/phase3_out.json → meals_options / routes.alternative
2. 选合适的备选
3. 更新行程文档，标注切换原因
4. 通知 Coordinator
```

### 2.5 职责边界

**只做：**
- 行程规划与动态调整
- 读 schedule.json（查冲突）和 accounts.json（读财务数据）
- 写 trips.json 和 schedule.json 的 event 碎片
- 预算边界控制（见 §2.6）

**不做：**
- 记账、查账、月度报表（→ Account Agent）
- 日程创建/修改/删除（→ Schedule Agent）
- 直接回复用户（→ 经 Coordinator）

### 2.6 预算边界职责

Trip Agent 对行程预算负有边界控制职责，见 AGENTS.md 第 §预算边界逻辑。

| 场景 | 模式 | 逻辑 |
|------|------|------|
| **用户说了预算 X** | constraint（强制约束） | `budget.user_specified = true`，方案总花费严格 ≤ X；超出选项自动降级；住宿安全底线（≥3星）不可降级 |
| **用户没说预算** | reference（参考模式） | `budget.user_specified = false`，Account 数据仅供参考；在 `warnings` 中注入财务提示，不硬阻断方案品质；方案估算可超出月收入 |

**预算信息注入流程**（阶段三 → 阶段四）：
- 阶段三：向 `phase3_spatial_optimizer.js` 注入 `budget_context`（month_remaining、daily_cap、trip_total_estimate、liability、user_specified）
- 阶段四：读取 `budget.warnings`，若有则在方案开头以独立段落展示

### 2.7 主动服务（Heartbeat）

| 类型 | 场景 | 触发条件 | 执行动作 |
|------|------|---------|---------|
| **出发前** | 行程前提醒 | start_date - 3天 | 提醒确认机票/酒店/证件，询问是否有变更 |
| **出发前** | 天气预警 | 行程前1天目的地有极端天气 | 建议调整行程顺序，通知 Coordinator |
| **出发前** | 人流预警 | POI 即将有大流量活动 | 建议换备选 POI 或调整时间 |
| **出发前** | 证件/签证提醒 | 目的地出境/偏远，行程前7天 | 提醒办理护照/签证 |
| **行程中** | 交通延误 | 外部 API 或用户告知 | 自动 replan 当日后续，通知 Coordinator |
| **行程中** | 餐厅满座/关闭 | MockBackend 事件 | 自动切换备选餐厅，更新行程，通知 Coordinator |
| **行程中** | 天气突变 | 实时天气数据 | 建议替换为室内备选 |
| **行程中** | 时间超支预警 | 当前 POI 停留超计划 50% | 提醒后续压缩或延后 |
| **行程后** | 旅途花费汇总 | 行程状态 → completed | 通知 Account Agent 汇总，生成花费报告 |
| **行程后** | 行程回顾 | 结束后24h内 | 发送亮点总结 + 实际 vs 估算对比 |
| **行程后** | 下次出行建议 | 行程结束且用户未规划新行程 | 推荐相似目的地 |
| **预防** | 行程密集预警 | 30天内同一目的地多次规划 | 提醒合并或调整 |

---

## 3. Schedule Agent

**位置**：`agents/schedule-agent/`
**面对用户**：❌ 否
**核心职责**：日程备忘 + 时间提醒 + 遗忘清单 + 关系网络 + 时间规律

### 3.1 使用的 Skill

| Skill | 什么时候用 | 引用章节 |
|-------|-----------|---------|
| `butler-comm-skill` | 通信 | butler-comm-skill全文 |
| `memory-layers-skill` | 五层 | memory-layers-skill |
| `memory-seven-dim-skill` | 关系网络/时间规律/遗忘清单 | memory-seven-dim-skill |

### 3.2 主管的七维维度

| 维度 | 记什么 | 触发时机 | 写入路径 |
|------|--------|---------|---------|
| **关系网络** | 联系人、关系、接触频率、最后联系时间 | 发现联系人变化 → 写 cache |路径1：cache→promote，weight≥3 晋升 |
| **时间规律** | 作息、工作节奏、空闲时段、周规律 | 分析 ≥2周 habit/event 数据归纳 | 直接写 dimension（无需晋升） |
| **遗忘清单** | 用户说过想吃/想做但没去的 | 用户说"想吃xxx还没去" |路径6：不过 cache，直接写 dimension |

### 3.3 数据结构（关键字段）

**schedule.json**（JSON 数组，每条一个日程条目）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 格式 `sch{自增3位数字}` |
| `type` | enum | ✅ | daily/event/habit |
| `sub_type` | string | 可选 | event 时用：meeting/reminder/anniversary/deadline/travel/custom |
| `time` | string | 条件 | HH:MM，daily 和 event 必填 |
| `date` | string | 条件 | YYYY-MM-DD，event 必填 |
| `weekday` | int | 条件 | 0-6，habit 必填 |
| `content` | string | ✅ | 日程内容/描述 |
| `repeat` | string/null | 可选 | daily/weekly/monthly/yearly/null |
| `alarm` | boolean | ✅ | 是否需要提醒 |
| `alarm_offset` | int | 可选 | 提前多少分钟提醒，默认30 |
| `source` | enum | ✅ | user/trip/account |
| `source_id` | string | 可选 | 来源记录 ID（如 trip.id） |
| `done` | boolean | ✅ | 是否已完成 |
| `done_at` | string | 可选 | 完成时间戳（ISO 8601） |
| `note` | string | 可选 | 备注 |
| `location` | string | 可选 | 地点 |
| `persons` | string[] | 可选 | 参与者/相关人（用于关系网络） |
| `tags` | string[] | 可选 | 标签 |
| `linked_account` | string | 可选 | 关联的 account id |
| `priority` | enum | 可选 | low/normal/high/urgent |
| `status` | enum | 可选 | active/cancelled/completed |
| `metadata` | object | 可选 | 扩展元数据（如 habit 的 streak_days、anniversary 的 advance_days） |

### 3.4 核心流程

#### 记录日程
```
1. 解析时间、内容、类型
2. 写入 data/schedule.json
3. 通过 butler-comm 回复 Coordinator
```

#### 查询日程
```
1. 读 schedule.json 筛选当日
2. 回复 Coordinator
```

#### 遗忘清单主动服务
```
1. 查 memory-seven-dim-skill 遗忘清单
2. 判断用户当前是否空闲（结合时间规律）
   - 空闲：生成提醒话术，通知 Coordinator
   - 不空闲：不打扰
```

### 3.5 职责边界

**只做：**
- 日程的增删改查
- 写 schedule.json
- 主管关系网络、时间规律、遗忘清单三个维度
- 读 trips.json（关联 trip 来源追溯）和 accounts.json（关联查账）

**不做：**
- 行程规划（→ Trip Agent）
- 记账（→ Account Agent）
- 直接回复用户（→ 经 Coordinator）
- 口味偏好（→ Trip Agent 主管）

### 3.6 主动服务（Heartbeat）

| 服务 | 触发条件 | 执行动作 |
|------|---------|---------|
| **alarm 提醒** | event 的 alarm=true，到达 alarm_offset 提前时间 | 发送提醒给 Coordinator |
| **habit 长期未执行** | habit 超过 2×周期未完成 | 询问是否删除或继续保留 |
| **纪念日提前提醒** | sub_type=anniversary，当前日期 = date - advance_days | 提前 N 天提醒 |
| **遗忘清单激活** | 遗忘清单有内容 + 用户当前空闲 | 生成推荐话术通知 Coordinator |
| **行程归来提醒** | source=trip 的 event，今日 date = trip.end | 询问旅途如何，是否汇总花费 |
| **习惯连续打卡激励** | habit 的 streak_days ≥ 3 | 鼓励话术 |
| **周规律发现** | 连续3 周相同 habit pattern | 写入七维时间规律，提前询问调整 |
| **夜间作息提醒** | 时间规律显示用户通常 22:00 睡觉，22:00 前15 分钟 | 提醒休息 |

---

## 4. Account Agent

**位置**：`agents/account-agent/`
**面对用户**：❌ 否
**核心职责**：账本管理 + 消费分析 + **努力目标识别与管理**

### 4.1 使用的 Skill

| Skill | 什么时候用 | 引用章节 |
|-------|-----------|---------|
| `butler-comm-skill` | 通信 | butler-comm-skill 全文 |
| `memory-layers-skill` | 五层 | memory-layers-skill |
| `memory-seven-dim-skill` | 消费习惯维度 | memory-seven-dim-skill「消费习惯」 |

### 4.2 主管的七维维度

| 维度 | 记什么 | 触发时机 | 写入路径 |
|------|--------|---------|---------|
| **消费习惯** | 花钱频率/金额/场景/支付偏好/预算感知 | 发现消费行为 → 写 cache | 路径1：cache→promote，weight≥3 晋升 |

### 4.3 数据结构（关键字段）

**accounts.json**（完整财务数据）

| 顶层字段 | 说明 |
|---------|------|
| `profile` | {currency, pay_methods, pay_method_preferred, salary_day, notes} |
| `income` | {sources[], total_monthly, total_annual} |
| `monthly_disposable` | {amount, fixed_expenses[], total_fixed, calculation_method} |
| `total_assets` | {total, cash, deposits[], investments[], debts[], net_worth} |
| `expense_records` | {records[], current_month_total} |
| `effort_goals` | {goals[], total_count} |
| `budget_config` | {enabled, monthly_total, categories{}, overtime_alert_threshold} |

**expense_records.records[] 关键字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 格式 `exp_YYYYMMDDHHMMSS` |
| `amount` | number | 消费金额 |
| `date` | string | 消费时间（ISO8601） |
| `category` | enum | food/transport/shopping/entertainment/housing/medical/education/beauty/social/investment/other |
| `sub_category` | string | 细分类别（如"外卖"） |
| `pay_method` | string | 支付方式 |
| `merchant` | string | 商户名称 |
| `related_goal_id` | string | 关联的努力目标 ID |
| `trip_id` | string | 关联的行程 ID |
| `auto_tagged` | boolean | 是否系统自动分类 |

**effort_goals.goals[] 关键字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 格式 `goal_XXX` |
| `name` | string | 目标名称，如"冰岛极光之旅" |
| `estimated_cost` | number | 预估总花费 |
| `saved_amount` | number | 当前已存金额 |
| `remaining` | number | 自动计算：estimated_cost - saved_amount |
| `priority` | enum | low/medium/high |
| `target_date` | string | 计划达成时间 |
| `status` | enum | active/achieved/abandoned |
| `sources` | string[] | 被记录的原因来源 |

**budget_config.categories 对象**（key = 消费类别）：

| 子字段 | 说明 |
|--------|------|
| `monthly_limit` | 该类月预算上限 |
| `alert_at` | 触发提醒的金额（默认80%） |
| `hard_limit` | 是否为硬上限 |

### 4.4 核心流程

#### 记录支出
```
1. 解析金额、类型、时间
2. 写入 accounts.json → expense_records.records
3. 更新 expense_records.current_month_total
4. 通过 butler-comm 回复 Coordinator
5. 走七维写入：识别消费习惯信号 → 写 cache_events
```

#### 查询预算
```
1. 查 accounts.json：
   - monthly_disposable.amount = 月可支配
   - expense_records.current_month_total = 本月已花
   - 剩余 = 月可支配 - 本月已花
2. 回复 Coordinator
```

#### Trip 结束后汇总
```
1. Trip Agent 通知"杭州3天总花费xxx"
2. 汇总旅途花费 → 写入 accounts.json（关联 trip_id）
3. 回填 actual_spent 到 trips.json
4. 通过 butler-comm 回复确认
```

### 4.5 职责边界

**只做：**
- 账本管理（accounts.json 的唯一维护者）
- 消费记录写入、更新
- 月度预算跟踪和预警
- 努力目标识别、记录、进度跟踪
- 向 Trip/Schedule Agent 提供财务数据

**不做：**
- 行程规划（→ Trip Agent）
- 日程管理（→ Schedule Agent）
- 直接回复用户（→ 经 Coordinator）
- 口味偏好（→ Trip Agent）
- 关系网络（→ Schedule Agent）

### 4.6 努力目标职责

Account Agent 负责识别和管理用户的"努力目标"（金额大、时间远的梦想），见 AGENTS.md 第 §努力目标设计逻辑。

**什么算努力目标**（同时满足）：

| 条件 | 说明 | 示例（月可支配8500） |
|------|------|---------------------|
| **金额门槛** | 单次或累计花费 ≥ 月可支配 × 3 | ≥ 25,500元 |
| **时间距离** | 用户期望在 6 个月以后实现 | "明年去冰岛" ✓ |
| **用户主动提到** | 对话中明确表达想法 | "我想去冰岛但好贵" ✓ |

**触发词识别**：
- 目标词："想去"/"想买"/"想体验"/"以后" + 目的地/物品
- 金额词："好贵"/"太贵"/"存钱"/"等攒够"/"负担不起"
- 组合触发 → 识别流程

**Trip Agent 发现贵目的地时的处理**：
- Trip → 发消息给 Account Agent 查询 effort_goal匹配
- Account 回复 matched_goal（id/name/saved_amount/remaining/priority）
- Trip 在行程文档中输出建议（"冰岛极光之旅是你的努力目标..."）

### 4.7 主动服务（Heartbeat）

| 服务 | 触发条件 | 执行动作 |
|------|---------|---------|
| **超预算提醒（>80%）** | sum(transactions)/budget.total > 80% | 通知 Coordinator |
| **超预算提醒（>100%）** | > 100% | 提醒调整 |
| **7天无记录** | 当前时间 - 最后 transaction > 7天 | 询问补录 |
| **大额支出异常** | 单笔 > 月预算 30% 且非旅行/大件 | 询问确认 |
| **存钱目标进度提醒** | goal 距 deadline ≤30天 且进度 <50% | 提醒加速 |
| **负债提醒** | total_liability > 0 且临近账单日 | 询问还款 |
| **发薪日提前提醒** | profile.salary_day - 3 天 | 提前3天提醒 |
| **努力目标达成进度** | 每周一（或大额消费后） | 生成各目标进度报告 |
| **消费结构月报** | 每月1日 |消费分布 + 异常检测 + 储蓄率 |
| **行程消费预提醒** | Trip Agent 规划前 | 主动推送财务摘要给 Trip |

---

## 5. 通信矩阵（直接读 vs 通信）

| 场景 | 方式 | 理由 |
|------|------|------|
| Trip 查 schedule 冲突 | **直接读** `data/schedule.json` | 数据共享，无需通信 |
| Trip 查 accounts 预算/收入 | **直接读** `data/accounts.json` + 七维记忆 | 数据消费，无需 Account 做事 |
| Trip → Schedule写 event | **直接写** `data/schedule.json` | 写操作有规则：source: "trip" |
| Trip → Account（行程结束汇总） | **通信**（butler-comm info_share） | Account 要做汇总操作 + 回填 actual_spent |
| Schedule 查关联 | **直接读** `data/accounts.json` | 数据共享 |
| Account查关联 | **直接读** `data/schedule.json` | 数据共享 |
| Schedule → Account（宴请关联账本） | **通信** | Account 要做关联操作 |
| Account → Schedule（开销关联日程） | **通信** | Schedule 要做关联操作 |
| Coordinator查财务（用户问） | **委托 Account Agent** | 需要计算（收入-支出），涉及多字段汇总 |

**原则**：能直接读就不通信。只有"对方要做事"时才通信。

---

## 6. 七维维度主管对应表

| 维度 | 主管 Agent | 写入路径 |
|------|-----------|---------|
| 口味偏好 | Trip Agent | cache → promote，weight≥3 |
| **消费习惯** | **Account Agent** | cache → promote，weight≥3 |
| **关系网络** | **Schedule Agent** | cache → promote，weight≥3 |
| **时间规律** | **Schedule Agent** | 直接写 dimension |
| **遗忘清单** | **Schedule Agent** | 直接写 dimension（路径6） |
| 认知风格 | Coordinator | cache → promote |
| 健康情况 | Coordinator | cache → promote |

---

## 7. 各 Agent 数据文件一览

| 文件 | Coordinator | Account | Schedule | Trip |
|------|:---:|:---:|:---:|:---:|
| `data/schedule.json` | 读 | 读 | 读写 | 读+写（event碎片） |
| `data/accounts.json` | 辅助读 |读写 | 读 | 读 |
| `data/trips.json` | 读 | 读 | 读 | 写 |
| `data/pois.json` | — | — | — | 读 |
| `data/emergency_events.json` | 读写 | — | — | — |
| `seven_dimensions`（MySQL） |读 | 读+写 | 读+写 | 读+写 |
| `cache_events`（MySQL） | 读 | 读+写 | 读+写 | 读+写 |

**注意**：Coordinator 不直接写业务数据文件（schedule/accounts/trips），只读写协调性数据（emergency_events）。