# taxi-skill

> 打车 skill —— Coordinator 主管
> 比赛本地生活相关 skill 之一
> 触发：用户独立叫车请求（不在 trip 框架内）
> 状态机：called → dispatched → arriving → arrived → onboard/cancelled/completed

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
排序 → top 3 → 推给用户选
   ↓
用户选 → 调 estimate_taxi_eta(stand_id, user_lat, user_lng)
   ↓
写一条 call 记录到 coordinator/data/taxi_state.json（state=called）
   ↓
注册 OpenClaw at cron：dispatch_min 后触发
   ↓
通知用户："已叫车，预计 X min 后到"
```

## 状态机

7 个状态，记录在 `coordinator/data/taxi_state.json` 的 `calls[]` 数组里：

| 状态 | 含义 | 持续时间 | 触发转移 |
|------|------|---------|---------|
| `called` | 用户已叫车，等待调度 | ~1 min | at cron 1 min 后 → `dispatched` |
| `dispatched` | 司机接单，开过来 | wait_min + drive_min | at cron ETA-1 min 时 → `arriving` |
| `arriving` | 车 1 min 内到 | < 1 min | at cron ETA 到时 → `arrived` |
| `arrived` | 车已到达，等用户上车 | 5 min 超时 | 用户确认上车 → `onboard`；超时未上 → `cancelled` |
| `onboard` | 用户已上车 | 至下车 | 司机点击结束 → `completed` |
| `cancelled` | 用户/司机取消 | 永久 | — |
| `completed` | 行程结束 | 永久 | 可选：写 `schedule.json` 一条 event 备忘 |

### 状态推进时序

```
T+0min:    user says "叫车" → state=called, 通知用户
T+1min:    at cron [dispatch] 触发 → state=dispatched, 通知用户"司机接单，开过来"
T+ETA-1:   at cron [arriving] 触发 → state=arriving, 通知用户"车快到了"
T+ETA:     at cron [arrived] 触发  → state=arrived, 通知用户"车到了，5 min 内不上车取消"
T+ETA+5:   at cron [timeout] 触发  → state=cancelled, 通知用户"超时已取消"
           用户主动确认 → state=onboard
           司机点击结束 → state=completed
```

## ETA 计算

**关键区分**：等车时间 ≠ 距离

| 组成 | 来源 | 是不是距离的函数 |
|------|------|---------------|
| `dispatch_min`（调度时间）| 平台分配司机 | ❌ 常量 1 min |
| `wait_min`（排到空车）| `taxi_stand.props.avg_wait_min`（写死）| ❌ 跟时段/地点/queue_count 有关 |
| `drive_min`（车开过来）| `haversine(stand, user) × 2.5min/km` | ✅ 距离的函数 |

**接口**：`MockBackend.estimate_taxi_eta(stand_id, user_lat, user_lng)` → 返回全部字段 + 价格估算

```js
const eta = await MockBackend.estimate_taxi_eta('taxi_001', 39.9163, 116.3972);
// {
//   stand_id: 'taxi_001',
//   stand_name: '国贸打车点',
//   distance_km: 2.34,
//   drive_min: 6,
//   wait_min: 3,
//   dispatch_min: 1,
//   total_eta_min: 10,
//   price_yuan: 14.6,
//   queue_count: 8,
//   status: 'open'
// }
```

**计价规则**（北京近似）：起步 13 元 (3km 内) + 后续 2.3 元/km

## 延迟通知机制：OpenClaw `at` cron

派车时**动态注册** 4 个 `at` cron（dispatched / arriving / arrived / timeout），到点自动跑一次，跑完自动删。

**注册模板**（Coordinator 派车时执行）：

```js
const cron = require('child_process').execSync;
const callId = 'taxi_' + Date.now();
const eta = await MockBackend.estimate_taxi_eta(standId, userLat, userLng);

const T0 = Date.now();
const T_DISPATCH = T0 + 60_000;                                  // +1 min
const T_ARRIVING = T0 + (eta.total_eta_min - 1) * 60_000;        // ETA-1
const T_ARRIVED  = T0 + eta.total_eta_min * 60_000;              // ETA
const T_TIMEOUT  = T0 + (eta.total_eta_min + 5) * 60_000;        // ETA+5

function regAt(name, at, msg) {
  cron(`openclaw cron add \
    --name "${name}" \
    --agent coordinator \
    --schedule kind=at,at=${new Date(at).toISOString()} \
    --message "${msg}" \
    --delete-after-run`);
}

