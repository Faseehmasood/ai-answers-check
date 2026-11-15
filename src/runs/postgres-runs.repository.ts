import { Injectable } from '@nestjs/common';
import pg from 'pg';
import { IRunsRepository } from './runs.repository.interface.js';
import { RunItem, RunSummary, SeedRunItemInput } from './runs.types.js';

interface PgRunItemRow {
  id: string;
  run_date: string;
  question_id: string;
  question_text: string;
  provider: string;
  status: string;
  raw_answer: string | null;
  citations: string[] | string | null;
  tokens_used: number;
  cost_cents: number;
  attempts: number;
  error_reason: string | null;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class PostgresRunsRepository implements IRunsRepository {
  constructor(private readonly pool: pg.Pool) {}

  private mapRow(row: PgRunItemRow): RunItem {
    let citations: string[] = [];
    if (Array.isArray(row.citations)) {
      citations = row.citations;
    } else if (typeof row.citations === 'string') {
      try {
        citations = JSON.parse(row.citations);
      } catch {
        citations = [];
      }
    }

    return {
      id: row.id,
      runDate: typeof row.run_date === 'string' ? row.run_date.substring(0, 10) : new Date(row.run_date).toISOString().substring(0, 10),
      questionId: row.question_id,
      questionText: row.question_text,
      provider: row.provider,
      status: row.status as RunItem['status'],
      rawAnswer: row.raw_answer,
      citations,
      tokensUsed: Number(row.tokens_used) || 0,
      costCents: Number(row.cost_cents) || 0,
      attempts: Number(row.attempts) || 0,
      errorReason: row.error_reason,
      lockedAt: row.locked_at ? new Date(row.locked_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async seedRunItems(items: SeedRunItemInput[]): Promise<number> {
    if (items.length === 0) return 0;

    let inserted = 0;
    // Batch in chunks of 500 for SQL parameter limit safety
    const chunkSize = 500;
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      chunk.forEach((item, index) => {
        const offset = index * 4;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, 'pending')`);
        values.push(item.runDate, item.questionId, item.questionText, item.provider);
      });

      const sql = `
        INSERT INTO run_items (run_date, question_id, question_text, provider, status)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (run_date, question_id, provider) DO NOTHING
      `;

      const result = await this.pool.query(sql, values);
      inserted += result.rowCount || 0;
    }

    return inserted;
  }

  async claimNextPendingItem(runDate: string, provider?: string): Promise<RunItem | null> {
    const providerFilter = provider ? `AND provider = $2` : '';
    const params = provider ? [runDate, provider] : [runDate];

    const sql = `
      UPDATE run_items
      SET status = 'in_progress', locked_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM run_items
        WHERE run_date = $1 AND status = 'pending' ${providerFilter}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *;
    `;

    const result = await this.pool.query<PgRunItemRow>(sql, params);
    if (!result.rows[0]) return null;
    return this.mapRow(result.rows[0]);
  }

  async getSpentBudgetToday(runDate: string): Promise<number> {
    const sql = `
      SELECT COALESCE(SUM(cost_cents), 0)::int AS total_spent
      FROM run_items
      WHERE run_date = $1;
    `;
    const result = await this.pool.query<{ total_spent: number }>(sql, [runDate]);
    return Number(result.rows[0]?.total_spent || 0);
  }

  async releaseBackToPending(id: string): Promise<void> {
    const sql = `
      UPDATE run_items
      SET status = 'pending', locked_at = NULL, updated_at = now()
      WHERE id = $1;
    `;
    await this.pool.query(sql, [id]);
  }

  async markDone(
    id: string,
    result: { rawAnswer: string; citations: string[]; tokensUsed: number; costCents: number },
  ): Promise<void> {
    const sql = `
      UPDATE run_items
      SET status = 'done',
          raw_answer = $1,
          citations = $2::jsonb,
          tokens_used = $3,
          cost_cents = $4,
          locked_at = NULL,
          updated_at = now()
      WHERE id = $5;
    `;
    await this.pool.query(sql, [
      result.rawAnswer,
      JSON.stringify(result.citations),
      result.tokensUsed,
      result.costCents,
      id,
    ]);
  }

  async markQuarantined(id: string, reason: string): Promise<void> {
    const sql = `
      UPDATE run_items
      SET status = 'quarantined', error_reason = $1, locked_at = NULL, updated_at = now()
      WHERE id = $2;
    `;
    await this.pool.query(sql, [reason, id]);
  }

  async markFailed(id: string, reason: string): Promise<void> {
    const sql = `
      UPDATE run_items
      SET status = 'failed', error_reason = $1, locked_at = NULL, updated_at = now()
      WHERE id = $2;
    `;
    await this.pool.query(sql, [reason, id]);
  }

  async reclaimStuckItems(timeoutMinutes: number): Promise<number> {
    const sql = `
      UPDATE run_items
      SET status = 'pending', locked_at = NULL, updated_at = now()
      WHERE status = 'in_progress' AND locked_at < now() - ($1 || ' minutes')::interval;
    `;
    const result = await this.pool.query(sql, [timeoutMinutes]);
    return result.rowCount || 0;
  }

  async getRunSummary(runDate: string): Promise<RunSummary> {
    const sql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'done')::int AS done,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'quarantined')::int AS quarantined,
        COALESCE(SUM(cost_cents), 0)::int AS spent_cents
      FROM run_items
      WHERE run_date = $1;
    `;
    const result = await this.pool.query<{
      total: number;
      pending: number;
      in_progress: number;
      done: number;
      failed: number;
      quarantined: number;
      spent_cents: number;
    }>(sql, [runDate]);

    const row = result.rows[0];
    return {
      runDate,
      total: Number(row?.total || 0),
      pending: Number(row?.pending || 0),
      inProgress: Number(row?.in_progress || 0),
      done: Number(row?.done || 0),
      failed: Number(row?.failed || 0),
      quarantined: Number(row?.quarantined || 0),
      spentCents: Number(row?.spent_cents || 0),
      budgetExceeded: false,
    };
  }

  async getAllItems(runDate: string): Promise<RunItem[]> {
    const sql = `SELECT * FROM run_items WHERE run_date = $1 ORDER BY created_at ASC`;
    const result = await this.pool.query<PgRunItemRow>(sql, [runDate]);
    return result.rows.map((r) => this.mapRow(r));
  }
}
