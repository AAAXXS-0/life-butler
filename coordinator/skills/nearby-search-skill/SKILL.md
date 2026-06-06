# nearby-search-skill

> 附近搜索 skill —— Coordinator 主管
> 比赛本地生活相关 skill 之一

## 触发

用户主动问："附近有啥吃的" / "这附近有啥好玩的" / "我想找个地方歇会儿" 等

## 关键决策：不主动问位置

**老板拍板**：从 `trips.json` 当前行程的当前位置直接取 lat/lng 作为搜索中心。

```
用户："附近有啥吃的"
   ↓
读 trips.json → 找 status=ongoing 的 trip
   ↓
拿当前所在 POI 的 lat/lng（如有 transport_hub 当前为最近点）
   ↓
用 (lat, lng) 作为搜索中心
   ↓
MockBackend.query_nodes({ type, city, near, radius_km })
```

## 数据

- `trips.json`（当前行程 + 当前位置）
- `MockBackend.query_nodes({ type, city, near, radius_km })` —— 需 index.js 支持 near/radius
- `accounts.json`（消费习惯 / 预算）
- `schedule.json`（是否有后续日程影响时间）
- 七维画像 taste 维度（用户偏好）
- 七维画像 effort_goal（是否有攒钱目标 → 收紧预算）

## 逻辑

```
1. 读 trips.json → 取当前 trip → 取当前 POI lat/lng
2. 推断用户想搜什么（吃 / 玩 / 歇）：
   - 吃 → type=restaurant
   - 玩 → type=attraction
   - 歇 → type=hotel 或 attraction（公园）
3. 调 query_nodes 拿附近 5km 内 POI 列表
4. 排序权重：
     - 距离（30%）
     - 评分（30%）
     - 开放状态（20%）
     - 与 taste 偏好匹配（20%）
5. 取 top 3
6. 推荐给用户
```

## 输出模板

```
📍 你现在在 <当前位置> 附近

推荐 3 个：
1. <name>（<类型>，<距离>km，评分<rating>）
   <一句话原因，如「和你的口味匹配」「北京菜」>
2. ...
3. ...
```

## 实现

伪代码（Coordinator 代理）：

```js
const MockBackend = require('../../mock_backend');
const fs = require('fs');

// 1. 拿当前 trip + 位置
const trips = JSON.parse(fs.readFileSync('agents/trip-agent/data/trips.json', 'utf8'));
const cur = trips.find(t => t.status === 'ongoing') || trips[trips.length - 1];
const center = cur.current_location || cur.last_poi;

// 2. 推断 type
const text = user_message;
let type = 'attraction';
if (/吃|餐|饭|咖啡|茶/.test(text)) type = 'restaurant';
if (/歇|住|酒店/.test(text)) type = 'hotel';
if (/玩|景点|看/.test(text)) type = 'attraction';

// 3. 搜索
const candidates = await MockBackend.query_nodes({
  type, city: '北京', near: { lat: center.lat, lng: center.lng, radius_km: 5 }
});

// 4. 排序（伪代码）
const ranked = candidates.map(c => ({
  ...c,
  score: distScore(c) + ratingScore(c) + openScore(c) + tasteScore(c, profile)
})).sort((a, b) => b.score - a.score).slice(0, 3);

await notifyUser({...});
```

## 不做的事

- 不调第三方地图 API —— 用 mockend
- 不做个性化推荐模型 —— 简单加权
- 不存历史搜索

## 与其他 skill 的关系

- 独立 skill，**不**走 trip-agent 回调
- 直接由 Coordinator 触发
- 数据只读，不写任何状态
