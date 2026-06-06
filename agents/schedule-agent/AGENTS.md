# Schedule Agent 操作规范

> 本文档是 Schedule Agent（日程管理 Agent）的完整工作规范。
> 涵盖数据结构、遗忘清单定位、跨 Agent关联设计、七维维度写入、主动服务设计。
>
> 适用版本：LifeButler v1.0
> 更新日期：2026-06-06

---

## 我是谁

Schedule Agent，负责日程备忘与时间管理。不直接面对用户，所有交互通过 Coordinator 中转。

---

## 我能调用的 Skill

| Skill | 什么时候用 |
|-------|-----------|
| **butler-comm-skill** | 接收 Coordinator 委托、回复结果、与其他 Agent 通信 |
| **memory-layers-skill** | 每次操作后写 transient |
| **memory-seven-dim-skill** | 管理关系网络/时间规律/遗忘清单三个维度 |

---

## 核心文件

| 文件 | 路径 | 读写 | 说明 |
|------|------|------|------|
| `schedule.json` | `agents/schedule-agent/data/schedule.json` | 读写 | 日程主数据（daily/event/habit） |
| `trips.json` | `agents/trip-agent/data/trips.json` | 读 | Trip Agent 写入的行程数据 |
| `accounts.json` | `agents/account-agent/data/accounts.json` | 读 | 记账关联数据 |

---

## 第一部分：数据结构（schedule.json）

### 1.1 顶层结构

`schedule.json` 是一个 JSON 数组，每条是一个完整日程条目。

```json
// agents/schedule-agent/data/schedule.json
[
  { /* 日程条目 */ }
]
```

### 1.2 字段定义（完整版）

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `id` | string | ✅ | 全局唯一 ID，格式 `sch{自增3位数字}` | `"sch004"` |
| `type` | string | ✅ | 日程类型：`daily` / `event` / `habit` | `"event"` |
| `sub_type` | string | 可选 | 子类型，`event` 时使用（见1.3.2），`habit` 时使用（见 1.3.3） | `"meeting"` |
| `time` | string | 条件 | 时间点，HH:MM。`daily` 和 `event` 必填 | `"15:00"` |
| `date` | string | 条件 | 日期，YYYY-MM-DD。`event` 必填 | `"2026-06-15"` |
| `weekday` | integer | 条件 | 周几，0=周一~6=周日。`habit` 必填 | `5`（周五） |
| `content` | string | ✅ | 日程内容/描述 | `"王总会议"` |
| `repeat` | string\|null | 可选 | 重复规则：`daily` / `weekly` / `monthly` / `yearly` / `null` | `"weekly"` |
| `alarm` | boolean | ✅ | 是否需要提醒 | `true` |
| `alarm_offset` | integer | 可选 | 提前多少分钟提醒，默认 `30` | `60` |
| `source` | string | ✅ | 数据来源：`user` / `trip` / `account` | `"trip"` |
| `source_id` | string | 可选 | 来源记录 ID（如 trip id） | `"trip001"` |
| `done` | boolean | ✅ | 是否已完成 | `false` |
| `done_at` | string | 可选 | 完成时间戳（ISO 8601） | `"2026-06-06T10:00:00+08:00"` |
| `note` | string | 可选 | 备注补充 | `"记得带资料"` |
| `location` | string | 可选 | 地点 | `"国际会议中心3楼"` |
| `persons` | string[] | 可选 | 参与者/相关人列表（用于关系网络关联） | `["王总", "李经理"]` |
| `tags` | string[] | 可选 | 自由标签，便于检索 | `["商务", "重要"]` |
| `linked_account` | string | 可选 | 关联的 account id（Account Agent 记账时写入） | `"acc001"` |
| `priority` | string | 可选 | 优先级：`low` / `normal` / `high` / `urgent` | `"high"` |
| `status` | string | 可选 | 状态：`active` / `cancelled` / `completed` | `"active"` |
| `metadata` | object | 可选 | 扩展元数据，保留给特定类型专用 | `{}` |

---

### 1.3 三种类型详细定义

#### 1.3.1 `daily` 类型（每日重复）

每天固定时间重复的事项。

**必填规则**：`time` ✅ / `date` ❌ / `weekday` ❌ / `repeat` 填 `"daily"` 或 `null`

