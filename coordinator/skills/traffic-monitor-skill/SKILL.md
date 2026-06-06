# traffic-monitor-skill

> 交通检查 skill —— Coordinator 主管
> 比赛本地生活相关 skill 之一

## 触发

trip-agent 通过 `replan-skill` 回调时附带 `traffic_congestion=true` 时，Coordinator 调本 skill。

## 逻辑

```
1. 读 trip 主路线涉及的边 ID 列表
2. MockBackend.query_edges({ type: 'walk'/'metro'/'drive' }) 拿边状态
3. 若主路线 ≥ 2 条边 status='congested':
     traffic_heavy = true
4. MockBackend.get_alternative_paths 算备选路线
5. 拼提示文案 + 写 coordinator inbox + 询问用户是否切到备选路线
6. 用户回是 → 调 trip 替换主路线
7. 用户回否 → 调 trip 保持
```

## 数据

- `edge_status`（status='congested'/'closed'/'open'）
- `trips.json` 主路线
- `MockBackend.get_alternative_paths()` 算备选

## 提示文案模板

```
⚠️ 交通拥堵

主路线 <edge_id>~<edge_id> 段拥堵
备选路线：<X 条边，<Y> 分钟>
是否切到备选？回复 1 切 / 2 保持
```

## 实现

伪代码（Coordinator 代理）：

```js
const MockBackend = require('../../mock_backend');
const user_trip = await readUserCurrentTrip();
const edge_statuses = await getEdgeStatus(user_trip.edges);
const congested = edge_statuses.filter(e => e.status === 'congested');
if (congested.length >= 2) {
  const alts = await MockBackend.get_alternative_paths(origin, dest, ['walk','metro','drive'], 3);
  await notifyUser({...});
  // 等待用户回复
}
```

## 不做的事

- 不调实时路况 API —— 只读 mockend 数据
- 不做路线评分 —— 用 MockBackend.get_alternative_paths

## 与其他 skill 的关系

- 同 `weather-monitor-skill` / `queue-monitor-skill` 同一逻辑
- 复用 `replan-skill` 入口
- 实际生产可对接高德/百度路况
