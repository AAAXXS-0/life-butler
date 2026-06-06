---
name: subagent-skill
description: SubAgent 任务执行 Skill。规范 OpenClaw sessions_spawn 工具的调用方式、参数、限制、命名、可观察性。Subagent 本身是 LLM，不调 LLM API。
metadata: { "openclaw": { "emoji": "🤖" } }
---

# SubAgent Skill

> Subagent 不是新概念——它本身就是 LLM。spawn subagent 的本质是"在隔离的 session 里跑一个新 LLM"。
> 所以：**SubAgent 自己就是 LLM，不调外部 LLM API**。这是最重要的设计原则。

---

## 定位

本 skill 规范：
1. 何时该用 subagent（vs 主 agent 自己做 vs 写脚本）
2. `sessions_spawn` 工具的调用方式、参数、限制
3. 命名约定（taskName）
4. 错误处理
5. 跨 skill 引用

---

## 何时用 SubAgent

| 场景 | 用 SubAgent | 用脚本 |
|------|------------|--------|
| 需要 LLM 推理/语义分析 | ✅ | ❌ |
| 纯 IO/计算/规则 | ❌ | ✅ |
| 后台批量任务，隔离 context | ✅ | ❌ |
| 实时交互（要阻塞等结果） | ❌ | ❌（用主 agent 直接做）|
| 需要重试/失败兜底 | ✅ | ❌ |

**反模式**：
- ❌ "用脚本调 LLM API"——一个 LLM 委托另一个 LLM，绕弯
- ❌ 用 SubAgent 跑纯计算（比如 parse JSON、连接 MySQL 查表）——浪费 LLM
- ❌ SubAgent 任务跑完前主 agent 不返回——破坏异步性

---

## sessions_spawn 工具规范

### 标准调用

```python
sessions_spawn(
  task="<prompt 详细描述任务>",     # 必填：subagent 的任务描述
  taskName="<短横线命名>",          # 必填：稳定别名，用于后续追踪
  runtime="subagent",                # 默认：subagent
  mode="run",                        # 一次性后台
  model="<provider/model>",          # 推荐：后台任务用便宜模型
  # cleanup="delete",               # 可选：subagent 完成后清理
)
```

### 必填参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `task` | string | subagent 的任务 prompt。**必须是独立可执行的完整描述**——subagent 不继承父 context |
| `taskName` | string | 稳定别名，小写字母/数字/下划线/连字符，**必须以字母开头** |

### 推荐参数

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `model` | `minimax/MiniMax-M2.7` | 后台扫描/批量任务用便宜模型 |
| `mode` | `run` | 一次性后台（vs 持续 session） |
| `runtime` | `subagent` | 默认值 |

### 不推荐参数

| 参数 | 不推荐值 | 理由 |
|------|----------|------|
| `context="fork"` | ❌ | subagent 应该 clean，**不继承父 context** |
| `model` 默认主模型 | ❌ | 后台任务用主模型贵且污染主 context |

---

## taskName 命名约定

格式：`<domain>-<action>[-<variant>]`

**好例子**：
- `chat-mode-scanner` —— 聊天模式扫描
- `promote-cache-nightly` —— promote 每日兜底
- `mock-event-spawner` —— 模拟事件生成

**坏例子**：
- `subagent1` ❌（无意义）
- `MyTask` ❌（大写、含糊）
- `chat_mode_scanner_v2_final` ❌（太多修饰）

---

## task prompt 写作规范

Subagent 不继承父 context，**prompt 必须独立可执行**。

### 必含要素

1. **角色身份**："你是 X subagent"（避免 subagent 困惑自己是谁）
2. **任务目标**：1-2 句话说清楚要达成什么
3. **步骤**：编号的明确步骤
4. **输入**：上下文信息（日期、文件路径等）由调用方传入，**不在 prompt 里硬编码**
5. **输出格式**：明确的输出格式
6. **依赖**：要调什么工具、写什么文件
7. **边界**：什么不该做

### 反模式

- ❌ 写"参考之前的对话"——subagent 看不到
- ❌ 写"按惯例做"——subagent 不知道惯例
- ❌ 不写输出格式——subagent 不知道返回什么
- ❌ 写得太长（>2000 字）——subagent 上下文会被截断

---

## 错误处理

| 场景 | 处理 |
|------|------|
| Subagent 失败 | 它自己 LLM 推理可重试，**不强制返回**给主 agent |
| 超时 | `cleanup="delete"` 让 session 不留垃圾 |
| 输出格式不对 | 调用方读 session transcript 自己解析 |

**重要**：不要在主 agent 写"等 subagent 返回"的逻辑——破坏异步性。

---

## 跨 skill 引用

使用 subagent 的 skill 应该在 prompt 文档里引用本 skill：

```markdown
> SubAgent 使用规范见 `skills/subagent-skill/SKILL.md`
> 提示词模板见本 skill 路径7 章节
```

目前用到 subagent 的 skill：
- `skills/memory-seven-dim-skill/SKILL.md` 路径7（chat_mode_profile_scanner）

---

## 已使用 SubAgent 清单

| taskName | 所在 skill | 用途 | 触发方式 |
|----------|------------|------|----------|
| `chat-mode-scanner` | memory-seven-dim-skill 路径7 | 扫描聊天模式 days 文件 | cron 9 每天 4:30 + Coordinator 实时 |
