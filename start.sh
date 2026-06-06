#!/bin/bash
# ============================================
# LifeButler 一键启动脚本 (start.sh)
# 适用：拿到项目后第一步
#
# 与 init.sh 的区别：
#   - start.sh = 装环境（Docker / npm / OpenClaw / agent / skill）
#   - init.sh  = 启服务（OpenClaw cron job 注册，要求 coordinator 已首次对话过）
#
# 顺序：docker → npm → openclaw → agent → print
# 幂等：每步检测已做过的会跳过
# 失败：fail fast，不回滚
# ============================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$SCRIPT_DIR"
OPENCLAW_VERSION="2026.6.1"
OPENCLAW_AGENT_HOME="${OPENCLAW_AGENT_HOME:-$HOME/.openclaw}"

# 颜色
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*"; }
step()  { echo -e "\n${BLUE}=== $* ===${NC}"; }

cd "$WORKSPACE"

# ============================================
# Step 0: 前置检查
# ============================================
step "Step 0: 前置检查"
command -v docker >/dev/null 2>&1 || { err "需要 Docker"; exit 1; }
command -v node  >/dev/null 2>&1 || { err "需要 Node.js ≥18"; exit 1; }
DOCKER_VER=$(docker --version)
NODE_VER=$(node --version)
info "Docker: $DOCKER_VER"
info "Node:   $NODE_VER"

# ============================================
# Step 1: 启 MySQL
# ============================================
step "Step 1: 启 MySQL (Docker)"

if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^butler-mysql$'; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^butler-mysql$'; then
    info "butler-mysql 已在运行"
  else
    info "butler-mysql 容器存在但停止，启动..."
    docker start butler-mysql
  fi
else
  info "docker compose up -d..."
  docker compose up -d
fi

# 等 MySQL 就绪
echo -n "  等 MySQL ready"
for i in $(seq 1 60); do
  if docker exec butler-mysql mysql -uroot -p1 -h 127.0.0.1 -e "SELECT 1" >/dev/null 2>&1; then
    echo
    break
  fi
  echo -n "."
  sleep 1
done

if ! docker exec butler-mysql mysql -uroot -p1 -h 127.0.0.1 -e "SELECT 1" >/dev/null 2>&1; then
  err "MySQL 60 秒内未就绪，放弃"
  exit 1
fi

# 验证 10 张表
TABLE_COUNT=$(docker exec butler-mysql mysql -uroot -p1 -h 127.0.0.1 life_butler_db -Nse "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='life_butler_db'" 2>/dev/null || echo 0)
if [ "$TABLE_COUNT" -ne 10 ]; then
  err "期望 10 张表，实际 $TABLE_COUNT 张（可能需要重导 seed.sql + db_schema.sql）"
  exit 1
fi
info "MySQL ready，$TABLE_COUNT 张表"

# ============================================
# Step 2: 装 npm 依赖
# ============================================
step "Step 2: 装 npm 依赖"
npm install

# ============================================
# Step 3: 装/检查 OpenClaw
# ============================================
step "Step 3: 装/检查 OpenClaw"

if command -v openclaw >/dev/null 2>&1; then
  INSTALLED_VER=$(openclaw --version 2>&1 | grep -oP '2026\.\d+\.\d+' | head -1)
  if [ "$INSTALLED_VER" = "$OPENCLAW_VERSION" ]; then
    info "OpenClaw $INSTALLED_VER 已装"
  else
    warn "OpenClaw 版本 $INSTALLED_VER ≠ $OPENCLAW_VERSION，继续"
  fi
else
  info "安装 OpenClaw $OPENCLAW_VERSION..."
  if ! npm install -g openclaw@$OPENCLAW_VERSION; then
    err "OpenClaw 装不上，整个项目基于 OpenClaw，终止"
    exit 1
  fi
  info "OpenClaw $OPENCLAW_VERSION 安装完成"
fi

# ============================================
# Step 4: 装载 4 agent + 注册 skill
# ============================================
step "Step 4: 装载 4 agent"

# 定义 4 个 agent
# workspace: agent 自身工作目录（人/AGENTS.md 那个）
# agent_dir: OpenClaw 运行时状态目录
AGENT_LIST=$(openclaw agents list 2>/dev/null | grep -E '^\- ' | awk '{print $2}' | grep -v '^(default)$' || true)

AGENTS=(
  "trip-agent:$WORKSPACE/agents/trip-agent"
  "account-agent:$WORKSPACE/agents/account-agent"
  "schedule-agent:$WORKSPACE/agents/schedule-agent"
  "coordinator:$WORKSPACE/coordinator"
)

