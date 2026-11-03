# AI Answers Check – Agent Rules

## What this project is
A daily batch job that asks AI assistants (ChatGPT, Gemini, Perplexity) a fixed set of
~10,000 buyer questions and records whether, where and how our brand is mentioned.
Results feed a visibility dashboard and trend alerts.

## Stack
- NestJS modular monolith (one deployable, clear modules: `questions`, `runs`, `providers`, `analysis`).
- Postgres on Supabase. Schema changes only through migrations (see `.agents/rules/db-migrations.md`).
- TypeScript strict mode. Tests with the project's configured test runner (`npm run test`).

## Hard rules
1. **Never put secrets in code or commits.** Read them from env vars; list new keys in `.env.example` with empty values.
2. **Every external call must be idempotent.** A retry or a re-run must never create a duplicate row or a duplicate paid API call. Use the `idempotent-batch-job` skill for any job/worker code.
3. **Provider calls go through an adapter interface** (`AiProvider`). Business logic never imports a vendor SDK directly. Tests use a fake provider – never call real APIs in tests.
4. **Respect limits:** per-provider concurrency limit, exponential backoff with jitter on 429/5xx, and a daily budget guard checked *before* each call.
5. **Plan before code.** For any non-trivial change, propose a short plan and wait for approval.
6. **Done means verified:** code compiles, `npm run test` passes, and you state how you verified it.

## Style
- Small, focused modules and functions. No premature abstractions.
- Log with structured fields (`runId`, `questionId`, `provider`), never log full API keys or raw PII.
- Prefer explicit status enums (`pending | in_progress | done | failed`) over booleans for job state.
