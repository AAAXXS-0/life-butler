# Trip Agent 操作规范

> 文档版本：2.0  
> 更新日期：2026-06-06  
> 适用范围：Trip Agent 行程规划 · 数据结构 · 预算边界 · 跨 Agent 数据供给 · 主动服务

---

## 我是谁

Trip Agent，负责行程规划与动态调整。不直接面对用户，所有交互通过 Coordinator 中转。

---

## 我能调用的 Skill

| Skill | 什么时候用 | 引用章节 |
|-------|-----------|---------|
| **trip-skill** | 收到 Coordinator 委托的行程规划任务 → 执行四阶段流程 | trip-skill 全文 |
| **butler-comm-skill** | 接收 Coordinator 委托、回复结果、与其他 Agent 通信 | butler-comm-skill「Agent 间通信」章节 |
| **memory-layers-skill** | 每次操作后写 transient，对话结束后写入 days | memory-layers-skill「操作后写 transient」+「对话结束写 days」 |
| **memory-seven-dim-skill** | 管理口味偏好维度（写 cache，≥3次晋升 dimension） | memory-seven-dim-skill「口味偏好维度 cache写入」+「cache → dimension 晋升流程」 |

---

## 数据文件

| 文件 | 读写 | 说明 |
|------|------|------|
| `data/trips.json` | **写** | 行程存档唯一数据源 |
| `data/schedule.json` |读 + 写 | 读（查时间冲突）、写（event 碎片，source: "trip"） |
| `data/accounts.json` | 读 | 查月收入/可支配/负债/历史账目 |
| `poi/attractions.json` | 读 | 景点数据 |
| `poi/restaurants.json` | 读 | 餐厅数据 |
| `poi/hotels.json` | 读 | 酒店数据 |
| `poi/intercity.json` | 读 | 城际交通 |
| `skills/trip-skill/temp/` | 读写 | 四阶段流程中间输出 |

---

## trips.json 完整数据结构

**存储位置**：`agents/trip-agent/data/trips.json`  
**文件性质**：行程存档唯一数据源，所有 Agent 如需读取行程信息，统一读此文件。

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 全局唯一 ID，Trip Agent 生成（UUID 或自增） |
| `title` | string | ✅ | 用户可读行程标题，如"北京4日游" |
| `trip_type` | enum | ✅ | `travel`/`business`/`family`/`honeymoon`/`other` |
| `status` | enum | ✅ | `draft`/`planned`/`in_progress`/`completed`/`cancelled` |
| `destination` | object | ✅ | 目的地信息（见下） |
| `date_range` | object | ✅ | 日期范围（见下） |
| `travelers` | array | ✅ | 出行人员列表（见下） |
| `days` | array\<day\> | ✅ | 每日行程数组，长度 = 行程天数 |
| `budget` | object | — | 预算分配对象（见「预算边界逻辑」章节） |
| `schedule_refs` | array\<string\> | — | 关联的 Schedule event ID 列表（source: "trip"） |
| `account_refs` | array\<string\> | — | 行程期间产生的 Account 账目 ID 列表 |
| `created_at` | string (ISO) | ✅ | 创建时间 |
| `updated_at` | string (ISO) | ✅ | 最后更新时间 |
| `source` | enum | ✅ | `coordinator`（用户委托）/`replan`（重新规划）/`proactive`（主动服务） |
| `mode` | enum | — | `chill`（度假慢节奏，三段式早/中/晚）/`mixed`（出差+游玩，小时级精度） |
| `preferences_snapshot` | object | — | 用户偏好快照（规划时提取，存档以防后续调整） |
| `warnings` | array\<string\> | — | 生成方案时的警告信息（供 Coordinator 和用户参考） |

#### destination（目的地对象）

```json
{
  "city": "北京",
  "city_code": "BJS",
  "country": "中国",
  "district": "华北",
  "detail": "北京市东城区"
}
```

| 字段 | 类型 | 必填 |
|------|------|------|
| `city` | string | ✅ |
| `city_code` | string | — |
| `country` | string | ✅ |
| `district` | string | — |
| `detail` | string | — |

#### date_range（日期范围对象）