for entry in "${AGENTS[@]}"; do
  name="${entry%%:*}"
  workspace="${entry#*:}"
  agent_dir="$OPENCLAW_AGENT_HOME/agents/$name/agent"

  if echo "$AGENT_LIST" | grep -qFx "$name"; then
    info "  $name: 已装载 (skip)"
  else
    if [ ! -d "$workspace" ]; then
      err "  $name: workspace 不存在 $workspace"
      exit 1
    fi
    mkdir -p "$agent_dir"
    if openclaw agents add "$name" \
        --workspace "$workspace" \
        --agent-dir "$agent_dir" \
        --non-interactive >/dev/null 2>&1; then
      info "  $name: 装载完成"
    else
      err "  $name: 装载失败"
      exit 1
    fi
  fi
done

# Step 4.5: 注册 extra skill
step "Step 4.5: 注册 extra skill"

# trip-agent 的 skill（在 agents/trip-agent/skills/ 下）
if [ -d "$WORKSPACE/agents/trip-agent/skills" ]; then
  for skill_dir in "$WORKSPACE/agents/trip-agent/skills"/*/; do
    [ -d "$skill_dir" ] || continue
    slug=$(basename "$skill_dir")
    if openclaw skills install "$skill_dir" --agent trip-agent --force >/dev/null 2>&1; then
      info "  trip-agent/$slug: installed"
    else
      warn "  trip-agent/$slug: install failed (continue)"
    fi
  done
fi

# coordinator 的 skill（在 coordinator/skills/ 下）
if [ -d "$WORKSPACE/coordinator/skills" ]; then
  for skill_dir in "$WORKSPACE/coordinator/skills"/*/; do
    [ -d "$skill_dir" ] || continue
    slug=$(basename "$skill_dir")
    if openclaw skills install "$skill_dir" --agent coordinator --force >/dev/null 2>&1; then
      info "  coordinator/$slug: installed"
    else
      warn "  coordinator/$slug: install failed (continue)"
    fi
  done
fi

# 根目录共享 skill（注册到 coordinator）
if [ -d "$WORKSPACE/skills" ]; then
  for skill_dir in "$WORKSPACE/skills"/*/; do
    [ -d "$skill_dir" ] || continue
    slug=$(basename "$skill_dir")
    if openclaw skills install "$skill_dir" --agent coordinator --force >/dev/null 2>&1; then
      info "  coordinator/$slug: installed (shared)"
    else
      warn "  coordinator/$slug: install failed (continue)"
    fi
  done
fi

# ============================================
# Step 5: 打印 next steps（coordinator 首次对话流程）
# ============================================
step "Step 5: 启动完成 — 下一步"

cat <<EOF

${GREEN}=== LifeButler 启动完成 ===${NC}

工作空间：$WORKSPACE
OpenClaw:  $OPENCLAW_VERSION
数据库：   butler-mysql 容器，10 张表
Agent:    trip / account / schedule / coordinator (4 个)

${BLUE}接下来 — coordinator 首次对话流程：${NC}

⚠️  coordinator 会主动给你的系统装一些东西（init questionnaire + MySQL 写
   入 + init.sh cron job 注册）。请准备好。

1. 启动 OpenClaw Gateway（如未跑）：
   ${YELLOW}openclaw gateway start${NC}
   # 或 ${YELLOW}openclaw tui${NC}（开 TUI 看 dashboard）

2. 跟 coordinator 聊第一次：
   ${YELLOW}openclaw chat coordinator${NC}
   # coordinator 会自动发 13 道问卷（Q1-Q7 基础 + Q8-Q13 财务，可跳）
   # 用户提交后 → 写 coordinator/data/init_questionnaire.json
   #           → INSERT 到 seven_dimensions 表
   #           → 标记 init_completed: true

3. ${RED}重要：cron job 此时还没注册${NC}。用户首次对话后再跑：
   ${YELLOW}bash coordinator/scripts/init.sh${NC}
   # init.sh 注册 5 wake jobs + 1 hourly sweep + 2 system crontab

4. 验证：
   ${YELLOW}openclaw cron list | grep butler${NC}
   ${YELLOW}crontab -l | grep event_${NC}

5. 手动测脚本（如需）：
   ${YELLOW}MYSQL_PASSWORD=*** npm run gen && npm run detect${NC}

EOF

info "完成。"
