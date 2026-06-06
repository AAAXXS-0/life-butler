# LifeButler — 智能生活管家

> 多 Agent 协作 + 图路径规划 + 七维记忆系统的行程规划引擎

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![MySQL](https://img.shields.io/badge/mysql-9.7-blue)](https://www.mysql.com)
[![Docker](https://img.shields.io/badge/docker--compose-blue)](https://docs.docker.com/compose/)

---

## 核心亮点

| 模块 | 说明 |
|------|------|
| **行程规划** | 图模型（K-Means + Dijkstra）POI 筛选、最短路径优化、备选路线 |
| **七维记忆** | cache → promote → demote → emergency 四层覆盖，长期学习用户偏好 |
| **事件模拟** | 天气/排队/路况变化自动生成，好事过滤、坏事触发 replan |
| **本地生活** |4 个 monitor skill：天气/排队/交通/附近搜索 |

---

## 架构

```
                       ┌─────────────────────────────┐
                        │ 用户（飞书）         │
                        └──────────────┬──────────────┘
                                       │ 消息
                                       ▼
                        ┌──────────────────────────────┐
                        │      Coordinator（主入口）      │
                        │  意图识别 → 路由 → 组装回复      │
                        └──┬───────┬────────┬───────────┘
                           │cron │cron    │cron
                           │run │run     │run
          ┌────────────────┴─┐  ┌─┴────┐  ┌┴────────┐
          │    Trip Agent    │  │Schedule│  │ Account │
          │   （行程规划）    │  │ Agent │  │  Agent   │
          └────────┬────────┘  └────┬─┘  └────┬────┘
                    │                │          │
         ┌─────────┴────────────────┴──────────┴──┐
          │              Mock Backend（MySQL）          │
          │   nodes / edges / node_status / edge_status │
          │   events / weather / cache_events         │
          │   seven_dimensions / promote_log         │
          │   emergency_events                      │
          └────────────────────────────────────────┘
```

**通信方式**：Coordinator 与各 Agent 通过 `shared/` 文件 + `openclaw cron run` 异步通信，不用 sessions_send。

**本地生活 monitor**：Coordinator 收到 Trip Agent replan 回调后，调 weather/queue/traffic/nearby-monitor skill 拼提示文案。

---

## 快速开始

### 0. 一键启动（推荐）

```bash
./start.sh
```

流程：Docker（MySQL） → npm install → OpenClaw 安装 +初始化向导 → 装载 4 个 agent → 注册 skill。

> `start.sh` 跑完后会自动启动 `openclaw onboard` 向导（阻塞），请在 TUI 中填入模型 provider、API key、Gateway 配置。
>
> `init.sh` 在 coordinator 首次对话**之后**才能跑，用于注册 cron job。

手动流程：

```bash
./start.sh        #装环境
openclaw onboard  # 初始化配置（start.sh 已自动调用，可跳过）
openclaw chat coordinator  # 首次对话（填问卷）
bash coordinator/scripts/init.sh  # 注册 cron job
```

### 1. 手动分步

```bash
# 1) 启 MySQL
cp .env.example .env     # 可跳过，docker-compose 有默认值
docker compose up -d

# 2) 验证表
docker exec butler-mysql mysql -uroot -p1 -h127.0.0.1 \
  --default-character-set=utf8mb4 life_butler_db -e "SHOW TABLES;"

# 3) 装依赖
npm install

# 4)装 OpenClaw + 初始化向导
npm install -g openclaw@2026.6.1
openclaw onboard        # 选 provider /填 API key / 配 Gateway

# 5) 装载 4 个 agent
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

# 6) 注册 skill
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

# 7) 首次对话后再注册 cron job
bash coordinator/scripts/init.sh
```

---

## 数据库（10 张表）

| 来源 | 表名 | 说明 |
|------|------|------|
| mockend | `nodes` | 图节点（景点/餐厅/酒店/交通枢纽）|
| mockend | `edges` | 图边（步行/地铁/驾车）|
| mockend | `node_status` | 节点动态状态（open/limited/closed/full）|
| mockend | `edge_status` | 边动态状态（open/congested/closed）|
| mockend | `events` | 事件记录（12 类型 + is_good 标记）|
| mockend | `weather` | 全市天气（sunny/rainy/sandstorm/typhoon）|
| 七维 | `cache_events` | 未验证侧写（第一层）|
| 七维 | `seven_dimensions` | 已验证画像（第二层）|
| 七维 | `promote_log` | 晋升日志 |
| 七维 | `emergency_events` | 紧急覆盖（临时最高优先级）|

---

##脚本清单

| 脚本 | 功能 | 用法 |
|------|------|------|
| `mock_backend/index.js` | MySQL 查询模块（被 import）| — |
| `mock_backend/scripts/event_generator.js` | 生成异常事件（改 DB +写 events 表）| `npm run gen` |
| `mock_backend/scripts/event_detector.js` | 过滤 is_good=0 → 推给 Trip Agent | `npm run detect` |
| `agents/trip-agent/skills/trip-skill/phases/phase2_poi_filter.js` | POI 筛选 + 备选路线 | `npm run phase2` |
| `agents/trip-agent/skills/trip-skill/phases/phase3_spatial_optimizer.js` | K-Means 聚类 + Dijkstra 路径 | `npm run phase3` |
| `skills/memory-seven-dim-skill/scripts/promote_cache.js` | cache → dimension 晋升 | `npm run promote` |
| `skills/memory-seven-dim-skill/scripts/query_profile.js` | 三级查询画像 | `npm run profile` |

---

## 项目结构

```
butler/
├── README.md
├── LICENSE # MIT
├── CONTRIBUTING.md
├── docker-compose.yml   # MySQL 9 + 自动导 SQL
├── package.json
├── .env.example
├── .gitignore
│
├── start.sh # 一键启动脚本
│
├── shared/              # Agent 间消息通道（shared/<agent>/）
│   └── trip-agent/      #   trip-agent 收件箱（每日 JSON）
│
├── mock_backend/
│   ├── index.js         # MySQL 查询模块
│   ├── seed.sql         # 6 张表 + 北京子图 mock 数据
│   ├── package.json
│   └── scripts/
│       ├── event_generator.js
│       ├── event_detector.js
│       └── README.md
│
├── skills/              # 共享 skill（注册到全部 4 个 agent）
│   ├── memory-layers-skill/
│   │   └── SKILL.md
│   └── memory-seven-dim-skill/
│       ├── SKILL.md
│       ├── references/
│       │   ├── db_schema.sql
│       │   └── path4_demotion_flow.md
│       └── scripts/
│           ├── promote_cache.js
│           ├── demote_dimension.js
│           ├── query_profile.js
│           └── add_forgotten_item.js
│
├── agents/
│   ├── trip-agent/
│   │   ├── AGENTS.md
│   │   └── skills/
│   │       ├── trip-skill/ # 四阶段行程规划
│   │       │   ├── SKILL.md
│   │       │   └── phases/
│   │       │       ├── phase2_poi_filter.js
│   │       │       └── phase3_spatial_optimizer.js
│   │       └── replan-skill/         # 坏事件后调 monitor
│   │           └── SKILL.md
│   │
│   ├── account-agent/
│   │   └── AGENTS.md
│   │
│   └── schedule-agent/
│       └── AGENTS.md
│
├── coordinator/ # LifeButler 主入口
│   ├── AGENTS.md
│   ├── memory/
│   │   └── init-readme.md
│   ├── scripts/
│   │   ├── init.sh # cron job 注册
│   │   └── user-init-questionnaire.html
│   ├── data/
│   └── skills/ # coordinator 专属 skill
│       ├── butler-comm-skill/      # A2A 异步通信
│       ├── subagent-skill/         #委托高级封装
│       ├── weather-monitor-skill/  # 本地生活：天气
│       ├── queue-monitor-skill/    # 本地生活：排队
│       ├── traffic-monitor-skill/  # 本地生活：交通
│       └── nearby-search-skill/    # 本地生活：附近
│
├── docs/
│   └── local-life-skills-design.md
│
└── ARCHITECTURE/ # 权威架构文档
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

MIT