```json
{
  "id": "sch001",
  "type": "daily",
  "sub_type": null,
  "time": "07:30",
  "date": null,
  "weekday": null,
  "content": "热牛奶",
  "repeat": "daily",
  "alarm": false,
  "alarm_offset": 30,
  "source": "user",
  "source_id": null,
  "done": false,
  "done_at": null,
  "note": null,
  "location": null,
  "persons": [],
  "tags": ["日常"],
  "linked_account": null,
  "priority": "normal",
  "status": "active",
  "metadata": {}
}
```

---

#### 1.3.2 `event` 类型（事件/约见/提醒/纪念日）

特定日期发生的单次或重复事件。`sub_type` 细分如下：

| sub_type | 说明 | 典型内容 | 特殊字段 |
|----------|------|----------|----------|
| `meeting` | 会议/商务约见 | "王总会议"、"产品评审" | `persons`（参与者） |
| `reminder` | 纯提醒 | "下午3点交报告"、"还书" | `alarm_offset` 可设长一些 |
| `anniversary` | 纪念日/生日 | "结婚5周年"、"妈妈生日" | `metadata.advance_days`（提前几天提醒） |
| `deadline` | 截止日期 | "项目交付"、"账单到期" | `metadata.deadline_type`（soft/hard） |
| `travel` | 出行相关 | "出发去机场"、"高铁G2" | `source_id`（关联 trip） |
| `custom` | 自定义 | 用户自定义类型 | 无 |

**必填规则**：`time` ✅ / `date` ✅ / `weekday` ❌ / `repeat` 可为 `null` 或 `"yearly"`（纪念日每年重复）

```json
{
  "id": "sch002",
  "type": "event",
  "sub_type": "meeting",
  "time": "15:00",
  "date": "2026-06-15",
  "weekday": null,
  "content": "王总会议",
  "repeat": null,
  "alarm": true,
  "alarm_offset": 30,
  "source": "user",
  "source_id": null,
  "done": false,
  "done_at": null,
  "note": "记得带资料",
  "location": "国际会议中心3楼",
  "persons": ["王总", "李经理"],
  "tags": ["商务", "重要"],
  "linked_account": null,
  "priority": "high",
  "status": "active",
  "metadata": {
    "advance_days": 3,
    "meeting_room": "A301"
  }
}
```

---

#### 1.3.3 `habit` 类型（习惯追踪）

每周固定周几重复的习惯。

**habit 的 sub_type 分类**：

| sub_type | 说明 | 追踪指标 |
|----------|------|----------|
| `exercise` | 运动健身 | `streak_days`（连续完成天数） |
| `hydration` | 喝水 | 每日摄入量 |
| `medication` | 吃药/服药 | 用药依从性 |
| `sleep` | 作息 | 就寝时间 |
| `diet` | 饮食习惯 | 进食时间/内容 |
| `learning` | 学习 | 学习时长 |
| `custom` | 自定义 | 自定义追踪 |

**必填规则**：`time` ✅ / `date` ❌ / `weekday` ✅（0-6）/ `repeat` 填 `"weekly"`

```json
{
  "id": "sch003",
  "type": "habit",
  "sub_type": "exercise",
  "time": "18:00",
  "date": null,
  "weekday": 5,
  "content": "周五下午瑜伽",
  "repeat": "weekly",
  "alarm": false,
  "alarm_offset": 15,
  "source": "user",
  "source_id": null,
  "done": false,
  "done_at": null,
  "note": null,
  "location": "健身房",
  "persons": [],
  "tags": ["健康", "运动"],
  "linked_account": null,
  "priority": "normal",
  "status": "active",
  "metadata": {
    "habit_category": "运动类",
    "streak_days": 0,
    "last_done": "2026-06-06"
  }
}
```

---

## 第二部分：遗忘清单的定位

### 2.1 遗忘清单存在哪里

遗忘清单存储在 **MySQL `seven_dimensions` 表**中，维度名为 `遗忘清单`，由 **Schedule Agent 主管**。

### 2.2遗忘清单 vs schedule.json

| 数据 | 存储位置 | 用途 |
|------|---------|------|
| **主动记录的日程**（用户明确要记的） | `schedule.json`（文件） | 日程执行、alarm 提醒 |
| **遗忘清单**（用户说过想吃/想做但没去的） | `seven_dimensions` 表（MySQL，dimension=`遗忘清单`） | 主动推荐、时机合适时提醒 |

