import { RunItem, RunSummary, SeedRunItemInput } from './runs.types.js';

export interface IRunsRepository {
  /**
   * Insert all units of work up front using ON CONFLICT DO NOTHING.
   * Returns count of newly inserted rows.
   */
  seedRunItems(items: SeedRunItemInput[]): Promise<number>;

  /**
   * Atomically claim the next pending item using row-level locking (FOR UPDATE SKIP LOCKED)
   * and mark it 'in_progress' with locked_at = now().
   */
  claimNextPendingItem(runDate: string, provider?: string): Promise<RunItem | null>;

  /**
   * Get the total cost spent today for the given date.
   */
  getSpentBudgetToday(runDate: string): Promise<number>;

  /**
   * Release an item back to pending (e.g. if budget ceiling was hit before calling).
   */
  releaseBackToPending(id: string): Promise<void>;

  /**
   * Atomically mark item done with results in the same statement.
   */
  markDone(
    id: string,
    result: { rawAnswer: string; citations: string[]; tokensUsed: number; costCents: number },
  ): Promise<void>;

  /**
   * Quarantine an item (e.g. unconfirmed in-flight timeouts to prevent double billing).
   */
  markQuarantined(id: string, reason: string): Promise<void>;

  /**
   * Mark an item permanently failed (e.g. non-retryable 4xx or exceeded max retries).
   */
  markFailed(id: string, reason: string): Promise<void>;

  /**
   * Reclaim items stuck in 'in_progress' past timeoutMinutes back to 'pending'.
   */
  reclaimStuckItems(timeoutMinutes: number): Promise<number>;

  /**
   * Get run summary counts for the runDate.
   */
  getRunSummary(runDate: string): Promise<RunSummary>;

  /**
   * Get all items for the runDate (for verification and assertions).
   */
  getAllItems(runDate: string): Promise<RunItem[]>;
}
