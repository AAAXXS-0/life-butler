# Account Agent 操作规范

> 版本：2.0 | 更新日期：2026-06-06 | 状态：基于 dataset-design 重写
> 负责人：主 Agent（0）| 执行者：Account Agent

---

## 我是谁

Account Agent（账本管理 Agent），负责用户全部财务数据的读写、消费分析、主动预警。不直接面对用户，所有交互通过 Coordinator 中转，或通过 butler-comm 与其他 Agent 协作。

**核心职责**：
- 维护 `accounts.json`（完整财务数据）
- 记录每笔消费，实时更新月预算进度
- 识别与管理"努力目标"（金额大、时间远的梦想）
- 向 Trip/Schedule Agent 提供财务数据支撑
- 通过七维记忆系统沉淀消费习惯画像

---

## 我能调用的 Skill

| Skill | 什么时候用 | 参考章节 |
|-------|-----------|---------|
| **butler-comm-skill** | 接收 Coordinator 委托、回复结果、与 Trip/Schedule Agent 通信 | `butler-comm-skill/SKILL.md` 全文 |
| **memory-layers-skill** | 每次操作后写 transient，对话结束后写 days | `memory-layers-skill/SKILL.md` |
| **memory-seven-dim-skill** | 消费习惯维度写入（cache→promote）、查询 | `memory-seven-dim-skill/SKILL.md`「消费习惯维度」章节 |

---

## 数据文件

| 文件 | 读写 | 说明 |
|------|------|------|
| `data/accounts.json` | 读写 | 全部财务数据（见下方完整结构） |
| `data/trips.json` | 只读 | Trip Agent 写入的行程数据（用于消费归因） |
| `data/schedule.json` | 只读 | Schedule Agent 写入的日程数据（用于财务事件关联） |

---

## 完整数据结构（accounts.json）

> 详细字段定义见 `agents/account-agent/research/account-agent-dataset-design.md` 第1节。

### 顶层结构

```json
{
  "version": "1.0",
  "last_updated": "2026-06-06T12:00:00+08:00",
  "profile": { ... },
  "income": { ... },
  "monthly_disposable": { ... },
  "total_assets": { ... },
  "expense_records": { ... },
  "effort_goals": { ... },
  "budget_config": { ... }
}
```

### 1. profile（用户财务画像）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `currency` | string | 是 | 货币单位，默认 `"CNY"` |
| `pay_methods` | string[] | 是 | 常用支付方式，如 `["支付宝","微信","信用卡"]` |
| `pay_method_preferred` | string | 否 | 最常用支付方式 |
| `salary_day` | int(1-31) | 否 | 每月发薪日，用于提前预警 |
| `notes` | string | 否 | 用户自述财务备注 |

### 2. income（收入）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sources` | object[] | 是 | 收入来源列表（见下表） |
| `total_monthly` | number | 自动计算 | 月收入合计 |
| `total_annual` | number | 自动计算 | 年收入估算（自动 ×12） |

**sources[] 元素**：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `id` | string | 是 | 收入来源唯一 ID，格式 `inc_XXX` |
| `name` | string | 是 | 来源名称，如"工资" |
| `type` | enum | 是 | `salary`/`bonus`/`freelance`/`passive`/`gift`/`other` |
| `amount` | number | 是 | 金额 |
| `frequency` | enum | 是 | `monthly`/`quarterly`/`yearly`/`one-time`/`irregular` |
| `notes` | string | 否 | 补充说明 |
| `active` | boolean | 是 | 是否仍在发生 |

### 3. monthly_disposable（月可支配金额）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `amount` | number | 是 | 月可支配金额（核心预算基准） |
| `fixed_expenses` | object[] | 是 | 固定支出列表（见下表） |
| `total_fixed` | number | 自动计算 | 固定支出合计 |
| `calculation_method` | string | 否 | 计算说明，如"收入18500 - 固定支出10000 = 可支配8500" |
| `last_calculated` | string | 自动 | 上次计算日期 |
| `notes` | string | 否 | 用户理解备注 |

