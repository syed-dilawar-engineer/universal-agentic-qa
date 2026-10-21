export class QAError extends Error {
  constructor(message: string, public readonly code: string = 'QA_ERROR', public readonly details?: any) {
    super(message);
    this.name = 'QAError';
  }
}

export class QABlockedError extends QAError {
  constructor(message: string, public readonly missingRequirement: string, details?: any) {
    super(message, 'QA_BLOCKED', details);
    this.name = 'QABlockedError';
  }
}

export class QAUnsupportedError extends QAError {
  constructor(message: string, public readonly unsupportedPlatform: string, details?: any) {
    super(message, 'QA_UNSUPPORTED', details);
    this.name = 'QAUnsupportedError';
  }
}

export class QATimeoutError extends QAError {
  constructor(message: string, public readonly timeoutMs: number, details?: any) {
    super(message, 'QA_TIMEOUT', details);
    this.name = 'QATimeoutError';
  }
}

export class QAAssertionError extends QAError {
  constructor(
    message: string,
    public readonly expected: any,
    public readonly actual: any,
    details?: any
  ) {
    super(message, 'QA_ASSERTION_FAILED', details);
    this.name = 'QAAssertionError';
  }
}

export class QAAdapterError extends QAError {
  constructor(message: string, public readonly adapterName: string, details?: any) {
    super(message, 'QA_ADAPTER_ERROR', details);
    this.name = 'QAAdapterError';
  }
}

export class QACircuitBreakerError extends QAError {
  constructor(
    message: string,
    public readonly limitName: string,
    public readonly limitValue: number,
    details?: any
  ) {
    super(message, 'QA_CIRCUIT_BREAKER_TRIPPED', details);
    this.name = 'QACircuitBreakerError';
  }
}

export class QASecurityError extends QAError {
  constructor(message: string, public readonly target: string, details?: any) {
    super(message, 'QA_SECURITY_BLOCKED', details);
    this.name = 'QASecurityError';
  }
}
