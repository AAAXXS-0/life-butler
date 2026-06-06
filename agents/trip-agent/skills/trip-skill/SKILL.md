---
name: trip-skill
description: 行程规划 Skill。为 Trip Agent 提供多日游行程规划能力，基于图模型（节点+边）做POI筛选与路径规划，含备选。
metadata: { "openclaw": { "emoji": "🗺️", "requires": { "bins": ["node"] } } }
---

# Trip Skill

行程规划 Skill，为 Trip Agent 使用。数据来源为 Mock Backend（MySQL 图模型）。

Agent 自身具备 LLM 能力，直接执行以下流程，不需要额外 LLM API 调用脚本。

---

## 核心变化：图模型 + 备选机制

- **数据层**：MySQL 图模型（nodes + edges + status），不再读静态 JSON
- **路径规划**：Dijkstra 最短路径 + 备选路径，不再用 haversine 估算
- **备选**：每个关键节点输出多个备选（餐厅/酒店/路线）

---

## 阶段划分

| 阶段 | 类型 | 执行者 | 数据来源 |
|------|------|--------|---------|
| 阶段一：理解用户意图 | LLM（agent 自行执行） | Agent | — |
| 阶段二：POI 筛选 | 脚本 | `phases/phase2_poi_filter.js` | MockBackend.query_nodes() |
| 阶段三：空间优化 | 脚本（核心算法） | `phases/phase3_spatial_optimizer.js` | MockBackend.get_shortest_path() |
| 阶段四：生成行程文档 | LLM（agent 自行执行） | Agent | 阶段三输出 |

---

## 阶段一：理解用户意图

当用户提供旅行需求时，提取以下结构化信息：

**输出格式（JSON，写入临时文件 `temp/phase1_out.json`）：**
```json
{
  "city": "北京",
  "days": 3,
  "date_range": null,
  "preferences": {
    "poi_types": ["历史遗迹", "博物馆"],
    "food_cuisine": "烤鸭",
    "shopping": true,
    "nightlife": false,
    "nature": false
  },
  "hard_constraints": {
    "must_include": [],
    "must_exclude": []
  },
  "budget_level": null,
  "travelers": 1
}
```

**预算相关字段**：
- `budget_level`：定性预算偏好（如 `"high"`/`"medium"`/`"low"`/未填 `null`）
- 用户**是否明确说了预算金额**（如"预算5000"）→ 写到 `budget_user_specified` 布尔字段（true/false），金额写到 `budget_total`
- 阶段三需要的 `budget_binding`（`"constraint"`/`"reference"`）由 Agent 根据这两项判断（见「预算处理」章节）

**Agent 自行完成，不需要调用脚本。**

---

## 阶段二：POI 筛选（图模型查询）

调用 Mock Backend 从 MySQL 图模型中查询 POI 节点（含实时状态），**每个类别返回多个备选**。

**调用方式（exec 工具）：**
```
node skills/trip-skill/phases/phase2_poi_filter.js <城市> <偏好JSON>
```

**参数：**
- 城市：如 `"北京"`
- 偏好JSON：`{ poi_types: [], food_cuisine: "", shopping: bool, alternatives_count: 3 }`

**内部逻辑**：`MockBackend.query_nodes({ type, city, tags[], max_price, min_rating })` 查 MySQL `nodes` 表，JOIN `node_status` 获取实时状态。

**输出（写入 `temp/phase2_out.json`）：**
```json
{
  "attractions": {
    "primary": [
      { "id": "attr_001", "name": "故宫", "type": "attraction", "category": "历史遗迹",
        "lat": 39.916, "lng": 116.397, "hours": "08:30-17:00", "duration_estimate": 180,
        "rating": 4.8, "tags": ["博物馆", "世界遗产"], "ticket_price": 60,
        "status": "open", "status_reason": null }
    ],
    "alternatives": [
      { "id": "attr_015", "name": "国家博物馆", "reason": "室内场馆，不受天气影响，评分4.9", "status": "open" },
      { "id": "attr_022", "name": "圆明园遗址", "reason": "历史价值高，评分4.7", "status": "open" }
    ]
  },
  "restaurants": {
    "lunch": {
      "primary": { "id": "rest_001", "name": "全聚德", "type": "restaurant", "category": "北京菜", ... },
      "alternatives": [
        { "id": "rest_005", "name": "便宜坊", "reason": "评分4.6，价格适中", "status": "open" },
        { "id": "rest_008", "name": "川菜馆", "reason": "口味好，评分4.8", "status": "open" }
      ]
    },
    "dinner": { ... }
  },
  "hotels": {
    "day1": {
      "primary": { "id": "hotel_001", "name": "王府半岛酒店", "type": "hotel", ... },
      "alternatives": [...]
    }
  },
  "events": []
}
```

