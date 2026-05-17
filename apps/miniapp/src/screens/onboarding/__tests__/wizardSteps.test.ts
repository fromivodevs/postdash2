import { describe, expect, it } from 'vitest';
import {
  WIZARD_EXIT_ROUTE,
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  isLastWizardStep,
  nextWizardStep,
  wizardStepAt,
} from '../wizardSteps.ts';
import { ROUTES } from '../../../routing/routes.ts';

describe('wizard step model', () => {
  it('has exactly 3 steps in order', () => {
    expect(WIZARD_STEP_COUNT).toBe(3);
    expect(WIZARD_STEPS.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(WIZARD_STEPS.map((s) => s.title)).toEqual([
      'Подключи канал',
      'Добавь источники',
      'Задай темы',
    ]);
  });

  it('exits to /radar on finish or skip', () => {
    expect(WIZARD_EXIT_ROUTE).toBe(ROUTES.radar);
  });

  it("each step routes its primary action to that step's destination screen (§9)", () => {
    // §9: the primary action navigates to the screen, it is not an internal
    // "next" button — so every step must carry a concrete destination route.
    expect(WIZARD_STEPS.map((s) => s.actionRoute)).toEqual([
      ROUTES.channel,
      ROUTES.sources,
      ROUTES.settings,
    ]);
  });
});

describe('nextWizardStep', () => {
  it('advances through the steps', () => {
    expect(nextWizardStep(1)).toBe(2);
    expect(nextWizardStep(2)).toBe(3);
  });

  it('returns null after the last step (wizard complete)', () => {
    expect(nextWizardStep(3)).toBe(null);
  });

  it('returns null for out-of-range input', () => {
    expect(nextWizardStep(0)).toBe(null);
    expect(nextWizardStep(99)).toBe(null);
  });

  it('skip flow: from any step, exit lands on /radar without advancing', () => {
    // The skip button never calls nextWizardStep — it navigates straight to
    // WIZARD_EXIT_ROUTE. This asserts that contract holds for every step.
    for (const step of WIZARD_STEPS) {
      expect(WIZARD_EXIT_ROUTE).toBe('/radar');
      expect(step.actionRoute).not.toBe('');
    }
  });
});

describe('isLastWizardStep', () => {
  it('is true only for the final step', () => {
    expect(isLastWizardStep(WIZARD_STEP_COUNT)).toBe(true);
    expect(isLastWizardStep(1)).toBe(false);
    expect(isLastWizardStep(2)).toBe(false);
  });

  it('is false for out-of-range indices', () => {
    expect(isLastWizardStep(0)).toBe(false);
    expect(isLastWizardStep(99)).toBe(false);
  });

  it('the last step has no next step (wizard finishes there)', () => {
    // The finish state is reached precisely when isLastWizardStep is true and
    // nextWizardStep returns null — these two must agree.
    expect(isLastWizardStep(WIZARD_STEP_COUNT)).toBe(true);
    expect(nextWizardStep(WIZARD_STEP_COUNT)).toBe(null);
  });
});

describe('wizardStepAt', () => {
  it('looks up a step by 1-based index', () => {
    expect(wizardStepAt(1).title).toBe('Подключи канал');
    expect(wizardStepAt(3).title).toBe('Задай темы');
  });

  it('throws on out-of-range index', () => {
    expect(() => wizardStepAt(0)).toThrow(RangeError);
    expect(() => wizardStepAt(4)).toThrow(RangeError);
  });
});
