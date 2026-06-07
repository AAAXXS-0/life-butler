# LifeButler — 智能生活管家

> 多 Agent 协作 + 图模型路径规划 + 双层记忆（五层 + 七维）+ 事件模拟与自动 Replan

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![MySQL](https://img.shields.io/badge/mysql-9.7-blue)](https://www.mysql.com)
[![Docker](https://img.shields.io/badge/docker--compose-blue)](https://docs.docker.com/compose/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## 核心亮点

| 模块 | 说明 |
|------|------|
| **图模型行程规划** | 自实现 Dijkstra + K-Means，POI/路径/备选全部走图查询 |
| **双层记忆** | 五层文件版（时间衰减）+ 七维 MySQL（内容画像），两套完全独立 |
| **事件模拟** | 12 种事件自动生成（天气/排队/路况/景区），好事过滤，坏事触发自动 replan |
| **本地生活 4 skill** | weather/queue/traffic/nearby — trip 回调后拼提示文案，nearby 走独立路径 |
| **异步 A2A** | `shared/<agent>/YYYY-MM-DD.json` + `openclaw cron run` 链式触发，不用 sessions_send |

---

## 架构

```
                    ┌───────────────┐
                    │  用户（飞书）   │
                    └───────┬───────┘
                            │ 消息
                            ▼
            ┌───────────────────────────────┐
            │       Coordinator（主入口）      │
            │  意图识别 → 路由 → 组装回复      │
            │  Heartbeat（整点）→ 触发下面 ↓   │
            └────┬──────────────────────┬────┘
                 │                      │
        ┌────────┴────┐                 │
        │ cron run   │                  │ 委托 / 通信
        │ （链式）     │                  ▼
        ▼            ▼           ┌──────────────┐
   ┌────────┐  ┌────────┐        │ 4 个收件箱    │
   │Schedule│  │Account │        │  shared/     │
   │ Agent  │  │ Agent  │        │  (JSON 文件) │
   └────┬───┘  └────┬───┘        └──────────────┘
        │           │
        │ mockend   │ mockend
        │ 异常推    │ 异常推
        ▼           ▼
   ┌──────────────────────────────────────┐
   │       MySQL: life_butler_db          │
   │                                      │
   │  图模型（4 表）  │  天气（1 表）       │
   │  nodes          │  weather           │
   │  edges          │                    │
   │  node_status    │                    │
   │  edge_status    │                    │
   │                                      │
   │  七维记忆（4 表）                      │
   │  cache_events                       │
   │  seven_dimensions                    │
   │  promote_log                         │
   │  emergency_events                    │
   └──────────────────────────────────────┘
```

**Trip Agent 不在 Heartbeat 链里** — 它的唤醒只有两条路：mockend 异常检测器、Coordinator 委托。

完整架构图（含 cron/事件流）见 [docs/architecture-diagram.html](docs/architecture-diagram.html)。

---

## 5 个 Agent

| Agent | 位置 | 面对用户 | 核心职责 |
|-------|------|---------|---------|
| **Butler（0）** | `~/.openclaw/workspace/` | ✅ 是 | 总指挥，路由 + 复杂决策 |
| **Coordinator** | `coordinator/` | ✅ 是 | 意图识别、组装回复、Heartbeat |
| **Trip Agent** | `agents/trip-agent/` | ❌ 经 Coordinator | 行程规划、动态调整、预算边界 |
| **Schedule Agent** | `agents/schedule-agent/` | ❌ 经 Coordinator | 日程备忘、习惯追踪、遗忘清单 |
| **Account Agent** | `agents/account-agent/` | ❌ 经 Coordinator | 账本管理、预算预警、努力目标 |

详细职责见 [ARCHITECTURE/02-Agent职责.md](ARCHITECTURE/02-Agent职责.md)。

---

## 13 个 Skill

### 各 Agent 专属

| Skill | 位置 | Agent | 用途 |
|-------|------|-------|------|
| `trip-skill` | `agents/trip-agent/skills/trip-skill/` | Trip | 4 阶段行程规划 |
| `replan-skill` | `agents/trip-agent/skills/replan-skill/` | Trip | 坏事件后内部使用，调 monitor |
| `butler-comm-skill` | `coordinator/skills/butler-comm-skill/` | Coordinator | A2A 通信封装 |
| `subagent-skill` | `coordinator/skills/subagent-skill/` | Coordinator | `sessions_spawn` 委托规范 |
| `weather-monitor-skill` | `coordinator/skills/weather-monitor-skill/` | Coordinator | 天气坏事件文案 |
| `queue-monitor-skill` | `coordinator/skills/queue-monitor-skill/` | Coordinator | 排队坏事件文案 |
| `traffic-monitor-skill` | `coordinator/skills/traffic-monitor-skill/` | Coordinator | 交通坏事件文案 |
| `nearby-search-skill` | `coordinator/skills/nearby-search-skill/` | Coordinator | 用户问"附近"独立路径 |

### 共享（注册到全部 4 agent）

| Skill | 位置 | 用途 |
|-------|------|------|
| `memory-layers-skill` | `skills/memory-layers-skill/` | 五层文件记忆读写 |
| `memory-seven-dim-skill` | `skills/memory-seven-dim-skill/` | 七维 MySQL 读写 |

---

## 数据存储

### MySQL（10 张表）

| 分组 | 表 | 说明 |
|------|-----|------|
| **图模型** | `nodes` | POI 节点（attraction/restaurant/hotel/transport_hub，含 queue_count/is_indoor）|
| | `edges` | 边（walk/metro/drive，带 distance_m/duration_min）|
| | `node_status` | 节点动态状态（open/full/closed/limited）|
| | `edge_status` | 边动态状态（open/congested/closed）|
| | `events` | 事件记录（12 类型 + is_good 标记）|
| **天气** | `weather` | 全市天气（sunny/rainy/sandstorm/typhoon）|
| **七维** | `cache_events` | 未验证侧写（路径1写入）|
| | `seven_dimensions` | 已验证画像（路径1/2 写入）|
| | `promote_log` | 晋升日志 |
| | `emergency_events` | 紧急覆盖（路径5 写入）|

### JSON（业务数据，`data/`）

| 文件 | 主写 | 其他读 |
|------|------|--------|
| `trips.json` | Trip Agent | Coordinator / Schedule / Account |
| `accounts.json` | Account Agent | Trip / Schedule / Coordinator |
| `schedule.json` | Schedule Agent | Trip / Account / Coordinator |

**业务数据库管理原则**：写操作一对一（专属 Agent），读操作共享（直接读不走通信）。

---

## 通信协议

**核心**：`shared/<agent>/YYYY-MM-DD.json` + `openclaw cron run`

**为什么不用 sessions_send**：不稳定 + 链式触发麻烦。

### 4 个收件箱

```
shared/
├── coordinator/      ← 任何 agent 可写
├── trip-agent/       ← 任何 agent 可写
├── schedule-agent/   ← 任何 agent 可写
└── account-agent/    ← 任何 agent 可写
```

### 消息类型

- `task_delegate` — 任务委托（Coordinator → 业务 Agent）
- `result_callback` — 任务回复（业务 Agent → Coordinator）
- `info_share` — 信息共享（任意 → 任意）

### 直接读 > 通信

只有"对方要做事"才通信。读数据直接走 JSON 文件或 MySQL。详细矩阵见 [ARCHITECTURE/02-Agent职责.md §5](ARCHITECTURE/02-Agent职责.md)。

---

## Cron 定时任务

### OpenClaw cron（5 个 A2A + 1 个巡检）

| 名称 | enabled | 触发者 | 说明 |
|------|---------|--------|------|
| `butler-coordinator-hourly-sweep` | ✅ true | 整点 | Coordinator 巡检 |
| `butler-coordinator-wake` | ❌ false | 子 agent 跑完 | Coordinator 唤醒 |
| `butler-trip-agent-wake` | ❌ false | coordinator / mockend | Trip 唤醒 |
| `butler-schedule-agent-wake` | ❌ false | coordinator | Schedule 唤醒 |
| `butler-account-agent-wake` | ❌ false | coordinator | Account 唤醒 |
| `butler-self-wake` | ❌ false | 0（主助手） | 备用 |

**注意**：醒型 job 永远 `enabled: false`，只能被 `openclaw cron run <id>` 链式触发。**禁止**用 `cron enable` 改成活的。

### 系统 crontab（4 个脚本）

| 频率 | 脚本 | 用途 |
|------|------|------|
| `*/30 * * * *` | `mock_backend/scripts/event_generator.js` | 生成 12 种事件 |
| `*/10 * * * *` | `mock_backend/scripts/event_detector.js` | 检测坏事件推 trip |
| `0 3 * * *` | `utils/comm-cleanup.py` | 清理 3 天前 shared/（可选）|
| `0 4 * * *` | `utils/seven-dim-promote.py` | 兜底 promote 脚本（可选）|

详细见 [ARCHITECTURE/06-Cron-定时任务.md](ARCHITECTURE/06-Cron-定时任务.md)。

---

## 记忆系统

### 五层（文件，4 个 agent 都用）

| 层级 | 路径 | 触发 |
|------|------|------|
| 瞬时 | `memory/transient.md` | 每次操作后 |
| 日级 | `memory/days/YYYY-MM-DD.md` | 每轮对话结束 |
| 周级 | `memory/weeks/YYYY-Www.md` | 周一汇总 |
| 月级 | `memory/months/YYYY-MM.md` | 月末汇总 |
| 年级 | `memory/years/YYYY.md` | 年末汇总 |

**原则**：原封不动，不加工不摘要。详细见 [ARCHITECTURE/04-记忆系统.md](ARCHITECTURE/04-记忆系统.md)。

### 七维（MySQL，4 个 agent 都用）

| 维度 | 主管 Agent |
|------|-----------|
| 口味偏好 | Trip Agent |
| 消费习惯 | Account Agent |
| 关系网络 | Schedule Agent |
| 时间规律 | Schedule Agent |
| 遗忘清单 | Schedule Agent |
| 认知风格 | Coordinator |
| 健康情况 | Coordinator |

**关键参数**：
- 触发阈值：3 次
- 时间窗口：14 天
- 降级观察期：1 年
- 查询优先级：emergency_events > seven_dimensions > cache_events

**7 条路径**：cache→dimension→promote/demote/emergency/forget/chat_mode。详见 [ARCHITECTURE/04-记忆系统.md §4](ARCHITECTURE/04-记忆系统.md)。

---

## 12 种事件

| type | 事件 | is_good | 目标 |
|------|------|---------|------|
| 1 | weather_sunny | 1 | city |
| 2 | weather_rainy | 0 | city |
| 3 | weather_sandstorm | 0 | city |
| 4 | weather_typhoon | 0 | city |
| 5 | queue_increase | 0 | node |
| 6 | queue_decrease | 1 | node |
| 7 | poi_crowded | 0 | node |
| 8 | restaurant_full | 0 | node |
| 9 | road_closed | 0 | edge |
| 10 | traffic_jam | 0 | edge |
| 11 | metro_delay | 0 | edge |
| 12 | no_op | 0 | — |

**过滤规则**：detector 只推 `is_good=0` 的事件到 trip-agent。trip 收到后判断是否影响路线，影响就调 replan-skill 重算。

---

## 快速开始

### 一键启动（推荐）

```bash
./start.sh
```

流程：装 MySQL Docker → npm install → 装 OpenClaw binary → `openclaw onboard`（向导，阻塞）→ 装载 4 agent → 注册 skill。

`openclaw onboard` 是首次配置向导，请填模型 provider、API key、Gateway 配置。

> ⚠️ `init.sh` 必须在 coordinator 首次对话**之后**跑（cron job 注册需要 wake job 存在）。

```bash
# start.sh 跑完后
openclaw chat coordinator   # 首次对话（自动发 13 道问卷）
bash coordinator/scripts/init.sh   # 注册 cron job
openclaw cron list | grep butler   # 验证
```

### 手动分步

```bash
# 1) 启 MySQL
cp .env.example .env  # 可选，有默认值
docker compose up -d

# 2) 装依赖
npm install

# 3) 装 OpenClaw + 跑向导
npm install -g openclaw@2026.6.1
openclaw onboard

# 4) 装载 4 个 agent
for a in trip-agent account-agent schedule-agent; do
  openclaw agents add $a \
    --workspace agents/$a \
    --agent-dir ~/.openclaw/agents/$a/agent \
    --non-interactive
done
openclaw agents add coordinator \
  --workspace coordinator \
  --agent-dir ~/.openclaw/agents/coordinator/agent \
  --non-interactive

# 5) 注册 skill
for s in agents/trip-agent/skills/*/; do
  openclaw skills install "$s" --agent trip-agent --force
done
for s in coordinator/skills/*/; do
  openclaw skills install "$s" --agent coordinator --force
done
for s in skills/*/; do
  for a in coordinator trip-agent account-agent schedule-agent; do
    openclaw skills install "$s" --agent "$a" --force
  done
done

# 6) 首次对话后注册 cron
bash coordinator/scripts/init.sh
```

### npm 脚本

```bash
npm run gen         # 生成事件
npm run detect      # 检测坏事件
npm run phase2      # POI 筛选
npm run phase3      # 空间优化（Dijkstra + K-Means）
npm run profile     # 查询用户画像
```

---

## 项目结构

```
butler/
├── README.md
├── LICENSE              # MIT
├── CONTRIBUTING.md
├── docker-compose.yml   # MySQL 9 + 自动导入 seed.sql
├── package.json         # mysql2 + 5 个 npm 脚本
├── .env.example
├── .gitignore
│
├── start.sh             # 一键启动（环境 + 4 agent + skill）
│
├── shared/              # 4 个 agent 收件箱
│   └── trip-agent/      #   示例：trip-agent 收件箱
│
├── data/                # 业务数据 JSON
│   ├── trips.json       #   行程（Trip 主写）
│   ├── accounts.json    #   账本（Account 主写）
│   └── schedule.json    #   日程（Schedule 主写）
│
├── mock_backend/
│   ├── index.js         # MySQL 查询模块（query_nodes / shortest_path / get_weather）
│   ├── seed.sql         # 10 张表 DDL + 北京子图 mock 数据
│   └── scripts/
│       ├── event_generator.js   # 12 事件生成（系统 cron 每 30m）
│       └── event_detector.js    # 过滤 is_good=0 推 trip（系统 cron 每 10m）
│
├── skills/              # 共享 skill（注册到全部 4 agent）
│   ├── memory-layers-skill/
│   │   └── SKILL.md     #   五层记忆读写规范
│   └── memory-seven-dim-skill/
│       ├── SKILL.md     #   七维 MySQL 7 路径
│       ├── references/{db_schema.sql, path4_demotion_flow.md}
│       └── scripts/{promote_cache,demote_dimension,query_profile,add_forgotten_item}.js
│
├── agents/
│   ├── trip-agent/
│   │   ├── AGENTS.md
│   │   └── skills/
│   │       ├── trip-skill/         # 4 阶段行程规划
│   │       │   ├── SKILL.md
│   │       │   └── phases/
│   │       │       ├── phase2_poi_filter.js
│   │       │       └── phase3_spatial_optimizer.js
│   │       └── replan-skill/       # 坏事件后调 monitor
│   │           └── SKILL.md
│   ├── account-agent/
│   │   └── AGENTS.md
│   └── schedule-agent/
│       └── AGENTS.md
│
├── coordinator/         # LifeButler 主入口
│   ├── AGENTS.md
│   ├── data/
│   │   └── init_questionnaire.json
│   ├── memory/
│   │   ├── init-readme.md          # 首次使用问卷
│   │   └── gather/                 # 多 Agent 回复聚合
│   ├── scripts/
│   │   ├── init.sh                 # cron job 注册
│   │   └── user-init-questionnaire.html
│   └── skills/         # coordinator 专属（8 个）
│       ├── butler-comm-skill/      #   A2A 通信
│       ├── subagent-skill/         #   sessions_spawn 委托
│       ├── weather-monitor-skill/  #   本地生活：天气
│       ├── queue-monitor-skill/    #   本地生活：排队
│       ├── traffic-monitor-skill/  #   本地生活：交通
│       └── nearby-search-skill/    #   本地生活：附近
│
├── docs/
│   ├── architecture-diagram.html   # 可视化架构图（浏览器打开）
│   └── local-life-skills-design.md # 本地生活 skill 设计稿
│
└── ARCHITECTURE/        # 权威架构文档
    ├── 00-README.md
    ├── 01-系统架构.md
    ├── 02-Agent职责.md
    ├── 03-通信协议.md
    ├── 04-记忆系统.md
    ├── 05-Mock-Backend.md
    ├── 06-Cron-定时任务.md
    ├── 07-主动服务.md
    └── 08-本地生活Skills.md
```

---

## 技术栈

- **运行时**：Node.js ≥18，CommonJS
- **数据库**：MySQL 9.7（Docker）
- **图算法**：自实现 Dijkstra（无外部库）
- **聚类**：自实现 K-Means
- **依赖**：仅 `mysql2` 一个 npm 包
- **Agent框架**：OpenClaw

---

## License

MIT — 详见 [LICENSE](LICENSE)