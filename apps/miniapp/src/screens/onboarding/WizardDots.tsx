/**
 * Progress dots for the onboarding wizard (§9 — "точки сверху, 1 of 3").
 *
 * Pure presentational component; styling is token-only (see .wizard-dots in
 * index.css). Exposes the current position to screen readers via aria-label.
 */

interface WizardDotsProps {
  /** 1-based current step. */
  current: number;
  /** Total step count. */
  total: number;
}

export function WizardDots({ current, total }: WizardDotsProps) {
  return (
    <div
      className="wizard-dots"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-label={`Шаг ${current} из ${total}`}
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((step) => (
        <span
          key={step}
          className={step === current ? 'wizard-dot wizard-dot--active' : 'wizard-dot'}
        />
      ))}
    </div>
  );
}
