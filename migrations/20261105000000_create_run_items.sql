-- Migration: 20261105000000_create_run_items.sql
-- Description: Create run_items table with unique constraint on (run_date, question_id, provider)

CREATE TABLE IF NOT EXISTS run_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date DATE NOT NULL,
    question_id VARCHAR(255) NOT NULL,
    question_text TEXT NOT NULL,
    provider VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    raw_answer TEXT,
    citations JSONB DEFAULT '[]'::jsonb,
    tokens_used INT DEFAULT 0,
    cost_cents INT DEFAULT 0,
    attempts INT DEFAULT 0,
    error_reason TEXT,
    locked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_run_date_question_provider UNIQUE (run_date, question_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_run_items_queue_claim 
ON run_items (status, run_date, locked_at) 
WHERE status IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_run_items_run_date 
ON run_items (run_date);

-- Rollback Plan:
-- DROP TABLE IF EXISTS run_items;