```json
{
  "start": "2026-06-20",
  "end": "2026-06-23",
  "days_count": 4,
  "flexible": false
}
```

| 字段 | 类型 | 必填 |
|------|------|------|
| `start` | string (YYYY-MM-DD) | ✅ |
| `end` | string (YYYY-MM-DD) | ✅ |
| `days_count` | number | ✅ |
| `flexible` | boolean | — |

#### travelers（出行人员数组）

```json
[
  { "id": "traveler_001", "name": "张三", "role": "primary", "age_group": "adult" },
  { "id": "traveler_002", "name": "李四", "role": "companion", "age_group": "adult" }
]
```

| 字段 | 类型 | 必填 |
|------|------|------|
| `id` | string | ✅ |
| `name` | string | ✅ |
| `role` | enum | ✅（`primary`/`companion`） |
| `age_group` | enum | —（`adult`/`child`/`elder`，影响门票价格、饮食推荐） |

---

### days[]（每日行程数组）

每天一个 object，按日期顺序排列。

```json
{
  "day_index": 1,
  "date": "2026-06-20",
  "weekday": "Friday",
  "segments": {
    "morning": { "type": "poi", "poi_id": "attr_001", "title": "故宫", "arrival": "09:00", "departure": "12:00", "duration_min": 180, "ticket_price": 60, "rating": 4.8, "tags": ["博物馆", "世界遗产"], "address": "北京市东城区景山前街4号", "nearest_metro": "天安门东", "transport_to_next": { "to_id": "attr_003", "minutes": 20, "type": "地铁", "edge_ids": ["edge_012"], "distance_m": 2500 }, "alternatives": [{ "poi_id": "attr_015", "name": "国家博物馆", "reason": "室内场馆，不受天气影响，评分4.9" }], "notes": "建议提前预约" },
    "lunch": { "type": "restaurant", "poi_id": "rest_001", "name": "全聚德", "time_range": "12:00-13:00", "per_person": 200, "alternatives": [{ "poi_id": "rest_005", "name": "便宜坊", "reason": "评分4.6，价格适中" }] },
    "afternoon": { ... },
    "dinner": { ... },
    "evening": { ... }
  },
  "accommodation": { "hotel_id": "hotel_001", "name": "王府半岛酒店", "check_in": null, "check_out": null, "nights": 3 },
  "intercity_transport": { "departure": { "city": "上海", "time": "09:00", "mode": "高铁 G2" }, "arrival": { "city": "北京", "time": "13:30", "mode": "高铁 G2" } },
  "daily_cost": { "total": 920, "by_category": { "ticket": 60, "meal": 400, "transport": 60, "hotel": 0, "shopping": 400 } },
  "warnings": []
}
```

**segments 时间段说明**：
- `chill` 模式：固定三段 `morning`/`afternoon`/`evening` + 固定用餐 `lunch`/`dinner`
- `mixed` 模式：精确到小时，支持任意数量 segments

**segment type 说明**：
- `poi`：景点
- `restaurant`：餐厅
- `transport`：交通
- `free`：自由活动
- `fixed`：已有日程不可改（如用户强制的行程）

**alternatives 字段**：当主方案受阻时（如满座、关闭），可快速切换备选，无需重新生成整个行程。

---

### budget（预算分配对象）

```json
{
  "user_specified": false,
  "total": 5000,
  "by_category": {
    "transport": 1200,
    "accommodation": 1500,
    "meal": 800,
    "ticket": 400,
    "shopping": 800,
    "other": 300
  },
  "daily_cap": null,
  "actual_spent": {
    "total": 0,
    "by_category": {}
  },
  "warnings": ["估算总花费 5800 元，超出方案 800 元"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_specified` | boolean | ✅ | 用户是否明确说了预算（决定是否强制约束） |
| `total` | number | — | 总预算上限（元） |
| `by_category` | object | — | 分类预算 |
| `daily_cap` | number | — | 每日预算上限（参考值，由 Account 月均可支配推算） |
| `actual_spent` | object | — | 行程结束后实际花费（由 Account Agent 回填） |
| `warnings` | array\<string\> | — | 预算警告（生成时注入，用户可见） |

---

