/**
 * Radar screen — Phase 5.
 *
 * Renders workspace-level news matches (workspace_news_matches projection)
 * with score-ordered cards, status filter chips, and the §7-aligned
 * loading / error / empty states. The single mutation path is "open
 * external URL" — no actions write yet (suppress + create_draft land in
 * Phase 6/7).
 *
 * View-model logic lives in `radarView.ts` (pure, test-covered). This file
 * is the dispatcher: data fetching, filter UI state, and card layout.
 */

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import {
  Button,
  Cell,
  ErrorState,
  List,
  Placeholder,
  Section,
  Skeleton,
} from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { openExternal } from '../telegram/openLink.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { getRadar } from '../api/radar.ts';
import { ROUTES } from '../routing/routes.ts';
import {
  RADAR_FILTER_OPTIONS,
  formatPublishedAt,
  formatScore,
  isSafeExternalUrl,
  pluralizeRu,
  selectRadarView,
  statusLabel,
  statusTone,
} from './radarView.ts';
import type { RadarListProjection, RadarMatchProjection, RadarMatchStatus } from '../api/types.ts';

type StatusFilter = RadarMatchStatus | 'all';

const RADAR_QUERY_KEY = ['radar'] as const;

export function RadarScreen(): ReactNode {
  // Root tab — never show the native back button.
  useBackButton({ visible: false, onClick: () => {} });

  const { session } = useSession();
  const [, navigate] = useLocation();
  const initData = session?.initData;

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('candidate');

  const radarQuery = useQuery<RadarListProjection, Error>({
    queryKey: [...RADAR_QUERY_KEY, statusFilter],
    queryFn: async ({ signal }) => {
      if (!initData) throw new Error('initData is missing');
      return getRadar(initData, { status: statusFilter }, signal);
    },
    enabled: Boolean(initData),
  });

  const view = selectRadarView({
    loading: radarQuery.isLoading,
    errored: radarQuery.isError,
    items: radarQuery.data?.items,
    // Default chip is 'candidate'; anything else means the user actively
    // narrowed the view and "0 results" should hint at "try a different
    // filter" instead of the onboarding empty state.
    filterActive: statusFilter !== 'candidate',
  });

  return (
    <Section header="Радар">
      <RadarFilterChips value={statusFilter} onChange={setStatusFilter} />

      {/*
        ARIA stable wrapper: aria-controls on each chip points here, so the
        controlled-region id is present in every view state (loading / error /
        empty / filter-empty / list) — not just `kind === 'list'`. aria-live
        announces state transitions (e.g. filter change → "Под этот фильтр
        ничего нет") to screen readers.
      */}
      <div id="radar-list" role="tabpanel" aria-live="polite">
        {view.kind === 'loading' && (
          <div className="radar-skeleton" data-testid="radar-skeleton">
            {[0, 1, 2].map((i) => (
              <div key={i} className="radar-skeleton__row">
                <Skeleton width="20%" height="20px" />
                <Skeleton width="80%" height="16px" />
                <Skeleton width="60%" height="14px" />
              </div>
            ))}
          </div>
        )}

        {view.kind === 'error' && (
          <ErrorState error={radarQuery.error} onRetry={() => void radarQuery.refetch()} />
        )}

        {view.kind === 'empty' && (
          <Placeholder
            header="Радар пока пуст"
            description="Подключи источники в разделе «Источники» и настрой темы в разделе «Настройки», чтобы радар начал работу."
          >
            <div className="radar-empty__actions">
              <Button
                size="l"
                stretched
                onClick={() => navigate(ROUTES.sources)}
                aria-label="Перейти к источникам"
              >
                Источники
              </Button>
              <Button
                size="l"
                stretched
                mode="outline"
                onClick={() => navigate(ROUTES.settings)}
                aria-label="Перейти к темам"
              >
                Темы
              </Button>
            </div>
          </Placeholder>
        )}

        {view.kind === 'filter-empty' && (
          <Placeholder
            header="Под этот фильтр ничего нет"
            description="Попробуй сменить фильтр — возможно, кандидаты лежат в другом статусе."
          >
            <Button
              size="l"
              stretched
              onClick={() => setStatusFilter('candidate')}
              aria-label="Сбросить фильтр"
            >
              Сбросить фильтр
            </Button>
          </Placeholder>
        )}

        {view.kind === 'list' && (
          <List>
            {view.items.map((item) => (
              <RadarMatchCell key={item.match_id} item={item} />
            ))}
          </List>
        )}
      </div>
    </Section>
  );
}

