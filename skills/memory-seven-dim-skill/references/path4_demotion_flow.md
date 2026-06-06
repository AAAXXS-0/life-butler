# 路径4降级流程详解

> 仅主管 Agent 可操作降级。任何 Agent 在路径1中发现与 dimension 现有侧写明显矛盾的观测 → 通知对应维度主管 Agent。

## 维度主管对应表

| 维度 | 主管 Agent |
|------|-----------|
| 口味偏好 | Trip Agent |
| 消费习惯 | Account Agent |
| 关系网络 | Schedule Agent |
| 时间规律 | Schedule Agent |
| 遗忘清单 | Schedule Agent |
| 认知风格 | Coordinator |
| 健康情况 | Coordinator |

## 4步降级流程

### Step 1：矛盾侧写入 cache

```
新增cache条目：
  dimension = 对应维度
  sub_key = 同上
  content = 矛盾侧写内容
  annotation = "矛盾侧写-{与之矛盾的侧写名}"
  例："矛盾侧写-口味偏好.辣度=中辣"
  weight = 1，created_at = NOW()，expires_at = +1年
```

### Step 2：Coordinator 介入关心用户

```
原则：人不会无缘无故变化
Coordinator 告知用户情况，询问原因：
"您刚才说不想吃辣，但之前记录您偏好中辣，是有什么变化吗？"
```

**用户回应三种情况：**

| 回应 | 走向 |
|------|------|
| 理由性回应 | 进入路径5处理突发事件 |
| 无回应/未确认 | 视为矛盾，继续 Step 3 |
| 真的侧写失效（极少） | 直接进入 Step 4 |

### Step 3：综合判断后决定后续操作

```
收集 Step2 的所有可能结果，统一在 Step3 判断走向：
  · 路径5处理完 → 继续 Step3 判断
  · 无回应/未确认 → 写"矛盾"标注，继续 Step4
  · 真的侧写失效 → 直接进入 Step4
```

### Step 4：降级操作（主管 Agent 执行）

```
① 删除 cache 中标注"矛盾"的条目

② 将被降级侧写写入 cache：
   · dimension/sub_key/content ← 原 dimension 记录
   · annotation = "降级侧写"
   · expires_at = created_at + 1年

③ 将矛盾侧写的 evidence_list 全部追加到被降级侧写的 evidence_list 末尾
   · 最后一条标注：{"type": "降级依据", "content": "...", "created_at": "..."}

④ seven_dimensions:
   · status → 'demoted'
   · demoted_at = NOW()
```

## 降级后的 cache 观察规则

```
降级 cache 条目：
  · 观察期 = 1年
  · 年内任何一次出现同样侧写
    → 主管 Agent 顺手执行 promote
    → 从 cache 晋升回 dimension
    → evidence_list 新增"恢复依据"条目
    → confidence = 1（重置）
  · 年内无出现
    → 观察期满后从 cache 清除
    → 已降级且过观察期 → 不再恢复
```

## evidence_list 标注格式

| 场景 | evidence_list 中的标注 |
|------|----------------------|
| 正常晋升 | 无特殊标注 |
| 降级时矛盾证据写入 | `{"type": "降级依据", "content": "...", "created_at": "..."}` |
| 恢复晋升 | `{"type": "恢复依据", "content": "...", "created_at": "..."}` |
