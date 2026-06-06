# 05-Mock-Backend

> 本文档描述 Mock Backend 的图模型设计
> 权威来源：`docs/mock-backend-design.md`（v2）
> 更新时间：2026-06-06

---

## 1. 核心定位

Mock Backend 是 Butler 系统的**动态数据层**，负责：
1. 提供基础 POI 数据查询（节点+边）
2. 生成随机事件（动态部分），触发行程异常

---

## 2. 图模型

**核心变化**（v1 → v2）：

| v1 | v2 |
|----|----|
| 静态 JSON | 图模型（MySQL） |
| haversine 算距离 | 边带 distance_m / duration_min |
| 事件随机打靶 | 事件在图层面操作（关节点/断边） |
| 备选硬编码 | 备选路径从图自动找 |

---

## 3. MySQL 表结构

### nodes（节点）

```sql
CREATE TABLE nodes (
  id         VARCHAR(32) PRIMARY KEY,
  type       ENUM('attraction','restaurant','hotel','transport_hub') NOT NULL,
  name       VARCHAR(128) NOT NULL,
  lat        DOUBLE NOT NULL,
  lng        DOUBLE NOT NULL,
  props      JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### edges（边）

```sql
CREATE TABLE edges (
  id             VARCHAR(32) PRIMARY KEY,
  from_node      VARCHAR(32) NOT NULL,
  to_node        VARCHAR(32) NOT NULL,
  type           ENUM('walk','metro','drive') NOT NULL,
  distance_m     INT NOT NULL,
  duration_min   INT NOT NULL,
  metro_line     VARCHAR(32),
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_node) REFERENCES nodes(id),
  FOREIGN KEY (to_node) REFERENCES nodes(id)
);
```

### node_status（节点动态状态）

```sql
CREATE TABLE node_status (
  node_id    VARCHAR(32) PRIMARY KEY,
  status     ENUM('open','full','closed','limited') DEFAULT 'open',
  reason     VARCHAR(256),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);