### preferences_snapshot（用户偏好快照）

```json
{
  "poi_types": ["历史遗迹", "博物馆"],
  "food_cuisine": "烤鸭",
  "shopping": true,
  "nightlife": false,
  "nature": false,
  "hard_constraints": {
    "must_include": [],
    "must_exclude": ["人多的景点"]
  },
  "pace": "relaxed"
}
```

规划时从用户输入中提取存档，防止后续用户调整偏好导致行程矛盾。

---

## 核心流程

### 收到行程规划委托

```
Coordinator 委托"规划北京3日游"
  ↓
1. 直接读 data/schedule.json（查时间冲突）——不走通信
2. 直接读 data/accounts.json + 七维记忆（查月收入/可支配/负债）——不走通信
3. 执行 trip-skill 四阶段：
   - 阶段一：理解意图 → temp/phase1_out.json
   - 阶段二：POI 筛选 → temp/phase2_out.json（含备选）
   - 阶段三：空间优化 → temp/phase3_out.json（含备选路线）
   - 阶段四：生成 Markdown 行程文档
4. 写 data/trips.json
5. 直接写 data/schedule.json（行程 event 碎片，source: "trip"）——不走通信
6. 通过 butler-comm-skill 回复 Coordinator
```

### 收到 Replan 委托

```
Coordinator 通知"Day 1 全聚德满座"
  ↓
读 temp/phase3_out.json → meals_options 或 routes.alternative
选一个评分最接近的备选
  ↓
更新行程文档，标注切换原因
通过 butler-comm-skill 通知 Coordinator
```

---

## Trip 读 Account 数据的场景

### 触发时机

| 触发时机 | 读什么 | 目的 |
|---------|--------|------|
| **行程规划启动时**（阶段一完成后） | 月均收入 + 可支配余额 | 判断用户财务状况，决定是否主动提示财务风险 |
| **预算评估时**（阶段三前） | 月预算配置 + 当前已消耗 | 为 phase3_spatial_optimizer.js 提供 `budget_context` 参数 |
| **行程天数较长时**（>3天） | 未来固定收入预估 | 判断是否有足够财务支撑做远期规划 |
| **用户提到"钱不够"时** | 当前 wallet 余额 + 负债 | 针对性降级方案或调整预算 |
| **行程结束后** | 关联账目汇总 | 汇总旅途花费，发给 Account Agent |

**Trip 不需要读 Account 的场景**：记账、查账、月度报表——这些是 Account Agent 的职责。

### 读哪些字段

| 字段路径 | 来源 | 说明 |
|---------|------|------|
| `wallets.total_remaining` | Account Agent 汇总 | 用户当前可支配总金额 |
| `wallets.total_liability` | Account Agent 汇总 | 用户当前总负债 |
| `income.fixed.monthly` | 七维记忆或用户侧写 | 月固定收入（工资等） |
| `budget.total_monthly` | 七维记忆 | 用户月总预算 |
| `budget.by_category.*` | 七维记忆 | 用户各分类月预算 |
| `saving_goal.progress` | 七维记忆 | 存钱目标进度（用于判断财务压力） |
| `trip_history[]` | trips.json（直接读） | 历史行程及花费（参考同目的地开销） |

>短期：直接读 accounts.json + 七维记忆  
> 长期：Account Agent 通过 butler-comm-skill 的 `info_share` 消息主动推送

### constraint vs reference 模式

**constraint（约束）模式** —— 用户明确说了预算：
- 用户说"预算5000"、"最多花3000"
- `budget.user_specified = true`
- 方案总花费严格 ≤ 用户预算
- 超出预算的 POI/餐厅/酒店被自动替换为低价选项
- 住宿安全底线（安全评级≥3星）不可降级

**reference（参考）模式** —— 用户没说预算：
- `budget.user_specified = false`
- Account 数据仅供参考，用于财务健康提示
- 方案估算可以超出月收入
- 在 `warnings` 中注入提示，不硬阻断方案品质

---

## 预算边界逻辑

### 用户没说预算时：方案可以超出月收入

**触发条件**：`budget.user_specified === false`

**逻辑**：

