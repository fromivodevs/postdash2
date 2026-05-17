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
import { type ReactNode } from 'react';
import {
  Button,
  Cell,
  ErrorState,
  List,
  Placeholder,
  Section,
  Spinner,
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

  const toggleMutation = useMutation<
    SourceSubscriptionProjection,
    Error,
    { sourceId: string; enabled: boolean }
  >({
    mutationFn: async ({ sourceId, enabled }) => {
      if (!initData) throw new Error('initData is missing');
      return patchSource(initData, sourceId, { enabled });
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
    onSuccess: () => {
      showSnackbar({ text: 'Источник удалён.' });
      void queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
    },
    onError: () => {
      showSnackbar({ text: 'Не удалось удалить.', tone: 'danger' });
    },
  });

  if (sourcesQuery.isLoading) {
    return (
      <Section header="Источники">
        <div className="screen-center">
          <Spinner size="m" />
        </div>
      </Section>
    );
  }

  if (sourcesQuery.isError) {
    return (
      <Section header="Источники">
        <ErrorState error={sourcesQuery.error} onRetry={() => void sourcesQuery.refetch()} />
      </Section>
    );
  }

  const items = sourcesQuery.data?.items ?? [];

  if (items.length === 0) {
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
        {items.map((item) => (
          <SourceCell
            key={item.subscription_id}
            item={item}
            onToggle={(enabled) =>
              toggleMutation.mutate({ sourceId: item.source.id, enabled })
            }
            onDelete={() => deleteMutation.mutate(item.source.id)}
            toggling={toggleMutation.isPending}
            deleting={deleteMutation.isPending}
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
  const fetched = item.source.last_fetched_at
    ? new Date(item.source.last_fetched_at).toLocaleString('ru-RU')
    : 'пока не проверялся';
  const subtitle = `${item.source.canonical_url} · ${fetched}`;
  return (
    <Cell
      subtitle={subtitle}
      after={
        <div className="source-cell__actions">
          <Button
            size="s"
            mode={item.enabled ? 'bezeled' : 'plain'}
            disabled={toggling}
            onClick={() => onToggle(!item.enabled)}
            aria-label={item.enabled ? 'Отключить' : 'Включить'}
          >
            {item.enabled ? 'Отключить' : 'Включить'}
          </Button>
          <Button
            size="s"
            mode="plain"
            disabled={deleting}
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
