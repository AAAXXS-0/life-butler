# weather-monitor-skill

> 天气活动抓取 skill —— Coordinator 主管
> 比赛本地生活相关 skill 之一

## 触发

trip-agent 通过 `replan-skill` 回调时附带 `weather_change=true` 时，Coordinator 调本 skill。

## 逻辑

```
1. 读 mock_backend.weather 表（get_weather('北京')）
2. 读 trips.json 当前行程的室外 POI 数量
3. 若 status ∈ {rainy, sandstorm, typhoon} 且室外 POI > 0:
     weather_affected = true
4. 拼提示文案 + 写 coordinator inbox + 询问用户是否更换行程
5. 用户回是 → 调 trip 切到备选（多室内 POI）
6. 用户回否 → 调 trip 保持原行程
```

## 数据

- `weather` 表（status, temperature, updated_at）
- `trips.json`（itinerary，含 POI 列表）
- `nodes.is_indoor` 字段（用于筛选室内备选）

## 提示文案模板

```
⚠️ 天气变了

当前北京：<status>，<temperature>°C
行程涉及 <N> 个室外 POI（<names>）
备选行程已生成：<M> 个室内 POI（<names>）

是否切换？回复 1 切换 / 2 保持
```

## 实现

伪代码（Coordinator 在代理此 skill 时执行）：

```js
const MockBackend = require('../../mock_backend');
const Trip = require('../trip-skill');
const user_trip = await readUserCurrentTrip();
const weather = await MockBackend.get_weather('北京');

if (['rainy','sandstorm','typhoon'].includes(weather.status)) {
  const outdoor = user_trip.pois.filter(p => !p.is_indoor);
  if (outdoor.length > 0) {
    const indoor_alt = user_trip.pois.filter(p => p.is_indoor);
    await notifyUser({...});
    // 等待用户回复
  }
}
```

## 不做的事

- 不直接改 trip —— 必须经用户确认
- 不发推送 —— 通过 shared/coordinator/inbox 走 channel
- 不做天气预测 —— 只读当前状态

## 文件

- SKILL.md（本文件）
- 无额外脚本 —— 由 Coordinator 在代理时直接调

## 与其他 skill 的关系

- **queue-monitor-skill**：餐厅排队增多时，逻辑同本 skill
- **traffic-monitor-skill**：交通拥堵时，逻辑同本 skill
- 3 个 skill **逻辑一样**，区别只在触发条件和提示文案
- **replan-skill**：trip-agent 内部使用，触发本 skill 的入口
- **nearby-search-skill**：独立 skill，用户主动问时调用
