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
| 🎲 **异常模拟** | generator/detector 实时模拟路况、客流等异常，自动 replan |

---

## 🏗️ 架构

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Coordinator │────→│  Trip Agent  │←────│ Mock Detector│
│  (用户入口)  │     │  (行程规划)   │     │  (异常检测)   │
└──────┬──────┘     └──────┬───────┘     └──────┬───────┘
       │                   │                     │
       ↓                   ↓                     ↓
┌──────────────┐   ┌──────────────┐     ┌──────────────┐
│ Account Agent│   │Schedule Agent│     │ Mock Generator│
│  (财务感知)   │   │  (日程管理)  │     │  (异常产生)   │
└──────────────┘   └──────────────┘     └──────────────┘
       │                   │                     │
       └───────────────────┴─────────────────────┘
                           │
                    ┌──────┴──────┐
                    │   MySQL 9   │
                    │life_butler_db│
                    │  (9 张表)    │
                    └─────────────┘
```

---

## 🚀 快速开始

### 1. 启动数据库

```bash
cp .env.example .env
docker compose up -d
```

### 2. 导入数据

```bash
# 数据库初始化后自动导入 seed.sql + db_schema.sql
# 手动验证：
docker exec butler-mysql mysql -uroot -p${MYSQL_ROOT_PASSWORD} -h 127.0.0.1 \
  --default-character-set=utf8mb4 life_butler_db -e "SHOW TABLES;"
# 预期输出：9 张表（nodes, edges, node_status, edge_status, events, cache_events, seven_dimensions, promote_log, emergency_events）
```

### 3. 配置定时任务（Coordinator 初始化）

```bash
# 在 OpenClaw 环境中运行，注册所有 cron job
bash coordinator/scripts/init.sh
```

创建：5 个 Agent 通信唤醒 + 1 个整点巡检 + 2 个系统 crontab（generator/detector）

### 4. 安装依赖 + 测试

```bash
npm install

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

## 🗄️ 数据库（9 张表）

| 来源 | 表名 | 说明 | 初始行 |
|------|------|------|--------|
| mockend | `nodes` | 图节点（景点/餐厅/酒店/交通枢纽） | 52 |
| mockend | `edges` | 图边（步行/地铁/驾车） | 80 |
| mockend | `node_status` | 节点动态状态（open/limited/closed/full） | 52 |
| mockend | `edge_status` | 边动态状态（open/congested/closed） | 80 |
| mockend | `events` | 异常事件记录 | 0 |
| 七维 | `cache_events` | 未验证侧写（第一层） | 0 |
| 七维 | `seven_dimensions` | 已验证画像（第二层） | 0 |
| 七维 | `promote_log` | 晋升日志 | 0 |
| 七维 | `emergency_events` | 紧急覆盖（临时最高优先级） | 0 |

---

## 📦 脚本清单（9 个 JS 文件）

| 文件 | 功能 | CLI 用法 |
|------|------|---------|
| `mock_backend/index.js` | MySQL 查询模块（query_nodes / shortest_path / Dijkstra） | 被 import |
| `mock_backend/scripts/anomaly_generator.js` | 随机 UPDATE node/edge 状态 + INSERT events | `node mock_backend/scripts/anomaly_generator.js` |
| `mock_backend/scripts/anomaly_detector.js` | 扫 MySQL → diff last_known.json → 推 trip-agent | `node mock_backend/scripts/anomaly_detector.js` |
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
│   ├── index.js              # MySQL 查询模块（CommonJS）
│   ├── seed.sql              # 5 张表 + 北京子图 mock 数据
│   └── scripts/
│       ├── anomaly_generator.js
│       ├── anomaly_detector.js
│       └── README.md
├── skills/
│   ├── trip-skill/
│   │   ├── SKILL.md          # 四阶段行程规划
│   │   └── phases/
│   │       ├── phase2_poi_filter.js
│   │       └── phase3_spatial_optimizer.js
│   ├── memory-seven-dim-skill/
│   │   ├── SKILL.md          # 七维记忆规范
│   │   ├── references/
│   │   │   ├── db_schema.sql # 4 张表
│   │   │   └── path4_demotion_flow.md
│   │   └── scripts/
│   │       ├── promote_cache.js
│   │       ├── demote_dimension.js
│   │       ├── query_profile.js
│   │       └── add_forgotten_item.js
│   ├── butler-comm-skill/
│   ├── memory-layers-skill/
│   └── subagent-skill/
├── agents/
│   ├── trip-agent/AGENTS.md
│   ├── account-agent/AGENTS.md
│   ├── schedule-agent/AGENTS.md
│   └── coordinator/AGENTS.md
└── ARCHITECTURE/
    ├── 00-README.md
    ├── 01-系统架构.md
    ├── 02-Agent职责.md
    ├── 03-通信协议.md
    ├── 04-记忆系统.md
    ├── 05-Mock-Backend.md
    ├── 06-Cron-定时任务.md
    └── 07-主动服务.md
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
