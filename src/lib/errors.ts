export type ErrorCode = 'not_found' | 'invalid' | 'conflict' | 'unavailable';

/** An expected failure whose message is safe to show to the caller. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  /** Machine-readable cause, so a website can show its own text. */
  readonly reason: string | undefined;

  constructor(code: ErrorCode, message: string, reason?: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.reason = reason;
  }
}
