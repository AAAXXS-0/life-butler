# replan-skill

> 行程重规划 skill —— Trip Agent 内部使用
> 比赛本地生活相关 skill 配套：trip-agent 收到坏事件后调本 skill

## 触发

`event_detector.js` 推送坏事件 → 写 `shared/trip-agent/YYYY-MM-DD.json` → cron run 唤醒 trip-agent → trip-agent **本 skill 内部使用**。

## 职责

1. 读 inbox 中的 `bad_events`（来自 event_detector）
2. 判断每个事件是否影响当前 trip
3. 影响 → 调对应 monitor skill（weather/queue/traffic）生成备选 + 拼提示
4. 写 `result_callback` 到 `shared/coordinator/YYYY-MM-DD.json`
5. cron run 唤醒 coordinator

## 逻辑

```
读 inbox.bad_events
  ↓
对每个 event:
  ├── type=2/3/4 (天气变化)
  │     weather_change = true
  │     调 coordinator/weather-monitor-skill
  │
  ├── type=5 (排队增加)
  │     queue_increase = true
  │     调 coordinator/queue-monitor-skill
  │
  ├── type=10/11 (交通拥堵/地铁延误)
  │     traffic_congestion = true
  │     调 coordinator/traffic-monitor-skill
  │
  ├── type=7/8/9 (POI 限流/餐厅满座/道路封闭)
  │     不调 monitor skill
  │     trip-agent 内部直接 replan（用备选 POI/餐厅/路线）
  │
  └── type=1/6/12 (好事件/no_op) — 不应出现（detector 已过滤）
  ↓
收集 monitor skill 的输出
  ↓
拼成 result_callback 消息
  ↓
写 shared/coordinator/YYYY-MM-DD.json
  ↓
openclaw cron run <coordinator-wake-id>
```

## 输入

- `shared/trip-agent/YYYY-MM-DD.json`（最近 2 天）
  - 字段：`type: 'info_share'`, `from: 'mock-detector'`, `content.events[]`（每条 event）
- `data/trips.json`（当前 trip）
- `temp/phase3_out.json`（上次生成的有序 POI 序列 + 备选路线）

## 输出

- `shared/coordinator/YYYY-MM-DD.json`（写一条 result_callback）
  ```json
  {
    "type": "result_callback",
    "from": "trip-agent",
    "to": "coordinator",
    "content": {
      "action": "replan_with_monitors",
      "trigger_events": [ <event 列表> ],
      "monitor_results": [
        {
          "skill": "weather-monitor-skill",
          "weather_affected": true,
          "alt_trip_summary": "改 3 个室外 POI 为室内备选"
        },
        {
          "skill": "queue-monitor-skill",
          "queue_heavy": true,
          "alt_trip_summary": "切 1 个备选餐厅"
        }
      ],
      "alt_trip": { <新的行程对象，参照 trips.json schema> },
      "ask": "请向用户展示：<文案>，并询问是否切换"
    }
  }
  ```

## 数据依赖

- `temp/phase3_out.json`（备选路线 + 备选 POI）
- `data/trips.json`（当前 trip 引用）
- `MockBackend.query_nodes / get_weather`（拉新数据）

## 不做的事

- 不直接通知用户 —— 必须经 coordinator
- 不主动发起 trip 委托 —— 只在 inbox 有坏事件时响应
- 不修改 monitor skill 内部逻辑 —— 只调用

## 与其他 skill 的关系

| Skill | 关系 |
|-------|------|
| trip-skill | trip-agent 主 skill，replan-skill 调 phase3 重算备选 |
| butler-comm-skill | trip-agent 写 result_callback 到 coordinator inbox 用 |
| weather-monitor-skill | 由 coordinator 持有，replan-skill 触发调用 |
| queue-monitor-skill | 由 coordinator 持有，replan-skill 触发调用 |
| traffic-monitor-skill | 由 coordinator 持有，replan-skill 触发调用 |
| event_detector.js | 把坏事件推 inbox，触发本 skill |

## 主动服务扩展

- 行程前 3 天：调 `weather-monitor-skill` 检查目的地天气
- 行程中：每 10m 收坏事件 → 实时 replan
- 行程后：通知 Account Agent 汇总

## 实现

本 skill 无 JS 实现文件 —— trip-agent 在收到 inbox 后**按上述逻辑直接调对应 monitor skill**。后续可拆为 `agents/trip-agent/skills/replan-skill/replan.js` 脚本，但当前 flow 简单，由 trip-agent 代理即可。

## 文件

- `SKILL.md`（本文件）
- 无脚本实现
