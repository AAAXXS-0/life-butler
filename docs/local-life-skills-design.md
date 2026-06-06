# 本地生活 Skills + Mockend 扩展（草稿 v0.2）

> 日期：2026-06-06
> 状态：设计稿，老板拍板 → 开始落地
> 适用范围：比赛项目本地生活相关 skill 缺口 + mockend 重构

---

## 一、比赛硬要求

需要至少 **2 个本地生活相关 skill**。老板提议做 4 个（含交通 + 附近搜索）。

---

## 二、4 个新 Skill（Coordinator 主管）

### 统一逻辑（weather / queue / traffic 三选一）

3 个 skill **逻辑一样**，为填比赛要求分开写。每个 skill 触发后走同一流程：

```
1. event_generator.js 产生事件
2. event_detector.js 检测到坏事
3. → 推 trip-agent 收信箱 + cron run 唤醒
4. trip-agent 发现影响行程 → 调 replan-skill → 将备选行程 + 坏事发送给 coordinator
5. coordinator 调对应 skill（weather/queue/traffic）→ 汇报用户 + 询问是否更换
6. 用户回是 → coordinator 回调 trip 更改行程
7. 用户回否 → coordinator 回调 trip 保持原行程
```

> 复用现有 `replan-skill`，3 个新 skill 不重复造轮子。

**3 个 skill 的区别只在「触发条件」和「提示文案」**：

### 1. `weather-monitor-skill`（天气活动抓取）

**触发**：trip-agent 回调中 `weather_change=true`

**数据**：`mock_backend/weather` 表（全市单条记录）

**动作**：
- 读 `weather` 表当前状态
- 若 status ∈ {雨, 沙尘暴, 台风} 且 trip 有室外 POI → 标 `weather_affected: true`
- 提示文案："天气变了（现为 <天气>），该行程有 X 个室外 POI，备选行程已生成"

---

### 2. `queue-monitor-skill`（餐厅排队监控）

**触发**：trip-agent 回调中 `queue_increase=true`

**数据**：`nodes.queue_count`

**动作**：
- 读相关餐厅的 queue_count
- 若 > 50 → 标 `queue_heavy: true`
- 提示文案："<餐厅名> 现在排队 <N> 人，备选已切到 <备选餐厅>"

---

### 3. `traffic-monitor-skill`（交通检查）

**触发**：trip-agent 回调中 `traffic_congestion=true`

**数据**：`edge_status.status = 'congested'` 的边

**动作**：
- 读 trip 主路线涉及的边
- 若 ≥ 2 条边 congestion → 标 `traffic_heavy: true`
- 提示文案："主路线 X 段拥堵，已切到备选 Y 段"

---

### 4. `nearby-search-skill`（附近搜索）

**触发**：用户"附近有啥吃的"/"这附近有啥好玩的"

**位置获取**：**不主动问** → 直接查 `trips.json` → 取用户当前所在城市的当前 POI 坐标作为搜索中心

**数据**：
- `trips.json` 当前行程当前位置
- `mock_backend.query_nodes({ type, city, near, radius_km })`
- `accounts.json`（消费习惯 / 预算）
- `schedule.json`（是否影响后续日程）
- 七维画像（taste / effort_goal）

**动作**：
1. 从 trip.json 拿当前位置 lat/lng
2. 按距离 + 评分 + 开放状态筛选 POI
3. 结合预算/时间/画像做加权排序
4. 推荐 top 3 给用户

**输出**：推荐列表（带原因说明）

---

## 三、Mockend 扩展

### 3.1 nodes 表加字段

```sql
ALTER TABLE nodes ADD COLUMN queue_count INT NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN is_indoor TINYINT(1) NOT NULL DEFAULT 0;
```

- `queue_count`：餐厅/景点当前排队人数（默认 0）
- `is_indoor`：是否室内（天气恶劣时切换用）

**更新 seed.sql**：餐厅 `is_indoor=1`，景点 `is_indoor=0`（故宫/天坛等户外大），酒店 `is_indoor=1`

### 3.2 新增 `weather` 表（全市级天气）

```sql
CREATE TABLE weather (
  city VARCHAR(32) PRIMARY KEY,
  status ENUM('sunny','rainy','sandstorm','typhoon') NOT NULL,
  temperature INT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO weather VALUES ('北京', 'sunny', 22, NOW());
```

全市笼罩，所以单条记录就够。

### 3.3 events 表事件类型扩展

| 事件 type | 含义 |
|-----------|------|
| 1 | 天气变晴 |
| 2 | 天气变雨 |
| 3 | 天气变沙尘暴 |
| 4 | 天气变台风 |
| 5 | 排队 +N |
| 6 | 排队 -N |
| 7 | POI 限流 |
| 8 | 餐厅满座 |
| 9 | 道路封闭 |
| 10 | 交通拥堵 |
| 11 | 地铁延误 |
| 12 | no_op |

### 3.4 事件发生器重写（`anomaly_generator.js` → `event_generator.js`）

**新事件概率分布**：

| 事件 | 概率 | 好/坏 |
|------|------|------|
| 天气变晴 | 8% | 好 |
| 天气变雨 | 10% | 坏 |
| 天气变沙尘暴 | 4% | 坏 |
| 天气变台风 | 2% | 坏 |
| 排队 +10 | 8% | 坏 |
| 排队 -10 | 8% | **好** |
| POI 限流 | 12% | 坏 |
| 餐厅满座 | 12% | 坏 |
| 道路封闭 | 10% | 坏 |
| 交通拥堵 | 15% | 坏 |
| 地铁延误 | 8% | 坏 |
| no_op | 3% | - |

