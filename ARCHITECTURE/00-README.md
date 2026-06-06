# LifeButler 架构文档（最新汇总）

> **本目录是 LifeButler 项目的"唯一权威"架构文档**
> 更新时间：2026-06-06
> 编写人：0（主 agent）

---

## 目录索引

| 文件 | 内容 |
|------|------|
| [01-系统架构.md](./01-系统架构.md) | 总体架构、组件关系、数据流 |
| [02-Agent职责.md](./02-Agent职责.md) | 5 个 Agent（Coordinator + Trip/Schedule/Account + Butler）的职责、技能、流程 |
| [03-通信协议.md](./03-通信协议.md) | butler-comm + Gather Session + 直接读文件规则 |
| [04-记忆系统.md](./04-记忆系统.md) | 五层 + 七维完整架构（基于 v2 设计） |
| [05-Mock-Backend.md](./05-Mock-Backend.md) | 图模型 + 7 种事件 |
| [06-Cron-定时任务.md](./06-Cron-定时任务.md) | 6 个 cron job 清单 |
| [07-主动服务.md](./07-主动服务.md) | 5 个 Agent 的主动服务触发场景 |

---

## 老文档废弃说明

`docs/` 目录下有以下文档已过时，与本目录不一致：

| 老文档 | 废弃原因 | 替代 |
|--------|---------|------|
| `docs/Agent详细职责.md` | agent 通信规则已经修订（直接读文件替代 6 个通信） | [02-Agent职责.md](./02-Agent职责.md) |
| `docs/项目全貌与待办.md` | 大部分"待办"已完成 | [01-系统架构.md](./01-系统架构.md) |
| `docs/agent-comm-persistent.md` | 已被 `skills/butler-comm-skill` 取代 | [03-通信协议.md](./03-通信协议.md) |
| `docs/架构设计.md` | 仍是 v2 描述（互相通信），已被 v3 替代 | [01-系统架构.md](./01-系统架构.md) |
| `docs/数据分类文档.md` | POI 路径已改为 `poi/` 顶层 | [05-Mock-Backend.md](./05-Mock-Backend.md) |
| `docs/数据接口规范.md` | 同上 | [05-Mock-Backend.md](./05-Mock-Backend.md) |

**保留的老文档**（不与新架构冲突）：

| 文档 | 保留原因 |
|------|---------|
| `docs/memory-system-v2.md` | 记忆系统完整设计（最权威） |
| `docs/七维记忆系统-完整流程图.md` | 流程图与 v2 一致 |
| `docs/mock-backend-design.md` | 图模型设计（v2） |
| `docs/trip-skill-prd.md` | Trip Skill 产品需求 |
| `docs/产品定义.md` | 产品定位 |
| `docs/业务数据库管理原则.md` | 写操作一对一、读操作共享 |
| `docs/演示脚本.md` | 演示用 |

---

## 一句话总结

**LifeButler** 是一个由 1 个 Butler（主助手）+ 1 个 Coordinator + 3 个功能 Agent（Trip/Schedule/Account）组成的"智能管家"系统，基于：
- **图模型** Mock Backend（图节点 + 图边 + 状态层）提供动态 POI + 路线 + 随机事件
- **双层记忆**（五层文件版 + 七维 MySQL）让管家"记住"用户
- **butler-comm 协议**（shared/ 文件 + cron run）让 Agent 之间异步协作
- **直接读文件** 原则：只要数据能直接读就不通信
