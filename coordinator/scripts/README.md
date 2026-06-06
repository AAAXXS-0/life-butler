# Coordinator 初始化脚本

## `init.sh`

Coordinator Agent 首次启动时运行。一次性配置所有定时任务。

### 做什么

| 类型 | 数量 | 说明 |
|------|------|------|
| OpenClaw cron（wake） | 5 | trip/schedule/account/coordinator/self 通信唤醒 |
| OpenClaw cron（sweep） | 1 | 整点巡检触发主动服务 |
| 系统 crontab | 2 | generator(30m) + detector(10m) |

### 运行

```bash
# 在项目根目录
bash coordinator/scripts/init.sh
```

### 幂等

可重复运行，已存在的 job 跳过。