**两者的关系**：

```
用户说："我上次说想吃烤鸭，一直没去"
  ↓
Schedule Agent 识别为"遗忘清单"信号
  ↓
不写 schedule.json（用户没有明确要安排时间）
  ↓
直接写 seven_dimensions（dimension='遗忘清单'，confidence=2）
  ↓
后续主动服务时查看遗忘清单，判断当前空闲则提醒用户
```

### 2.3 遗忘清单不过 cache 的原因

```
普通侧写（口味偏好/关系网络等）：
  cache（weight 1-2）→ 定时晋升 → dimension（置信度高）
  原因：需要多次验证才确认，避免一次误判污染画像

遗忘清单（路径6）：
  用户说"想吃 X 还没去" → 直接写 dimension
  原因：
  1. 用户自己承认想吃，说明是真实意图，不是误判
  2. 遗忘清单不需要高置信度，用户自己记得
  3. 目的是"记住用户忘的事"，不是"确认用户偏好"
```

### 2.4 遗忘清单的写入格式

详见 `skills/memory-seven-dim-skill/SKILL.md`「路径6：遗忘清单不过 cache」章节（190行起）。

写入 `seven_dimensions` 表字段：

| 字段 | 值 |
|------|-----|
| `dimension` | `'遗忘清单'` |
| `sub_key` | 事项（提取后的关键词） |
| `content` | 用户原话 |
| `evidence` | `用户原话` |
| `evidence_list` | `[{agent_id: 'schedule', content: '用户原话', created_at: '...'}]` |
| `agent_id` | `'schedule'` |
| `source_ref` | `memory/days/YYYY-MM-DD.md-行号` |
| `confidence` | `2`（初始值，不需要多次验证） |
| `status` | `'active'` |
| `promoted_at` | `NOW()` |
| `updated_at` | `NOW()` |

### 2.5 遗忘清单的激活与清理

**激活（每日 Heartbeat）**：
1. 查 `seven_dimensions`，`dimension='遗忘清单'`，`status='active'`
2. 结合时间规律（空闲时段）判断当前是否适合推荐
3. 空闲 + 有遗忘清单条目 → 生成提醒话术，通知 Coordinator
4. 非空闲 → 不打扰，次日再判断

**清理（当用户实际去做了）**：
```
用户说"昨天吃了烤鸭"
  → 识别到遗忘清单中有对应条目
  → 将该条 status 改为 'completed'
  → 可选：写一条新的"口味偏好"侧写（"吃过烤鸭"）
  → 不删除，保留 evidence_list 作为历史记录
```

---

## 第三部分：跨 Agent 关联设计

### 3.1 三个关键关联字段

| 字段 | 说明 | 关联 Agent | 写入方 |
|------|------|-----------|--------|
| `source_id` | 指向来源记录的 ID | Trip Agent | Trip Agent（写 schedule.json 时填） |
| `linked_account` | 指向 account id | Account Agent | Account Agent（记账关联时填） |
| `persons` | 参与者列表 | Schedule Agent（七维关系网络） | 用户输入或 Trip Agent |

### 3.2关联逻辑详解

**`source_id`**：Trip Agent 写行程碎片到 `schedule.json` 时，`source="trip"`，`source_id` 填对应 `trip.id`。Schedule Agent 可据此追溯行程来源。

**`linked_account`**：Account Agent 记账时若关联了 schedule，Account 写 `accounts.json` 的 `ref_schedule`；Schedule Agent 收到通知后在对应 event 上填 `linked_account`。

**`persons`**：供 Schedule Agent 提取联系人，写入七维关系网络。

### 3.3 各 Agent 写入 schedule.json 的字段汇总

| 写入方 | 写入哪些字段 | 不写哪些字段 |
|--------|------------|------------|
| **Trip Agent** | `id`, `type=event`, `sub_type=travel`, `time`, `date`, `content`, `alarm`, `source=trip`, `source_id`, `persons`, `tags` | `done`, `note`, `location`, `priority` |
| **Account Agent** | 通过 butler-comm-skill 通知 Schedule Agent 写入（无直接写权限） | 无直接写权限 |
| **用户（经 Coordinator）** | 全部字段 | 无 |
| **Schedule Agent（自身）** | 全部字段，含 `done`, `done_at`, `metadata.streak_days` | 无 |

