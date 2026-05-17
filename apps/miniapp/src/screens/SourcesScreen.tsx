/**
 * Sources screen — Phase 3.
 *
 * Renders the workspace's source subscriptions with toggle/delete actions.
 * Uses `GET /sources` for the list, `PATCH /sources/:id` to toggle enabled,
 * `DELETE /sources/:id` to unsubscribe. The "Add" button routes to
 * `/sources/new` which holds the URL+type form.
 *
 * Phase 4 will fill in the source-health fields (last_fetched_at,
 * last_fetch_status) — until then the UI shows "пока не проверялся" so the
 * user understands the placeholder state is intentional.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useState, type ReactNode } from 'react';
import {
  formatLastFetched,
  isRowDeleting,
  isRowToggling,
  selectSourcesView,
} from './sourcesView.ts';
import {
  Button,
  Cell,
  ConfirmModal,
  ErrorState,
  List,
  Placeholder,
  Section,
  Skeleton,
  useSnackbar,
} from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { ROUTES } from '../routing/routes.ts';
import { deleteSource, getSources, patchSource } from '../api/sources.ts';
import type {
  SourceSubscriptionListProjection,
  SourceSubscriptionProjection,
} from '../api/types.ts';

const SOURCES_QUERY_KEY = ['sources'] as const;

export function SourcesScreen(): ReactNode {
  useBackButton({ visible: false, onClick: () => {} });
  const [, navigate] = useLocation();
  const { showSnackbar } = useSnackbar();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const initData = session?.initData;

  const sourcesQuery = useQuery<SourceSubscriptionListProjection, Error>({
    queryKey: SOURCES_QUERY_KEY,
    queryFn: async ({ signal }) => {
      if (!initData) throw new Error('initData is missing');
      return getSources(initData, signal);
    },
    enabled: Boolean(initData),
  });

  // Per-source pending state. React Query's mutation pendingState is global
  // to the mutation instance — without per-row tracking, every row's button
  // freezes while ANY row is in flight. We track the active source_id
  // separately so only the row being mutated shows the loading state.
  const [pendingToggleSourceId, setPendingToggleSourceId] = useState<string | null>(null);
  const [pendingDeleteSourceId, setPendingDeleteSourceId] = useState<string | null>(null);
  // §7 Modal tier — destructive actions need a confirmation step. Pending
  // candidate stored as the full subscription so the modal can show the
  // source name + URL without a second lookup.
  const [deleteCandidate, setDeleteCandidate] = useState<SourceSubscriptionProjection | null>(null);

  const toggleMutation = useMutation<
    SourceSubscriptionProjection,
    Error,
    { sourceId: string; enabled: boolean }
  >({
    mutationFn: async ({ sourceId, enabled }) => {
      if (!initData) throw new Error('initData is missing');
      return patchSource(initData, sourceId, { enabled });
    },
    onMutate: ({ sourceId }) => {
      setPendingToggleSourceId(sourceId);
    },
    onSettled: () => {
      setPendingToggleSourceId(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
    },
    onError: () => {
      showSnackbar({ text: 'Не удалось изменить источник.', tone: 'danger' });
    },
  });

  const deleteMutation = useMutation<void, Error, string>({
    mutationFn: async (sourceId) => {
      if (!initData) throw new Error('initData is missing');
      await deleteSource(initData, sourceId);
    },
    onMutate: (sourceId) => {
      setPendingDeleteSourceId(sourceId);
    },
    onSettled: () => {
      setPendingDeleteSourceId(null);
    },
    onSuccess: () => {
      showSnackbar({ text: 'Источник удалён.' });
      void queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
    },
    onError: () => {
      showSnackbar({ text: 'Не удалось удалить.', tone: 'danger' });
    },
  });

  // Pure view-model selector (tested in sourcesView.test.ts) — replaces the
  // four-state inline branching with a single discriminated union the JSX
  // dispatches on. Keeps the dispatch tight + the logic test-covered.
  const view = selectSourcesView({
    loading: sourcesQuery.isLoading,
    errored: sourcesQuery.isError,
    items: sourcesQuery.data?.items,
  });

  if (view.kind === 'loading') {
    // §6 Skeleton-first for list views — three placeholder cells with the
    // shape of a real SourceCell give the user a clearer "loading" cue than
    // a centered Spinner and prevent layout shift when content arrives.
    return (
      <Section header="Источники">
        <div className="sources-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="sources-skeleton__row">
              <Skeleton width="60%" height="18px" />
              <Skeleton width="90%" height="14px" />
            </div>
          ))}
        </div>
      </Section>
    );
  }

  if (view.kind === 'error') {
    return (
      <Section header="Источники">
        <ErrorState error={sourcesQuery.error} onRetry={() => void sourcesQuery.refetch()} />
      </Section>
    );
  }

  if (view.kind === 'empty') {
    return (
      <Section header="Источники">
        <Placeholder
          header="Пока нет источников"
          description="Добавь RSS-ленту или сайт, чтобы радар начал работу."
        >
          <Button
            size="l"
            stretched
            onClick={() => navigate(`${ROUTES.sources}/new`)}
            aria-label="Добавить источник"
          >
            + Добавить источник
          </Button>
        </Placeholder>
      </Section>
    );
  }

  return (
    <Section header="Источники">
      <List>
        {view.items.map((item) => (
          <SourceCell
            key={item.subscription_id}
            item={item}
            onToggle={(enabled) =>
              toggleMutation.mutate({ sourceId: item.source.id, enabled })
            }
            onDelete={() => setDeleteCandidate(item)}
            toggling={isRowToggling(item.source.id, pendingToggleSourceId)}
            deleting={isRowDeleting(item.source.id, pendingDeleteSourceId)}
          />
        ))}
      </List>
      <div className="sources-add-row">
        <Button
          size="l"
          stretched
          onClick={() => navigate(`${ROUTES.sources}/new`)}
          aria-label="Добавить источник"
        >
          + Добавить источник
        </Button>
      </div>
      <ConfirmModal
        open={deleteCandidate !== null}
        title="Удалить источник?"
        description={
          deleteCandidate
            ? `Источник «${deleteCandidate.source.name ?? deleteCandidate.source.url}» будет отключён. Глобальная запись сохранится.`
            : ''
        }
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        destructive
        onConfirm={() => {
          if (deleteCandidate) {
            deleteMutation.mutate(deleteCandidate.source.id);
            setDeleteCandidate(null);
          }
        }}
        onCancel={() => setDeleteCandidate(null)}
      />
    </Section>
  );
}

interface SourceCellProps {
  item: SourceSubscriptionProjection;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  toggling: boolean;
  deleting: boolean;
}

function SourceCell({ item, onToggle, onDelete, toggling, deleting }: SourceCellProps): ReactNode {
  // formatLastFetched is the same logic the test covers — keeps the JSX
  // free of locale + null-handling concerns and means a future timezone
  // tweak lands in one place.
  const fetched = formatLastFetched(item.source.last_fetched_at);
  return (
    <Cell
      subtitle={
        // Semantic split: URL gets its own element so screen readers
        // announce it as a distinct field; <time> for the timestamp gives
        // the AT a structural cue separate from the URL string.
        <span className="source-cell__subtitle">
          <span className="source-cell__url" aria-label="URL источника">
            {item.source.canonical_url}
          </span>
          <span aria-hidden="true"> · </span>
          {item.source.last_fetched_at ? (
            <time className="source-cell__fetched" dateTime={item.source.last_fetched_at}>
              {fetched}
            </time>
          ) : (
            <span className="source-cell__fetched">{fetched}</span>
          )}
        </span>
      }
      after={
        <div className="source-cell__actions">
          <Button
            size="s"
            mode={item.enabled ? 'bezeled' : 'plain'}
            disabled={toggling}
            loading={toggling}
            onClick={() => onToggle(!item.enabled)}
            aria-label={item.enabled ? 'Отключить' : 'Включить'}
          >
            {item.enabled ? 'Отключить' : 'Включить'}
          </Button>
          <Button
            size="s"
            mode="plain"
            disabled={deleting}
            loading={deleting}
            onClick={onDelete}
            aria-label="Удалить источник"
          >
            Удалить
          </Button>
        </div>
      }
    >
      {item.source.name ?? item.source.url}
    </Cell>
  );
}