### 3.5 坏事检测器（`anomaly_detector.js` → `event_detector.js`）

只检测影响行程的"坏事"：

```
对每条 change：
  1. 判定好坏（按规则）
  2. 若是好（排队减少、天气变晴）→ 不推 trip-agent，不通知用户
  3. 若是坏（其他）→ 推 trip-agent + 调对应 skill（weather/queue/traffic）
  4. no_op 跳过
```

**好/坏判定规则**（老板定版）：

| 事件 | 判定 | detector 行为 |
|------|------|-----------------|
| 天气变晴 | **好** | 不报 |
| 天气变雨/沙尘暴/台风 | **坏** | 报 + 调 weather-monitor |
| 排队 +N | **坏** | 报 + 调 queue-monitor |
| 排队 -N | **好** | **不报** |
| POI 限流/关闭 | 坏 | 报 |
| 餐厅满座/关门 | 坏 | 报 |
| 道路封闭/拥堵/地铁延误 | 坏 | 报 + 调 traffic-monitor |

实现：event_detector.js 维护一张 `GOOD_EVENTS = new Set([1, 6])`，命中则丢弃。

---

## 四、数据流

```
[系统 crontab 每 30m] event_generator.js
  ↓ 改 MySQL nodes/edges/weather 表
  
[系统 crontab 每 10m] event_detector.js
  ↓ diff vs last_known.json
  ↓ 按好/坏规则过滤
  ↓ 坏事件 → 写 trip-agent inbox + cron run 唤醒
  
[trip-agent 唤醒]
  ↓ 读 inbox
  ↓ 调 replan-skill
  ↓ replan 调对应 skill（weather/queue/traffic）
  ↓ skill 处理完写 result_callback 到 coordinator inbox
  
[coordinator 唤醒]
  ↓ 读 inbox
  ↓ 通知用户
```

---

## 五、待定 / 风险（老板拍板后）

| 项 | 拍板后状态 |
|----|----------|
| 4 个 skill 一次性都做 | **否** — 3 skill 简化为同一逻辑，3 个 SKILL.md 文档拆开 |
| event_generator 改名 | **是** — `event_generator.js` / `event_detector.js` |
| 4 个 skill 加 cron | **不需要** — 3 个 skill 是 trip 回调被动的，不加 wake job；nearby 直接调不加 wake |
| mockend 节点加 queue_count + is_indoor | **是** — seed.sql 同步 |
| 比赛 deadline | **不管**，不赶 |
| weather 数据怎么生成 | generator 直接 UPDATE `weather` 表（4 状态机） |
| queue_count 怎么动态 | generator 选 node 加/减 N（-N 为好，+N 为坏） |
| 位置获取（nearby） | **不主动问** — 从 trip.json 拿 |

---

## 六、落地顺序

1. **mockend schema**（nodes 加 queue_count + is_indoor + weather 表 + seed.sql 同步）
2. **index.js** 支持新查询（queue_count、is_indoor、weather）
3. **event_generator.js**（重写：12 种事件 + 好/坏标记 + UPDATE weather）
4. **event_detector.js**（重写：按规则过滤好事，只推坏事）
5. **3 个 skill SKILL.md**（weather/queue/traffic，结构相同）
6. **nearby-search-skill SKILL.md**（trip.json 拿位置）
7. **init.sh 同步**（旧 anomaly-* 删掉 / 新 event-* 加上）
8. **ARCHITECTURE 05/06 + 09（新建）**（mockend 重构 + 4 skill）
9. **README 同步**
10. **测试**（用 MySQL + 9 个脚本 + 4 skill 跑一遍）
11. **commit**（init git → add → commit）

---

## 七、文件名 / 路径

| 文件 | 路径 |
|------|------|
| `weather-monitor-skill/SKILL.md` | `skills/weather-monitor-skill/SKILL.md` |
| `queue-monitor-skill/SKILL.md` | `skills/queue-monitor-skill/SKILL.md` |
| `traffic-monitor-skill/SKILL.md` | `skills/traffic-monitor-skill/SKILL.md` |
| `nearby-search-skill/SKILL.md` | `skills/nearby-search-skill/SKILL.md` |
| `event_generator.js` | `mock_backend/scripts/event_generator.js` |
| `event_detector.js` | `mock_backend/scripts/event_detector.js` |
| `weather` 表 | MySQL life_butler_db.weather |

---

## 八、好/坏判定规则（老板定版）

| 事件 | 判定 | detector 行为 |
|------|------|-----------------|
| 天气变晴 | **好** | 不报 |
| 天气变雨/沙尘暴/台风 | **坏** | 报 + 调 weather-monitor |
| 排队 +N | **坏** | 报 + 调 queue-monitor |
| 排队 -N | **好** | **不报** |
| POI 限流/关闭 | 坏 | 报 |
| 餐厅满座/关门 | 坏 | 报 |
| 道路封闭/拥堵/地铁延误 | 坏 | 报 + 调 traffic-monitor |

实现：event_detector.js 维护一张 `GOOD_EVENTS = new Set([1, 6])`，命中则丢弃。

---

老板拍板顺序：先做 mockend 改造，再做 skill 文档，最后 init.sh + ARCHITECTURE + README 同步，最后 commit。
