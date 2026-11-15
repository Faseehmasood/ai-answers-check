export type RunItemStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'quarantined';

export interface RunItem {
  id: string;
  runDate: string; // YYYY-MM-DD
  questionId: string;
  questionText: string;
  provider: string;
  status: RunItemStatus;
  rawAnswer?: string | null;
  citations: string[];
  tokensUsed: number;
  costCents: number;
  attempts: number;
  errorReason?: string | null;
  lockedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeedRunItemInput {
  runDate: string;
  questionId: string;
  questionText: string;
  provider: string;
}

export interface RunSummary {
  runDate: string;
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  failed: number;
  quarantined: number;
  spentCents: number;
  budgetExceeded: boolean;
}
