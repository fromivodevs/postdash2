/**
 * Onboarding wizard — Phase 1 skeleton (§9, §16 "stub ok").
 *
 * 3 steps (Подключи канал / Добавь источники / Задай темы), progress dots,
 * one primary action per step, "Пропустить" always visible. Each step's
 * primary action navigates to that step's destination screen (§9); skipping
 * redirects to /radar (WIZARD_EXIT_ROUTE).
 *
 * The last step's primary action additionally marks the wizard done, so the
 * wizard has a real end: returning via the native BackButton lands on a
 * "Готово" finish state rather than stranding the user on step 3.
 *
 * Step content + advance logic live in wizardSteps.ts (pure, tested). This
 * component only holds the current-step state and wires navigation.
 */

import { useState } from 'react';
import { useLocation } from 'wouter';
import { Button, Placeholder, Section } from '../../components/index.ts';
import { WizardDots } from './WizardDots.tsx';
import {
  WIZARD_EXIT_ROUTE,
  WIZARD_STEP_COUNT,
  isLastWizardStep,
  nextWizardStep,
  wizardStepAt,
} from './wizardSteps.ts';

export function OnboardingScreen() {
  const [, navigate] = useLocation();
  const [stepIndex, setStepIndex] = useState(1);
  const [done, setDone] = useState(false);

  // Primary action: §9 — each step's action takes the user straight to that
  // step's destination screen (Канал / Источники / Настройки), it is not a
  // self-contained "next" button. For steps 1–2 we advance the internal
  // pointer so a native-BackButton return sits on the next step; for the last
  // step there is no next step, so we mark the wizard done — a BackButton
  // return then shows the "Готово" finish state instead of a dead-end step 3.
  const handlePrimary = (): void => {
    const step = wizardStepAt(stepIndex);
    navigate(step.actionRoute);
    if (isLastWizardStep(stepIndex)) {
      setDone(true);
      return;
    }
    const next = nextWizardStep(stepIndex);
    if (next !== null) setStepIndex(next);
  };

  const handleSkip = (): void => {
    navigate(WIZARD_EXIT_ROUTE, { replace: true });
  };

  const handleFinish = (): void => {
    navigate(WIZARD_EXIT_ROUTE, { replace: true });
  };

  if (done) {
    return (
      <Section header="Настройка PostDash">
        <Placeholder
          header="Готово"
          description="Базовая настройка завершена. Радар начнёт собирать инфоповоды по заданным темам."
        >
          <Button size="l" stretched onClick={handleFinish}>
            Перейти к радару
          </Button>
        </Placeholder>
      </Section>
    );
  }

  const step = wizardStepAt(stepIndex);

  return (
    <Section header="Настройка PostDash">
      <WizardDots current={stepIndex} total={WIZARD_STEP_COUNT} />
      <Placeholder header={step.title} description={step.description}>
        <Button size="l" stretched onClick={handlePrimary}>
          {step.actionLabel}
        </Button>
        <Button
          size="l"
          mode="plain"
          stretched
          onClick={handleSkip}
          aria-label="Пропустить настройку"
        >
          Пропустить
        </Button>
      </Placeholder>
    </Section>
  );
}