**events 字段**：Mock Backend 当前触发的异常事件（如"全聚德满座"），供 Agent 参考。

**Agent 读取 `temp/phase2_out.json` 获取结果，继续阶段三。**

---

## 阶段三：空间优化（图路径规划）

对候选 POI 做空间优化，**基于图模型做最短路径规划**，输出主路线 + 备选路线。

**调用方式（exec 工具）：**
```
node skills/trip-skill/phases/phase3_spatial_optimizer.js <phase2_json> <days> <daily_hours>
```

**参数：**
- phase2_json：阶段二输出的完整 JSON（字符串）
- days：行程天数（如 `3`）
- daily_hours：每日可用小时数（默认 `10`）
- **budget_context**（必传）：JSON 对象，描述预算模式与资金（详见「预算处理」章节）
  - 注入方式：环境变量 `BUDGET_CONTEXT_JSON` 或 stdin

**内部逻辑**：
1. 对每天的 POI 做 K-Means 聚类（按天分组）
2. 组内用 `MockBackend.get_shortest_path()` 做 Dijkstra 路径规划
3. 每个 POI 对之间调用 `get_alternative_paths()` 生成备选路线
4. 插入用餐时段（午餐 12:00-13:00，晚餐 18:00-20:00）
5. **处理 budget_context**（详见「预算处理」章节）：
   - `constraint` 模式：方案总价严格 ≤ `month_remaining`，超支项自动替换为低价选项
   - `reference` 模式：方案可超出 `month_remaining`，warnings 注入超支提示，不硬阻断品质
   - 收集所有警告写入输出 `warnings` 字段

**输出（写入 `temp/phase3_out.json`）：**
```json
{
  "days": [
    {
      "day": 1,
      "routes": {
        "primary": {
          "pois": [
            { "id": "attr_001", "name": "故宫", "arrival": "09:00", "departure": "12:00",
              "path_to_next": { "to_id": "attr_003", "edges": ["edge_012","edge_034"], "duration_min": 20, "distance_m": 2500, "type": "metro" }
            }
          ],
          "meals": {
            "lunch": { "id": "rest_001", "name": "全聚德", "time": "12:00-13:00",
              "options": [
                { "id": "rest_001", "name": "全聚德" },
                { "id": "rest_005", "name": "便宜坊" },
                { "id": "rest_008", "name": "川菜馆" }
              ]},
            "dinner": null
          }
        },
        "alternative": {
          "note": "如主路线受阻，可切换此备选路线",
          "pois": [...]
        }
      }
    }
  ],
  "edge_usage": ["edge_012","edge_034", ...]
}
```

**关键设计**：
- `path_to_next` 替换原来的 `transport_to_next`——精确到具体边（edge ID），而非模糊的"地铁"
- `edge_usage` 列出主路线涉及的所有边，供事件系统断边时快速定位
- 每个用餐时段包含 `options` 数组

**Agent 读取 `temp/phase3_out.json` 获取结果，进入阶段四。**

---

## 阶段四：生成行程文档

根据阶段三输出的有序 POI 序列（含备选），结合用户偏好，生成 markdown 格式行程文档。

**预算警告展示**（详见「预算处理」章节）：
- 读 `phase3_out.json.warnings` 数组
- 如非空，在 Markdown 方案开头以独立段落展示
- 一同写入 `trips.json` 的 `budget.warnings` 字段，供 replan 参考

**Agent 自行完成，不需要调用脚本。**

输出格式参考：
```markdown
# 北京3日游行程

## Day 1（X月X日）

### 09:00-12:00 故宫
- 门票：60元，建议提前预约
- 交通：地铁1号线天安门东站B口出，步行5分钟
- 简介：明清两代皇家宫殿

### 备选：如果故宫人流量大 → 国家博物馆（室内，评分4.9）

### 12:00-13:00 全聚德（烤鸭）
- 人均：200元
- 备选：便宜坊（评分4.6）/ 川菜馆（评分4.8）

...
```

---

## 数据来源

| 数据 | 来源 |
|------|------|
| POI 节点 + 实时状态 | MySQL life_butler_db（MockBackend.query_nodes） |
| 路线 + 距离 + 时间 | MySQL life_butler_db（MockBackend.get_shortest_path） |
| 异常事件 | MySQL events 表（MockBackend.get_active_events） |
| 阶段输出 | `skills/trip-skill/temp/phaseN_out.json` |
| 预算数据 | Account Agent `data/accounts.json` + 七维记忆（`income`/`budget`/`saving_goal`） |

