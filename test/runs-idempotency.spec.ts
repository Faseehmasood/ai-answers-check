import { describe, it, expect, beforeEach } from 'vitest';
import { RunsService } from '../src/runs/runs.service.js';
import { InMemoryRunsRepository } from '../src/runs/in-memory-runs.repository.js';
import { FakeAiProvider } from '../src/providers/fake-ai.provider.js';
import {
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderValidationError,
} from '../src/providers/provider-errors.js';

describe('Idempotent Batch Job Runner (v1)', () => {
  let repository: InMemoryRunsRepository;
  let service: RunsService;
  let chatgptProvider: FakeAiProvider;
  let geminiProvider: FakeAiProvider;
  let perplexityProvider: FakeAiProvider;

  const sampleQuestions = [
    { id: 'q1', text: 'What is the best CRM for small teams?' },
    { id: 'q2', text: 'Which project management software supports agile?' },
    { id: 'q3', text: 'Top marketing automation platforms in 2026?' },
    { id: 'q4', text: 'Best customer support helpdesk tool?' },
    { id: 'q5', text: 'Recommended cloud accounting software?' },
  ];

  const providerNames = ['chatgpt', 'gemini', 'perplexity'];

  beforeEach(() => {
    repository = new InMemoryRunsRepository();
    service = new RunsService(repository);

    chatgptProvider = new FakeAiProvider({ providerName: 'chatgpt', defaultCostCents: 2 });
    geminiProvider = new FakeAiProvider({ providerName: 'gemini', defaultCostCents: 1 });
    perplexityProvider = new FakeAiProvider({ providerName: 'perplexity', defaultCostCents: 3 });

    service.registerProvider(chatgptProvider);
    service.registerProvider(geminiProvider);
    service.registerProvider(perplexityProvider);
  });

  describe('Core Idempotency: Re-running the same date produces NO duplicates', () => {
    it('runs a date to completion, and re-running the same date creates 0 new rows and 0 extra API calls', async () => {
      const runDate = '2026-11-05';
      const expectedTotalItems = sampleQuestions.length * providerNames.length; // 5 * 3 = 15

      // FIRST RUN
      const seededCount1 = await service.seedRun(runDate, sampleQuestions, providerNames);
      expect(seededCount1).toBe(expectedTotalItems);

      const summary1 = await service.executeBatch(runDate, { dailyBudgetCents: 5000 });
      expect(summary1.total).toBe(expectedTotalItems);
      expect(summary1.done).toBe(expectedTotalItems);
      expect(summary1.pending).toBe(0);
      expect(summary1.failed).toBe(0);

      // Verify each provider was called exactly 5 times (once per question)
      expect(chatgptProvider.callCount).toBe(5);
      expect(geminiProvider.callCount).toBe(5);
      expect(perplexityProvider.callCount).toBe(5);
      const totalCallsAfterRun1 =
        chatgptProvider.callCount + geminiProvider.callCount + perplexityProvider.callCount;
      expect(totalCallsAfterRun1).toBe(15);

      // Verify DB row count
      const rowsAfterRun1 = await repository.getAllItems(runDate);
      expect(rowsAfterRun1.length).toBe(15);
      expect(rowsAfterRun1.every((r) => r.status === 'done')).toBe(true);

      // SECOND RUN ON THE EXACT SAME DATE
      const seededCount2 = await service.seedRun(runDate, sampleQuestions, providerNames);
      // ON CONFLICT DO NOTHING: 0 new rows inserted
      expect(seededCount2).toBe(0);

      const summary2 = await service.executeBatch(runDate, { dailyBudgetCents: 5000 });
      expect(summary2.total).toBe(expectedTotalItems);
      expect(summary2.done).toBe(expectedTotalItems);
      expect(summary2.pending).toBe(0);

      // CRITICAL ASSERTION: ZERO additional provider calls made
      expect(chatgptProvider.callCount).toBe(5);
      expect(geminiProvider.callCount).toBe(5);
      expect(perplexityProvider.callCount).toBe(5);
      const totalCallsAfterRun2 =
        chatgptProvider.callCount + geminiProvider.callCount + perplexityProvider.callCount;
      expect(totalCallsAfterRun2).toBe(totalCallsAfterRun1); // Exactly 15, no duplicate charges!

      // CRITICAL ASSERTION: ZERO duplicate rows in DB
      const rowsAfterRun2 = await repository.getAllItems(runDate);
      expect(rowsAfterRun2.length).toBe(15);
    });
  });

  describe('Pre-Call Budget Guard', () => {
    it('checks budget BEFORE each call and halts before making an unpaid/over-budget call', async () => {
      const runDate = '2026-11-06';
      // chatgpt costs 2 cents per call.
      // With a daily budget of 5 cents, it should make at most 3 calls (2 + 2 = 4 cents spent; 4 < 5 so call 3 is made, spend becomes 6. Next item checks: 6 >= 5 -> halts immediately!)
      const budgetCents = 5;

      await service.seedRun(runDate, sampleQuestions, ['chatgpt']); // 5 items

      const summary = await service.executeBatch(runDate, { dailyBudgetCents: budgetCents });

      expect(summary.budgetExceeded).toBe(true);
      // Call 1: spend=0 < 5 -> executes (spend becomes 2)
      // Call 2: spend=2 < 5 -> executes (spend becomes 4)
      // Call 3: spend=4 < 5 -> executes (spend becomes 6)
      // Call 4: spend=6 >= 5 -> BLOCKED BEFORE CALL! Released to pending.
      expect(chatgptProvider.callCount).toBe(3);
      expect(summary.done).toBe(3);
      expect(summary.pending).toBe(2); // remaining items stayed pending

      // Verify the blocked item was released back to pending and not lost
      const items = await repository.getAllItems(runDate);
      const pendingItems = items.filter((i) => i.status === 'pending');
      expect(pendingItems.length).toBe(2);
    });
  });

  describe('Crash Mid-Run & Resumption', () => {
    it('resumes cleanly after a crash without reprocessing completed items', async () => {
      const runDate = '2026-11-07';
      await service.seedRun(runDate, sampleQuestions, ['gemini']); // 5 items, 1 cent each

      // Process 2 items normally
      const item1 = await repository.claimNextPendingItem(runDate);
      const ans1 = await geminiProvider.ask(item1!.questionText);
      await repository.markDone(item1!.id, ans1);

      const item2 = await repository.claimNextPendingItem(runDate);
      const ans2 = await geminiProvider.ask(item2!.questionText);
      await repository.markDone(item2!.id, ans2);

      // Simulate item 3 being claimed by a worker that crashed 10 minutes ago
      const item3 = await repository.claimNextPendingItem(runDate);
      repository.simulateStuckLock(item3!.id, 10); // 10 minutes ago

      expect(geminiProvider.callCount).toBe(2);

      // Now run the service batch: it should reclaim item 3 and finish items 3, 4, 5
      const summary = await service.executeBatch(runDate, { dailyBudgetCents: 1000 });

      expect(summary.done).toBe(5);
      expect(summary.total).toBe(5);
      // Items 1 and 2 were NOT called again. Total calls = 2 + 3 = 5
      expect(geminiProvider.callCount).toBe(5);
    });
  });

  describe('In-Flight Timeout Quarantine vs 429 Retry', () => {
    it('quarantines 504 in-flight timeouts without retrying to guarantee never paying twice', async () => {
      const runDate = '2026-11-08';
      const timeoutErrorProvider = new FakeAiProvider({
        providerName: 'chatgpt',
        errorOnQuestionId: {
          [sampleQuestions[0].text]: new ProviderTimeoutError('Gateway Timeout 504 on in-flight socket'),
        },
      });

      const testService = new RunsService(repository);
      testService.registerProvider(timeoutErrorProvider);

      await testService.seedRun(runDate, [sampleQuestions[0]], ['chatgpt']);
      const summary = await testService.executeBatch(runDate, { dailyBudgetCents: 1000 });

      expect(summary.quarantined).toBe(1);
      expect(summary.done).toBe(0);
      // Must NOT be retried: callCount must be exactly 1
      expect(timeoutErrorProvider.callCount).toBe(1);

      const items = await repository.getAllItems(runDate);
      expect(items[0].status).toBe('quarantined');
      expect(items[0].errorReason).toContain('Gateway Timeout 504');
    });

    it('retries 429 rate limit errors with backoff and succeeds on subsequent attempt', async () => {
      const runDate = '2026-11-09';
      let attempts = 0;

      const flakyProvider = {
        providerName: 'chatgpt',
        async ask(questionText: string) {
          attempts++;
          if (attempts === 1) {
            throw new ProviderRateLimitError('Rate limit exceeded (429)');
          }
          return {
            rawAnswer: `Success on attempt ${attempts} for: ${questionText}`,
            citations: ['https://example.com'],
            tokensUsed: 100,
            costCents: 2,
          };
        },
      };

      const testService = new RunsService(repository);
      testService.registerProvider(flakyProvider);

      await testService.seedRun(runDate, [sampleQuestions[0]], ['chatgpt']);
      const summary = await testService.executeBatch(runDate, { dailyBudgetCents: 1000, maxRetries: 3 });

      expect(summary.done).toBe(1);
      expect(summary.failed).toBe(0);
      expect(attempts).toBe(2); // failed once on 429, succeeded on retry
    });

    it('never retries 400 validation errors', async () => {
      const runDate = '2026-11-10';
      const validationErrorProvider = new FakeAiProvider({
        providerName: 'chatgpt',
        errorOnQuestionId: {
          [sampleQuestions[0].text]: new ProviderValidationError('Bad request (400): prompt too long'),
        },
      });

      const testService = new RunsService(repository);
      testService.registerProvider(validationErrorProvider);

      await testService.seedRun(runDate, [sampleQuestions[0]], ['chatgpt']);
      const summary = await testService.executeBatch(runDate, { dailyBudgetCents: 1000 });

      expect(summary.failed).toBe(1);
      expect(summary.done).toBe(0);
      // Validation error: zero retries
      expect(validationErrorProvider.callCount).toBe(1);
    });
  });
});