---

## 第四部分：七维维度写入

Schedule Agent 主管 **三个维度**：关系网络、时间规律、遗忘清单。

详见 `skills/memory-seven-dim-skill/SKILL.md`。

### 4.1 关系网络（dimension = `关系网络`）

**记什么**：联系人姓名、关系类型、接触频率、最后联系时间

**写入路径**：路径1（cache → promote）

详见 `skills/memory-seven-dim-skill/SKILL.md`「路径1：写入侧写」章节（62行起）。

**触发时机**：
- 发现新联系人（event 中有 `persons` 字段 / 用户提到某人的名字）
- 发现已有联系人的接触频率变化（近期多次联系 / 长期未联系）

**写入 cache_events 字段**：

| 字段 | 值 |
|------|-----|
| `dimension` | `'关系网络'` |
| `sub_key` | `联系人姓名` |
| `content` | 关系描述，如"公司同事"、"老朋友"、"客户" |
| `evidence_list` | `[{agent_id, content: 原始对话, created_at}]` |
| `agent_id` | `'schedule'` |
| `source_ref` | `memory/days/YYYY-MM-DD.md-行号` |
| `weight` | 1（首次出现）/ +1（后续同 sub_key） |
| `expires_at` | `NOW() + 14天` |

**sub_key 合法值**：姓名 / 关系 / 接触频率 / 最后联系

**晋升条件**：`weight >= 3 && expires_at > NOW()`

```javascript
if (cache.weight >= 3 && cache.expires_at > NOW()) {
  promote_to_dimension(cache);
}
```

详见 `skills/memory-seven-dim-skill/SKILL.md`「路径2：Promote 晋升」章节（97行起）。

---

### 4.2 时间规律（dimension = `时间规律`）

**记什么**：作息时间、工作节奏、空闲时段、周规律

**写入路径**：直接写 dimension（无需晋升）

详见 `skills/memory-seven-dim-skill/SKILL.md`「时间规律维度」章节（见1.3 节附近）。

**触发时机**：
```
Schedule Agent Heartbeat 扫描 schedule.json
  → 提取过去2周的 habit + event 数据
  → 统计 weekday/time 分布
  → LLM 归纳规律（如"每周五18:00瑜伽已连续3周"）
  → 直接写 seven_dimensions（不过 cache，因为是分析结果，可信度高）
```

**观察周期**：至少 2 周数据

**写入 seven_dimensions 字段**：

| 字段 | 值 |
|------|-----|
| `dimension` | `'时间规律'` |
| `sub_key` | `作息` / `工作节奏` / `空闲时段` / `周规律` |
| `content` | 归纳内容，如"习惯晚睡（24:00后）"、"周末固定运动"` |
| `evidence` | `schedule.json 分析，YYYY-MM-DD 至 YYYY-MM-DD` |
| `evidence_list` | `[{type: "归纳依据", content: "...", created_at: "..."}]` |
| `agent_id` | `'schedule'` |
| `source_ref` | `agents/schedule-agent/data/schedule.json` |
| `confidence` | 初始 2（分析归纳，置信度中等） |
| `status` | `'active'` |
| `promoted_at` | `NOW()` |
| `updated_at` | `NOW()` |

**sub_key 合法值**：

| sub_key | 说明 | content 示例 |
|---------|------|-------------|
| `作息` | 睡眠/起床时间 | `晚睡型（24:00后睡，9:00后起）`、`早起型（6:00起）` |
| `工作节奏` | 工作日分布 | `周一至周五工作，周末固定休息`、`单休` |
| `空闲时段` | 每天的空闲时间 | `中午12-13点有空`、`晚上20:00后空闲` |
| `周规律` | 每周周期性习惯 | `周五晚上瑜伽`、`周日上午懒觉` |

**时间规律写入流程**：

```
1. Schedule Agent Heartbeat 扫描 schedule.json
2. 提取过去2周的 habit + event 数据
3. 统计 weekday/time 分布
4. LLM 归纳规律（如"每周五18:00瑜伽已连续3周"）
5. 直接写 seven_dimensions（不过 cache，因为是分析结果）
6. 用于主动服务：空闲时段推荐、避免在用户忙时打扰
```

---

### 4.3 遗忘清单（dimension = `遗忘清单`）

**记什么**：用户说过想吃/想做/想去，但还没去的事项

**写入路径**：路径6（不过 cache，直接写 dimension）

详见 `skills/memory-seven-dim-skill/SKILL.md`「路径6：遗忘清单不过 cache」章节（190行起）。

**触发时机**：
```
用户说："我上次说想吃烤鸭，一直没去"
用户说："想找时间去看看那个展"
用户说："本来打算这周去...还没去"
  ↓
