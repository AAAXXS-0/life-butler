# 本地生活 Skills 架构

> 版本：v1
> 更新日期：2026-06-06
> 依据：`docs/local-life-skills-design.md`

---

## 一、目标

补比赛要求「本地生活相关 skill」缺口。同时把 mockend 从"异常模拟"重构为"事件模拟"，支持好事/坏事区分。

---

## 二、4 个 Skill

| Skill | 主管 | 触发 | 文件 |
|-------|------|------|------|
| weather-monitor-skill | Coordinator | trip replan 回调（weather_change=true） | `coordinator/skills/weather-monitor-skill/SKILL.md` |
| queue-monitor-skill | Coordinator | trip replan 回调（queue_increase=true） | `coordinator/skills/queue-monitor-skill/SKILL.md` |
| traffic-monitor-skill | Coordinator | trip replan 回调（traffic_congestion=true） | `coordinator/skills/traffic-monitor-skill/SKILL.md` |
| nearby-search-skill | Coordinator | 用户主动问"附近有啥" | `coordinator/skills/nearby-search-skill/SKILL.md` |
| taxi-skill | Coordinator | 用户主动叫车（不在 trip 框架内） | `coordinator/skills/taxi-skill/SKILL.md` |
| replan-skill | trip-agent | mockend 坏事件触发后内部使用 | `agents/trip-agent/skills/replan-skill/SKILL.md` |

---

## 三、统一逻辑（weather/queue/traffic）

3 个 skill 逻辑一样：

```
1. event_generator.js 产生事件（30m/次）
2. event_detector.js 检测到坏事（10m/次）
3. → 推 trip-agent 收信箱 + cron run 唤醒
4. trip-agent → 调 replan-skill → 把备选行程+坏事 推 coordinator
5. coordinator 调对应 skill（weather/queue/traffic）
   → 拼提示文案 → 写 coordinator inbox → 通知用户
6. 用户回是 → coordinator 回调 trip 改行程
7. 用户回否 → coordinator 回调 trip 保持
```

> 3 个 skill 区别只在「触发条件 + 提示文案」，**不**重复造轮子。

---

## 四、nearby-search（独立）

不走 trip 回调，由 Coordinator 主动触发：

```
用户："附近有啥吃的"
   ↓
读 trips.json → 当前位置 lat/lng（**不主动问**）
   ↓
MockBackend.query_nodes({ type, city, near, radius_km: 5 })
   ↓
加权排序（距离30% + 评分30% + 开放20% + 偏好20%）
   ↓
推荐 top 3
```

---

## 五、事件类型（mockend 扩展）

| type | code | 概率 | is_good | 目标 |
|------|------|------|---------|------|
| 1 | weather_sunny | 8% | **1** | city (weather 表) |
| 2 | weather_rainy | 10% | 0 | city |
| 3 | weather_sandstorm | 4% | 0 | city |
| 4 | weather_typhoon | 2% | 0 | city |
| 5 | queue_increase | 8% | 0 | node (queue_count +10) |
| 6 | queue_decrease | 8% | **1** | node (queue_count -10) |
| 7 | poi_crowded | 12% | 0 | node (status=limited) |
| 8 | restaurant_full | 12% | 0 | node (status=full) |
| 9 | road_closed | 10% | 0 | edge (status=closed) |
| 10 | traffic_jam | 15% | 0 | edge (status=congested) |
| 11 | metro_delay | 8% | 0 | edge (status=congested) |
| 12 | no_op | 3% | 0 | - |

**好坏判定规则**（老板定版）：
- 天气变晴 = 好（不报）
- 排队 +N = 坏（报）
- 排队 -N = **好**（不报）
- 其他都坏

**实现**：`events.is_good` 字段标记，detector 过滤 `is_good=0`。

---

## 六、数据流

```
[系统 crontab 每 30m] event_generator.js
  ↓ 改 MySQL nodes/edges/weather 表 + INSERT events (is_good 标记)
  
[系统 crontab 每 10m] event_detector.js
  ↓ 拉 events 表最近 40 分钟新事件
  ↓ 过滤 is_good=0
  ↓ → 写 shared/trip-agent/YYYY-MM-DD.json + cron run 唤醒 trip-agent
  
[trip-agent 唤醒]
  ↓ 读 inbox
  ↓ 调 replan-skill
  ↓ 把备选行程 + 坏事 推 coordinator
  ↓ 调 weather/queue/traffic skill 拼提示文案
  
[coordinator 唤醒]
  ↓ 读 inbox
  ↓ 通知用户 + 询问
  ↓ 用户回是/否 → 回调 trip 改/不改行程
```

---

## 七、mockend 改动

### 7.1 nodes 表加字段

```sql
ALTER TABLE nodes ADD COLUMN queue_count INT NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN is_indoor TINYINT(1) NOT NULL DEFAULT 0;
```

### 7.2 新增 weather 表

