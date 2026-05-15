/**
 * Onboarding wizard step model (§9).
 *
 * Pure data + a tiny step-advance helper so the "skip / finish -> /radar" flow
 * is unit-testable without rendering React. The screen component
 * (OnboardingScreen.tsx) only owns the current-step state and navigation.
 *
 * 3 steps, each with a single primary action; "Пропустить" is always available
 * (§9 — the wizard never blocks access).
 */

import { ROUTES } from '../../routing/routes.ts';

export interface WizardStep {
  /** 1-based index, used for the "1 of 3" progress dots. */
  readonly index: number;
  readonly title: string;
  readonly description: string;
  /** Label of the single primary action button. */
  readonly actionLabel: string;
  /** Route the primary action sends the user to. */
  readonly actionRoute: string;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    index: 1,
    title: 'Подключи канал',
    description: 'Свяжи Telegram-канал, в который PostDash будет публиковать посты.',
    actionLabel: 'Подключить канал',
    actionRoute: ROUTES.channel,
  },
  {
    index: 2,
    title: 'Добавь источники',
    description: 'Укажи каналы и RSS, за которыми радар будет следить.',
    actionLabel: 'Добавить источники',
    actionRoute: ROUTES.sources,
  },
  {
    index: 3,
    title: 'Задай темы',
    description: 'Опиши темы — без них радар не знает, что искать.',
    actionLabel: 'Настроить темы',
    actionRoute: ROUTES.settings,
  },
];

export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;

/** Where the wizard sends the user when finished or skipped (§9). */
export const WIZARD_EXIT_ROUTE = ROUTES.radar;

/**
 * Given a 1-based step index, returns the next index, or null when the wizard
 * is complete (caller then shows the finish state / redirects to
 * WIZARD_EXIT_ROUTE).
 */
export function nextWizardStep(current: number): number | null {
  if (current < 1 || current >= WIZARD_STEP_COUNT) return null;
  return current + 1;
}

/**
 * True when `index` is the wizard's last step — its primary action finishes
 * the wizard (no further step to advance to) instead of just moving the
 * internal pointer. Out-of-range indices are not the last step.
 */
export function isLastWizardStep(index: number): boolean {
  return index === WIZARD_STEP_COUNT;
}

/** Looks up a step by its 1-based index; throws on out-of-range (caller bug). */
export function wizardStepAt(index: number): WizardStep {
  const step = WIZARD_STEPS.find((s) => s.index === index);
  if (!step) throw new RangeError(`wizard step ${index} does not exist`);
  return step;
}
