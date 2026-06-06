# queue-monitor-skill

> 餐厅排队监控 skill —— Coordinator 主管
> 比赛本地生活相关 skill 之一

## 触发

trip-agent 通过 `replan-skill` 回调时附带 `queue_increase=true` 时，Coordinator 调本 skill。

## 逻辑

```
1. 读 trip 当前行程涉及的餐厅 ID 列表
2. MockBackend.query_nodes({ type: 'restaurant', city: '北京' }) 拿餐厅列表（含 queue_count）
3. 若某餐厅 queue_count > 50:
     queue_heavy = true，标出该餐厅
4. 拼提示文案 + 写 coordinator inbox + 询问用户是否切到备选餐厅
5. 用户回是 → 调 trip 替换
6. 用户回否 → 调 trip 保持
```

## 数据

- `nodes.queue_count`（排队人数）
- `trips.json` 当前行程
- 七维画像 taste 维度（用户偏好菜系）

## 提示文案模板

```
⚠️ 餐厅排队多

<餐厅名> 现在排队 <N> 人
备选：<备选餐厅名>（<评分>，<距离>）
是否切到备选？回复 1 切 / 2 保持
```

## 实现

伪代码（Coordinator 代理）：

```js
const MockBackend = require('../../mock_backend');
const rest = await MockBackend.query_nodes({ type: 'restaurant', city: '北京' });
const user_trip = await readUserCurrentTrip();
const heavy = rest.filter(r => r.queue_count > 50 && user_trip.restaurants.includes(r.id));
if (heavy.length > 0) {
  // 找备选（同菜系、评分高、queue_count < 20）
  const alts = rest.filter(r => r.queue_count < 20 && r.props.cuisine === heavy[0].props.cuisine);
  await notifyUser({...});
  // 等待用户回复
}
```

## 不做的事

- 不改 trip 直接替换
- 不预测排队高峰

## 与其他 skill 的关系

- 同 `weather-monitor-skill` / `traffic-monitor-skill` 同一逻辑
- 复用 `replan-skill` 入口