```sql
CREATE TABLE weather (
  city VARCHAR(32) PRIMARY KEY,
  status ENUM('sunny','rainy','sandstorm','typhoon') NOT NULL,
  temperature INT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 7.3 events 表加 is_good + city 枚举

```sql
ALTER TABLE events ADD COLUMN is_good TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE events MODIFY target_type ENUM('node','edge','city') NOT NULL;
```

### 7.4 index.js 暴露

- `query_nodes` 返回 `queue_count` / `is_indoor`
- 新增 `get_weather(city)`

### 7.5 脚本改名

- `anomaly_generator.js` → `event_generator.js`（12 事件，含好/坏）
- `anomaly_detector.js` → `event_detector.js`（按 is_good 过滤）

---

## 八、与 replan-skill 的关系

`replan-skill` 是 trip-agent 内部使用的 skill，触发本 4 个 skill 中的一个或多个。
本 4 个 skill **不**直接对接 trip-agent，而是经 Coordinator 中转。

---

## 八点五、打车双场景设计（trip 内 + 独立叫车）

打车功能分为**两个独立场景**实现，避免一个 skill 同时管 trip 规划和独立叫车两种需求。

### 场景 A：trip 内的 taxi 接驳

- **执行者**：Trip Agent（`trip-skill` 阶段三）
- **实现方式**：`edges.type` 加 `'taxi'` 选项，taxi_stand 节点提供打车点
- **使用场景**：景点 → 酒店、深夜/坏天气下不坐地铁、跨区接驳
- **不调 skill**：trip-skill 阶段三的 Dijkstra 直接把 taxi edge 纳入候选池

### 场景 B：独立的叫车请求

- **执行者**：Coordinator（`taxi-skill`）
- **实现方式**：`coordinator/skills/taxi-skill/`，独立 skill
- **使用场景**：用户说"下班了帮我叫车回家"、"打个车去机场"（不在 trip 框架内）
- **数据源**：`trips.json.current_location`（不问位置）→ `MockBackend.query_nodes({ type: 'taxi_stand', near, radius_km: 2 })`

### 关键设计原则

| 原则 | 说明 |
|------|------|
| **不重复造轮子** | trip 内和独立叫车**共享** taxi_stand 节点 + taxi 边数据 |
| **不混用 skill** | trip 内接驳不调 `taxi-skill`，独立叫车不走 `trip-skill` |
| **数据流独立** | trip 内的 taxi 路径由 phase3 算好；独立叫车由 taxi-skill 实时查 |
| **不调真 API** | 全部走 mockend，高德/滴滴接口预留（未实现） |

### ETA 计算（场景 B）

**关键区分**：等车时间 ≠ 距离

| 组成 | 来源 | 是否距离函数 |
|------|------|-----------|
| dispatch_min | 平台分配 | ❌ 常量 1 min |
| wait_min | `taxi_stand.props.avg_wait_min` | ❌ 跟时段/地点/queue_count 有关 |
| drive_min | `haversine(stand, user) × 2.5min/km` | ✅ 距离函数 |

接口：`MockBackend.estimate_taxi_eta(stand_id, user_lat, user_lng)`

计价（北京）：起步 13 元 (3km) + 2.3 元/km

### 状态机 + 延迟通知（场景 B）

**7 个状态**：`called` → `dispatched` → `arriving` → `arrived` → `onboard` / `cancelled` / `completed`

**状态文件**：`coordinator/data/taxi_state.json`（运行时数据，可加 gitignore）

**延迟通知机制**：OpenClaw `at` cron

派车时动态注册 4 个 `at` cron（到点自动跑一次，跑完自动删）：

```bash
# 派车时（T+0）
T_DISPATCH=$(( $(date +%s) + 60 ))              # +1 min
T_ARRIVING=$(( $(date +%s) + (ETA-1)*60 ))      # ETA-1
T_ARRIVED=$(( $(date +%s) + ETA*60 ))           # ETA
T_TIMEOUT=$(( $(date +%s) + (ETA+5)*60 ))       # ETA+5

openclaw cron add --name "taxi-${CALL_ID}-dispatch" \
  --agent coordinator \
  --schedule kind=at,at=$(date -d @$T_DISPATCH -Iseconds) \
  --message "推进 callId=$CALL_ID 到 dispatched" \
  --delete-after-run
# ... 其他 3 个类似
```

**为什么不加到 events 表**：taxi 叫车是有状态机的工作流（called→dispatched→...），不是随机的环境变化。状态机数据有 `state` + `history`，跟 events 表的"一条 = 一次环境变更"语义不同。

详见 `coordinator/skills/taxi-skill/SKILL.md`。

---

## 九、文件清单

```
agents/
├── trip-agent/
│   └── skills/
│       ├── trip-skill/             # 行程规划四阶段
│       │   ├── SKILL.md
│       │   └── phases/phase2_poi_filter.js, phase3_spatial_optimizer.js
│       └── replan-skill/           # 坏事件后调 monitor
│           └── SKILL.md
├── coordinator/
│   └── skills/
│       ├── butler-comm-skill/      # A2A 通信
│       ├── subagent-skill/         # 委托封装
│       ├── weather-monitor-skill/  # 本地生活：天气
│       ├── queue-monitor-skill/    # 本地生活：排队
│       ├── traffic-monitor-skill/  # 本地生活：交通
│       ├── nearby-search-skill/    # 本地生活：附近
│       └── taxi-skill/             # 本地生活：打车（独立叫车）
skills/                            # 共享 skill
├── memory-layers-skill/
└── memory-seven-dim-skill/
mock_backend/
├── index.js                            (+ get_weather, + queue_count/is_indoor, + taxi edge 支持)
├── seed.sql                            (+ weather 表, + is_indoor/queue_count, + events.is_good, + taxi_stand 节点 + taxi 边)
└── scripts/
    ├── event_generator.js              (替代 anomaly_generator.js)
    └── event_detector.js               (替代 anomaly_detector.js)
docs/
└── local-life-skills-design.md         (设计稿)
```
