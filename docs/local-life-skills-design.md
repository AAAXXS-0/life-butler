# 本地生活 Skills + Mockend 扩展（草稿 v0.1）

> 日期：2026-06-06
> 状态：草稿，待老板拍板后落地
> 适用范围：比赛项目本地生活相关 skill 缺口 + mockend 重构

---

## 一、比赛硬要求

需要至少 **2 个本地生活相关 skill**。老板提议做 4 个（含交通 + 附近搜索）。

---

## 二、4 个新 Skill（Coordinator 主管）

所有 skill 触发逻辑：trip-skill 在检测到异常时调 `replan-skill` → 通知 Coordinator → Coordinator 派对应 skill → skill 处理完 → 写 inbox → cron run 唤醒 Coordinator → Coordinator 告知用户。

### 1. `weather-monitor-skill`（天气活动抓取）

**触发**：
- trip-skill replan 回调时附带 weather_change=true
- 用户主动问"今天天气怎么样"/"明天能出门吗"

**数据**：
- `mock_backend/weather.json`（新增，模拟气象局）
- 用户当前 `trips.json` 中正在进行的行程

**动作**：
- 读 `weather.json` 当前北京天气（晴/雨/沙尘暴/台风）
- 比对 trip 涉及的室外 POI 数量
- 若天气恶劣且有室外 POI → 建议调换为室内备选

**输出**：调换建议 + 通知用户

---

### 2. `queue-monitor-skill`（餐厅排队监控）

**触发**：
- trip-skill replan 回调时附带 queue_increase=true（排队人数变多）
- 用户主动问"那家店要排多久"

**数据**：
- `nodes.queue_count`（节点新增字段，动态变化）
- 当前 trip 中涉及的餐厅

**动作**：
- 若某餐厅 queue_count > 50（阈值）→ 建议切备选
- 通知用户"X 餐厅当前排队 X 人，建议切 Y"

**输出**：备选推荐 + 通知用户

---

### 3. `traffic-monitor-skill`（交通检查）

**触发**：
- trip-skill replan 回调时附带 traffic_congestion=true
- 用户主动问"现在去机场堵不堵"

**数据**：
- `edge_status` 中 status='congested' 的边
- 当前行程涉及的所有边

**动作**：
- 若主路线 ≥ 2 条边 congestion → 切备选路线
- 通知用户"主路线 X 段拥堵，已切备选 Y 段"

**输出**：备选路线 + 通知用户

---

### 4. `nearby-search-skill`（附近搜索）

**触发**：用户突然来"附近有啥吃的"/"这附近有啥好玩的"等

**数据**（Coordinator 直接读，无需委托）：
- 用户当前位置（询问用户或从最近 trip 推断）
- `mock_backend.query_nodes({ type, city, near: lat/lng, radius_km })`
- `accounts.json`（消费习惯 / 预算）
- `schedule.json`（是否影响后续日程）
- `trips.json`（是否在出行中）
- 七维画像（taste 维度 / effort_goal）

**动作**：
1. 询问/推断用户位置
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

| 事件 | 当前 | 扩展后 |
|------|------|--------|
| 天气变化 | 1 | 1（晴/雨/沙尘暴/台风，4 选 1） |
| 排队人数变化 | - | 8（增/减，独立事件） |
| POI 关闭 | 2 | 2 |
| 餐厅满座 | 4 | 4 |
| 道路封闭 | 5 | 5 |
| 交通拥堵 | 6 | 6 |
| 地铁延误 | 7 | 7 |
| no_op | - | 9 |

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

**好/坏判定规则**（人定，老板定的版本）：

| 事件 | 判定 | 说明 |
|------|------|------|
| 天气变晴 | **好** | 不报 |
| 天气变雨/沙尘暴/台风 | **坏** | 报 + 调 weather-monitor |
| 排队 +N | **坏** | 报 + 调 queue-monitor |
| 排队 -N | **好** | **不报**（你说设减少是好事） |
| POI 限流/关闭 | 坏 | 报 |
| 餐厅满座/关门 | 坏 | 报 |
| 道路封闭/拥堵/地铁延误 | 坏 | 报 + 调 traffic-monitor |

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

## 五、待定 / 风险

| 项 | 状态 |
|----|------|
| weather 数据怎么生成（generator 直接 UPDATE weather 表） | 待确认 |
| queue_count 怎么动态（generator 选 node 加/减 N） | 待确认 |
| 用户问"附近有啥"时位置怎么获取（问 / 从 trip 推断 / 默认） | 待确认 |
| 4 个 skill 是否一次性都做（建议 v0.1 只做 weather + queue + nearby，traffic 复用现有 edge_status 不单独 skill） | 待确认 |
| event_generator 改名是否影响现有 cron | 需要 init.sh 同步更新 |
| 4 个 skill 的 SKILL.md 写完再加 cron | 是 |
| mockend 节点加 queue_count + is_indoor 需要 seed.sql 同步 | 是 |
| 比赛 deadline 是什么时候 | 需问 |

---

## 六、落地顺序建议

1. **mockend 数据扩展**（nodes + queue_count + is_indoor + weather 表 + seed.sql 更新）
2. **event_generator.js + event_detector.js**（改名 + 扩展事件类型 + 好/坏过滤）
3. **weather-monitor-skill**（最简单）
4. **queue-monitor-skill**
5. **nearby-search-skill**（无 mockend 依赖，最独立）
6. **traffic-monitor-skill**（可选，replan-skill 已部分覆盖）
7. **init.sh 同步更新**（job 名称 + message 内容）
8. **README 同步更新**

---

## 七、文件名 / 路径建议

| 文件 | 路径 |
|------|------|
| `weather-monitor-skill/SKILL.md` | `skills/weather-monitor-skill/SKILL.md` |
| `queue-monitor-skill/SKILL.md` | `skills/queue-monitor-skill/SKILL.md` |
| `traffic-monitor-skill/SKILL.md` | `skills/traffic-monitor-skill/SKILL.md` |
| `nearby-search-skill/SKILL.md` | `skills/nearby-search-skill/SKILL.md` |
| `event_generator.js` | `mock_backend/scripts/event_generator.js`（替 anomaly_generator.js） |
| `event_detector.js` | `mock_backend/scripts/event_detector.js`（替 anomaly_detector.js） |
| `weather.json` 等于 `weather` 表 | 不需要单独文件 |

---

老板拍板哪个先做 / 哪个砍掉 / 哪个名字改 / 概率分布改，我再细写。