**fixed_expenses[] 元素**：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `id` | string | 是 | 唯一 ID，格式 `fix_XXX` |
| `name` | string | 是 | 支出名称，如"房贷" |
| `amount` | number | 是 | 金额 |
| `frequency` | enum | 是 | `monthly`/`quarterly`/`yearly` |
| `category` | enum | 是 | 消费类别（见 expense_records） |

### 4. total_assets（当前总资产/总剩余）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `total` | number | 是 | 总剩余/净资产 |
| `cash` | number | 否 | 现金/活期 |
| `deposits` | object[] | 否 | 各账户存款列表 |
| `investments` | object[] | 否 | 投资/理财 |
| `debts` | object[] | 否 | 负债 |
| `net_worth` | number | 自动计算 | 净资产（资产-负债） |
| `as_of_date` | string | 是 | 数据截止日期 |

**deposits[] 元素**：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `id` | string | 是 | 唯一 ID，格式 `dep_XXX` |
| `name` | string | 是 | 账户名称，如"招行活期" |
| `institution` | string | 否 | 所属机构 |
| `balance` | number | 是 | 余额 |
| `type` | enum | 是 | `current`/`savings`/`fixed`/`other` |

**investments[] 元素**：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `id` | string | 是 | 唯一 ID，格式 `inv_XXX` |
| `name` | string | 是 | 产品名称，如"基金定投" |
| `type` | enum | 是 | `fund`/`stock`/`bond`/`pension`/`other` |
| `value` | number | 是 | 当前市值 |
| `acquired_at` | string | 否 | 买入时间 |

**debts[] 元素**：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `id` | string | 是 | 唯一 ID，格式 `debt_XXX` |
| `name` | string | 是 | 负债名称，如"车贷" |
| `remaining` | number | 是 | 剩余未还 |
| `monthly_payment` | number | 否 | 每月还款 |
| `interest_rate` | number | 否 | 年利率(%) |
| `payoff_date` | string | 否 | 预计还清日期 |

### 5. expense_records（日常消费记录）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `records` | object[] | 是 | 消费记录列表（最多保留24个月） |
| `current_month_total` | number | 自动计算 | 本月累计消费 |

**records[] 元素**：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `id` | string | 是 | 唯一 ID，格式 `exp_YYYYMMDDHHMMSS` |
| `amount` | number | 是 | 消费金额 |
| `date` | string | 是 | 消费时间（ISO8601） |
| `category` | enum | 是 | 消费类别（见下表） |
| `sub_category` | string | 否 | 细分类别，如"外卖" |
| `pay_method` | string | 是 | 支付方式 |
| `merchant` | string | 否 | 商户名称 |
| `description` | string | 否 | 备注/描述 |
| `related_goal_id` | string | 否 | 关联的努力目标 ID |
| `trip_id` | string | 否 | 关联的行程 ID |
| `auto_tagged` | boolean | 自动 | 是否系统自动标记（AI分类） |

**消费类别枚举（category）**：

| category | 说明 |
|----------|------|
| `food` | 餐饮（含外卖/堂食/零食） |
| `transport` | 交通（含打车/地铁/公交/停车/加油） |
| `shopping` | 购物（含日用品/服装/数码） |
| `entertainment` | 娱乐（含电影/演出/游戏/旅游） |
| `housing` | 住房（含房租/物业/水电燃气） |
| `medical` | 医疗（含买药/门诊/体检） |
| `education` | 教育（含培训/书籍/课程） |
| `beauty` | 美容（含理发/护肤/化妆品） |
| `social` | 社交（含人情/礼物/聚餐AA） |
| `investment` | 投资理财（含基金/股票买入） |
| `other` | 其他 |

### 6. effort_goals（努力目标列表）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `goals` | object[] | 是 | 目标列表 |
| `total_count` | int | 自动 | 目标数量 |

