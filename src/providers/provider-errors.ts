export class ProviderRateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds = 1) {
    super(message);
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

export class ProviderServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderServerError';
  }
}
