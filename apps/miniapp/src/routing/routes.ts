/**
 * Route table + Telegram deep-link mapping (§10).
 *
 * Everything here is a pure string -> string mapping so the boot logic and its
 * tests never need a router instance. App.tsx owns the actual <Route> tree;
 * this module owns "what path does X resolve to".
 */

export const ROUTES = {
  radar: '/radar',
  drafts: '/drafts',
  sources: '/sources',
  channel: '/channel',
  settings: '/settings',
  onboarding: '/onboarding',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

/** The five bottom-tab roots, in display order. */
export interface TabDef {
  readonly path: RoutePath;
  readonly label: string;
}

export const TAB_DEFS: readonly TabDef[] = [
  { path: ROUTES.radar, label: 'Радар' },
  { path: ROUTES.drafts, label: 'Черновики' },
  { path: ROUTES.sources, label: 'Источники' },
  { path: ROUTES.channel, label: 'Канал' },
  { path: ROUTES.settings, label: 'Настройки' },
];

/**
 * Maps a Telegram `start_param` (from `?startapp=...`) to an in-app path.
 *
 * Supported forms (§10):
 *   draft_<id>        -> /drafts/<id>
 *   connect_<code>    -> /channel?code=<code>
 *   radar_high_score  -> /radar?filter=score_7plus
 *   onboarding        -> /onboarding
 *
 * Returns null for unknown/empty params — the caller then falls back to its
 * normal initial route (root or onboarding redirect).
 */

/**
 * Upper bound on the id segment of a deep-link (`draft_<id>`, `connect_<code>`).
 * `start_param` is untrusted client input; a UUID is 36 chars and connect
 * codes are short, so 64 is a generous ceiling that still rejects an attempt
 * to smuggle a huge string into the route/history.
 */
const MAX_DEEP_LINK_ID_LENGTH = 64;

export function startParamToPath(startParam: string | undefined | null): string | null {
  if (!startParam) return null;

  if (startParam === 'onboarding') return ROUTES.onboarding;
  if (startParam === 'radar_high_score') return `${ROUTES.radar}?filter=score_7plus`;

  const draftId = /^draft_(.+)$/.exec(startParam)?.[1];
  if (draftId) {
    if (draftId.length > MAX_DEEP_LINK_ID_LENGTH) return null;
    return `${ROUTES.drafts}/${encodeURIComponent(draftId)}`;
  }

  const connectCode = /^connect_(.+)$/.exec(startParam)?.[1];
  if (connectCode) {
    if (connectCode.length > MAX_DEEP_LINK_ID_LENGTH) return null;
    return `${ROUTES.channel}?code=${encodeURIComponent(connectCode)}`;
  }

  return null;
}

/** True when `path` is one of the five tab roots (Tabbar should be visible). */
export function isRootTabPath(path: string): boolean {
  const normalized = path === '/' ? ROUTES.radar : path;
  return TAB_DEFS.some((tab) => tab.path === normalized);
}

/**
 * Route patterns AppShell registers, in wouter syntax (`:param` segments).
 * Kept here next to startParamToPath so a deep-link target can be checked
 * against the real route table without a router instance — the routes.test
 * uses this to prove every deep-link lands on a registered screen (not the
 * silent Radar fall-through).
 */
export const REGISTERED_ROUTE_PATTERNS: readonly string[] = [
  '/',
  `${ROUTES.radar}/:matchId`,
  ROUTES.radar,
  `${ROUTES.drafts}/:draftId`,
  ROUTES.drafts,
  `${ROUTES.sources}/new`,
  ROUTES.sources,
  ROUTES.channel,
  ROUTES.settings,
  ROUTES.onboarding,
];

/**
 * True when `path` (which may carry a `?query`) matches one of the registered
 * route patterns. A `:param` segment matches any single non-empty segment.
 */
export function isRegisteredRoute(path: string): boolean {
  const pathname = path.split('?')[0] ?? path;
  const segments = pathname.split('/');
  return REGISTERED_ROUTE_PATTERNS.some((pattern) => {
    const patternSegments = pattern.split('/');
    if (patternSegments.length !== segments.length) return false;
    return patternSegments.every((patternSeg, i) => {
      if (patternSeg.startsWith(':')) return (segments[i] ?? '').length > 0;
      return patternSeg === segments[i];
    });
  });
}