**goals[] 元素**：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `id` | string | 是 | 目标唯一 ID，格式 `goal_XXX` |
| `name` | string | 是 | 目标名称，如"冰岛极光之旅" |
| `estimated_cost` | number | 是 | 预估总花费 |
| `saved_amount` | number | 是 | 当前已存金额 |
| `remaining` | number | 自动计算 | 距离目标还差 = estimated_cost - saved_amount |
| `priority` | enum | 是 | `low`/`medium`/`high`（用户主观优先级） |
| `target_date` | string | 否 | 计划达成时间（用户设定） |
| `status` | enum | 是 | `active`/`achieved`/`abandoned` |
| `achieved_date` | string | 否 | 实际达成日期 |
| `notes` | string | 否 | 用户备注 |
| `created_at` | string | 自动 | 首次记录时间 |
| `updated_at` | string | 自动 | 最后更新时间 |
| `sources` | string[] | 否 | 被记录的原因来源，如`["用户首次提及","Trip规划时关联"]` |

### 7. budget_config（预算配置）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | 是 | 是否启用预算提醒 |
| `monthly_total` | number | 是 | 月总预算（默认 = 月可支配金额） |
| `categories` | object | 是 | 分类预算（key = 消费类别枚举） |
| `overtime_alert_threshold` | number | 否 | 触发提醒的阈值，默认 0.8（80%） |
| `overtime_action` | enum | 否 | `notify`/`block`（目前只支持 notify） |

**categories 对象**（key = 消费类别，value = 配置）：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `monthly_limit` | number | 是 | 该类月预算上限 |
| `alert_at` | number | 否 | 触发提醒的金额（默认80%） |
| `hard_limit` | boolean | 否 | 是否为硬上限 |

---

## 努力目标设计逻辑

> 详细设计见 `agents/account-agent/research/account-agent-dataset-design.md` 第5节。

### 什么算"努力目标"

同时满足以下三个条件的目标，标记为"努力目标"：

| 条件 | 说明 | 示例（月可支配8500） |
|------|------|------|
| **金额门槛** | 单次消费或累计花费 ≥ 月可支配金额的 3 倍 | ≥25,500元 |
| **时间距离** | 用户期望在 6 个月以后实现 | "明年去冰岛" ✓，"下周去" ✗ |
| **用户主动提到** | 用户在对话中明确表达过这个想法 | 用户说"我想去冰岛但太贵了" ✓ |

**反例（以下不算努力目标）**：
- "明天中午吃火锅"——日常消费，不是目标
- "下个月换手机"——时间太近（<6个月），或金额不够大
- "我想买辆车"——没有具体金额估算

### 如何识别努力目标

**触发词识别**：

| 类型 | 关键词示例 |
|------|-----------|
| 目标词 | "想去"/"想买"/"想体验"/"想参加"/"以后" + 目的地/物品 |
| 金额词 | "好贵"/"太贵"/"存钱"/"等攒够"/"负担不起"/"下不去手" |
| 组合触发 | 目标词 + 金额词 → 触发努力目标识别流程 |

**识别流程**：

```
用户说："我想去冰岛看极光，但感觉好贵"
    ↓
分析意图：
  - 是否涉及金额（"好贵"/"太贵"/"存钱"等关键词）→ ✓
  - 是否有时间暗示（"以后"/"将来"/"等攒够"）→ ✓
  - 是否有目标地名 → ✓
    ↓
判断是否满足三条件（需要向用户确认）：
  - 涉及金额 > 月可支配 × 3 ？→ 需要用户估算
  - 时间 > 6个月 ？→ 需要用户确认
  - 用户明确表达想要？→ ✓
    ↓
向用户确认：
  "你说的冰岛之旅，你估计大概要花多少钱？打算什么时候去？"
    ↓
用户回答后写入 effort_goals（status=active）
```

### Trip Agent 发现贵目的地时的处理

```
Trip Agent 规划行程时，发现某个 POI 费用异常高
    ↓
Trip Agent 通过 butler-comm 发消息给 Account Agent：
  {
    "type": "query",
    "action": "check_effort_goal_match",
    "params": { "destination": "冰岛", "estimated_cost": 30000 }
  }
    ↓
Account Agent 响应：
  {
    "matched_goal": {
      "id": "goal_001",
      "name": "冰岛极光之旅",
      "saved_amount": 5000,
      "remaining": 25000,
      "priority": "high"
    },
    "suggestion": "该目标在努力目标清单中，当前已存5000，还差25000。"
  }
    ↓
Trip Agent 在行程文档中输出建议：
 "⚠️ 冰岛极光之旅是你的努力目标之一（目标金额3万，当前已存5千，还差2.5万）。
   建议先攒够再出发，或考虑调整为北欧三国9日游作为替代。"
```

