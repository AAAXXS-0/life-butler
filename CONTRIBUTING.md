# Contributing to LifeButler

欢迎参与 LifeButler 的开发。以下指南适用于功能开发、Bug 修复和文档改进。

---

## 项目贡献者

|贡献者 | GitHub | 主要贡献 |
|--------|--------|---------|
|厸 | [](https://github.com/) | 项目发起人。智能行程规划引擎、4 个 Agent 系统、Mock Backend、数据库设计、Docker 集成、所有核心功能实现 |
| 0 | [](https://github.com/) | 系统架构设计、多 Agent 协作流程、七维记忆系统设计、代码审查与重构、文档编写 |

---

## 如何贡献

### Bug 报告

请在 [GitHub Issues](https://github.com/<owner>/life-butler/issues) 提交，包含：

- 复现步骤
- 预期行为 vs 实际行为
- 环境信息（Node 版本、MySQL 版本、操作系统）

### 功能建议

请先确认该功能是否在架构范围内（见 [ARCHITECTURE/](ARCHITECTURE/)）。新功能建议随附：

- 使用场景说明
- 与现有模块的协作方式
- 建议的实现路径（可选）

### Pull Request

1. **Fork → Feature Branch**：从 `master` 创建分支
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **保持提交原子化**：每个 commit 解决一个具体问题，不要混多个改动
3. **测试**：涉及 MySQL 的脚本改动，请用 `MYSQL_PORT=3308 npm run detect` 验证
4. **文档同步**：若改动涉及 Agent 行为或 skill 逻辑，同步更新 `ARCHITECTURE/` 下的相关文档
5. **PR 描述**：
   - 改了什么
   - 为什么改
   - 如何验证

### 代码风格

- JS：遵循项目既有风格（CommonJS，2 空格缩进）
- Shell：bash，选项卡对齐，颜色变量使用项目已有格式（`$RED/$GREEN/$YELLOW/$BLUE/$NC`）
- Skill 文档：参照已有 `SKILL.md` 结构，包含「触发条件」「核心逻辑」「输出」三节

### Git 提交规范

```
<类型>: <简短描述>

类型：feat / fix / refactor / docs / chore / test
```

---

## 项目结构速查

```
agents/ # 4 个独立 Agent（含各自 skill）
coordinator/    # 主调度 Agent +问卷 + cron 注册脚本
skills/         # 共享 skill（memory-layers / memory-seven-dim）
mock_backend/   # MySQL 模块 + 事件模拟/检测脚本
ARCHITECTURE/   # 唯一权威架构文档
```

新增 Agent 或 skill 时，同步更新 `ARCHITECTURE/02-Agent职责.md`。

---

## 开发流程（内部参考）

```
用户需求 → Coordinator理解 → 路由到对应 Agent
                            → Agent 调 skill 执行
                            → 写 memory/transient.md
                            → 对话结束写 memory/days/
```

详见 [ARCHITECTURE/03-通信协议.md](ARCHITECTURE/03-通信协议.md)。

---

## 联系方式

Bug / 安全问题 → [GitHub Issues](https://github.com/<owner>/life-butler/issues)

其他问题 → 欢迎 PR 直接讨论。