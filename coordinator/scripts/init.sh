#!/bin/bash
# ============================================
# LifeButler 初始化脚本
# Coordinator 首次启动时运行，配置所有定时任务
#
# 健壮性要点（DS 老师 2026-06-07 反馈）：
#   - 检查 python3 依赖（#3）
#   - 日志路径用 $WORKSPACE/logs/ 而非 /var/log/，避免权限问题（#2）
#   - register_cron 失败时不要把空 ID 写进 taxonomy.json（#4）
#   - 非致命步骤临时关 set -e 防止脚本静默退出（#5）
# ============================================
set -e

WORKSPACE="${BUTLER_WORKSPACE:-$(dirname "$(dirname "$(dirname "$(readlink -f "$0")")")")}"
AGENTS="$WORKSPACE/agents"
SCRIPTS="$WORKSPACE/mock_backend/scripts"
LOG_DIR="${LOG_DIR:-$WORKSPACE/logs}"  # 改：避免 /var/log/ 权限问题（#2）

# ============================================
# 依赖检查
# ============================================

# python3 检查（#3）：解析 openclaw cron add 输出需要它
command -v python3 >/dev/null 2>&1 || {
  echo "[ERR] python3 未安装，无法解析 OpenClaw cron job ID"
  echo "      装一下: sudo apt-get install -y python3"
  exit 1
}

# 日志目录创建（#2）
mkdir -p "$LOG_DIR" 2>/dev/null || {
  echo "[ERR] 无法创建日志目录 $LOG_DIR"
  exit 1
}

echo "=== LifeButler Init ==="
echo "Workspace: $WORKSPACE"
echo "Log dir:   $LOG_DIR"

# ============================================
# Part 1: OpenClaw Cron Jobs（Agent 间通信）
# ============================================

# 辅助：从 openclaw cron add 的 JSON 输出抽 job ID
# 失败时返回空字符串 + warn（#4 改进：函数内部就 warn，不等外层）
register_cron() {
  local NAME="$1"; shift
  local OUT
  OUT=$(openclaw cron add "$@" --wake now 2>&1) || true
  local JOB_ID
  JOB_ID=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
  if [ -z "$JOB_ID" ]; then
    # 已存在——从 cron list 查
    JOB_ID=$(openclaw cron list 2>/dev/null | awk -v n="$NAME" '$2==n {print $1; exit}')
    if [ -z "$JOB_ID" ]; then
      # 真失败了（#4 关键修复：显式 warn，不静默）
      echo "  [WARN] $NAME: 创建 + 查 cron list 都拿不到 ID，请手动检查 'openclaw cron list | grep $NAME'" >&2
    else
      echo "  $NAME: 已存在，ID=$JOB_ID"
    fi
  else
    echo "  $NAME: 已创建，ID=$JOB_ID"
  fi
  echo "$JOB_ID"
}

# 检查 openclaw 是否可用
if ! command -v openclaw &>/dev/null; then
  echo "[WARN] openclaw CLI not found, skipping cron job setup"
  echo "       Cron jobs 需要 OpenClaw 运行时环境"