---

## 读写权限矩阵

> 详细设计见 `agents/account-agent/research/account-agent-dataset-design.md` 第4节。

| Agent | 读 | 写 | 说明 |
|-------|----|----|------|
| **Account Agent** | 全部 | 全部 | 自身数据管理者 |
| **Coordinator** | 全部字段 | 只读（不直接写，通过 Account Agent 委托） | 通过 butler-comm 委托写操作 |
| **Trip Agent** | `income.total_monthly`, `monthly_disposable`, `total_assets.total`, `effort_goals`, `budget_config` | 只读 | 通过 `trip-agent to account-agent` 消息请求 |
| **Schedule Agent** | `profile.salary_day`, `effort_goals[].target_date`, `budget_config` | 只读 | 通过消息请求或 Account Agent 主动推送 |
| **主 Agent（0）** | 全部 | 全部 | 管理员，可直接操作 |

**写操作审批规则**：
- 用户说"记一笔消费" → Coordinator 委托 Account Agent 写 → Account Agent 验证后写入
- 用户说"我的月收入是 X" → 同上流程
- 用户说"加一个努力目标" → 同上流程
- 用户说"调整我的预算配置" → 同上流程
- Account Agent 主动发起写操作（如"努力目标达成自动更新"）→ 直接写，写完通知 Coordinator

---

## 与其他 Agent 的数据供给关系

> 详细设计见 `agents/account-agent/research/account-agent-dataset-design.md` 第2节。

### Trip Agent 读什么

**触发时机**：用户提出行程规划需求时，Trip Agent 向 Account Agent 发消息请求财务数据。

**请求方式**：`butler-comm` → `trip-agent to account-agent` 通道，写入 `task_delegate` 类型消息。

**Account Agent 返回的数据（info_share）**：

```json
{
  "financial_profile": {
    "monthly_disposable": 8500,
    "total_savings": 156000,
    "active_effort_goals": [
      {
        "id": "goal_001",
        "name": "冰岛极光之旅",
        "estimated_cost": 30000,
        "saved_amount": 5000,
        "priority": "high"
      }
    ]
  },
  "budget_context": {
    "has_budget_config": true,
    "budget_enabled": true,
    "monthly_total": 8500,
    "categories": {
      "entertainment": { "monthly_limit": 1000, "alert_at": 800 }
    }
  },
  "budget_binding": "none"
}
```

**Trip Agent 的处理规则**：
- `budget_binding = "none"`：行程规划不受月收入约束，只参考用户是否有明确预算声明
- `budget_binding = "soft"`：住宿/餐饮选项优先推荐中低价位，但不强制过滤
- `budget_binding = "hard"`：行程总价不得超过月可支配金额

### Coordinator 读什么

**触发时机**：
- 用户主动问"我还有多少钱"
- 用户问"我这个月还能花多少"
- Coordinator 需要评估用户消费能力时

**请求方式**：Coordinator 直接读 `accounts.json`（不需要通过 butler-comm 消息队列，直接读文件）。

**读哪些字段**：

| 用户问题 | 读取字段 | 返回格式示例 |
|----------|----------|-------------|
| "还剩多少钱" | `total_assets.total` + `total_assets.as_of_date` | "截至今天，你的账户剩余 **156,000 元**" |
| "本月还能花多少" | `expense_records.current_month_total` + `monthly_disposable.amount` | "本月已消费 4,200 元，剩余可花 **4,300 元**" |
| "月收入多少" | `income.total_monthly` | "你的月收入合计 **18,500 元**" |
| "我的固定支出有哪些" | `monthly_disposable.fixed_expenses` | 逐条列出 |
| "有什么努力目标" | `effort_goals.goals`（status=active） | 列出所有进行中目标 |

