/**
 * Bottom-tab glyphs (§3 navigation, §13 native look).
 *
 * Inline SVGs instead of an icon dependency: five tiny one-path glyphs are far
 * cheaper than pulling a whole icon set, and they tree-shake to nothing for
 * screens that don't import them. Every glyph draws with `currentColor` so
 * telegram-ui's Tabbar.Item drives the selected/idle color from theme tokens —
 * no hardcoded colors here (CLAUDE.md / §2).
 *
 * Sizing is fixed at 26px: the tap target is the Tabbar.Item itself (≥44px,
 * owned by telegram-ui), the glyph is just the visual.
 */

import type { ReactElement } from 'react';
import type { RoutePath } from '../routing/routes.ts';
import { ROUTES } from '../routing/routes.ts';

const ICON_SIZE = 26;

interface GlyphProps {
  /** SVG path data for the single-path glyph. */
  readonly d: string;
}

function Glyph({ d }: GlyphProps): ReactElement {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * One distinct glyph per tab root. Keyed by RoutePath so the map can't drift
 * from the route table — a new tab without an icon is a type error.
 */
const TAB_ICON_PATHS: Record<RoutePath, string> = {
  // Радар — concentric radar sweep.
  [ROUTES.radar]: 'M12 3a9 9 0 1 0 9 9M12 8a4 4 0 1 0 4 4M12 12l7-7',
  // Черновики — document with text lines.
  [ROUTES.drafts]: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  // Источники — linked nodes (feeds).
  [ROUTES.sources]: 'M5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM19 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 5h7a3 3 0 0 1 3 3v2M7 19h7a3 3 0 0 0 3-3v-2',
  // Канал — paper-plane / broadcast.
  [ROUTES.channel]: 'M21 4 3 11l7 3 3 7 8-17ZM10 14l4-4',
  // Настройки — gear.
  [ROUTES.settings]: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4Z',
  // /onboarding is not a tab root, but RoutePath includes it — give it the
  // settings glyph so the Record stays exhaustive (Tabbar never renders it).
  [ROUTES.onboarding]: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
};

/** Renders the glyph for a given tab root path. */
export function TabIcon({ path }: { readonly path: RoutePath }): ReactElement {
  return <Glyph d={TAB_ICON_PATHS[path]} />;
}
