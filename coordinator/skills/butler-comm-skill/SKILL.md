# butler-comm skill
> 管理 Butler Team 的跨 Agent 持久化通信（QQ式聊天风格）
> 版本：1.0 | 创建日期：2026-06-05

---

## 定位

本 skill 管理 Coordinator 与三个子 Agent（trip-agent / schedule-agent / account-agent）之间的**持久化异步通信**，基于本地文件系统的聊天记录，模拟 QQ 体验。

---

## 通信根目录

```
workspace-butler/shared/                # 通信根目录（共享文件夹）
├── coordinator/                        # coordinator 的收件箱（所有 agent 可写）
│   └── YYYY-MM-DD.json
├── trip-agent/                         # trip-agent 的收件箱
│   └── YYYY-MM-DD.json
├── schedule-agent/                     # schedule-agent 的收件箱
│   └── YYYY-MM-DD.json
├── account-agent/                      # account-agent 的收件箱
│   └── YYYY-MM-DD.json
└── taxonomy.json                       # 静态通讯录 + cron job ID 映射
```

**核心原则**：
- **cron job 有方向性**（`cron run A` 是单向触发 A）
- **聊天文件夹是双向的**（任何 agent 都可以往里写、按 `from` 字段过滤读）
- 每个 agent 只需一个收件箱文件夹
- **总计 4 个文件夹**（精简掉双向分离的 12 通道）

**文件夹命名规则**：
- 文件夹名 = **接收方 agent 名**（非「sender to receiver」）
- 全部小写，连字符分隔
- 例：`coordinator/`、`trip-agent/`、`account-agent/`

**消息方向靠 `from` 字段**：
- 读消息时过滤 `from != self`，避免读到自己写的
- 例：trip-agent 跑起来后处理 `from in (coordinator, schedule-agent, account-agent)` 的未读消息
- 写消息时 `from = self`（trip-agent 写时填 `from: "trip-agent"`）

---

## 通讯录（addressbook）

通讯录 = `shared/taxonomy.json`（静态文件）。Agent 启动时读这个文件获取：
1. 4 个 agent 的元信息（角色 / 收件箱 / wake cron 名 / session_key）
2. **各 wake cron job 的 ID**（用于 `openclaw cron run <id>` 唤醒）—— init.sh 创建后写入
3. 消息分类规则（task_delegate / result_callback / info_share 的语义）

`taxonomy.json` 三段结构（详见文件内）：

```json
{
  "version": 1,
  "agents": {
    "trip-agent": { "role": "...", "inbox": "shared/trip-agent/", "wake_cron_name": "butler-trip-agent-wake", "session_key": "session:butler-trip-agent:inbox" },
    "..."
  },
  "cron_jobs": {
    "trip-agent":     "<uuid>",
    "schedule-agent": "<uuid>",
    "account-agent":  "<uuid>",
    "coordinator":    "<uuid>",
    "self":           "<uuid>"
  },
  "hourly_sweep_cron_id": "<uuid>",
  "taxonomy": { "message_types": { ... } }
}
```

### 怎么读 taxonomy.json 拿 wake ID

子 agent 跑完要唤醒 coordinator 时，**不要**靠记忆里的 ID 字符串，从 taxonomy.json 读：

```bash
COORD_ID=$(python3 -c "import json; print(json.load(open('shared/taxonomy.json'))['cron_jobs']['coordinator'])")
openclaw cron run "$COORD_ID"
```

为什么这样设计：
- OpenClaw 的 `cron add` 返回的 ID 是**随机 UUID**（如 `3142739c-fc3b-...`）
- 不存下来就会丢，agent 们互相找不到
- 存到 taxonomy.json 后所有 agent 共读、单一权威来源

### 收件箱可达性（与 taxonomy.json 一致）

4 个收件箱 = 4 个可达 agent。每个 agent 知道：

| agent | 自己的收件箱（被读） | 可写的收件箱（发送） |
|-------|---------------------|---------------------|
| coordinator | `coordinator/` | `trip-agent/`, `schedule-agent/`, `account-agent/` |
| trip-agent | `trip-agent/` | `coordinator/`, `schedule-agent/`, `account-agent/` |
| schedule-agent | `schedule-agent/` | `coordinator/`, `trip-agent/`, `account-agent/` |
| account-agent | `account-agent/` | `coordinator/`, `trip-agent/`, `schedule-agent/` |

**例**：account-agent 跑完想推 trip-agent：
- 写 `shared/trip-agent/YYYY-MM-DD.json`（`from: "account-agent"`）
- `openclaw cron run <butler-trip-agent-wake-id>`
- trip-agent 读 `shared/trip-agent/` 找 `from=account-agent` 且 `read=false` 的消息

---

## 聊天文件格式

**每日文件**：`workspace-butler/shared/<channel>/YYYY-MM-DD.json`

**结构**：
```json
[
  {
    "id": "<uuid>",
    "from": "<agent name>",
    "reply_to": "<uuid or null>",
    "ts": 1749087613000,
    "content": "<正文内容>",
    "read": false,
    "type": "task_delegate|result_callback|info_share"
  }
]
```

