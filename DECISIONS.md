# Architectural & Design Decisions

## What We Decided

### 1. Queue Architecture: Postgres `FOR UPDATE SKIP LOCKED`
- **Decision:** Use a Postgres-native queue backed by the `run_items` table with `FOR UPDATE SKIP LOCKED` for task claiming.
- **Rationale:**
  - Zero extra infrastructure (operates directly on Supabase Postgres).
  - Eliminates dual-state sync risks between a secondary queue (e.g. Redis) and Postgres persistence.
  - Native atomicity: task locking, idempotency tracking, and result storage exist in the same database transaction.
  - Safe worker crashes: stuck items are reclaimed using lock timeouts (`locked_at < now() - INTERVAL '5 minutes'`).

### 2. Idempotency Key & Safe Re-Runs
- **Decision:** Enforce a natural `UNIQUE(run_date, question_id, provider)` constraint in the database.
- **Workflow:**
  - **Seed up-front:** Job initialization seeds all units of work as `pending` via `INSERT ... ON CONFLICT DO NOTHING`.
  - **Atomic claim:** Workers claim rows with `UPDATE run_items SET status = 'in_progress', locked_at = now() ... WHERE id = (...) FOR UPDATE SKIP LOCKED`.
  - **Atomic completion:** Single statement marks item `done` and writes `raw_answer`, `citations`, `tokens_used`, and `cost_cents`.
  - **Re-run safety:** Re-running the job for the same `run_date` creates 0 new rows and triggers 0 external API calls.

### 3. Pre-Call Budget Guard
- **Decision:** Check the daily budget ceiling **before** every individual API call, not after.
- **Rationale:**
  - If the accumulated spend reaches or exceeds `daily_budget_cents`, the runner stops claiming/calling and pauses gracefully.
  - Protects against surprise billing before any expensive token generation occurs.

### 4. Timeout Quarantine & Duplicate Billing Prevention
- **Decision:** Distinguish pre-execution rejections (429 rate limit, 503 unavailable) from ambiguous in-flight network drops (504 gateway timeout, socket hangup).
- **Rationale:**
  - 429 and 503 mean the provider never processed the prompt; safe to retry with exponential backoff + jitter.
  - 504 and socket drops mean the provider may have already generated the answer and billed tokens. To guarantee we never pay twice, unconfirmed timeouts are marked `quarantined` rather than blindly retried.

### 5. Provider Adapter Abstraction & Deterministic Testing
- **Decision:** All AI calls route through an `AiProvider` interface (`providerName`, `ask(questionText)`).
- **Rationale:**
  - Business logic remains independent of vendor SDKs.
  - Tests exclusively use `FakeAiProvider` with configurable responses, simulated latency, error injection, and call tracking.

---

## What We Skipped (Deferred to Later Versions)

1. **Redis / BullMQ Queue:**
   - Deferred. Postgres `SKIP LOCKED` is simpler, reliable, and completely eliminates external Redis infrastructure for v1. Can upgrade if DB connection pool limits require offloading at 50,000+ daily scale.
2. **Analysis & Brand Extraction Pipeline (Stage 2):**
   - Deferred. v1 focuses exclusively on robust, idempotent ingestion of raw responses and citations. Entity resolution, sentiment analysis, and brand rank detection will run as a decoupled post-processing stage.
3. **Live Vendor SDK Implementations:**
   - OpenAI, Gemini, and Perplexity production API adapters are planned for v1.1. Core batch flow, idempotency, and tests are validated with `FakeAiProvider` first.
4. **Watchdog Microservice:**
   - Standalone external watchdog process deferred; v1 includes inline stuck lock reclamation (`reclaimStuckItems`).