```

### edge_status（边动态状态）

```sql
CREATE TABLE edge_status (
  edge_id    VARCHAR(32) PRIMARY KEY,
  status     ENUM('open','congested','closed') DEFAULT 'open',
  reason     VARCHAR(256),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (edge_id) REFERENCES edges(id)
);
```

### events（事件）

```sql
CREATE TABLE events (
  id           VARCHAR(32) PRIMARY KEY,
  type         TINYINT NOT NULL,
  target_type  ENUM('node','edge') NOT NULL,
  target_id    VARCHAR(32) NOT NULL,
  severity     ENUM('low','medium','high') NOT NULL,
  title        VARCHAR(256),
  detail       TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 4. Mock Backend 接口

模块位置：`mock_backend/index.js`（CommonJS）

```js
query_nodes({ type, city, filters })
  → [{ id, type, name, lat, lng, props, status }]

query_edges({ from_node, to_node, type })
  → [{ id, from_node, to_node, type, distance_m, duration_min, status }]

get_shortest_path(origin_id, dest_id, edge_types)
  → { path: [node_id], edges: [edge_id], total_distance_m, total_duration_min }

get_alternative_paths(origin_id, dest_id, edge_types, count)
  → [{ path, edges, total_distance_m, total_duration_min }]

generate_event(trip_day)
  → { event } 或 null

get_active_events(trip_nodes)
  → [events]
```

---

## 5. 7 种事件

| # | 事件 | 图操作 |
|---|------|--------|
| 1 | 天气突变 | 区域 attraction → status='limited' |
| 2 | 餐厅满座/关门 | restaurant → status='full'/'closed' |
| 3 | 交通管制/封路 | edge → status='closed' |
| 4 | 景区限流/预约满 | attraction → status='full' |
| 5 | 酒店满房 | hotel → status='full' |
| 6 | 航班/高铁延误 | transport_hub 写入 events |
| 7 | 景点活动取消 | attraction props 更新 |

---

## 6. 事件分级

| severity | 效果 | 通知用户 |
|----------|------|----------|
| low | Coordinator 记录 | 否 |
| medium | Trip Agent 自动切备选 | 事后通知 |
| high | Coordinator 通知确认后强制 replan | 是 |

---

## 7. trip-skill 接入图模型

### Phase 2（POI 筛选）

- 调 `MockBackend.query_nodes()` 替代读 `poi/*.json`
- 每个节点带 `status` 字段

### Phase 3（空间优化）

- 调 `MockBackend.get_shortest_path()` 替代 haversine + TSP
- `path_to_next` 包含具体边（edges 数组）
- 新增 `edge_usage`：主路线涉及的所有边 ID，供事件系统断边定位

---

## 8. 实施步骤

1. MySQL 建库建表
2. 生成北京子图 mock 数据（~52 nodes + ~80 edges）
3. `mock_backend/index.js`（query + Dijkstra + 备选）
4. `mock_backend/event_generator.js`（7 种事件，概率触发）
5. 接入 phase2_poi_filter.js
6. trip-skill phase3 改图路径规划
7. **两个定时脚本**（系统 crontab 调度）：
   - `mock_backend/scripts/anomaly_generator.js`：每 30m 改一次 MySQL 状态
   - `mock_backend/scripts/anomaly_detector.js`：每 10m 检测，有变化推 trip-agent

详见 `ARCHITECTURE/06-Cron-定时任务.md` §mockend 脚本 + 本文档 §9。

代码需求见 `update_docs/mock-backend-code-requirements.md`。


---

## 9. 两个 mockend 定时脚本

**核心设计原则**：两个脚本**直接操作 MySQL**，不经中间文件。对比本只有 `last_known.json`（detector diff 用）。检测到差异后，**只**写 trip-agent 收信箱 + `openclaw cron run` 唤醒它。trip-agent 决定是否影响行程。

> **无 graph.json**：generator 直接 UPDATE MySQL，detector 直接 SELECT MySQL。

### 9.1 anomaly_generator.js（异常发生器）

**频率**：每 30m（可调，范围 10-60m）

**职责**：随机对 MySQL 做状态变更（不改图结构、只改 `node_status`/`edge_status` + 记 `events`）

**操作**：
1. 随机选 node 或 edge（`SELECT … FROM nodes/node_status ORDER BY RAND() LIMIT 1`）
2. 按 7 种事件概率分布选一种事件
3. **node 事件** → UPDATE `node_status` SET status/原因
4. **edge 事件** → UPDATE `edge_status` SET status/原因
5. INSERT INTO `events`（记录事件）
6. 不发任何通知（detector 负责发现）

**文件**：`mock_backend/scripts/anomaly_generator.js`（**已有 .py 旧版需重写**）

### 9.2 anomaly_detector.js（异常检测器）

**频率**：每 10m（可调，范围 10-20m，比发生器高）

**职责**：扫 MySQL 当前状态，对比 `last_known.json` 基线，有变化推 trip-agent

**操作流程**：

```
1. 读 MySQL 当前状态：
   SELECT node_id, status, reason FROM node_status
   SELECT edge_id, status, reason FROM edge_status
2. 读 mock_backend/state/last_known.json（上次扫描的快照）
3. 首次运行（last_known 不存在/为空）：
   → 存当前状态到 last_known.json
   → 退出（不发任何消息）
4. 非首次：
   → diff（当前 MySQL 结果 vs last_known.json）
   → 无差异 → 退出
   → 有差异：
     a. 构造 inbox 消息
        {
          "id": "<uuid>",
          "from": "mock-detector",
          "reply_to": null,
          "ts": <epoch_ms>,
          "content": <diff 的 JSON：哪些 node/edge 状态变了>,
          "read": false,
          "type": "info_share"
        }
     b. 追加到 shared/trip-agent/YYYY-MM-DD.json（带文件锁）
     c. openclaw cron run <butler-trip-agent-wake-id>
     d. 更新 last_known.json
```

**对比本**：`last_known.json` 格式：`{ nodes: { <node_id>: { status, reason } }, edges: { <edge_id>: { status, reason } } }`。

**文件**：`mock_backend/scripts/anomaly_detector.js`（**已有 .py 旧版需重写**）

### 9.3 trip-agent 收到后做什么

**trip-agent 不需要主动服务**（没有"主动检查"的需求）。它的唤醒路径**只有两条**：

1. **mockend 异常检测器**（本脚本）—— 图变化时唤醒，处理变更
2. **coordinator 委托**—— 用户请求行程规划

**没有「定时主动服务检查」**：mockend 异常是实时推的（detector 每 10m 跑），不需要 trip-agent 自己去轮询图。

**收到变更后判断**：
- 不影响行程（变化节点/边不在 trip 路线上）→ **无事发生**
- 影响行程（变化节点/边在 trip 路线上）：
  1. replan：调 phase2/phase3 重算路线（避开封闭边/限流节点）
  2. 写 `result_callback` 到 `shared/coordinator/YYYY-MM-DD.json`
  3. `openclaw cron run <coordinator-wake-id>` 唤醒 coordinator
  4. coordinator 组装变更告知 → 通知用户（通过 channel）

### 9.4 调度方式

**系统 crontab**（不走 OpenClaw cron，纯脚本无 LLM 决策，统一 Node.js）：

```cron
# mockend 异常发生器（每 30 分钟）
*/30 * * * * cd /home/zero/.openclaw/workspace-butler && node mock_backend/scripts/anomaly_generator.js >> /var/log/butler-mockgen.log 2>&1

# mockend 异常检测器（每 10 分钟）
*/10 * * * * cd /home/zero/.openclaw/workspace-butler && node mock_backend/scripts/anomaly_detector.js >> /var/log/butler-mockdet.log 2>&1
```

**频率可调**：在 crontab 里改 `*/30` 和 `*/10` 即可。

### 9.5 关键文件

| 文件 | 用途 |
|------|------|
| `node_status` + `edge_status`（MySQL） | generator 直接 UPDATE / detector 直接 SELECT |
| `events`（MySQL） | generator INSERT 事件记录 |
| `mock_backend/state/last_known.json` | detector 对比本，存储上次扫描的 { node_id: {status,reason}, edge_id: {status,reason} } |
| `shared/trip-agent/YYYY-MM-DD.json` | detector 写差异的收件箱 |
| `/var/log/butler-mockgen.log` | generator 日志 |
| `/var/log/butler-mockdet.log` | detector 日志 |

**没有 `graph.json`、没有 `export_graph.py`**：两个脚本直接 MySQL，不经过中间文件。
