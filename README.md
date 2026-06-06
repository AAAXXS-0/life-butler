# LifeButler — 智能生活管家

> 多 Agent 协作 + 图路径规划 + 七维记忆系统的行程规划引擎

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![MySQL](https://img.shields.io/badge/mysql-9.7-blue)](https://www.mysql.com)
[![Docker](https://img.shields.io/badge/docker-compose-blue)](https://docs.docker.com/compose/)

---

## ✨ 核心亮点

| 模块 | 说明 |
|------|------|
| 🗺️ **行程规划** | 图模型（K-Means + Dijkstra）POI 筛选、最短路径优化、备选路线 |
| 🧠 **七维记忆** | cache → promote → demote → emergency 四层覆盖，长期学习用户偏好 |
| 🎲 **事件模拟** | event_generator/detector 模拟天气/排队/路况变化，好事过滤、坏事自动 replan |
| 📍 **本地生活** | 4 skill：weather-monitor / queue-monitor / traffic-monitor / nearby-search |

---

## 🏗️ 架构

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Coordinator │────→│  Trip Agent  │←────│ Event Detector│
│  (用户入口)  │     │  (行程规划)   │     │  (坏事检测)   │
└──────┬──────┘     └──────┬───────┘     └──────┬───────┘
       │                   │                     │
       │   ┌───────────────┴───────────────┐     │
       │   │ weather/queue/traffic monitor │     │
       │   │       (本地生活 skills)        │     │
       │   └───────────────┬───────────────┘     │
       ↓                   ↓                     ↓
┌──────────────┐   ┌──────────────┐     ┌──────────────┐
│ Account Agent│   │Schedule Agent│     │ Event Generator│
│  (财务感知)   │   │  (日程管理)  │     │  (事件产生)   │
└──────────────┘   └──────────────┘     └──────────────┘
       │                   │                     │
       └───────────────────┴─────────────────────┘
                           │
                    ┌──────┴──────┐
                    │   MySQL 9   │
                    │life_butler_db│
                    │  (10 张表)   │
                    └─────────────┘
```

---

## 🚀 快速开始

### 0. 一键启动（推荐）

```bash
./start.sh        # 装环境：docker → npm → openclaw → 4 agent + skill
```

按提示：
- Docker / Node / OpenClaw 自动检查
- 4 个 agent 装载：`trip-agent` / `account-agent` / `schedule-agent` / `coordinator`
- extra skill 自动注册到对应 agent
- 最后打印 coordinator 首次对话流程

**与 init.sh 的区别**：
- `start.sh` = 装环境（Docker / npm / OpenClaw / agent / skill）
- `init.sh`  = 启服务（OpenClaw cron job 注册）

> ⚠️  `init.sh` 不能在 coordinator 首次对话之前跑——cron job 提前跑没意义。
> 顺序：start.sh → 启动 OpenClaw → 跟 coordinator 聊第一次 → `init.sh`

### 1. 手动分步（不用 start.sh）

```bash
# 1) 启 MySQL
cp .env.example .env
docker compose up -d

# 2) 验证 10 张表
docker exec butler-mysql mysql -uroot -p*** -h 127.0.0.1 \
  --default-character-set=utf8mb4 life_butler_db -e "SHOW TABLES;"

# 3) 装依赖
npm install

# 4) 装 OpenClaw
npm install -g openclaw@2026.6.1

# 5) 装载 4 agent
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

# 6) 注册 extra skill
for s in agents/trip-agent/skills/*/; do
  openclaw skills install "$s" --agent trip-agent --force
done
for s in coordinator/skills/*/; do
  openclaw skills install "$s" --agent coordinator --force
done
```

### 2. 首次对话与 cron 注册

```bash
# 启动 OpenClaw
openclaw gateway start
# 或 openclaw tui

# 跟 coordinator 聊第一次（会自动发 13 道问卷）
openclaw chat coordinator

# 首次对话后再跑 init.sh 注册 cron job
bash coordinator/scripts/init.sh

# 验证
openclaw cron list | grep butler
```

# POI 筛选（Phase 2）
MYSQL_PORT=3308 MYSQL_PASSWORD=1 npm run phase2

# 空间优化（Phase 3）
MYSQL_PORT=3308 MYSQL_PASSWORD=1 npm run phase3

# 生成异常
MYSQL_PORT=3308 MYSQL_PASSWORD=1 npm run gen

# 检测异常
MYSQL_PORT=3308 MYSQL_PASSWORD=1 npm run detect

# 查询用户画像
MYSQL_PORT=3308 MYSQL_PASSWORD=1 npm run profile
```

---

## 🗄️ 数据库（10 张表）

| 来源 | 表名 | 说明 | 初始行 |
|------|------|------|--------|
| mockend | `nodes` | 图节点（景点/餐厅/酒店/交通枢纽，含 queue_count/is_indoor）| 52 |
| mockend | `edges` | 图边（步行/地铁/驾车）| 80 |
| mockend | `node_status` | 节点动态状态（open/limited/closed/full）| 52 |
| mockend | `edge_status` | 边动态状态（open/congested/closed）| 80 |
| mockend | `events` | 事件记录（12 类型 + is_good 好/坏标记）| 0 |
| mockend | `weather` | 全市天气（sunny/rainy/sandstorm/typhoon）| 1 |
| 七维 | `cache_events` | 未验证侧写（第一层）| 0 |
| 七维 | `seven_dimensions` | 已验证画像（第二层）| 0 |
| 七维 | `promote_log` | 晋升日志 | 0 |
| 七维 | `emergency_events` | 紧急覆盖（临时最高优先级）| 0 |

---

## 📦 脚本清单（9 个 JS 文件）

| 文件 | 功能 | CLI 用法 |
|------|------|---------|
| `mock_backend/index.js` | MySQL 查询模块（query_nodes / shortest_path / get_weather / Dijkstra）| 被 import |
| `mock_backend/scripts/event_generator.js` | 12 事件：改 nodes/edges/weather 表 + INSERT events（is_good 标记）| `node mock_backend/scripts/event_generator.js` |
| `mock_backend/scripts/event_detector.js` | 读 events 表 → 过滤 is_good=0 → 推 trip-agent | `node mock_backend/scripts/event_detector.js` |
| `skills/trip-skill/phases/phase2_poi_filter.js` | POI 筛选（query_nodes + rating 排序 + 备选） | `node … phase2 北京 '{"poi_types":["历史遗迹"]}'` |
| `skills/trip-skill/phases/phase3_spatial_optimizer.js` | K-Means 聚类 + Dijkstra 路径 + budget 处理 | `node … phase3 <phase2.json> 3 10 <budget>` |
| `skills/memory-seven-dim-skill/scripts/promote_cache.js` | cache → dimension 晋升（14 天内 weight≥3） | `node … promote_cache.js` |
| `skills/memory-seven-dim-skill/scripts/demote_dimension.js` | dimension → cache 降级（矛盾覆盖） | `node … demote_dimension.js <dim> <sub_key> <冲突>` |
| `skills/memory-seven-dim-skill/scripts/query_profile.js` | 三级查询画像（emergency > dim > cache） | `node … query_profile.js [dimension]` |
| `skills/memory-seven-dim-skill/scripts/add_forgotten_item.js` | 遗忘清单直写 seven_dimensions | `node … add_forgotten_item.js "事项" "证据"` |

---

## 📁 项目结构

```
butler/
├── README.md
├── docker-compose.yml        # MySQL 9 + 双 SQL 自动导入
├── package.json              # mysql2 依赖 + npm scripts
├── .env.example              # 环境变量模板
├── .gitignore
├── mock_backend/
│   ├── index.js              # MySQL 查询模块（CommonJS, + get_weather）
│   ├── seed.sql              # 6 张表 + 北京子图 mock 数据
│   ├── package.json
│   └── scripts/
│       ├── event_generator.js     # 事件发生器（12 事件, 好/坏）
│       ├── event_detector.js      # 坏事检测器（过滤 is_good=0）
│       └── README.md
├── skills/                              # 共享 skill（所有 4 个 agent 都用）
│   ├── memory-layers-skill/SKILL.md
│   └── memory-seven-dim-skill/
│       ├── SKILL.md
│       ├── references/
│       │   ├── db_schema.sql
│       │   └── path4_demotion_flow.md
│       └── scripts/{promote_cache,demote_dimension,query_profile,add_forgotten_item}.js
├── agents/
│   ├── trip-agent/AGENTS.md
│   │   └── skills/                      # trip-agent 拥有
│   │       ├── trip-skill/             # 四阶段行程规划
│   │       │   ├── SKILL.md
│   │       │   └── phases/phase2_poi_filter.js, phase3_spatial_optimizer.js
│   │       └── replan-skill/           # 坏事件后调 monitor
│   │           └── SKILL.md
│   ├── account-agent/AGENTS.md
│   ├── schedule-agent/AGENTS.md
│   └── coordinator/                     # = butler 主代理
│       ├── AGENTS.md
│       ├── memory/init-readme.md
│       ├── scripts/{init.sh, user-init-questionnaire.html}
│       └── skills/                      # coordinator 拥有
│           ├── butler-comm-skill/       # A2A 通信
│           ├── subagent-skill/          # 委托高级封装
│           ├── weather-monitor-skill/   # 本地生活：天气
│           ├── queue-monitor-skill/     # 本地生活：排队
│           ├── traffic-monitor-skill/   # 本地生活：交通
│           └── nearby-search-skill/     # 本地生活：附近
└── ARCHITECTURE/
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

## 🔧 技术栈

- **运行时**：Node.js ≥18，CommonJS
- **数据库**：MySQL 9.7（Docker）
- **图算法**：自实现 Dijkstra（无外部库依赖）
- **聚类**：自实现 K-Means
- **依赖**：仅 `mysql2` 一个 npm 包

---

## 📄 License

MIT