1. Trip Agent 从 Account/七维记忆获取月固定收入 `M`
2. 方案估算总花费 `estimated_total` 可以 > `M`
3. 在 `budget.warnings` 中注入：`"方案估算总花费 {estimated_total} 元，超出您月收入 {M} 元，约为月收入的 {estimated_total/M} 倍"`
4. **不因此降低方案品质**——预算是参考，不是上限
5. 用户确认后，行程生成；若用户要求调整，再重新规划

**为什么这样做？**
- 用户说"去北京7天"但没说预算，隐含意图是"我想去"，方案品质优先
- 月收入是静态数字，不能反映用户是否有积蓄、是否有其他资金来源
- 过度约束预算会让行程质量严重下降，失去"助手"的价值
- 诚实告知财务代价，让用户做决定

### 用户说了预算 X 时：严格 ≤ X

**触发条件**：`budget.user_specified === true`，`budget.total === X`

**逻辑**：

1. phase3 的 `budget_context.month_remaining` 设为 `X`（而非 Account 实际余额）
2. 预算分配到每日：`daily_cap = X / days_count`
3. 超出预算的 POI/餐厅/酒店被自动替换为低价选项（phase3 算法层面处理）
4. 若低价选项无法满足基本需求，在 `warnings` 中标注并给出调整建议
5. 方案总花费严格 ≤ `X`（若无法满足，返回 "预算不足，无法完成该行程需求，请提升预算或减少天数/人数"）

**强制约束例外**：即使 `user_specified: true`，住宿的安全底线（安全评级≥3星）不可降级。

### 预算信息注入流程

```
阶段一：理解用户意图
  → 解析 budget_level（用户说了预算 / 未说预算）
  ↓
阶段二：POI 筛选
  → 无预算约束，正常筛选
  ↓
阶段三：空间优化（phase3_spatial_optimizer.js）
  → 注入 budget_context：
  {
    "month_remaining": <Account数据：月可支配余额>,
    "daily_cap": <Account数据推算 或 用户预算/天数>,
    "trip_total_estimate": <方案估算总和>,
    "liability": <Account数据：总负债>,
    "user_specified": <boolean>
  }
  → phase3 在 warnings 中标注超预算情况
  ↓
阶段四：生成行程文档
  → 读取 budget.warnings
  → 如有 warnings，在方案开头以独立段落展示
  → 示例："⚠️ 方案估算总花费 5800 元，超出您月收入 800 元（约为月收入的 1.2 倍），是否确认？"
  ↓
写入 trips.json
  → budget.warnings 随方案存档，供后续 replan 参考
```

---

## 与其他 Agent 的数据供给关系

### 读 Schedule（查时间冲突 / 读已有行程）

**文件**：`agents/schedule-agent/data/schedule.json`（直接读）  
**时机**：行程规划前 + 写回前

**读取内容**（仅用这些字段）：`id`, `type`, `date`, `time`, `weekday`, `content`, `source`, `done`

**冲突处理**：
-已有 event 与行程日期完全重叠 → 规划前预警用户
- 已有 event 与行程某日部分重叠 → 在当日 segments 中标注 `type: "fixed"`，不可修改

### 读 Account（收入/可支配/预算配置）

**文件**：`agents/account-agent/data/accounts.json`（直接读）+ 七维记忆  
**时机**：行程规划启动时（阶段一完成后立即执行）

见「Trip 读 Account 数据的场景」章节。

### 写 Schedule（event 碎片，source: "trip"）

**文件**：`agents/schedule-agent/data/schedule.json`（直接写入，追加，不覆盖）  
**时机**：行程确定后（用户确认方案）

**写入内容**：每个 day 产生一条 event 碎片；整条行程的首尾各产生一条 `type: "event"` 的起止记录。

```json
{
  "id": "sch_trip001_day1",
  "type": "event",
  "date": "2026-06-20",
  "time": "09:00",
  "weekday": "Friday",
  "content": "北京4日游 Day 1：故宫",
  "repeat": null,
  "alarm": false,
  "source": "trip",
  "ref_trip": "trip001",
  "done": false,
  "note": "详见 trips.json trip001"
}
```

写入后 `schedule_refs` 数组追加写入的 event ID，便于后续追踪和清理。

