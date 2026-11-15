# AI Answers Check

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6.svg)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-v12-E0234E.svg)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-336791.svg)](https://supabase.com/)

**AI Answers Check** is an open-source, production-grade daily batch engine built with **NestJS** and **PostgreSQL (Supabase)**. It queries major AI assistants (**ChatGPT**, **Gemini**, **Perplexity**) across a fixed set of ~10,000 buyer questions every day to track whether, where, and how a brand is mentioned and cited—feeding visibility dashboards and trend alerts with **zero duplicate API charges**.

---

## What This Project Does & Engineering Highlights

When running tens of thousands of paid LLM queries every day, naive cron jobs fail in expensive ways: crashes cause full re-runs that double-bill already-completed prompts, gateway timeouts trigger blind retries that pay twice for generated tokens, and runaway loops blow past daily API budgets.

**AI Answers Check** solves these problems at the database and worker protocol level:

### 1. Strict Idempotency (Zero Duplicate Rows, Zero Duplicate Charges)
- **Natural Unique Key:** Enforces `UNIQUE (run_date, question_id, provider)` at the PostgreSQL schema level ([migrations/20261105000000_create_run_items.sql](./migrations/20261105000000_create_run_items.sql)).
- **Up-Front Seeding:** Seeds all `(run_date, question_id, provider)` combinations as `pending` via `INSERT ... ON CONFLICT DO NOTHING` before execution starts.
- **Safe Re-Runs:** Re-running the batch job for the same `run_date` inserts **0 new rows** and triggers **0 external API calls** for completed items.

### 2. Zero-Redis Postgres Queue (`FOR UPDATE SKIP LOCKED`)
- Workers atomically claim tasks directly from PostgreSQL using row-level locking:
  ```sql
  UPDATE run_items
  SET status = 'in_progress', locked_at = now(), attempts = attempts + 1
  WHERE id = (
    SELECT id FROM run_items
    WHERE run_date = $1 AND status = 'pending'
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
  ```
- **Crash Recovery:** Orphaned `in_progress` items from crashed workers are automatically reclaimed when `locked_at < now() - INTERVAL '5 minutes'` (`reclaimStuckItems`).

### 3. Pre-Call Daily Budget Guard
- Accumulated daily spend (`SUM(cost_cents)`) is verified **before** every individual provider API call—never after.
- If the daily budget ceiling (`dailyBudgetCents`) is reached, the worker immediately releases the claimed item back to `pending` and pauses the run cleanly before spending another cent.

### 4. Smart Fault Tolerance & Timeout Quarantine
Not all HTTP errors are equal when calling paid AI APIs:
| Failure Type | Example | Worker Action | Why |
| :--- | :--- | :--- | :--- |
| **Pre-Execution Transient** (`ProviderRateLimitError`, `ProviderServerError`) | `429 Too Many Requests`, `503 Service Unavailable` | Release back to `pending` & retry (up to `maxRetries`) | Provider rejected the request before generating tokens; safe to retry. |
| **In-Flight Ambiguous Timeout** (`ProviderTimeoutError`) | `504 Gateway Timeout`, socket hangup | Mark **`quarantined`** (never auto-retry) | Provider may have already generated the response and billed tokens. Quarantining guarantees we **never pay twice**. |
| **Client / Validation Error** (`ProviderValidationError`) | `400 Bad Request` | Mark **`failed`** immediately (0 retries) | Deterministic client error; retrying would only waste quota. |

### 5. Clean Provider Adapter Architecture
- All external AI calls route through the [`AiProvider`](./src/providers/ai-provider.interface.ts) adapter interface (`providerName`, `ask(questionText)`).
- Business logic in [`RunsService`](./src/runs/runs.service.ts) has zero direct dependency on vendor SDKs.
- Includes [`FakeAiProvider`](./src/providers/fake-ai.provider.ts) and [`InMemoryRunsRepository`](./src/runs/in-memory-runs.repository.ts) for fast, deterministic unit and idempotency testing without hitting real APIs.

### 6. Daily Morning Audit SQL Suite
- [`queries/morning_audit.sql`](./queries/morning_audit.sql) provides three ready-to-run operational queries for yesterday's batch (`CURRENT_DATE - INTERVAL '1 day'`):
  1. **Executive Health Summary:** Completion status (`COMPLETED` vs `INCOMPLETE / STALLED`), duplicate key violation check, overall failure rate %, and total spend in USD.
  2. **Per-Provider Breakdown:** Failure rate %, timeout quarantine rate %, completion rate %, total tokens used, and total/average USD cost per provider.
  3. **Strict Duplicate Key Auditor:** Zero-tolerance check that returns any offending `(run_date, question_id, provider)` records with `COUNT(*) > 1`.

---

## Project Structure

```text
ai-answers-check/
├── .agents/
│   ├── rules/
│   │   └── db-migrations.md                  # Safe PostgreSQL migration rules
│   └── skills/
│       └── idempotent-batch-job/SKILL.md     # Idempotent worker design patterns
├── migrations/
│   └── 20261105000000_create_run_items.sql   # PostgreSQL schema & partial queue index
├── queries/
│   └── morning_audit.sql                     # Daily health, cost & duplicate audit SQL
├── src/
│   ├── providers/
│   │   ├── ai-provider.interface.ts          # Vendor-agnostic AI adapter contract
│   │   ├── fake-ai.provider.ts               # Configurable fake provider for tests
│   │   └── provider-errors.ts                # Typed errors (429, 5xx, 504 timeout, 4xx)
│   ├── runs/
│   │   ├── runs.module.ts                    # NestJS module wiring
│   │   ├── runs.service.ts                   # Idempotent seeding & worker loop
│   │   ├── runs.repository.interface.ts      # Repository contract
│   │   ├── postgres-runs.repository.ts       # Production PostgreSQL (SKIP LOCKED) repo
│   │   ├── in-memory-runs.repository.ts      # In-memory repo for deterministic tests
│   │   └── runs.types.ts                     # Explicit status enums & DTOs
│   ├── app.module.ts
│   └── main.ts
├── test/
│   ├── runs-idempotency.spec.ts              # Idempotency, budget guard & quarantine tests
│   └── app.e2e-spec.ts                       # End-to-end application tests
├── .env.example                              # Template for environment variables (no secrets)
├── AGENTS.md                                 # Project engineering & security rules
└── DECISIONS.md                              # Architecture Decision Records (ADRs)
```

---

## Getting Started

### 1. Prerequisites
- **Node.js** `>= 20.x`
- **npm** `>= 10.x`
- **PostgreSQL** (or a [Supabase](https://supabase.com/) project) for production runs

### 2. Installation

```bash
git clone https://github.com/Faseehmasood/ai-answers-check.git
cd ai-answers-check
npm install
```

### 3. Environment Configuration (Security First)
Copy `.env.example` to `.env` and fill in your credentials locally. **Never commit `.env` or real API keys** (`.gitignore` blocks all `.env` files automatically).

```bash
cp .env.example .env
```

`.env.example`:
```dotenv
DATABASE_URL=
OPENAI_API_KEY=
GEMINI_API_KEY=
PERPLEXITY_API_KEY=
DAILY_BUDGET_USD=
```

### 4. Apply Database Migration
Run the SQL migration against your PostgreSQL / Supabase database:

```bash
psql "$DATABASE_URL" -f migrations/20261105000000_create_run_items.sql
```

---

## Running & Testing

```bash
# Build the project (TypeScript strict mode)
npm run build

# Run unit & idempotency tests (Vitest)
npm run test

# Run tests with coverage
npm run test:cov

# Lint codebase (Oxlint)
npm run lint

# Start application in watch mode
npm run start:dev
```

### What the Automated Test Suite Verifies (`test/runs-idempotency.spec.ts`)
1. **Same-Date Re-Run Idempotency:** Seeds 5 questions across 3 providers (`15` items), runs to completion, and re-runs the exact same `run_date`—verifying `0` new rows inserted and `0` additional provider API calls.
2. **Pre-Call Budget Cutoff:** Enforces a strict cent budget ceiling prior to each provider call, halting execution and returning the claimed item to `pending` before overspending.
3. **Mid-Run Crash Recovery:** Simulates a worker crash with a stale lock (`10 minutes` old), confirming `reclaimStuckItems` recovers the stuck item and finishes the batch without re-calling completed items.
4. **Timeout Quarantine vs. Rate-Limit Retry:** Confirms `504` in-flight timeouts are marked `quarantined` with `callCount === 1` (no double billing), `429` rate limits retry and succeed, and `400` validation errors fail immediately with `0` retries.

---

## Architectural Decisions
See [DECISIONS.md](./DECISIONS.md) for detailed Architecture Decision Records (ADRs) covering why we chose PostgreSQL `FOR UPDATE SKIP LOCKED` over Redis/BullMQ for v1, timeout quarantine semantics, and stage-2 roadmap items.

---

## License

This project is open-sourced under the [MIT License](./LICENSE).
