# mockend 异常发生器 + 检测器

> 详见 `ARCHITECTURE/05-Mock-Backend.md` §9 + `ARCHITECTURE/06-Cron-定时任务.md` §5

**核心**：两个脚本直接操作 MySQL，不经过 graph.json。

## 两个脚本

| 脚本 | 频率 | 作用 |
|------|------|------|
| `anomaly_generator.js` | `*/30 * * * *`（每 30 分钟）| 随机 UPDATE MySQL `node_status`/`edge_status` + INSERT `events` |
| `anomaly_detector.js` | `*/10 * * * *`（每 10 分钟）| SELECT MySQL 当前状态 → diff `last_known.json` → 有差异推 trip-agent |

## 调度方式：系统 crontab

```bash
crontab -e
# 加以下行：

# === mockend 异常发生器（每 30 分钟）===
*/30 * * * * cd /home/zero/.openclaw/workspace-butler && node mock_backend/scripts/anomaly_generator.js >> /var/log/butler-mockgen.log 2>&1

# === mockend 异常检测器（每 10 分钟）===
*/10 * * * * cd /home/zero/.openclaw/workspace-butler && node mock_backend/scripts/anomaly_detector.js >> /var/log/butler-mockdet.log 2>&1
```

**调频率**：改 `*/30` 和 `*/10`（如 `*/15` 表示每 15 分钟，`*/5` 表示每 5 分钟）。

## 关键文件

| 文件 | 谁读写 | 用途 |
|------|--------|------|
| `node_status` + `edge_status`（MySQL） | generator 写 / detector 读 | 动态状态（generator 直接 UPDATE，detector 直接 SELECT） |
| `events`（MySQL） | generator 写 | 事件记录 |
| `mock_backend/state/last_known.json` | detector 读写 | detector 对比本，存储上次扫描的 { node_id: {status,reason}, ... } |
| `shared/trip-agent/YYYY-MM-DD.json` | detector 写 / trip-agent 读 | 异常 diff 投递目标 |
| `/var/log/butler-mockgen.log` | generator | generator 日志 |
| `/var/log/butler-mockdet.log` | detector | detector 日志 |

**没有 `graph.json`**：两个脚本直接 MySQL，不需要中间文件。**统一 Node.js**，不混用 Python。

## 关键依赖

`anomaly_detector.js` 头部硬编码 trip-agent wake job id：

```python
TRIP_WAKE_JOB_ID = "b9b05aa8-975e-4108-a239-22afe32ef841"
```

这是 `openclaw cron add` 创建的 `butler-trip-agent-wake` job ID。

**改 wake job ID 时**：重新 `openclaw cron run` 后用 `openclaw cron list --all | grep trip` 查新 ID，改这个常量。

## 测试

```bash
# 注意：generator/detector 直接读 MySQL，统一 Node.js

# 1. 手动跑 generator
node mock_backend/scripts/anomaly_generator.js

# 2. 跑 detector
node mock_backend/scripts/anomaly_detector.js

# 3. 首次应看到「首次检测，已建立 last_known 基线」
# 4. 再跑一次 generator（改 MySQL）
node mock_backend/scripts/anomaly_generator.js
# 5. 再跑 detector
node mock_backend/scripts/anomaly_detector.js
# 6. 应看到「检测到 N 节点 + M 边变化，已写 trip-agent 收信箱」+ trip-agent 被唤醒
```

## 7 种事件（generator 用）

| 事件 | 目标 | 概率 | 状态变更 |
|------|------|------|---------|
| road_closed | edge | 15% | `status: open → closed` |
| traffic_jam | edge | 20% | `status: open → slow + delay_min: 10-60` |
| metro_delay | edge | 15% | `status: open → delayed + delay_min: 5-30` |
| poi_crowded | node | 15% | `crowd_level: high + wait_min: 20-60` |
| poi_closed | node | 5% | `status: closed` |
| weather_bad | node | 10% | `weather_impact: bad` |
| event_held | node | 10% | `event_active: true + event_name` |
| no_op | — | 10% | 不做任何变更（让 detector 偶尔空跑）|

详细设计见 `ARCHITECTURE/05-Mock-Backend.md` §5。
