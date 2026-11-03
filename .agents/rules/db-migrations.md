---
trigger: model_decision
description: Apply when creating or changing database tables, columns, indexes, constraints or SQL migrations.
---

# Database & Migration Rules

- All schema changes go in a new, timestamped migration file. Never edit a migration that has already been applied.
- Every migration must be safe to run on a live table: add columns as nullable or with a default, create large indexes `CONCURRENTLY`.
- Idempotency is enforced in the database, not only in code: job result tables need a `UNIQUE` constraint on the natural key (e.g. `run_date, question_id, provider`).
- Writes that may be retried use `INSERT ... ON CONFLICT ... DO NOTHING` / `DO UPDATE`, never blind inserts.
- Use `timestamptz` for times and store `created_at` / `updated_at` on every table.
- The Supabase MCP is **read-only**. Use it to inspect schema and data; never attempt writes through it. Apply migrations through the migration tool only.
- After writing a migration, state the rollback plan in one or two lines.
