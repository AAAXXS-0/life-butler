#!/bin/bash
# ============================================
# LifeButler 初始化脚本
# Coordinator 首次启动时运行，配置所有定时任务
# ============================================
set -e

WORKSPACE="${BUTLER_WORKSPACE:-$(dirname "$(dirname "$(dirname "$(readlink -f "$0")")")")}"
AGENTS="$WORKSPACE/agents"
SCRIPTS="$WORKSPACE/mock_backend/scripts"

echo "=== LifeButler Init ==="
echo "Workspace: $WORKSPACE"

# ============================================
# Part 1: OpenClaw Cron Jobs（Agent 间通信）
# ============================================

# 检查 openclaw 是否可用
if ! command -v openclaw &>/dev/null; then
  echo "[WARN] openclaw CLI not found, skipping cron job setup"
  echo "       Cron jobs 需要 OpenClaw 运行时环境"
else
  echo "--- 注册 OpenClaw cron jobs ---"

  # --- trip-agent wake（coordinator 委托 / mockend 异常 唤醒） ---
  openclaw cron add \
    --name "butler-trip-agent-wake" \
    --agent butler-trip-agent \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-trip-agent:inbox" \
    --message "读 shared/trip-agent/ 中最近2天的 .json 文件。处理 coordinator 委托或 mockend 异常 diff。写回复到对应收件箱。" \
    --disabled \
    --no-deliver \
    --wake now 2>/dev/null || echo "  trip-agent-wake: already exists (skip)"

  # --- schedule-agent wake ---
  openclaw cron add \
    --name "butler-schedule-agent-wake" \
    --agent butler-schedule-agent \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-schedule-agent:inbox" \
    --message "读 shared/schedule-agent/ 中最近2天的 .json 文件。处理时间冲突查询或日程写入。写回复到对应收件箱。" \
    --disabled \
    --no-deliver \
    --wake now 2>/dev/null || echo "  schedule-agent-wake: already exists (skip)"

  # --- account-agent wake ---
  openclaw cron add \
    --name "butler-account-agent-wake" \
    --agent butler-account-agent \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-account-agent:inbox" \
    --message "读 shared/account-agent/ 中最近2天的 .json 文件。处理费用汇总或预算核实请求。写回复到对应收件箱。" \
    --disabled \
    --no-deliver \
    --wake now 2>/dev/null || echo "  account-agent-wake: already exists (skip)"

  # --- coordinator wake（子 agent 回复唤醒） ---
  openclaw cron add \
    --name "butler-coordinator-wake" \
    --agent butler \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-coordinator:inbox" \
    --message "读 shared/coordinator/ 中最近2天的 .json 文件。处理子 agent 回复（行程结果、异常通知等）。推送结果给用户。" \
    --disabled \
    --no-deliver \
    --wake now 2>/dev/null || echo "  coordinator-wake: already exists (skip)"

  # --- self-wake（备份 / 自维护，可选） ---
  openclaw cron add \
    --name "butler-self-wake" \
    --agent butler \
    --at "2036-01-01T00:00:00+08:00" \
    --session-key "session:butler-self:maintenance" \
    --message "自维护任务：备份 workspace、清理过期 inbox 消息、检查 agent 状态。" \
    --disabled \
    --no-deliver \
    --wake now 2>/dev/null || echo "  self-wake: already exists (skip)"

  # --- 整点巡检（coordinator 主动检查） ---
  openclaw cron add \
    --name "butler-coordinator-hourly-sweep" \
    --agent butler \
    --cron "0 * * * *" \
    --tz "Asia/Shanghai" \
    --session-key "session:butler-coordinator:heartbeat" \
    --message "按 coordinator/HEARTBEAT.md 巡检：查 emergency_events，触发子 agent 主动服务（用各自 wake job）" \
    --no-deliver \
    --wake now 2>/dev/null || echo "  hourly-sweep: already exists (skip)"

  echo "--- cron jobs: done ---"
fi

# ============================================
# Part 2: 系统 Crontab（mockend 异常模拟）
# ============================================

echo ""
echo "--- 配置系统 crontab ---"

CRON_GEN="*/30 * * * * cd $WORKSPACE && node $SCRIPTS/anomaly_generator.js >> /var/log/butler-mockgen.log 2>&1"
CRON_DET="*/10 * * * * cd $WORKSPACE && node $SCRIPTS/anomaly_detector.js >> /var/log/butler-mockdet.log 2>&1"

if command -v crontab &>/dev/null; then
  # 检查是否已存在（幂等安装）
  CURRENT=$(crontab -l 2>/dev/null || true)
  NEED_UPDATE=false

  if ! echo "$CURRENT" | grep -q "anomaly_generator.js"; then
    echo "# LifeButler mockend 异常发生器（每30分钟）" >> /tmp/butler-cron.tmp
    echo "$CRON_GEN" >> /tmp/butler-cron.tmp
    NEED_UPDATE=true
  fi
  if ! echo "$CURRENT" | grep -q "anomaly_detector.js"; then
    echo "# LifeButler mockend 异常检测器（每10分钟）" >> /tmp/butler-cron.tmp
    echo "$CRON_DET" >> /tmp/butler-cron.tmp
    NEED_UPDATE=true
  fi

  if [ "$NEED_UPDATE" = true ]; then
    echo "$CURRENT" >> /tmp/butler-cron.tmp
    crontab /tmp/butler-cron.tmp
    rm -f /tmp/butler-cron.tmp
    echo "  system crontab: added generator + detector"
  else
    echo "  system crontab: already configured (skip)"
  fi
else
  echo "[WARN] crontab not available, skipping system cron setup"
  echo "       手动添加以下行到 crontab："
  echo "       $CRON_GEN"
  echo "       $CRON_DET"
fi

echo ""
echo "=== Init Complete ==="
echo "  OpenClaw:  5 wake jobs + 1 hourly sweep"
echo "  System:    generator (30m) + detector (10m)"
echo ""
echo "  验证：openclaw cron list | grep butler"
