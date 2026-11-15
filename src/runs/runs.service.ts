import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IRunsRepository } from './runs.repository.interface.js';
import { RunSummary, SeedRunItemInput } from './runs.types.js';
import { AiProvider } from '../providers/ai-provider.interface.js';
import {
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderValidationError,
} from '../providers/provider-errors.js';

export interface QuestionInput {
  id: string;
  text: string;
}

export interface ExecuteBatchOptions {
  dailyBudgetCents: number;
  maxRetries?: number;
}

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  private providers = new Map<string, AiProvider>();

  constructor(
    @Inject('RUNS_REPOSITORY')
    private readonly repository: IRunsRepository,
  ) {}

  registerProvider(provider: AiProvider): void {
    this.providers.set(provider.providerName, provider);
  }

  /**
   * Seed all units of work up front using ON CONFLICT DO NOTHING.
   * Re-running the job for the same date creates 0 new rows.
   */
  async seedRun(
    runDate: string,
    questions: QuestionInput[],
    providerNames: string[],
  ): Promise<number> {
    const inputs: SeedRunItemInput[] = [];

    for (const q of questions) {
      for (const provider of providerNames) {
        inputs.push({
          runDate,
          questionId: q.id,
          questionText: q.text,
          provider,
        });
      }
    }

    const inserted = await this.repository.seedRunItems(inputs);
    this.logger.log({
      msg: 'Seeded run items',
      runDate,
      totalExpected: inputs.length,
      newlyInserted: inserted,
    });
    return inserted;
  }

  /**
   * Run the batch worker loop:
   * 1. Atomically claims pending work via row lock (SKIP LOCKED).
   * 2. Checks the budget BEFORE each provider call, not after.
   * 3. Calls provider adapter.
   * 4. Updates result and status atomically.
   */
  async executeBatch(
    runDate: string,
    options: ExecuteBatchOptions,
  ): Promise<RunSummary> {
    const maxRetries = options.maxRetries ?? 3;
    let budgetCutoffTriggered = false;

    // First reclaim any stuck items older than 5 minutes
    const reclaimed = await this.repository.reclaimStuckItems(5);
    if (reclaimed > 0) {
      this.logger.warn({ msg: 'Reclaimed orphaned stuck items', count: reclaimed, runDate });
    }

    while (true) {
      // Claim work atomically
      const item = await this.repository.claimNextPendingItem(runDate);
      if (!item) {
        // No more pending items for this run date
        break;
      }

      // GUARD BEFORE CALLING: Check budget ceiling before external call
      const currentSpend = await this.repository.getSpentBudgetToday(runDate);
      if (currentSpend >= options.dailyBudgetCents) {
        this.logger.warn({
          msg: 'Daily budget ceiling reached. Pausing batch before external call.',
          runDate,
          currentSpendCents: currentSpend,
          dailyBudgetCents: options.dailyBudgetCents,
          itemId: item.id,
        });

        // Release the claimed item back to pending so it is not marked stuck or lost
        await this.repository.releaseBackToPending(item.id);
        budgetCutoffTriggered = true;
        break;
      }

      const provider = this.providers.get(item.provider);
      if (!provider) {
        this.logger.error({
          msg: 'Provider adapter not found',
          provider: item.provider,
          itemId: item.id,
        });
        await this.repository.markFailed(item.id, `Unknown provider adapter: ${item.provider}`);
        continue;
      }

      try {
        // External call through adapter
        const answer = await provider.ask(item.questionText);

        // Atomic write-done: updates result + status in one statement
        await this.repository.markDone(item.id, answer);

        this.logger.debug?.({
          msg: 'Processed item successfully',
          runDate,
          questionId: item.questionId,
          provider: item.provider,
          costCents: answer.costCents,
        });
      } catch (err: unknown) {
        const error = err as Error;

        if (error instanceof ProviderTimeoutError) {
          // In-flight ambiguous timeout: provider may have already generated and billed tokens.
          // Quarantine without retrying to guarantee we NEVER pay twice.
          this.logger.warn({
            msg: 'In-flight timeout detected. Quarantining to prevent duplicate billing.',
            itemId: item.id,
            provider: item.provider,
            error: error.message,
          });
          await this.repository.markQuarantined(item.id, error.message);
        } else if (error instanceof ProviderValidationError) {
          // Client/validation 4xx: never retry invalid requests
          this.logger.error({
            msg: 'Validation error from provider. Marking failed.',
            itemId: item.id,
            error: error.message,
          });
          await this.repository.markFailed(item.id, error.message);
        } else if (
          error instanceof ProviderRateLimitError ||
          error instanceof ProviderServerError ||
          error.message?.includes('429')
        ) {
          // Transient 429 or 5xx: safe to retry if within maxRetries
          if (item.attempts < maxRetries) {
            this.logger.warn({
              msg: 'Transient provider error, releasing to retry',
              itemId: item.id,
              attempts: item.attempts,
              maxRetries,
              error: error.message,
            });
            await this.repository.releaseBackToPending(item.id);
          } else {
            this.logger.error({
              msg: 'Exceeded max retries for provider error',
              itemId: item.id,
              attempts: item.attempts,
              error: error.message,
            });
            await this.repository.markFailed(item.id, `Exceeded max retries: ${error.message}`);
          }
        } else {
          // General unhandled failure
          await this.repository.markFailed(item.id, error.message || 'Unknown error');
        }
      }
    }

    const summary = await this.repository.getRunSummary(runDate);
    if (budgetCutoffTriggered) {
      summary.budgetExceeded = true;
    }

    return summary;
  }
}
