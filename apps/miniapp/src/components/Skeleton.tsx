/**
 * Skeleton placeholder block (§3 inventory, §6 skeleton-first loading).
 *
 * §6 mandates skeleton screens — not spinners — for list/detail loading
 * states. This is the thin, token-only primitive every future screen draws
 * its loading layout from: a single rounded block sized by the caller. A
 * subtle shimmer animation runs via CSS (.skeleton in index.css) and is
 * disabled automatically under `prefers-reduced-motion` (§11).
 *
 * Real per-screen skeletons (5 radar cards, draft editor header + textarea)
 * compose several of these; they land with each screen's real phase.
 */

interface SkeletonProps {
  /** CSS width — a token, %, or px string. Defaults to full width. */
  readonly width?: string;
  /** CSS height — a token or px string. Defaults to a single text line. */
  readonly height?: string;
  /** Corner radius token. Defaults to --radius-sm. */
  readonly radius?: string;
}

export function Skeleton({
  width = '100%',
  height = 'var(--space-4)',
  radius = 'var(--radius-sm)',
}: SkeletonProps) {
  return (
    <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius }} />
  );
}