else
  echo "--- 注册 OpenClaw cron jobs ---"

  # --- trip-agent wake（coordinator 委托 / mockend 事件 唤醒） ---
  TRIP_WAKE_ID=$(register_cron "butler-trip-agent-wake" \
    --name "butler-trip-agent-wake" \
    --agent butler-trip-agent \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-trip-agent:inbox" \
    --message "读 shared/trip-agent/ 中最近2天的 .json 文件。处理 coordinator 委托或 mockend 事件 detector 推送的坏事件。写回复到 shared/coordinator/。最后从 shared/taxonomy.json 读 coordinator 的 wake ID，调 openclaw cron run 唤醒。" \
    --disabled \
    --no-deliver)

  # --- schedule-agent wake ---
  SCHEDULE_WAKE_ID=$(register_cron "butler-schedule-agent-wake" \
    --name "butler-schedule-agent-wake" \
    --agent butler-schedule-agent \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-schedule-agent:inbox" \
    --message "读 shared/schedule-agent/ 中最近2天的 .json 文件。处理时间冲突查询或日程写入。写回复到 shared/coordinator/。最后从 shared/taxonomy.json 读 coordinator 的 wake ID，调 openclaw cron run 唤醒。" \
    --disabled \
    --no-deliver)

  # --- account-agent wake ---
  ACCOUNT_WAKE_ID=$(register_cron "butler-account-agent-wake" \
    --name "butler-account-agent-wake" \
    --agent butler-account-agent \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-account-agent:inbox" \
    --message "读 shared/account-agent/ 中最近2天的 .json 文件。处理费用汇总或预算核实请求。写回复到 shared/coordinator/。最后从 shared/taxonomy.json 读 coordinator 的 wake ID，调 openclaw cron run 唤醒。" \
    --disabled \
    --no-deliver)

  # --- coordinator wake（子 agent 回复唤醒）---
  # 使用 --session main 而非 custom inbox session
  # 原因：coordinator 是面向用户的 agent，--session main 会让 cron
  # 跑在用户聊天的那个 main session，回复直接走用户 channel（OpenClaw
  # 文档："Main session jobs can use the target main session's last
  # delivery context for replies"）。不再需要 shared/coordinator/inbox 转发。
  COORDINATOR_WAKE_ID=$(register_cron "butler-coordinator-wake" \
    --name "butler-coordinator-wake" \
    --agent butler \
    --at "2036-01-01T00:00:00+08:00" \
    --session main \
    --message "读 shared/coordinator/ 中最近2天的 .json 文件。处理子 agent 回复（行程结果、异常通知等）。以本 agent 主 session 的身份直接回复用户。" \
    --disabled \
    --no-deliver)

  # --- self-wake（备份 / 自维护，可选） ---
  SELF_WAKE_ID=$(register_cron "butler-self-wake" \
    --name "butler-self-wake" \
    --agent butler \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-self:maintenance" \
    --message "自维护任务：备份 workspace、清理过期 inbox 消息、检查 agent 状态。" \
    --disabled \
    --no-deliver)

  # --- 整点巡检（coordinator 主动检查） ---
  HOURLY_SWEEP_ID=$(register_cron "butler-coordinator-hourly-sweep" \
    --name "butler-coordinator-hourly-sweep" \
    --agent butler \
    --cron "0 * * * *" \
    --tz "Asia/Shanghai" \
    --session-key "session:butler-coordinator:heartbeat" \
    --message "按 coordinator/HEARTBEAT.md 巡检：查 emergency_events，触发子 agent 主动服务（用各自 wake job）" \
    --no-deliver)

  echo "--- cron jobs: done ---"

  # ============================================
  # Part 1.5: 写 wake job ID 到 shared/taxonomy.json
  # ============================================
  TAXONOMY="$WORKSPACE/shared/taxonomy.json"
  if [ -f "$TAXONOMY" ]; then
    # （#4）写入前检查所有 ID，空值显式 warn
    EMPTY_IDS=()
    for KEY in TRIP_WAKE_ID SCHEDULE_WAKE_ID ACCOUNT_WAKE_ID COORDINATOR_WAKE_ID SELF_WAKE_ID HOURLY_SWEEP_ID; do
      eval "VAL=\$$KEY"
      if [ -z "$VAL" ]; then
        EMPTY_IDS+=("$KEY")
      fi
    done
    if [ ${#EMPTY_IDS[@]} -gt 0 ]; then
      echo "  [WARN] 以下 wake job ID 为空，跳过 taxonomy.json 写入以防污染：${EMPTY_IDS[*]}" >&2
      echo "         先手动 'openclaw cron list | grep butler' 看 job 是否真存在，再重跑 init.sh" >&2
    else
      echo "--- 写 wake job ID 到 taxonomy.json ---"
      # （#5）非致命操作临时关 set -e + 错误处理
      set +e
      python3 - <<PYEOF
import json, datetime, sys
p = "$TAXONOMY"
try:
    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["cron_jobs"] = {
        "trip-agent":     "$TRIP_WAKE_ID",
        "schedule-agent": "$SCHEDULE_WAKE_ID",
        "account-agent":  "$ACCOUNT_WAKE_ID",
        "coordinator":    "$COORDINATOR_WAKE_ID",
        "self":           "$SELF_WAKE_ID",
    }
    data["hourly_sweep_cron_id"] = "$HOURLY_SWEEP_ID"
    data["updated_at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print("  taxonomy.json: cron_jobs + hourly_sweep_cron_id 已写入")
except Exception as e:
    print(f"  [WARN] taxonomy.json 读写失败: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
      PY_EXIT=$?
      set -e
      if [ $PY_EXIT -ne 0 ]; then
        echo "  [WARN] taxonomy.json 写入失败（exit=$PY_EXIT），agent 间通讯可能找不到 wake ID" >&2
      fi
    fi
  else
    echo "[WARN] $TAXONOMY 不存在，跳过 ID 写入"
  fi
fi

# ============================================
# Part 2: 系统 Crontab（mockend 异常模拟）
# ============================================

echo ""
echo "--- 配置系统 crontab ---"

# （#2）日志路径改用 $WORKSPACE/logs/
CRON_GEN="*/30 * * * * cd $WORKSPACE && node $SCRIPTS/event_generator.js >> $LOG_DIR/eventgen.log 2>&1"
CRON_DET="*/10 * * * * cd $WORKSPACE && node $SCRIPTS/event_detector.js >> $LOG_DIR/eventdet.log 2>&1"

if command -v crontab &>/dev/null; then
  # （#5）crontab 写操作临时关 set -e
  set +e
  # 检查是否已存在（幂等安装）
  CURRENT=$(crontab -l 2>/dev/null || true)
  NEED_UPDATE=false

  # 同时清除旧的 anomaly_* 旧条目
  NEED_CLEANUP=false
  if echo "$CURRENT" | grep -q "anomaly_generator.js\|anomaly_detector.js"; then
    NEED_CLEANUP=true
  fi

  if ! echo "$CURRENT" | grep -q "event_generator.js"; then
    echo "# LifeButler mockend 事件发生器（每30分钟）" >> /tmp/butler-cron.tmp
    echo "$CRON_GEN" >> /tmp/butler-cron.tmp
    NEED_UPDATE=true
  fi
  if ! echo "$CURRENT" | grep -q "event_detector.js"; then
    echo "# LifeButler mockend 坏事检测器（每10分钟）" >> /tmp/butler-cron.tmp
    echo "$CRON_DET" >> /tmp/butler-cron.tmp
    NEED_UPDATE=true
  fi

  if [ "$NEED_UPDATE" = true ] || [ "$NEED_CLEANUP" = true ]; then
    # 清掉旧 anomaly_* 行后合并新条目
    echo "$CURRENT" | grep -v "anomaly_generator.js\|anomaly_detector.js" > /tmp/butler-cron.tmp
    if [ "$NEED_UPDATE" = true ]; then
      # 重新加 event_* 条目（去重）
      if ! grep -q "event_generator.js" /tmp/butler-cron.tmp; then
        echo "$CRON_GEN" >> /tmp/butler-cron.tmp
      fi
      if ! grep -q "event_detector.js" /tmp/butler-cron.tmp; then
        echo "$CRON_DET" >> /tmp/butler-cron.tmp
      fi
    fi
    crontab /tmp/butler-cron.tmp
    CRONTAB_EXIT=$?
    rm -f /tmp/butler-cron.tmp
    if [ $CRONTAB_EXIT -ne 0 ]; then
      echo "  [WARN] crontab 更新失败（exit=$CRONTAB_EXIT），可能需要手动添加：" >&2
      echo "         $CRON_GEN" >&2
      echo "         $CRON_DET" >&2
    else
      echo "  system crontab: updated to event_* (cleaned old anomaly_*)"
    fi
  else
    echo "  system crontab: already configured (skip)"
  fi
  set -e
else
  echo "[WARN] crontab not available, skipping system cron setup"
  echo "       手动添加以下行到 crontab："
  echo "       $CRON_GEN"
  echo "       $CRON_DET"
fi

echo ""
echo "=== Init Complete ==="
echo "  OpenClaw:  5 wake jobs + 1 hourly sweep"
echo "  System:    event_generator (30m) + event_detector (10m)"
echo "  Logs:      $LOG_DIR/"
echo ""
echo "  验证：openclaw cron list | grep butler"
