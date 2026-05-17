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
import { useSession } from '../session/SessionProvider.tsx';
import { getRadar } from '../api/radar.ts';
import { ROUTES } from '../routing/routes.ts';
import {
  RADAR_FILTER_OPTIONS,
  formatPublishedAt,
  formatScore,
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
  });

  return (
    <Section header="Радар">
      <RadarFilterChips value={statusFilter} onChange={setStatusFilter} />

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
          description="Подключи источники и добавь темы, и радар начнёт находить релевантные новости."
        >
          <Button
            size="l"
            stretched
            onClick={() => navigate(ROUTES.sources)}
            aria-label="Перейти к источникам"
          >
            Источники
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
    </Section>
  );
}

interface RadarFilterChipsProps {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}

function RadarFilterChips({ value, onChange }: RadarFilterChipsProps): ReactNode {
  return (
    <div className="radar-filters" role="tablist" aria-label="Фильтр статуса">
      {RADAR_FILTER_OPTIONS.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`radar-chip${isActive ? ' radar-chip--active' : ''}`}
            onClick={() => onChange(opt.value)}
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
      ? ` · ${item.cluster.sources_count} источников`
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
        <a
          href={item.news.url}
          target="_blank"
          rel="noopener noreferrer"
          className="radar-card__link"
        >
          {item.news.title}
        </a>
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