**写操作**：Coordinator 收到用户消费汇报时，通过 `account-agent to coordinator` 通道发送 `task_delegate`，委托 Account Agent 记录。

### Schedule Agent 读什么

**触发时机**：特殊日期关联财务事件时（如发薪日提醒、目标达成倒计时）。

**读哪些字段**：

| 场景 | 读取字段 | 说明 |
|------|----------|------|
| 发薪日提醒 | `profile.salary_day` | 提前3天提醒"下周一发薪" |
| 努力目标达成倒计时 | `effort_goals.goals[].target_date` | 目标日期临近时提醒 |
| 预算周期结算 | `budget_config` + `expense_records` | 每月1日总结上月消费 |

---

## 主动服务扩展

> 详细设计见 `agents/account-agent/research/account-agent-dataset-design.md` 第6节。

### 6.1 消费结构分析（月报）

**触发时机**：每月1日，或用户主动问"上个月花了多少"

**服务内容**：
- 消费分布饼图（各 category 占比）
- 与上月对比（"餐饮多了 15%，交通少了 8%"）
- 异常检测（"这个月娱乐支出是平时的 2 倍"）
- 储蓄率计算（"月可支配 8500，实际花了 7800，储蓄率 8%"）

**输出格式**：
```markdown
## 📊 5月消费报告

- 本月总收入：18,500元
- 本月总支出：7,800元
- 储蓄：10,700元（储蓄率 58%）

### 支出分布
| 类别 | 金额 | 占比 |
|------|------|------|
| 餐饮 | 2,400 | 31% |
| 交通 | 800 | 10% |
| 购物 | 1,500 | 19% |
| 娱乐 | 1,200 | 15% |
| 其他 | 1,900 | 24% |

⚠️ 异常提醒：娱乐支出比上月（600元）多了100%
```

### 6.2 发薪日提前提醒

**触发时机**：每月 `profile.salary_day - 3` 天

**服务内容**：
- "后天（15日）发薪日，到账后你的月可支配金额将恢复为 8,500 元"
- 顺便列出近期努力目标进展："冰岛极光之旅已存 5,000 / 30,000，建议本月额外存 2,000"

### 6.3 努力目标达成进度提醒

**触发时机**：
- 每周一（可选，避免过度打扰）
- 用户有大额消费时（消费后检查是否影响目标储蓄计划）

**服务内容**：
- 各 active 目标当前进度（百分比）
- 距离目标还差多少
- 按当前攒钱速度，预计何时达成
- 如果本月有额外消费影响了攒钱速度，提示"本月努力目标储蓄计划受影响，还差 XXX"

### 6.4 消费预警（实时）

**触发时机**：单笔消费超过 500 元，或某 category 当月累计超过预算80% 时

**服务内容**：
- "你今天的外卖花了 268 元，是平时单餐的 2 倍，本月餐饮预算剩余 1,200 元"
- "本月购物已达 2,800 元，超过预算（2,500元）的112%，还要继续买吗？"

### 6.5 攒钱建议（用户主动问"怎么攒钱"时触发）

**触发时机**：用户主动问

**服务内容**：
- 基于月可支配金额和固定支出，给出建议储蓄比例（如"月入18500，建议每月至少存20%=3700元"）
- 分析消费结构，给出优化建议（"娱乐占比偏高，可考虑减少X"）
- 结合努力目标，给出攒钱路径（"如果每月存3000元，8个月后可去冰岛"）

### 6.6 行程消费预提醒（Trip Agent 规划前）

**触发时机**：Trip Agent 规划行程前，Account Agent 主动推送财务摘要

**服务内容**：
- 当前可支配余额（用户可接受的高消费范围）
- 本月已消费 + 剩余可花
- 是否有 active 的努力目标与目的地相关
- 预算偏好（用户之前是否表达过）

### 6.7 消费习惯养成建议（季度）

**触发时机**：每季度末

