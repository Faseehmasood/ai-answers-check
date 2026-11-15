import { IRunsRepository } from './runs.repository.interface.js';
import { RunItem, RunSummary, SeedRunItemInput } from './runs.types.js';

export class InMemoryRunsRepository implements IRunsRepository {
  private items = new Map<string, RunItem>();

  private buildKey(runDate: string, questionId: string, provider: string): string {
    return `${runDate}::${questionId}::${provider}`;
  }

  async seedRunItems(inputs: SeedRunItemInput[]): Promise<number> {
    let inserted = 0;
    const now = new Date();

    for (const input of inputs) {
      const key = this.buildKey(input.runDate, input.questionId, input.provider);
      // UNIQUE (run_date, question_id, provider) - ON CONFLICT DO NOTHING
      if (!this.items.has(key)) {
        const item: RunItem = {
          id: `item-${this.items.size + 1}-${Math.random().toString(36).substring(2, 9)}`,
          runDate: input.runDate,
          questionId: input.questionId,
          questionText: input.questionText,
          provider: input.provider,
          status: 'pending',
          citations: [],
          tokensUsed: 0,
          costCents: 0,
          attempts: 0,
          rawAnswer: null,
          errorReason: null,
          lockedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.items.set(key, item);
        inserted++;
      }
    }

    return inserted;
  }

  async claimNextPendingItem(runDate: string, provider?: string): Promise<RunItem | null> {
    for (const item of this.items.values()) {
      if (item.runDate === runDate && item.status === 'pending') {
        if (!provider || item.provider === provider) {
          item.status = 'in_progress';
          item.lockedAt = new Date();
          item.attempts += 1;
          item.updatedAt = new Date();
          return { ...item };
        }
      }
    }
    return null;
  }

  async getSpentBudgetToday(runDate: string): Promise<number> {
    let totalCents = 0;
    for (const item of this.items.values()) {
      if (item.runDate === runDate) {
        totalCents += item.costCents || 0;
      }
    }
    return totalCents;
  }

  async releaseBackToPending(id: string): Promise<void> {
    for (const item of this.items.values()) {
      if (item.id === id) {
        item.status = 'pending';
        item.lockedAt = null;
        item.updatedAt = new Date();
        return;
      }
    }
  }

  async markDone(
    id: string,
    result: { rawAnswer: string; citations: string[]; tokensUsed: number; costCents: number },
  ): Promise<void> {
    for (const item of this.items.values()) {
      if (item.id === id) {
        item.status = 'done';
        item.rawAnswer = result.rawAnswer;
        item.citations = result.citations;
        item.tokensUsed = result.tokensUsed;
        item.costCents = result.costCents;
        item.lockedAt = null;
        item.updatedAt = new Date();
        return;
      }
    }
  }

  async markQuarantined(id: string, reason: string): Promise<void> {
    for (const item of this.items.values()) {
      if (item.id === id) {
        item.status = 'quarantined';
        item.errorReason = reason;
        item.lockedAt = null;
        item.updatedAt = new Date();
        return;
      }
    }
  }

  async markFailed(id: string, reason: string): Promise<void> {
    for (const item of this.items.values()) {
      if (item.id === id) {
        item.status = 'failed';
        item.errorReason = reason;
        item.lockedAt = null;
        item.updatedAt = new Date();
        return;
      }
    }
  }

  async reclaimStuckItems(timeoutMinutes: number): Promise<number> {
    let reclaimed = 0;
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

    for (const item of this.items.values()) {
      if (item.status === 'in_progress' && item.lockedAt && item.lockedAt < cutoff) {
        item.status = 'pending';
        item.lockedAt = null;
        item.updatedAt = new Date();
        reclaimed++;
      }
    }

    return reclaimed;
  }

  simulateStuckLock(id: string, ageMinutes: number): void {
    for (const item of this.items.values()) {
      if (item.id === id) {
        item.lockedAt = new Date(Date.now() - ageMinutes * 60 * 1000);
        return;
      }
    }
  }

  async getRunSummary(runDate: string): Promise<RunSummary> {
    let total = 0;
    let pending = 0;
    let inProgress = 0;
    let done = 0;
    let failed = 0;
    let quarantined = 0;
    let spentCents = 0;

    for (const item of this.items.values()) {
      if (item.runDate === runDate) {
        total++;
        spentCents += item.costCents || 0;
        if (item.status === 'pending') pending++;
        else if (item.status === 'in_progress') inProgress++;
        else if (item.status === 'done') done++;
        else if (item.status === 'failed') failed++;
        else if (item.status === 'quarantined') quarantined++;
      }
    }

    return {
      runDate,
      total,
      pending,
      inProgress,
      done,
      failed,
      quarantined,
      spentCents,
      budgetExceeded: false,
    };
  }

  async getAllItems(runDate: string): Promise<RunItem[]> {
    const list: RunItem[] = [];
    for (const item of this.items.values()) {
      if (item.runDate === runDate) {
        list.push({ ...item });
      }
    }
    return list;
  }

  clear(): void {
    this.items.clear();
  }
}
