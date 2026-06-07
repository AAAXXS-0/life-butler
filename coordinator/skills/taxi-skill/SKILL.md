# taxi-skill

> 打车 skill —— Coordinator 主管
> 比赛本地生活相关 skill 之一
> 触发：用户独立叫车请求（不在 trip 框架内）

## 触发

用户主动说："下班了帮我叫车" / "打个车去机场" / "帮我叫个车回家" 等。

> **场景区分**：
> - 本 skill 处理**独立叫车**（不在 trip 框架内的临时叫车）
> - trip 内的接驳（如景点 → 酒店）由 `trip-skill` 阶段三的 `taxi` edge 类型处理，不需要本 skill

## 关键决策：不主动问位置

**老板拍板**：从 `trips.json` 当前行程的当前位置直接取 lat/lng 作为出发点。

```
用户："下班了帮我打个车回家"
   ↓
读 trips.json → 找 status=ongoing 的 trip → 拿当前 POI lat/lng
   ↓
没 trip / 没当前位置 → 读 schedule.json 最近日程的 location
   ↓
还拿不到 → 提示"你目前在哪儿？"（不主动问位置原则的例外场景）
   ↓
MockBackend.query_nodes({ type: 'taxi_stand', city, near, radius_km: 2 })
   ↓
按距离 + queue_count + 实时状态加权排序
   ↓
取 top 3（最近 3 个打车点）
   ↓
拼输出 → 写 shared/coordinator/YYYY-MM-DD.json
```

## 数据

| 数据 | 来源 | 用途 |
|------|------|------|
| 当前位置 | `trips.json`（current_location）| 搜索中心 |
| 当前位置备选 | `schedule.json`（最新 event.location）| trip 不在时兜底 |
| 附近打车点 | `MockBackend.query_nodes({ type: 'taxi_stand', near, radius_km: 2 })` | 主数据 |
| 实时状态 | `nodes.queue_count` + `node_status.status` | 可调度车数 + 关闭/限流 |
| 天气 | `weather` 表 | 台风/沙尘暴时不推荐打车 |
| 预算 | `accounts.json`（monthly_disposable）| 估价判断 |
| 用户偏好 | 七维 `消费习惯` / `时间规律` | 紧/松预算 |

## 排序权重

```
score = 距离 (30%) + queue_count (30%) + 状态 (20%) + 价格 (20%)

- 距离：越近越高（用 haversine 或 MockBackend 内部算）
- queue_count：越多越好（taxi_stand 节点自带字段）
- 状态：open 满分，limited 减半，full/closed 排除
- 价格：根据 distance_m × 2.3 元/km + 13 元起步估算（标准化成 0-1）
```

## 输出模板

```
🚖 帮你找到附近 3 个打车点

1. 国贸打车点（CBD）
   距离 0.8 km · 8 辆可调度 · 预计 12 元
2. 三里屯打车点（三里屯）
   距离 1.2 km · 6 辆可调度 · 预计 15 元
3. 王府井打车点（王府井）
   距离 2.1 km · 5 辆可调度 · 预计 22 元

你选哪个？回复数字 / 回复"最近"/"最便宜"/"车最多"
```

## 逻辑

```
1. 拿当前位置（trip → schedule → 都不行就问用户）
2. 推断目的地（用户没明说就问："你要去哪儿？"）
3. 调 query_nodes 拿附近 2km 内 taxi_stand
4. 排序 → top 3
5. 拼输出 → 走 shared/coordinator/YYYY-MM-DD.json
6. 用户回复选哪个 → 写一条 event 到 schedule.json（type=reminder，sub_type=taxi）
7. 后续：mockend event_generator.js 可模拟"车 5 分钟后到"事件
```

## 实现

伪代码（Coordinator 代理）：

```js
const MockBackend = require('../../mock_backend');
const fs = require('fs');

// 1. 拿当前位置
const trips = JSON.parse(fs.readFileSync('agents/trip-agent/data/trips.json', 'utf8'));
let center = null;
const cur = trips.find(t => t.status === 'ongoing');
if (cur?.current_location) {
  center = cur.current_location;
} else {
  // 备选：schedule.json
  const schedule = JSON.parse(fs.readFileSync('agents/schedule-agent/data/schedule.json', 'utf8'));
  const latest = schedule.filter(e => e.location).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (latest?.location) center = latest.location;
}

if (!center) {
  await notifyUser('你现在在哪儿？');
  return;
}

// 2. 天气检查（不推荐打车：台风/沙尘暴）
const weather = await MockBackend.get_weather('北京');
if (['typhoon', 'sandstorm'].includes(weather?.status)) {
  await notifyUser(`当前${weather.status}，不建议打车，建议叫专车或等天气好转`);
  return;
}

// 3. 拿打车点
const stands = await MockBackend.query_nodes({
  type: 'taxi_stand', city: '北京',
  near: { lat: center.lat, lng: center.lng, radius_km: 2 }
});

// 4. 排序
const ranked = stands
  .filter(s => s.status === 'open' || s.status === 'limited')
  .map(s => ({
    ...s,
    score: distScore(center, s) + queueScore(s.queue_count) + openScore(s.status) + priceScore(s)
  }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 3);

// 5. 输出
await notifyUser({...});
```

## 不做的事

- 不调第三方地图 API（高德/滴滴）—— 用 mockend
- 不做订单状态追踪（mockend event_generator 模拟）
- 不做支付集成
- 不改 trip —— trip 内的接驳走 trip-skill 阶段三

## 文件

- SKILL.md（本文件）
- 无额外脚本 —— 由 Coordinator 在代理时直接调

## 与其他 skill 的关系

- **trip-skill**：trip 内的接驳（如景点 → 酒店）由 trip-skill 阶段三的 `taxi` edge 处理
- **traffic-monitor-skill**：trip 内交通拥堵时切备选，跟独立叫车无关
- **nearby-search-skill**：用户主动搜"附近"，本 skill 是搜"附近打车点"——目的不同
- **replan-skill**：trip-agent 内部用，触发 trip 内的 taxi 切换，不调本 skill
- **mockend event_generator.js**：能模拟打车点 queue_count 增减（type=5 排队+ 触发 taxi_stand 节点）

## 与 mockend 事件系统的联动

event_generator.js 的 `queue_increase`（type=5）/`queue_decrease`（type=6）事件原本针对餐厅/景点的 queue_count 字段，**可以扩展支持 taxi_stand 节点**：

```js
// 伪代码（event_generator.js 内）
if (eventType === 5 && node.type === 'taxi_stand') {
  // 排队 +N → 周边可调度车辆增多（实际上"排队"语义反转，但 mock 简化）
  UPDATE nodes SET queue_count = queue_count + 10 WHERE id = ?;
}
```

不过这是 mockend 层的扩展，不属于本 skill 范围。**当前实现**只要 taxi_stand 节点带 `queue_count` 字段即可，本 skill 直接读。