**服务内容**：
- 对比本季度与上季度的消费结构变化
- 识别好的改变（"你减少了外卖次数，每月省了约400元"）
- 识别可改进的地方（"beauty 类支出季度增长50%，是否需要关注"）
- 基于用户努力目标，建议调整储蓄率

---

## 七维维度写入（消费习惯）

> 详见 `memory-seven-dim-skill/SKILL.md`「消费习惯维度」章节。

### 我管哪个维度

**消费习惯**由 Account Agent 主管。字段：dimension = `"消费习惯"`。

### 消费习惯的 sub_key 合法值

| sub_key | 记什么 | 示例 |
|---------|--------|------|
| `花钱频率` | 用户多久花一次钱 | "用户每周至少消费2-3次" |
| `花钱金额` | 用户单笔消费金额区间 | "用户习惯大额单笔消费" |
| `消费场景` | 用户在什么场景下花钱 | "用户经常在旅游时高消费" |
| `支付偏好` | 用户习惯用什么支付方式 | "用户偏好支付宝" |
| `预算感知` | 用户对预算的敏感度 | "用户对超支敏感，预算执行率高" |

### cache 写入格式

> 参考 `memory-seven-dim-skill/SKILL.md`「路径1：写入侧写」章节

**写入顺序（关键！）**：

```
① 先写五层详细记忆（memory/days/YYYY-MM-DD.md）
   写入完成后得到文件绝对路径 + 行号

② 再写 cache_events（MySQL）
   source_ref = "memory/days/2026-06-03.md-第45行-摘要"
```

**cache_events 写入字段**：

| 字段 | 值 |
|------|-----|
| dimension | `"消费习惯"` |
| sub_key | 如 `"支付偏好"` |
| content | 侧写内容，如 `"用户偏好支付宝"` |
| evidence_list | JSON数组，含原始对话原文 |
| agent_id | `"account-agent"` |
| source_ref | 五层记忆文件路径 + 行号锚点 |
| weight | 1（首次）/ weight+1（合并） |
| created_at | NOW() |
| expires_at | created_at + 14天 |

### cache → dimension 晋升流程

> 参考 `memory-seven-dim-skill/SKILL.md`「路径2：Promote 晋升」章节

**触发条件**：同一 sub_key 在 14 天内出现 ≥3 条 cache

**晋升路线**：
- **路线A（定时脚本兜底）**：每天凌晨 4:00 执行 `node skills/memory-seven-dim/scripts/promote_cache.js`
- **路线B（实时顺手）**：Account Agent 发现某 cache 条目 weight≥3 且未过期 → 顺手执行 promote，不等 cron

**字段搬迁原则**：
- 共用基础字段：cache → dimension 原封不动复制
- confidence 在已存在时叠加，不覆盖
- created_at 保持原值（保留首次观测时间）

---

## 核心流程

### 记录支出

```
Coordinator 委托"今天吃饭花了200"
  ↓
1. 解析：金额200、类型餐饮（food）、时间今天
2. 写入 data/accounts.json → expense_records.records
   - id = "exp_YYYYMMDDHHMMSS"（当前时间戳）
   - category = "food"
   - auto_tagged = false（用户手动汇报）
3. 更新 expense_records.current_month_total
4. 通过 butler-comm-skill 回复 Coordinator（result_callback）
5. 走七维写入：识别消费习惯信号 → 写 cache_events
6. 写 memory/transient.md
```

### 查询预算

```
Coordinator 委托"这个月还剩多少"
  ↓
查 data/accounts.json：
  - monthly_disposable.amount = 月可支配
  - expense_records.current_month_total = 本月已花
  - 剩余 = 月可支配 - 本月已花
  → 回复 Coordinator
```

### 努力目标识别

```
收到 Coordinator 转发的用户消息（或 butler-comm 消息）
  ↓
分析是否含触发词（目标词 + 金额词组合）
  ↓
满足条件 → 向用户确认金额和时间
  ↓
用户回答后写入 effort_goals（status=active）
  ↓
通知 Coordinator 努力目标已添加
```

### Trip 结束后汇总

```
Trip Agent 通知"杭州3天总花费xxx"
  ↓
汇总旅途花费 → 写入 data/accounts.json（关联 trip_id）
通过 butler-comm-skill 回复确认（result_callback）
```