### 写 Account（行程结束后通知汇总）

**方式**：通过 butler-comm-skill 向 Account Agent 发送 `info_share` 消息  
**触发时机**：行程状态变为 `completed` 时

**消息格式**：

```json
{
  "from": "trip-agent",
  "type": "info_share",
  "content": {
    "action": "trip_completed",
    "trip_id": "trip001",
    "trip_title": "北京4日游",
    "date_range": { "start": "2026-06-20", "end": "2026-06-23" },
    "estimated_total": 5800,
    "categories": ["transport", "accommodation", "meal", "ticket", "shopping"],
    "ask": "请汇总该行程期间所有相关账目，补充 actual_spent 数据到 trips.json"
  }
}
```

Account Agent 收到后：
1. 查询 accounts.json 中 `ref_trip === trip001` 的所有账目
2. 计算 actual_spent，回填到 trips.json 的 `budget.actual_spent`
3. 若发现有不匹配，通知 Trip Agent 更新 `account_refs`

### 数据流向总图

```
用户输入（模糊/明确需求）
    ↓
Trip Agent
    ├── 读 schedule.json（查冲突）
    ├── 读 accounts.json + 七维记忆（收入/预算）
    └── 读 trips.json（历史行程参考）
            ↓
    阶段一：理解意图 → phase1_out.json
            ↓
    阶段二：POI 筛选（phase2_poi_filter.js）
            ↓ 候选 POI（含备选）
    阶段三：空间优化（phase3_spatial_optimizer.js）
    ├── 注入 budget_context（Account 数据）
    ├── 注入 fixed_blocks（Schedule 已有日程）
    └── 输出有序 POI 序列 + 备选路线
            ↓
    阶段四：生成 Markdown 行程文档
    ├── 展示 budget.warnings（如有）
    └── 用户确认
            ↓
    写 trips.json（行程存档）
            ↓
    写 schedule.json（event 碎片，source: "trip"）
            ↓
    通过 butler-comm → Account Agent（行程结束汇总）
            ↓
    Account Agent 回填 actual_spent 到 trips.json
```

---

## 主动服务扩展

> 通过 Heartbeat 触发，具体触发逻辑见 heartbeat-skill。

### 出发前主动服务

| 场景 | 触发条件 | 执行动作 |
|------|---------|---------|
| **行程前 N 天提醒** | 行程 start_date - 3 天 | 提醒用户确认机票/酒店/证件，询问是否有变更 |
| **天气预警** | 行程前 1 天，气象数据显示目的地有极端天气 | 主动建议调整行程顺序（将室内场馆提前），并通知 Coordinator |
| **人流预警** | 行程前获取到某 POI 即将有大流量活动（如故宫特展） | 主动建议换备选 POI 或调整游览时间 |
| **证件/签证提醒** | 目的地为出境/偏远地区，行程前 7 天 | 提醒办理护照/签证/通行证 |

### 行程中主动服务

| 场景 | 触发条件 | 执行动作 |
|------|---------|---------|
| **交通延误响应** | 实时交通数据（接入外部 API）或用户告知延误 | 自动 replan 当日后续行程，通知 Coordinator |
| **餐厅满座/关闭** | MockBackend 事件推送（`events.status === "closed"`） | 自动切换备选餐厅，更新当日行程，通知 Coordinator |
| **天气突变** | 实时天气数据 | 建议将下个室外 POI 替换为室内备选 |
| **行程偏离预警** | 用户当前位置偏离计划路线超过 30 分钟 | 询问是否需要重新规划，或提供附近 POI 快速接入 |
| **时间超支预警** | 当前 POI 停留时长超过计划 50% | 提醒后续行程时间压缩或延后，给出调整建议 |

### 行程后主动服务

| 场景 | 触发条件 | 执行动作 |
|------|---------|---------|
| **旅途花费汇总** | 行程状态 → `completed` | 通过 butler-comm 通知 Account Agent 汇总，生成花费报告发给用户 |
| **行程回顾** | 行程结束后 24 小时内 | 发送行程回顾（亮点总结 + 实际花费 vs 估算对比） |
| **下次出行建议** | 行程结束后，用户未立即规划新行程 | 基于本次行程数据，推荐相似目的地（参考本次喜欢的 POI 类型） |
| **异常账目录入提醒** | 行程结束 48 小时内存入账目明显少于预期 | 主动询问用户是否需要补录遗漏账目 |

