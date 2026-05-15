/**
 * Field error — the §7 "Field error" tier of the error taxonomy.
 *
 * Red text directly below an input for validation messages ("URL invalid",
 * "слишком длинно"). Renders nothing when there is no message, so screens can
 * drop it unconditionally under any field.
 *
 * `id` lets the input wire `aria-describedby` to it (§8 screen-reader support).
 */

import type { ReactNode } from 'react';

interface FieldErrorProps {
  /** Validation message, or null/undefined when the field is valid. */
  message: string | null | undefined;
  /** Element id so the related input can reference it via aria-describedby. */
  id?: string;
}

export function FieldError({ message, id }: FieldErrorProps): ReactNode {
  if (!message) return null;
  return (
    <p className="field-error" role="alert" {...(id ? { id } : {})}>
      {message}
    </p>
  );
}