regAt(`taxi-${callId}-dispatch`,  T_DISPATCH, '推进 taxi_state callId=' + callId + ' 至 dispatched，通知用户');
regAt(`taxi-${callId}-arriving`,  T_ARRIVING, '推进 taxi_state callId=' + callId + ' 至 arriving，通知用户');
regAt(`taxi-${callId}-arrived`,   T_ARRIVED,  '推进 taxi_state callId=' + callId + ' 至 arrived，通知用户');
regAt(`taxi-${callId}-timeout`,   T_TIMEOUT,  '推进 taxi_state callId=' + callId + ' 至 cancelled（超时未上车）');
```

**关键参数**：
- `kind=at,at=<ISO-8601>`：单次触发
- `--delete-after-run`：跑完自动删（避免 cron 列表污染）
- `--agent coordinator`：触发 Coordinator
- `--message`：到点执行的内容

## 数据

| 数据 | 来源 | 用途 |
|------|------|------|
| 当前位置 | `trips.json`（current_location）| 搜索中心 |
| 当前位置备选 | `schedule.json`（最新 event.location）| trip 不在时兜底 |
| 附近打车点 | `MockBackend.query_nodes({ type: 'taxi_stand', near, radius_km: 2 })` | 主数据 |
| 实时 ETA + 价格 | `MockBackend.estimate_taxi_eta(stand_id, user_lat, user_lng)` | 关键接口 |
| 天气 | `weather` 表 | 台风/沙尘暴时不推荐打车 |
| 预算 | `accounts.json`（monthly_disposable）| 价格提示 |
| **叫车状态** | **`coordinator/data/taxi_state.json`** | 状态机持久化 |

## 排序权重（找打车点时）

```
score = 距离 (30%) + queue_count (30%) + 状态 (20%) + 价格 (20%)
- 距离：越近越高
- queue_count：越多越好（taxi_stand 节点自带字段）
- 状态：open 满分，limited 减半，full/closed 排除
- 价格：根据 distance × 2.3 元/km + 13 元起步估算
```

## 输出模板

### 阶段 1：列 3 个候选
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

### 阶段 2：用户选了之后
```
✅ 已叫车！

🚖 上车点：国贸打车点
⏰ 预计等待：1 min（调度）+ 3 min（排队）+ 6 min（车开过来）= 10 min
💰 预计价格：14.6 元
📍 你在：[当前位置名]

到了会通知你。
```

### 阶段 3：到点通知
```
🚖 车已派出
司机正在开过来，距你 ~6 min

(3 min 后)
🚖 车快到了
1 min 内到

(0 min 时)
🚖 车到了
在 [上车点] 等你，5 min 内不上车自动取消
```

## 实现

伪代码（Coordinator 代理）：

```js
const MockBackend = require('../../mock_backend');
const fs = require('fs');
const path = require('path');

const TAXI_STATE_PATH = path.resolve(__dirname, '../../data/taxi_state.json');

function loadTaxiState() {
  return JSON.parse(fs.readFileSync(TAXI_STATE_PATH, 'utf8'));
}
function saveTaxiState(s) {
  fs.writeFileSync(TAXI_STATE_PATH, JSON.stringify(s, null, 2), 'utf8');
}

// === 阶段 1：找候选打车点 ===
async function findStands(userLat, userLng) {
  const stands = await MockBackend.query_nodes({
    type: 'taxi_stand', city: '北京',
    near: { lat: userLat, lng: userLng, radius_km: 2 }
  });
  return stands
    .filter(s => s.status === 'open' || s.status === 'limited')
    .sort((a, b) => b.queue_count - a.queue_count)
    .slice(0, 3);
}

// === 阶段 2：叫车 + 注册 at cron ===
async function callTaxi(standId, userLat, userLng, callId) {
  const eta = await MockBackend.estimate_taxi_eta(standId, userLat, userLng);
  const state = loadTaxiState();
  state.calls.push({
    id: callId,
    stand_id: standId,
    stand_name: eta.stand_name,
    user_lat: userLat,
    user_lng: userLng,
    state: 'called',
    eta: eta,
    created_at: Date.now(),
    history: [{ state: 'called', at: Date.now() }],
  });
  saveTaxiState(state);
  // 注册 4 个 at cron（dispatched/arriving/arrived/timeout）
  registerTaxiCrons(callId, eta);
  return eta;
}

// === 阶段 3：at cron 触发时推进状态 ===
function advanceState(callId, newState, note) {
  const state = loadTaxiState();
  const call = state.calls.find(c => c.id === callId);
  if (!call) return;
  call.state = newState;
  call.history.push({ state: newState, at: Date.now(), note });
  saveTaxiState(state);
  // 通知用户（走 shared/coordinator/...json + channel）
  notifyUser({...});
}
```

## 不做的事

- 不调第三方地图 API（高德/滴滴）—— 用 mockend
- 不做订单状态追踪（mockend event_generator 模拟）
- 不做支付集成
- 不改 trip —— trip 内的接驳走 trip-skill 阶段三

## 文件

- `SKILL.md`（本文件）
- `../../data/taxi_state.json` —— 状态机持久化（运行时数据，可 gitignore）
- 无额外脚本 —— 由 Coordinator 在代理时直接调

## 与其他 skill 的关系

- **trip-skill**：trip 内的接驳由 trip-skill 阶段三的 `taxi` edge 处理
- **traffic-monitor-skill**：trip 内交通拥堵时切备选，跟独立叫车无关
- **nearby-search-skill**：用户主动搜"附近"，本 skill 是搜"附近打车点"——目的不同
- **replan-skill**：trip-agent 内部用，触发 trip 内的 taxi 切换，不调本 skill

## 异常处理

| 场景 | 处理 |
|------|------|
| 天气 typhoon/sandstorm | 不推荐打车，建议专车或等天气好转（不进入状态机）|
| taxi_stand status=closed | 过滤掉，不在候选列表 |
| queue_count=0 | warning 提示"附近暂无车，建议走其他方式" |
| 用户选了之后 1 min 内取消 | 直接 advance 到 cancelled，删除 4 个 at cron |
| 司机取消（mock 不会发生）| 模拟：advance 到 cancelled + 提示 |
| ETA 计算失败 | 回退到默认值（wait=3, drive=haversine×3）|
