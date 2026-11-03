---
name: idempotent-batch-job
description: >-
  Use this skill when building or changing any scheduled job, queue worker or batch
  process that calls external/paid APIs (AI providers, payment gateways) and must be
  safe to retry, resume after a crash, and never create duplicates.
---

# Idempotent Batch Job

Lesson from payments: a retry after a timeout charged customers twice. The fix is
always the same pattern – make every unit of work identifiable, claimable and
safe to repeat.

## Steps

1. **Define the unit of work and its idempotency key.**
   For the AI answers check: one row per `(run_date, question_id, provider)`.
   Enforce it with a `UNIQUE` constraint in the database.

2. **Create the run up front.** At job start, insert all expected work items as
   `pending` using `INSERT ... ON CONFLICT DO NOTHING`. Re-running the job for the
   same date creates nothing new.

3. **Claim work atomically.** Workers take items with
   `UPDATE ... SET status = 'in_progress', locked_at = now() ... WHERE status = 'pending'`
   using `FOR UPDATE SKIP LOCKED`, so two workers never process the same item.
   Items stuck `in_progress` longer than a timeout go back to `pending`.

4. **Guard before calling.** Check the daily budget and per-provider concurrency
   limit *before* the external call, not after.

5. **Call with retries.** Exponential backoff with jitter on 429/5xx/timeouts,
   max N attempts, then mark `failed` with the error. Never retry 4xx validation errors.

6. **Write the result in the same statement that marks it done**
   (`UPDATE ... SET status = 'done', answer = ..., attempts = ...`). No separate
   insert that could duplicate.

7. **Expose run health:** expected, done, failed, in_progress counts and cost per run.

## Verification (required)

- Unit test with a fake provider: run the job **twice** for the same date and
  assert row count == expected and provider call count == expected (no duplicates).
- Test a crash mid-run: kill after K items, re-run, assert only the remaining
  items are processed.
- Test that a 429 is retried and a 400 is not.