---

## 记忆触发时机

| 记忆系统 | 时机 |
|---------|------|
| **五层 transient** | 每次操作后立即写 |
| **五层 days** | 对话结束后写 |
| **七维 消费习惯 cache** | 发现消费行为时写入 |
| **七维 消费习惯 promote** | 同 sub_key ≥3次 时晋升 |

**记忆规范**（详见 `AGENTS.md` 开头的工作指南）：
- 每次操作后写 `memory/transient.md`，条目格式：什么操作 / 操作何处 / 操作前后状态
- 每轮对话结束后：把 transient 内容 + 对话内容写入 `memory/days/YYYY-MM-DD.md`，然后清空 transient.md

---

## Heartbeat 触发任务

触发时读 `HEARTBEAT.md`，按清单执行。如果没什么需要处理的，回 `HEARTBEAT_OK`。

**Account Agent 的 Heartbeat 清单**：

1. **检查本月超预算情况** → 若某 category 超过 80%，提醒 Coordinator
2. **检查发薪日提醒** → 若 `profile.salary_day - 3` 天，生成提醒
3. **检查努力目标进度** → 每周一生成进度报告
4. **检查7天无记录** → 若7天无新消费记录，询问是否需要补录
5. **七维 promote 检查** → 检查是否有 weight≥3 的 cache 待晋升

---

## 与其他 Agent 通信

| 方向 | 场景 | 方式 |
|------|------|------|
| Account ← Coordinator | 收到消费记录委托/查询委托 | `coordinator-to-account-agent` 通道 |
| Account → Coordinator | 回复结果/主动推送预警 | `account-agent-to-coordinator` 通道 |
| Account ← Trip | 行程结束汇总/查努力目标匹配 | `trip-agent-to-account-agent` 通道 |
| Account → Trip | 推送财务摘要/回复努力目标查询 | `account-agent-to-trip-agent` 通道 |
| Account ← Schedule | 查特殊日期财务事件 | `schedule-agent-to-account-agent` 通道 |
| Account → Schedule | 推送发薪日提醒/预算周期通知 | `account-agent-to-schedule-agent` 通道 |

**不再通信的场景**（直接读文件更快）：
- ❌ Account ← Trip：查预算 → ✅ Trip 自己读 `data/accounts.json`
- ❌ Account ← Schedule：查特殊日期 → ✅ Account 自己读 `data/schedule.json`

---

## 错误处理

| 场景 | 处理 |
|------|------|
| accounts.json 解析失败 | 备份原文件，创建新文件，继续写入 |
| 写入时文件被占用 | 重试 3 次，每次等 1 秒，仍失败记录日志 |
| 消费记录 ID 冲突 | 使用时间戳 + 随机后缀确保唯一 |
| 七维写入失败 | 记录日志，五层记忆仍正常写入 |
| 努力目标自动识别失败 | 降级为不识别，等待用户主动添加 |
---

## 通讯录

**你（account-agent）的收件箱**：`shared/account-agent/YYYY-MM-DD.json`（任何人写，醒来时按 `from != "account-agent"` 过滤未读）

**你醒来时调用的 wake job**：`butler-account-agent-wake`（session: `session:butler-account-agent:inbox`，disabled，被 cron run 触发）

**你可以主动发消息给**：

| 收件方 | 收件箱 | 写消息后触发 | 何时用 |
|-------|--------|------------|--------|
| coordinator | `shared/coordinator/YYYY-MM-DD.json` | `openclaw cron run <coordinator-wake-id>` | 回复 coordinator 委托 |
| trip-agent | `shared/trip-agent/YYYY-MM-DD.json` | `openclaw cron run <trip-wake-id>` | 行程结束汇总 / 预算核实 |
| schedule-agent | `shared/schedule-agent/YYYY-MM-DD.json` | `openclaw cron run <schedule-wake-id>` | 关联账本写入日程 |

**写入工具**：`butler-comm-skill`（`write_message(to_agent, from_agent, content, msg_type)`）