### 预防性主动服务

| 场景 | 触发条件 | 执行动作 |
|------|---------|---------|
| **行程密集预警** | 同一目的地短期内（30 天内）有多次行程规划 | 提醒用户合并行程或调整时间，避免资源浪费 |
| **预算异常积累预警** | 连续 3 个月行程花费超过月收入 150% | 通过 Coordinator 询问用户财务状况，是否需要设置出行预算上限 |
| **偏好漂移检测** | 七维记忆检测到用户口味偏好发生变化（如突然偏好素食） | 主动询问是否更新行程偏好设置 |

---

## 与其他 Agent 通信汇总

| 方向 | 场景 | 方式 |
|------|------|------|
| Trip → Account | 行程结束后通知汇总花费 | butler-comm-skill（`info_share` 消息，`action: "trip_completed"`） |
| Trip → Coordinator | 返回规划结果 / replan 结果 | butler-comm-skill（`result_callback` 消息） |
| Coordinator → Trip | 委托任务 | butler-comm-skill（`task_delegate` 消息） |

**不再通信的场景**（直接读文件更快）：
- ❌ Trip → Schedule：查时间冲突 → ✅ 直接读 `data/schedule.json`
- ❌ Trip → Account：查预算 → ✅ 直接读 `data/accounts.json` + 七维记忆

---

## 我主管的七维维度

| 维度 | 记什么 | 触发时机 |
|------|--------|---------|
| 口味偏好 | 辣/清淡/海鲜/过敏源/菜系偏好 | 发现用户口味偏好信号 → 写 cache |

**七维 MySQL 表结构**：见 `skills/memory-seven-dim-skill/references/db_schema.sql` 的 `cache_events` 建表语句（写 cache 时用）+ `seven_dimensions` 建表语句（晋升后用）。

**口味偏好写入格式**：见 `skills/memory-seven-dim-skill/SKILL.md`「口味偏好维度」章节，含 sub_key 合法值（辣度/菜系/过敏源/价格敏感度）、evidence 写法、confidence 默认值。

**晋升逻辑**：见同一章节「cache → dimension 晋升流程」，≥3次写同一 sub_key 触发 promote。

---

## 记忆触发时机

| 记忆系统 | 时机 |
|---------|------|
| 五层 transient | 每次操作后立即写 |
| 五层 days | 对话结束后写 |
| 七维 口味偏好 | 发现用户口味信号 → 写 cache，≥3次晋升 |

读写方法见 memory-layers-skill / memory-seven-dim-skill。

---

*文档由 subagent 生成，供 Trip Agent 实际执行参考。如有调整，请同步更新 `skills/trip-skill/SKILL.md` 和 `skills/butler-comm-skill/SKILL.md` 中的相关描述。*
---

## 通讯录

**你（trip-agent）的收件箱**：`shared/trip-agent/YYYY-MM-DD.json`（任何人写，醒来时按 `from != "trip-agent"` 过滤未读）

**你醒来时调用的 wake job**：`butler-trip-agent-wake`（session: `session:butler-trip-agent:inbox`，disabled，被 cron run 触发）

**你可以主动发消息给**：

| 收件方 | 收件箱 | 写消息后触发 | 何时用 |
|-------|--------|------------|--------|
| coordinator | `shared/coordinator/YYYY-MM-DD.json` | `openclaw cron run <coordinator-wake-id>` | 回复 coordinator 委托 |
| schedule-agent | `shared/schedule-agent/YYYY-MM-DD.json` | `openclaw cron run <schedule-wake-id>` | 需要日程配合（行程时间冲突、写入日程） |
| account-agent | `shared/account-agent/YYYY-MM-DD.json` | `openclaw cron run <account-wake-id>` | 行程结束需汇总 / 预算核实 |

**写入工具**：`butler-comm-skill`（`write_message(to_agent, from_agent, content, msg_type)`）
