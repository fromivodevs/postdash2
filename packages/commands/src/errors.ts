/**
 * Command-layer error taxonomy. Maps to HTTP status codes at the API boundary.
 *
 * Phase 2 addition: optional `details` (typed escape valve) lets a single
 * `CommandError` carry a wire-level code such as `'expired_code'` /
 * `'channel_taken'` / `'bot_not_admin'` without ballooning the error class
 * hierarchy. The route layer reads `err.details?.code` to pick the wire
 * status (`400`/`409`/`410`) and the user-facing message. See architecture
 * doc Decision: "CommandError grows optional details".
 *
 * Invariant: `details` values are short, log-safe strings (no PII, no secrets,
 * no stack traces). The route layer is allowed to forward them verbatim to
 * the HTTP response body.
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
  /**
   * Optional structured payload for the route layer. Conventional keys:
   *   - `code`: a wire-level discriminator (e.g. `'expired_code'`,
   *             `'reused_code'`, `'channel_taken'`, `'bot_not_admin'`).
   * Backwards compatible: Phase 1 callers omit it; the route layer treats
   * the field as optional.
   */
  public readonly details?: Record<string, string>;

  constructor(
    code: CommandErrorCode,
    message: string,
    causeOrDetails?: unknown,
    details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    // Three-arg vs four-arg call shape. Phase 1 callers passed `cause` as the
    // 3rd arg (an arbitrary `unknown`); Phase 2 callers may pass `details` as
    // a 3rd arg (a plain object) OR pass both: `(code, message, cause, details)`.
    // We distinguish by checking whether the 3rd arg looks like a plain-object
    // details bag — if it does, AND no 4th arg was given, treat it as details.
    if (details !== undefined) {
      // Explicit 4-arg form: (code, message, cause, details).
      if (causeOrDetails !== undefined) this.cause = causeOrDetails;
      this.details = details;
    } else if (isDetailsBag(causeOrDetails)) {
      // 3-arg form with a details object: (code, message, details).
      this.details = causeOrDetails;
    } else if (causeOrDetails !== undefined) {
      // 3-arg form with a cause: (code, message, cause). Phase 1 shape.
      this.cause = causeOrDetails;
    }
  }
}

/**
 * Heuristic: a plain object whose values are all strings is treated as a
 * details bag (matches the documented `Record<string,string>` shape). An
 * `Error` instance or anything non-object is treated as a `cause`. This keeps
 * the Phase 1 two-/three-arg calls `new CommandError('forbidden', '...')` /
 * `new CommandError('internal', '...', err)` source-compatible.
 */
function isDetailsBag(v: unknown): v is Record<string, string> {
  if (v === null || typeof v !== 'object') return false;
  if (v instanceof Error) return false;
  if (Array.isArray(v)) return false;
  // Reject objects with prototype other than Object.prototype / null — that
  // rules out class instances (which a Phase 1 caller might pass as a cause).
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== 'string') return false;
  }
  return true;
}