**字段说明**：
| 字段 | 说明 |
|------|------|
| id | 消息唯一 ID（UUID），用于追踪和引用 |
| from | 发送方 agent 名称 |
| reply_to | 回复的消息 ID（可 null） |
| ts | 时间戳（毫秒，Unix epoch） |
| content | 正文内容（JSON 字符串或纯文本） |
| read | 已读标记，false=未读，true=已读 |
| type | 消息类型 |

**type 分类**：
- `task_delegate`：任务委托（coordinator 派发任务给子 agent）
- `result_callback`：结果回调（子 agent 返回处理结果）
- `info_share`：信息共享（agent 之间流转信息）

---

## 写入流程

```
A agent 需要委托 B agent 处理事务
    ↓
构造聊天文件路径：shared/<A> to <B>/<今天日期>.json
（目录不存在则先创建）
    ↓
[加锁] 读取现有 JSON → 追加新 Entry → 写回文件 → [解锁]
    ↓
触发 B 的处理：调用 `openclaw cron run <B-agent-job-id>`（详见下方触发机制）
    ↓
B 收到消息 → 处理事务 → 决定是否回复
```

**写入代码范式**（Python）：
```python
import json, os, fcntl, uuid
from datetime import datetime

def write_message(to_agent, from_agent, content, msg_type, reply_to=None):
    """向指定 agent 的收件箱写消息。
    
    to_agent: 收件方（'coordinator' / 'trip-agent' / 'schedule-agent' / 'account-agent'）
    from_agent: 发送方
    """
    base = "/home/zero/.openclaw/workspace-butler/shared"
    today = datetime.now().strftime("%Y-%m-%d")
    chat_file = f"{base}/{to_agent}/{today}.json"
    
    os.makedirs(os.path.dirname(chat_file), exist_ok=True)
    
    with open(chat_file, 'a+') as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        f.seek(0)
        try:
            entries = json.load(f) if os.path.getsize(chat_file) > 0 else []
        except json.JSONDecodeError:
            entries = []
        
        entry = {
            "id": str(uuid.uuid4()),
            "from": from_agent,
            "reply_to": reply_to,
            "ts": int(datetime.now().timestamp() * 1000),
            "content": content,
            "read": False,
            "type": msg_type
        }
        entries.append(entry)
        
        f.seek(0)
        f.truncate()
        json.dump(entries, f, ensure_ascii=False, indent=2)
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)

# 使用示例（coordinator 委托 trip-agent）
write_message(
    to_agent="trip-agent",
    from_agent="coordinator",
    content=json.dumps({"task": "plan_trip", "dest": "杭州", "days": 3}, ensure_ascii=False),
    msg_type="task_delegate"
)
```

**Node.js / shell 场景**：使用 Python 脚本包装 `utils/write-message.py`

---

## 读取流程

```
Agent 收到触发（cron run 或直接调用）
    ↓
定位聊天文件：shared/<channel>/<日期>.json
    ↓
[加锁] 读取 Entry 列表 → 找到自己的未读消息 → 标记已读 → [解锁]
    ↓
处理事务内容
    ↓
根据需要决定是否回复（走写入流程）
```

**读取代码范式**（Python）：
```python
import json, os, fcntl
from datetime import datetime, timedelta

def read_messages(my_agent, mark_read=True, days_back=2):
    """读自己收件箱里别人发来的未读消息。
    
    my_agent: 接收方 agent 名
    days_back: 扫最近 N 天的 .json 文件（默认 2 = 今天 + 昨天）
               跨夜场景足够；comm-cleanup 删 3 天前，2 天是安全上限
    返回: 其它 agent 发来的未读消息列表（按 ts 升序）
    """
    base = "/home/zero/.openclaw/workspace-butler/shared"
    inbox = f"{base}/{my_agent}"
    
    # 计算要扫的日期范围
    today = datetime.now()
    target_dates = {(today - timedelta(days=i)).strftime("%Y-%m-%d")
                    for i in range(days_back)}
    
    entries = []
    target_files = []
    for fname in os.listdir(inbox):
        if not fname.endswith(".json"):
            continue
        date_str = fname[:-len(".json")]  # 去后缀
        if date_str not in target_dates:
            continue
        target_files.append(fname)
        with open(f"{inbox}/{fname}") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_SH)
            try:
                entries.extend(json.load(f))
            except json.JSONDecodeError:
                pass
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    
    # 筛 别人发来的未读（过滤掉自己写的）
    unread = [e for e in entries if e["from"] != my_agent and not e["read"]]
    if not unread:
        return []
    
    unread_sorted = sorted(unread, key=lambda x: x["ts"])
    
    if mark_read:
        # 标记已读（带文件锁）
        for fname in target_files:
            fpath = f"{inbox}/{fname}"
            with open(fpath, 'r+') as f:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX)
                try:
                    all_entries = json.load(f)
                except json.JSONDecodeError:
                    all_entries = []
                
                for e in unread_sorted:
                    for orig in all_entries:
                        if orig["id"] == e["id"]:
                            orig["read"] = True
                
                f.seek(0)
                f.truncate()
                json.dump(all_entries, f, ensure_ascii=False, indent=2)
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    
    return unread_sorted

# 使用示例（trip-agent 醒来后读自己的收件箱）
msgs = read_messages(my_agent="trip-agent")
```

