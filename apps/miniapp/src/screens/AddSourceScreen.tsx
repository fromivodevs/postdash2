/**
 * Add-source screen — Phase 1 placeholder (§10 route table, §16 "stub ok").
 *
 * `/sources/new` is a real route in the §10 table; the actual add-source form
 * (URL input + validation, react-hook-form + zod) lands with the Sources
 * management phase. For Phase 1 this is an actionable stub: a non-root screen,
 * so the native BackButton is shown (§4), with §12-style copy.
 *
 * No fake loading state here: Phase 1 has no real fetch on this route, so a
 * skeleton would never actually be shown to a user. The §6 skeleton-first
 * pattern lands with the real form phase, composed from the standalone
 * Skeleton primitive (components/Skeleton.tsx).
 */

import { Placeholder, Section } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useLocation } from 'wouter';
import { ROUTES } from '../routing/routes.ts';

export function AddSourceScreen() {
  const [, navigate] = useLocation();
  // Non-root screen — show the native back chevron, return to the list.
  useBackButton({ visible: true, onClick: () => navigate(ROUTES.sources) });

  return (
    <Section header="Новый источник">
      <Placeholder
        header="Добавление источника"
        description="Здесь появится форма добавления канала или RSS. Пока что вернись к списку источников."
      />
    </Section>
  );
}