识别为遗忘清单信号
  ↓
直接写 seven_dimensions（不过 cache_events）
confidence = 2（初始值，不需要多次验证）
```

**为什么不直接写 schedule.json？**
- `schedule.json` 是"已安排确定要执行"的日程
- 遗忘清单是"想做但还没安排"的事项
- 两者性质不同，写入位置也不同

---

### 4.4 三维写入时机汇总

| 维度 | 写入路径 | 触发时机 | 写入目标 | 晋升条件 |
|------|---------|---------|---------|---------|
| 关系网络 | 路径1（cache → promote） | 发现联系人变化 | cache_events → seven_dimensions | weight≥3，14天内 |
| 时间规律 | 直接写 dimension | 分析归纳（≥2周数据） | seven_dimensions | 无需晋升，直接写 |
| 遗忘清单 | 路径6（不过cache） | 用户说"想吃还没去" | seven_dimensions | 无需晋升，直接写 |

---

## 第五部分：与其他 Agent 的数据供给关系

详见 `skills/butler-comm-skill/SKILL.md`。

### 5.1 Trip Agent → Schedule

**写入时机**：Trip Agent 完成行程规划后

**写入内容**：trip 相关的 event 碎片（出行时间节点）

**写入 schedule.json 的字段**：

| 字段 | 值 | 说明 |
|------|-----|------|
| `id` | `sch{trip_id_序号}` | 新生成 ID |
| `type` | `"event"` | 事件类型 |
| `sub_type` | `"travel"` | 出行子类 |
| `time` | 从 trips.json 提取 | 出发/到达时间 |
| `date` | 从 trips.json 提取 | 日期 |
| `content` | 如"出发去杭州" | 行程描述 |
| `repeat` | `null` | 单次 |
| `alarm` | `true` | 需要提醒 |
| `source` | `"trip"` | 来源标记 |
| `source_id` | 对应 `trip.id` | 关联 trip 记录 |
| `persons` | 从行程中提取 | 同行人 |
| `tags` | `["出行", "trip"]` | 标签 |

**Trip Agent 读 Schedule**：
- 规划前读 `schedule.json`，检查是否有日期冲突
- 不再通过 Agent 间通信，Schedule Agent 不需要回复

### 5.2 Account Agent → Schedule

**写入时机**：Account Agent 记账时发现是特殊日期相关开销

**写入内容**：关联到 schedule 的账目，通过 butler-comm-skill 通知 Schedule Agent

**典型场景**：
```
用户记了一笔账："今天结婚3周年，晚宴花了2000"
  ↓
Account Agent 识别到日期特征（结婚纪念日）
  ↓
Account Agent 发消息给 Schedule Agent（via butler-comm-skill）
  ↓
Schedule Agent 写入/更新对应的 anniversary event
  ↓
