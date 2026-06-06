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
| weather-monitor-skill | Coordinator | trip replan 回调（weather_change=true） | `skills/weather-monitor-skill/SKILL.md` |
| queue-monitor-skill | Coordinator | trip replan 回调（queue_increase=true） | `skills/queue-monitor-skill/SKILL.md` |
| traffic-monitor-skill | Coordinator | trip replan 回调（traffic_congestion=true） | `skills/traffic-monitor-skill/SKILL.md` |
| nearby-search-skill | Coordinator | 用户主动问"附近有啥" | `skills/nearby-search-skill/SKILL.md` |

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

## 九、文件清单

```
skills/
├── weather-monitor-skill/SKILL.md
├── queue-monitor-skill/SKILL.md
├── traffic-monitor-skill/SKILL.md
├── nearby-search-skill/SKILL.md
├── replan-skill/                      (现有, trip-agent 内部)
└── ...
mock_backend/
├── index.js                            (+ get_weather, + queue_count/is_indoor)
├── seed.sql                            (+ weather 表, + is_indoor/queue_count, + events.is_good)
└── scripts/
    ├── event_generator.js              (替代 anomaly_generator.js)
    └── event_detector.js               (替代 anomaly_detector.js)
docs/
└── local-life-skills-design.md         (设计稿)
```