---

## 三日自动清理

**触发**：独立每日 Cron Job，凌晨 03:00 执行

**清理脚本**（`utils/comm-cleanup.py`）：
```python
#!/usr/bin/env python3
import os, time
from datetime import datetime, timedelta

BASE = "/home/zero/.openclaw/workspace-butler/shared"
CUTOFF_DAYS = 3

def cleanup():
    today = datetime.now()
    cutoff = today - timedelta(days=CUTOFF_DAYS)
    removed = []
    
    for channel in os.listdir(BASE):
        ch_path = os.path.join(BASE, channel)
        if not os.path.isdir(ch_path) or channel == "taxonomy.json":
            continue
        
        for fname in os.listdir(ch_path):
            if not fname.endswith(".json"):
                continue
            date_str = fname.replace(".json", "")
            try:
                file_date = datetime.strptime(date_str, "%Y-%m-%d")
            except ValueError:
                continue
            
            if (today - file_date).days > CUTOFF_DAYS:
                os.remove(os.path.join(ch_path, fname))
                removed.append(f"{channel}/{fname}")
        
        # 删除空文件夹
        if not os.listdir(ch_path):
            os.rmdir(ch_path)
    
    return removed

if __name__ == "__main__":
    r = cleanup()
    print(f"清理了 {len(r)} 个文件: {r}")
```

**Cron 配置**：
```json
{
  "name": "butler-comm-cleanup",
  "schedule": { "kind": "cron", "expr": "0 3 * * *", "tz": "Asia/Shanghai" },
  "payload": {
    "kind": "agentTurn",
    "message": "执行 comm cleanup 流程：清理 workspace-butler/shared/ 下所有聊天文件夹中距今超过3天的聊天文件，删除文件后若文件夹为空则删除文件夹。完成后输出清理报告。"
  },
  "sessionTarget": "isolated",
  "enabled": true
}
```

**禁止在写入时检查删除**。清理必须独立运行。

## 触发机制（用 cron run，不用 sessions_send）

**sessions_send 有问题，不可靠。不要用 sessions_send 触发 agent。**

改用 `cron run` + **session-keyed inbox** 实现 per-session 串行排队：

1. **每个子 Agent 创建一条"死"cron job**（enabled: no，永远不自动触发）
2. **该 cron job 必须配 `--session session:butler-<agent-name>:inbox`**（per-session 串行排队）
   - **为什么必加**：默认 `--session isolated` 每次起新 session，会出现 trip-agent 并行跑两轮 → 写 shared/ 文件锁争用 → 上下文丢失
   - 同 session key 的 run 严格串行：上一跑没完，下一跑排队等 → 不并行 → 不打断
   - 实例：`--session session:butler-trip-agent:inbox`
3. Coordinator 发完消息后，调用 `openclaw cron run <job-id>` 唤醒目标 agent
4. 被唤醒的 agent 读 shared/ 消息 → 处理 → 写回复 → 触发下一个（如果是链式）

```bash
# 触发 trip-agent（自动串行排队，不会并行）
openclaw cron run <trip-agent-cron-job-id>

# 触发 schedule-agent
openclaw cron run <schedule-agent-cron-job-id>

# 触发 account-agent
openclaw cron run <account-agent-cron-job-id>
```

**子 agent 死 cron job 配置范例**（trip-agent）：
```bash
openclaw cron add \
  --name "butler-trip-agent-wake" \
  --agent "butler-trip-agent" \
  --session "session:butler-trip-agent:inbox" \
  --message "读 shared/trip-agent/ 下最近 2 天的 .json 文件里别人发给你的未读消息，按 ts 升序处理；处理完写回复到 shared/coordinator/<今天日期>.json；最后 openclaw cron run <coordinator-wake-id>" \
  --no-deliver \
  --expect-final \
  --disabled
```

**为什么用 cron run：**
- agent 可以离线（睡着也能被唤醒）
- 不需要实时在线等待
- 比 sessions_send 稳定得多

**为什么配 session-keyed inbox：**
- 多 A2A 消息并发到同一目标 agent 时，per-session 串行排队
- 防止目标 agent 在跑时被新触发打断
- 防止同一目标 agent 多 session 并行写 shared/ 撞锁
- 不污染 agent 的 main 会话（不抢用户聊天）

---

## 错误处理

| 场景 | 处理 |
|------|------|
| 聊天文件被占用 | 重试 3 次，每次等 1 秒，仍失败记录日志 |
| JSON 解析失败 | 备份原文件，创建新文件，继续写入 |
| 目标 agent 无回应 | 等待 cron run 返回，超时 5 分钟则通知 0 |
| 文件夹命名冲突 | 字典序固定顺序，不重复 |


*本 skill 解释权归主 agent（0）。*