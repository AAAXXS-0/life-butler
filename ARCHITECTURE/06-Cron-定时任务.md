# 06-Cron 定时任务

> 本文档列出 LifeButler 系统所有定时任务
> 更新时间：2026-06-06
> **两类调度**：
> - **OpenClaw cron**（带 LLM 决策的 agent turn）→ `openclaw cron add`
> - **系统 crontab**（纯 Python 脚本）→ `crontab -e`

---

## 1. 任务清单

### 1.1 OpenClaw cron（agent turn）

| # | 任务 | 频率 | 触发谁 | 做什么 | 状态 |
|---|------|------|--------|--------|------|
| 1 | Coordinator 整点巡检 | 每小时 | Coordinator | 检查 emergency_events，触发 Schedule + Account 主动服务 | ✅ 必需 |
| 2 | ~~Trip 主动检查~~ | — | — | ~~trip 不需要主动服务~~ | ❌ 不需要 |
| 3 | Schedule 主动检查 | 每小时 | Schedule Agent | alarm、habit 状态、纪念日/生日 | ✅ 必需 |
| 4 | Account 主动检查 | 每小时 | Account Agent | 超预算、trip 结束汇总、7天无记录 | ✅ 必需 |
| 5 | A2A 死 cron（5 wake） | 死（`enabled: false`）| sub-agents + coordinator | 被 `openclaw cron run` 链式触发，处理 inbox 消息 | ✅ 必需 |

### 1.2 系统 crontab（纯 Python 脚本）

| # | 任务 | 频率 | 脚本 | 状态 |
|---|------|------|------|------|
| 6 | mockend 异常发生器 | `*/30 * * * *`（每 30 分钟）| `mock_backend/scripts/anomaly_generator.js` | ✅ 必需 |
| 7 | mockend 异常检测器 | `*/10 * * * *`（每 10 分钟）| `mock_backend/scripts/anomaly_detector.js` | ✅ 必需 |
| 8 | comm-cleanup | `0 3 * * *`（每天 3:00）| `utils/comm-cleanup.py` | 🔄 可选 |
| 9 | 七维 promote 兜底 | `0 4 * * *`（每天 4:00）| `utils/seven-dim-promote.py` | 🔄 可选 |

### 1.3 实时触发（非 cron）

| 任务 | 触发者 | 做什么 |
|------|--------|--------|
| ~~chat_mode_profile_scanner~~ | — | ❌ 已移除（实时触发写在 skill 里） |
| coordinator ↔ 0 直接对话 | webchat | 用户 ↔ 主助手 ↔ coordinator 实时通信 |

> **注**：chat_mode_profile_scanner 实际为**实时触发**，由 Coordinator 在聊天结束后立刻调用 sessions_spawn 触发，不需要 cron。详见 `skills/memory-seven-dim-skill/SKILL.md` 路径7「触发时机」。

---

## 2. 触发链

### 2.1 OpenClaw cron 部分

```
Cron Job 1（Coordinator 整点巡检，OpenClaw cron）
  ↓ cron run
  Job 3/4（Schedule + Account 主动服务）→ 异常 → 通知 Coordinator
  （Trip 不需要主动服务，它的唤醒只有 mockend 异常检测器一条路）

Cron Job 5（A2A wake jobs，OpenClaw cron，5 个全死）
  ↓ cron run 链式触发
  trip-agent ←→ schedule-agent ←→ account-agent
  全部 → coordinator
  coordinator → 0 / 用户（通过 channel）
```

### 2.2 系统 crontab 部分

```
Crontab Job 6（mockend 异常发生器，每 30m）
  ↓ 直接 UPDATE MySQL node_status / edge_status
  → 改 mockend 图（节点/边状态）

Crontab Job 7（mockend 异常检测器，每 10m）
  ↓ diff MySQL 当前状态 vs last_known.json
  → 有差异：写 shared/trip-agent/YYYY-MM-DD.json
  → openclaw cron run <butler-trip-agent-wake-id>
  → trip-agent 决定是否影响行程
      - 不影响 → 无事发生
      - 影响 → replan + 通知 coordinator + coordinator 通知用户

Crontab Job 8（comm-cleanup，每天 3:00）— 可选
  → 清理 shared/ 下 3 天前的聊天文件

Crontab Job 9（七维 promote，每天 4:00）— 可选
  → 兜底晋升 cache_events → seven_dimensions
```

### 2.3 关键原则

**mockend 异常检测器 → trip-agent 唤醒链路**：
- 脚本不直接调 `openclaw agent`（那是 CLI，不是 cron）
- 脚本 `openclaw cron run <wake-id>` 触发**已经存在**的 OpenClaw A2A wake job
- wake job 走 session-keyed inbox 串行排队（per-session 防并行）

---

## 3. 系统 crontab 配置（实际命令）

```bash
# 编辑 crontab
crontab -e

# 加以下行（如果还没加）：
# === mockend 异常发生器（每 30 分钟）===
*/30 * * * * cd /home/zero/.openclaw/workspace-butler && node mock_backend/scripts/anomaly_generator.js >> /var/log/butler-mockgen.log 2>&1

# === mockend 异常检测器（每 10 分钟）===
*/10 * * * * cd /home/zero/.openclaw/workspace-butler && node mock_backend/scripts/anomaly_detector.js >> /var/log/butler-mockdet.log 2>&1

# === comm-cleanup（每天 3:00）— 可选 ===
0 3 * * * cd /home/zero/.openclaw/workspace-butler && python3 utils/comm-cleanup.py >> /var/log/butler-cleanup.log 2>&1

# === 七维 promote 兜底（每天 4:00）— 可选 ===
0 4 * * * cd /home/zero/.openclaw/workspace-butler && python3 utils/seven-dim-promote.py >> /var/log/butler-promote.log 2>&1
```

**频率可调**：改 `*/30` 和 `*/10` 即可（如 `*/15` 表示每 15 分钟一次）。

---

## 4. OpenClaw cron 配置原则

**A2A 死 cron job（Job 5 中 5 个 wake）**：
- 全 `enabled: false`，由上游 `openclaw cron run` 链式触发
- 配 `--session session:butler-<agent>:inbox`（per-session 串行）
- 必带 `--no-deliver` + `--expect-final`

**整点巡检（Job 1）**：
- `enabled: true`，自动跑
- 巡检后 `cron run` 触发 3 子 Agent wake job

**禁止**：
- 禁止用 `cron enable` 把 wake job 变活的（会变成全局定时心跳，打破 A2A 链）
- 禁止 OpenClaw cron 跑纯 Python 脚本（无 LLM 决策的都用系统 crontab）

---

## 5. mockend 脚本详情

详见 `ARCHITECTURE/05-Mock-Backend.md` §9（含 anomaly_generator.js / anomaly_detector.js 完整职责 + 文件位置 + 日志路径）。
