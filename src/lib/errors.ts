export type ErrorCode = 'not_found' | 'invalid' | 'conflict';

/** An expected failure whose message is safe to show to the caller. */
export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
