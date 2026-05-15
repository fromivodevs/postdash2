/**
 * Command-layer error taxonomy. Maps to HTTP status codes at the API boundary.
 */

export type CommandErrorCode =
  | 'validation_failed'
  | 'idempotency_replay_in_progress'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'internal';

export class CommandError extends Error {
  public readonly code: CommandErrorCode;
  public override readonly cause?: unknown;

  constructor(code: CommandErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
