import { AiAnswer, AiProvider } from './ai-provider.interface.js';

export interface FakeAiProviderOptions {
  providerName?: string;
  defaultCostCents?: number;
  defaultTokens?: number;
  cannedAnswerPrefix?: string;
  errorOnQuestionId?: Record<string, Error>;
}

export class FakeAiProvider implements AiProvider {
  public readonly providerName: string;
  public callCount = 0;
  public readonly calls: Array<{ questionText: string; timestamp: Date }> = [];
  private options: FakeAiProviderOptions;

  constructor(options: FakeAiProviderOptions = {}) {
    this.providerName = options.providerName ?? 'fake_provider';
    this.options = options;
  }

  async ask(questionText: string): Promise<AiAnswer> {
    this.callCount += 1;
    this.calls.push({ questionText, timestamp: new Date() });

    // Check if error simulation is requested
    if (this.options.errorOnQuestionId && this.options.errorOnQuestionId[questionText]) {
      throw this.options.errorOnQuestionId[questionText];
    }

    const defaultCost = this.options.defaultCostCents ?? 1; // 1 cent default
    const defaultTokens = this.options.defaultTokens ?? 150;
    const prefix = this.options.cannedAnswerPrefix ?? 'According to our analysis, top brands include';

    return {
      rawAnswer: `${prefix} BrandAlpha and BrandBeta for query: "${questionText}".`,
      citations: [
        'https://example.com/reviews/top-picks',
        'https://brandalpha.com/product',
      ],
      tokensUsed: defaultTokens,
      costCents: defaultCost,
    };
  }

  reset(): void {
    this.callCount = 0;
    this.calls.length = 0;
  }
}