**不再读 `poi/*.json`**——数据全在图模型里。

---

## 预算处理

> Trip Agent 端负责读取 Account/七维数据并构造 budget_context，trip-skill 阶段三负责按模式处理、注入 warnings。详细 Agent 端决策见 `agents/trip-agent/AGENTS.md`「预算边界逻辑」章节。

### 预算模式

| 模式 | 触发条件（由 Agent 判断） | 含义 |
|------|---------------------------|------|
| **constraint** | 用户明确说"预算5000"/"最多花3000" | 严格约束，方案总价 ≤ 用户预算 |
| **reference** | 用户没说预算 | 仅参考，方案可超出月收入，warnings 提示 |

Agent 根据 `phase1_out.budget_user_specified` + `budget_total` 决定模式，写入 `phase3` 调用的 `budget_context.budget_binding` 字段。

### budget_context 数据契约

**输入**（Agent 构造后传入 phase3）：

```json
{
  "budget_binding": "constraint" | "reference",
  "month_remaining": 8500,           // constraint: 用户预算X；reference: Account月可支配
  "user_specified": false,            // 用户是否明确说了预算
  "total_trip_estimate": 5800,       // 当前方案估算总和
  "warnings": [],                     // 输出warnings数组（供存档）
  "effort_goal_matched": {           // 可选：有努力目标匹配时注入
    "name": "冰岛极光之旅",
    "remaining": 25000,
    "saved_amount": 5000
  }
}
```

**注入方式**：
- 环境变量 `BUDGET_CONTEXT_JSON`（推荐，避开 argv 长度限制）
- 或 stdin（兜底）

**输出**（phase3 写入 `phase3_out.json.warnings` 数组）：

每条 warning 是字符串，常用格式：
- 参考模式超支：`"方案估算 {total} 元，超出月可支配 {month_remaining} 元，约为 {ratio} 倍"`
- 约束模式预算不足：`"预算不足，无法完成该行程需求，请提升预算或减少天数/人数"`
- 努力目标提醒：`"本次行程关联努力目标：{name}，剩余 {remaining} 元"`

### phase3 内部处理

**constraint 模式**（`budget_binding = "constraint"`，`user_specified = true`）：
- `month_remaining = 用户预算 X`（**不是** Account 数据）
- 方案总价严格 ≤ X
- 超支的 POI/餐厅/酒店自动替换为低价选项
- 住宿安全底线（安全评级≥3星）不可降级
- 若低价选项仍无法满足基本需求 → warnings 注入调整建议
- 极端情况（仍超预算）→ warnings 注入"预算不足"提示，不阻断生成

**reference 模式**（`budget_binding = "reference"`，`user_specified = false`）：
- `month_remaining = Account月可支配`
- 方案估算可超出 `month_remaining`，**不硬阻断方案品质**
- warnings 注入超支提示
- 若有努力目标相关目的地 → warnings 注入努力目标提醒

### 阶段四：Markdown 展示

Agent 读 `phase3_out.json.warnings` 数组，若非空在 Markdown 方案开头以独立段落展示：

```markdown
## 预算提示

⚠️ 方案估算总花费 5800 元，超出您月收入 5000 元（约为月收入的 1.16 倍），是否确认？
```

并把 warnings 一同写入 `trips.json.budget.warnings` 字段，供后续 replan 参考。

---

## Replan 流程

当 Coordinator 通知某节点受阻时：

```
Coordinator 通知：全聚德今日满座
    ↓
Trip Agent 查看阶段三输出中该用餐时段的 options 数组
    ↓
选择评分相近的备选（如便宜坊）
    ↓
如果备选节点也在不同位置 → 查看 routes.alternative 中的备选路径
    ↓
更新行程文档，标注切换原因
    ↓
通过 butler-comm-skill 通知 Coordinator
```

**不需要调用脚本**，Trip Agent 凭自身 LLM 能力完成判断和切换。

---

## 调试模式

```bash
# 测试阶段二（需要 MySQL 连接）
cd workspace-butler
node skills/trip-skill/phases/phase2_poi_filter.js "北京" '{"poi_types":["历史遗迹"],"food_cuisine":"烤鸭","shopping":false,"alternatives_count":3}'

# 测试阶段三（需要 MySQL 连接）
cd workspace-butler
node skills/trip-skill/phases/phase3_spatial_optimizer.js '{"attractions":{"primary":[...]}}' 3 10
```