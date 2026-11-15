export interface AiAnswer {
  rawAnswer: string;
  citations: string[];
  tokensUsed: number;
  costCents: number;
}

export interface AiProvider {
  readonly providerName: string;
  ask(questionText: string): Promise<AiAnswer>;
}