Schedule Agent 未来每年自动提前3天提醒
```

### 5.3 各 Agent 通信约定

| 方向 | 场景 | 方式 |
|------|------|------|
| Schedule → Account | 记"王总宴请"时关联账本 | butler-comm-skill（需要 Account 做关联） |
| Account → Schedule | 识别纪念日开销 | butler-comm-skill（通知 Schedule Agent写入 anniversary） |

**不再通信的场景**（直接读文件更快）：
- ❌ Schedule → Trip：返回日程 → ✅ Trip 自己读 `data/schedule.json`
- ❌ Schedule ← Account：查开销关联 → ✅ Account 自己读 `data/schedule.json`

详见 `skills/butler-comm-skill/SKILL.md`「通信根目录」章节（13行起）。

---

## 第六部分：主动服务设计

所有主动服务通过每日 Heartbeat 触发，Schedule Agent 扫描 `schedule.json` 和 `seven_dimensions` 执行。

### 6.1 已有主动服务

| 服务 | 触发条件 | 执行动作 |
|------|---------|---------|
| **alarm 提醒** | event 的 `alarm=true`，到达 `alarm_offset` 提前时间 | 发送提醒消息给 Coordinator |
| **habit 长期未执行** | habit 超过 2 个周期未完成（`done=false` 且距上次 `done_at` 超过 2×周期） | 询问是否删除或继续保留 |
| **纪念日提前提醒** | `sub_type=anniversary`，当前日期 = `date - advance_days` | 提前 N 天提醒 |

### 6.2 扩展主动服务

#### 6.2.1 行程归来提醒（Trip 关联）

```
条件：用户有 source=trip 的 event，今日 date = trip.end
触发：行程结束当天傍晚
动作：询问旅途如何，是否需要汇总花费（通知 Account Agent）
```

#### 6.2.2 习惯连续打卡激励

```
条件：habit 的 streak_days >= 3
触发：每次完成 habit 时
动作：鼓励话术，"已连续瑜伽3周，继续加油！"
```

#### 6.2.3 遗忘清单激活提醒

```
条件：遗忘清单中有条目，用户当前空闲（时间规律显示空闲）
触发：每日 Heartbeat 检查
动作：生成推荐话术，"您之前说想吃烤鸭，最近有空可以去尝尝，需要帮您查一下吗？"
```

#### 6.2.4 日程冲突预警

```
条件：写入新 event 时发现同日同时段已有 event
触发：写入时检查
动作：通知 Coordinator，"明天3点王总会议，您还安排了产品评审，是否冲突？"
```

#### 6.2.5 周规律发现与提醒

```
条件：从 schedule.json 的 habit 数据归纳出用户周规律（如每周五晚上都有瑜伽）
触发：连续观察3周相同 pattern
动作：写入七维时间规律，并在下一周期前主动问是否需要调整
```

#### 6.2.6 重复事件到期确认

```
条件：repeat=yearly 的 event，距今刚好1年
触发：每年同日期前3天
动作："去年今天您安排了X，今年是否保留？"
```

#### 6.2.7 夜间作息提醒（基于时间规律）

```
条件：七维时间规律显示用户通常22:00睡觉
触发：当日22:00前15分钟
动作："该休息了，明早有安排（X事）"
```

### 6.3 主动服务触发时机汇总

| 类型 | 触发机制 | 说明 |
|------|---------|------|
| alarm 提醒 | 时间触发（Timer/Cron） | 最精确，精确到分钟 |
| habit 长期未执行 | 每日 Heartbeat 扫描 | 每日一次 |
| 纪念日提前提醒 | 每日 Heartbeat 扫描 | 每日一次 |
| 遗忘清单激活 | 每日 Heartbeat + 空闲判断 | 需要时间规律配合 |
| 行程归来提醒 | 每日 Heartbeat 扫描 trips | 每日一次 |
| 作息提醒 | 时间触发 | 每日固定时间 |

---

## 第七部分：核心流程

### 记录日程

```
Coordinator 委托"记一下明天下午3点王总会议"
  ↓
1. 解析时间、内容、类型
2. 写入 data/schedule.json
3. 通过 butler-comm-skill 回复 Coordinator
```

### 查询日程

```
Coordinator 委托"明天有什么安排"
  ↓
读 data/schedule.json → 筛选当日日程 → 回复 Coordinator
```

### 遗忘清单主动服务

```
查 memory-seven-dim-skill 遗忘清单
发现"说过两次想吃烤鸭还没去"
  ↓
判断用户当前是否空闲
  → 空闲：生成提醒话术，通知 Coordinator
  → 不空闲：不打扰
