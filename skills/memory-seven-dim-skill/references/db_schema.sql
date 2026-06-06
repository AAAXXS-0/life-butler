-- =============================================
-- 七维记忆系统 MySQL 建表 SQL
-- 库名：life_butler_db（与 mock_backend 共用）
-- 状态：随 docker-compose 启动自动执行
-- 更新时间：2026-06-06
-- 注意：库初始化时为空！侧写数据由 init-questionnaire-skill 流程填入
-- =============================================

USE life_butler_db;

-- =============================================
-- 表1：cache_events（第一层：未验证侧写）
-- =============================================
CREATE TABLE IF NOT EXISTS cache_events (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    dimension   VARCHAR(32)      NOT NULL,                          -- 七维之一
    sub_key     VARCHAR(64)      NOT NULL,                          -- 具体子项
    content     TEXT             NOT NULL,                          -- 侧写内容
    evidence    TEXT             NOT NULL,                          -- 原始对话原文（单条）
    evidence_list JSON           NOT NULL,                          -- 所有原始证据（数组）
    agent_id    VARCHAR(64)      NOT NULL,                          -- 写入的 Agent
    source_ref  VARCHAR(128)     DEFAULT '',                        -- session id 或 days 文件路径（含行号锚点）
    weight      TINYINT          DEFAULT 1,                         -- 同类条目计数
    demoted     TINYINT          DEFAULT 0,                         -- 是否被降级跳过，0/1
    created_at  DATETIME         NOT NULL,
    expires_at  DATETIME         NOT NULL,                          -- created_at + 14天（普通）/ 1年（降级侧写）
    INDEX idx_dimension_created (dimension, created_at),
    INDEX idx_expires (expires_at),
    INDEX idx_demoted (demoted)
);

-- =============================================
-- 表2：seven_dimensions（第二层：已验证画像）
-- =============================================
CREATE TABLE IF NOT EXISTS seven_dimensions (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    dimension       VARCHAR(32)      NOT NULL,
    sub_key         VARCHAR(64)      NOT NULL,
    content         TEXT             NOT NULL,
    evidence        TEXT             NOT NULL,
    evidence_list   JSON             NOT NULL,
    agent_id        VARCHAR(64)      NOT NULL,                       -- 'init' = 来自初始化问卷
    source_ref     VARCHAR(128)     DEFAULT '',
    confidence      TINYINT          NOT NULL,                       -- 置信度 1-10
    status          VARCHAR(16)      DEFAULT 'active',               -- active / demoted
    demoted_at      DATETIME         DEFAULT NULL,
    promoted_at     DATETIME         NOT NULL,
    updated_at      DATETIME         NOT NULL,
    UNIQUE KEY uk_dimension_subkey (dimension, sub_key),
    INDEX idx_status (status)
);

-- =============================================
-- 表3：promote_log（晋升日志）
-- =============================================
CREATE TABLE IF NOT EXISTS promote_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    cache_event_ids JSON             NOT NULL,                       -- 被晋升的 cache 事件 ID 列表
    target_id       BIGINT           NOT NULL,                       -- seven_dimensions.id
    target_type     VARCHAR(16)      NOT NULL,                       -- new_insert | update
    created_at      DATETIME         NOT NULL
);

-- =============================================
-- 表4：emergency_events（突发事件临时覆盖层）
-- =============================================
CREATE TABLE IF NOT EXISTS emergency_events (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_id            VARCHAR(64)      NOT NULL UNIQUE,            -- 业务 event_id
    dimension           VARCHAR(32)      NOT NULL,
    override_key        VARCHAR(64)      NOT NULL,
    override_value      TEXT             NOT NULL,
    source              VARCHAR(32)      DEFAULT NULL,               -- 'user_direct' | 'user_behavior_conflict'
    start_date          DATE             NOT NULL,
    end_date            DATE             NOT NULL,
    duration_days       SMALLINT         NOT NULL,
    check_interval_days SMALLINT         DEFAULT 2,
    next_check_date     DATE             NOT NULL,
    status              VARCHAR(16)      DEFAULT 'active',           -- active | completed | superseded
    resume_profile      BOOLEAN          DEFAULT TRUE,
    created_at          DATETIME         NOT NULL,
    updated_at          DATETIME         NOT NULL,
    INDEX idx_next_check (next_check_date, status)
);

-- =============================================
-- 初始化策略
-- =============================================
-- 库建好后 4 张表都是空的。
-- 首次使用时由 Coordinator 检测到 seven_dimensions 为空，
-- 调用 init-questionnaire-skill 发问卷，根据用户回答写入。
-- 详见 skills/init-questionnaire-skill/SKILL.md
