-- ============================================================================
-- AI Answers Check: Daily Morning Audit Query
-- Target run: Yesterday (CURRENT_DATE - INTERVAL '1 day')
-- Description:
--   1. Evaluates completion status (did it finish or stall?)
--   2. Audits unique key constraint violations (duplicate count)
--   3. Calculates failure rates, quarantine rates, and costs per provider
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXECUTIVE HEALTH SUMMARY (Did it finish? Any duplicates? Total cost?)
-- ----------------------------------------------------------------------------
SELECT
    run_date,
    COUNT(*) AS total_items,
    COUNT(*) FILTER (WHERE status = 'done') AS done_count,
    COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
    COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
    COUNT(*) FILTER (WHERE status = 'quarantined') AS quarantined_count,
    CASE 
        WHEN COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress')) = 0 AND COUNT(*) > 0 
            THEN 'COMPLETED'
        WHEN COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress')) > 0 
            THEN 'INCOMPLETE / STALLED'
        ELSE 'NO_DATA_FOR_DATE'
    END AS run_status,
    -- Unique key duplicate audit: MUST BE EXACTLY 0
    (COUNT(*) - COUNT(DISTINCT (question_id, provider))) AS duplicate_key_violations,
    -- Overall failure rate
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / NULLIF(COUNT(*), 0), 2) AS overall_failure_rate_pct,
    -- Total spend
    ROUND(SUM(cost_cents) / 100.0, 2) AS total_cost_usd
FROM run_items
WHERE run_date = CURRENT_DATE - INTERVAL '1 day'
GROUP BY run_date;


-- ----------------------------------------------------------------------------
-- 2. PER-PROVIDER BREAKDOWN (Failure rate, timeout quarantines, token & dollar cost)
-- ----------------------------------------------------------------------------
SELECT
    provider,
    COUNT(*) AS total_assigned,
    COUNT(*) FILTER (WHERE status = 'done') AS done_count,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
    COUNT(*) FILTER (WHERE status = 'quarantined') AS quarantined_count,
    -- Failure Rate % (Permanent failures, 4xx or retries exhausted)
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / NULLIF(COUNT(*), 0), 2) AS failure_rate_pct,
    -- Quarantine Rate % (504s / unconfirmed in-flight timeouts held to avoid double billing)
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'quarantined') / NULLIF(COUNT(*), 0), 2) AS quarantine_rate_pct,
    -- Completion Rate %
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'done') / NULLIF(COUNT(*), 0), 2) AS completion_rate_pct,
    -- Tokens and financial cost
    COALESCE(SUM(tokens_used), 0) AS total_tokens_used,
    ROUND(COALESCE(SUM(cost_cents), 0) / 100.0, 2) AS total_cost_usd,
    ROUND(COALESCE(AVG(cost_cents), 0) / 100.0, 4) AS avg_cost_per_item_usd
FROM run_items
WHERE run_date = CURRENT_DATE - INTERVAL '1 day'
GROUP BY provider
ORDER BY total_cost_usd DESC;


-- ----------------------------------------------------------------------------
-- 3. DUPLICATE KEY AUDITOR (Strict Zero-Tolerance Check)
-- Returns 0 rows if healthy. Returns offending records if duplicates exist.
-- ----------------------------------------------------------------------------
SELECT
    run_date,
    question_id,
    provider,
    COUNT(*) AS duplicate_occurrences,
    ARRAY_AGG(id) AS item_ids,
    ARRAY_AGG(status) AS statuses
FROM run_items
WHERE run_date = CURRENT_DATE - INTERVAL '1 day'
GROUP BY run_date, question_id, provider
HAVING COUNT(*) > 1;