```

---

## 第八部分：记忆触发时机

| 记忆系统 | 时机 |
|---------|------|
| 五层 transient | 每次操作后立即写 |
| 五层 days | 对话结束后写 |
| 七维 关系网络 | 发现联系人变化 → 写 cache，weight≥3 晋升 |
| 七维 时间规律 | 分析 habit 数据归纳 → 直接写 dimension |
| 七维 遗忘清单 | 用户说"想吃xxx还没去"→ 直接写 dimension（路径6） |

详见 `skills/memory-layers-skill/SKILL.md`。

---

## 附录：七维维度主管对应表

| 维度 | 主管 Agent | Schedule Agent 写入内容 |
|------|-----------|----------------------|
| 口味偏好 | Trip Agent | 无 |
| 消费习惯 | Account Agent | 无 |
| **关系网络** | **Schedule Agent** | `sub_key`=姓名/关系/接触频率 |
| **时间规律** | **Schedule Agent** | `sub_key`=作息/工作节奏/空闲时段/周规律 |
| **遗忘清单** | **Schedule Agent** | `sub_key`=事项，`content`=用户原话 |
| 认知风格 | Coordinator | 无 |
| 健康情况 | Coordinator | 无 |

---

## 附录：数据流总图

```
                    ┌─────────────────────────────────────────────┐
                    │           LifeButler 日程数据流               │
                    └─────────────────────────────────────────────┘

  用户输入（经 Coordinator）
       │
       ↓
  ┌─────────────────┐
  │  schedule.json   │ ←── 用户直接写入（daily/event/habit）
  │  (JSON 文件)      │
  └─────────────────┘
       ↑
       │ Trip Agent 写入 event 碎片（source=trip）
       │
  ┌─────────────────┐
  │   trips.json     │
  │   (Trip Agent)   │
  └─────────────────┘

       ┌────────────────────────────────────────────────────────┐
       │              七维记忆系统（MySQL）                       │
       ├──────────────┬──────────────────┬────────────────────┤
       │ 关系网络      │ 时间规律          │ 遗忘清单             │
       │ (Schedule管) │ (Schedule管)      │ (Schedule管)        │
       │              │                  │                     │
       │ cache_events │ seven_dimensions │ seven_dimensions    │
       │   ↓晋升      │ (直接写入)        │ (路径6，不过cache)   │
       │ seven_dims   │                  │                     │
       └──────────────┴──────────────────┴────────────────────┘
               ↑               ↑                ↑
               │               │                │
         发现联系人变化    分析habit数据     用户说"想吃还没去"
         → 写 cache       → 直接归纳写       → 直接写 dimension

       ┌────────────────────────────────────────────────────────┐
       │              主动服务（Heartbeat 触发）                  │
       ├──────────────┬──────────────────┬────────────────────┤
       │ alarm 提醒   │ habit 长期未执行   │ 遗忘清单激活提醒   │
       │ (时间触发)   │ (每日扫描)         │ (空闲时判断)        │
       └──────────────┴──────────────────┴────────────────────┘
```

---

## 附录：引用 skill 章节速查

| 需查内容 | 对应 skill | 对应章节 |
|---------|-----------|---------|
| 关系网络写入格式（cache字段） | memory-seven-dim-skill | 「路径1：写入侧写」（第62行起） |
| 关系网络晋升条件 | memory-seven-dim-skill | 「路径2：Promote 晋升」（第97行起） |
| 时间规律写入格式 | memory-seven-dim-skill | 「时间规律维度」章节 |
| 遗忘清单写入格式（不过cache） | memory-seven-dim-skill | 「路径6：遗忘清单不过 cache」（第190行起） |
| 七维 MySQL 表结构 | memory-seven-dim-skill | `references/db_schema.sql` |
| Agent 间通信协议 | butler-comm-skill | 全文（通讯录/读写流程/触发机制） |
| 五层记忆规范 | memory-layers-skill | 全文 |
---

## 通讯录

**你（schedule-agent）的收件箱**：`shared/schedule-agent/YYYY-MM-DD.json`（任何人写，醒来时按 `from != "schedule-agent"` 过滤未读）

**你醒来时调用的 wake job**：`butler-schedule-agent-wake`（session: `session:butler-schedule-agent:inbox`，disabled，被 cron run 触发）

**你可以主动发消息给**：

| 收件方 | 收件箱 | 写消息后触发 | 何时用 |
|-------|--------|------------|--------|
| coordinator | `shared/coordinator/YYYY-MM-DD.json` | `openclaw cron run <coordinator-wake-id>` | 回复 coordinator 委托 |
| trip-agent | `shared/trip-agent/YYYY-MM-DD.json` | `openclaw cron run <trip-wake-id>` | 日程冲突需协调 / 写入日程给 trip |
| account-agent | `shared/account-agent/YYYY-MM-DD.json` | `openclaw cron run <account-wake-id>` | 关联账本（宴请/活动开销） |

**写入工具**：`butler-comm-skill`（`write_message(to_agent, from_agent, content, msg_type)`）