interface RadarFilterChipsProps {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}

function RadarFilterChips({ value, onChange }: RadarFilterChipsProps): ReactNode {
  // ARIA APG tablist contract: Left/Right cycle, Home/End jump to ends.
  // Without these the chip set is keyboard-incomplete (Tab/Enter alone is
  // not enough). pl-ux-critic blocker in main_loop=2 sub_loop=1.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, currentIdx: number): void => {
    const lastIdx = RADAR_FILTER_OPTIONS.length - 1;
    let nextIdx = currentIdx;
    if (e.key === 'ArrowRight') nextIdx = currentIdx === lastIdx ? 0 : currentIdx + 1;
    else if (e.key === 'ArrowLeft') nextIdx = currentIdx === 0 ? lastIdx : currentIdx - 1;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = lastIdx;
    else return;
    e.preventDefault();
    onChange(RADAR_FILTER_OPTIONS[nextIdx]!.value);
  };
  return (
    <div className="radar-filters" role="tablist" aria-label="Фильтр статуса">
      {RADAR_FILTER_OPTIONS.map((opt, idx) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls="radar-list"
            // Roving tabindex per ARIA APG: only the active tab is in tab order.
            tabIndex={isActive ? 0 : -1}
            className={`radar-chip${isActive ? ' radar-chip--active' : ''}`}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface RadarMatchCellProps {
  item: RadarMatchProjection;
}

function RadarMatchCell({ item }: RadarMatchCellProps): ReactNode {
  const tone = statusTone(item.status);
  const scoreText = formatScore(item.score);
  const publishedAt = formatPublishedAt(item.news.published_at);
  const sourceName = item.source.name ?? item.source.canonical_url;
  const clusterBadge =
    item.cluster && item.cluster.sources_count > 1
      ? ` · ${item.cluster.sources_count} ${pluralizeRu(item.cluster.sources_count, [
          'источник',
          'источника',
          'источников',
        ])}`
      : '';
  return (
    <Cell
      subtitle={
        <span className="radar-card__subtitle">
          <span className="radar-card__source">{sourceName}</span>
          {publishedAt && (
            <>
              <span aria-hidden="true"> · </span>
              <time dateTime={item.news.published_at ?? undefined}>{publishedAt}</time>
            </>
          )}
          {clusterBadge}
        </span>
      }
      after={
        <div className="radar-card__after">
          <span
            className={`radar-card__score radar-card__score--${tone}`}
            aria-label={`Скор ${scoreText}`}
          >
            {scoreText}
          </span>
        </div>
      }
    >
      <div className="radar-card__title">
        {isSafeExternalUrl(item.news.url) ? (
          <a
            href={item.news.url}
            target="_blank"
            rel="noopener noreferrer"
            className="radar-card__link"
            // Inside Telegram, routes the click through WebApp.openLink
            // (Instant View + haptics). Outside Telegram, the helper falls
            // back to window.open, and right-click "open in new tab" still
            // honours the bare href.
            onClick={(e) => {
              if (openExternal(item.news.url)) {
                e.preventDefault();
              }
            }}
          >
            {item.news.title}
          </a>
        ) : (
          // Non-renderable URL (rejected by isSafeExternalUrl) — render plain
          // text so the title is not styled like an interactive link.
          <span>{item.news.title}</span>
        )}
      </div>
      {item.relevance_reason && <div className="radar-card__reason">{item.relevance_reason}</div>}
      <div className="radar-card__meta">
        <span className={`radar-card__badge radar-card__badge--${tone}`}>
          {statusLabel(item.status)}
        </span>
        {item.risk_flags.length > 0 && (
          <span className="radar-card__risk">⚠ {item.risk_flags.join(', ')}</span>
        )}
      </div>
    </Cell>
  );
}
