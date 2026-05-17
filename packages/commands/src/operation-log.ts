/**
 * Shared `operation_log` writer (Rule 6 per 02-ARCHITECTURE.md).
 *
 * Phase 3 originally lacked operation_log writes on its 6 mutating commands
 * (caught in step-perfect-loop main-1). Round 1 added per-module helpers in
 * topic-profiles.ts and sources.ts; round 4 consolidates into one helper so
 * the Rule 6 shape (commandType, objectType, objectId, payload_summary
 * bounded discriminator) can't drift between modules. Future commands
 * (Phase 4 ingestion, Phase 7 publishing) draw from the same helper.
 *
 * payload_summary intentionally typed loosely: callers pass a small bag of
 * discriminator fields. The constraint "no PII, no full URLs, no API key
 * fragments" is a documentation rule, not a type rule — the field is too
 * variable across command types to lock down structurally.
 */

import type { DbOrTx } from '@postdash/db';
import { operationLog } from '@postdash/db';

export interface WriteOperationLogInput {
  workspaceId: string;
  userId: string | null;
  commandType: string;
  objectType: string;
  objectId: string;
  /**
   * Small discriminator bag. Must NOT contain PII, full URLs (use
   * scheme+host only if a URL must be logged), tokens, or full AI output.
   * Callers are responsible for sanitisation.
   */
  payloadSummary?: Record<string, unknown> | null;
}

export async function writeOperationLog(tx: DbOrTx, input: WriteOperationLogInput): Promise<void> {
  await tx.insert(operationLog).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    commandType: input.commandType,
    objectType: input.objectType,
    objectId: input.objectId,
    payloadSummary: input.payloadSummary ?? {},
    result: 'success',
  });
}

/**
 * Redacts a URL for safe inclusion in error messages / logs. Keeps the
 * scheme + host + path; drops query string entirely (could carry API keys).
 * Unparseable input returns `<invalid url>` so the redaction never throws.
 */
export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<invalid url>';
  }
}
