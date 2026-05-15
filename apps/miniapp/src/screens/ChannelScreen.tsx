/**
 * Channel screen — Phase 2 (architecture/channel-connection.md "Mini App").
 *
 * Renders a four-state machine driven by `GET /channels` + a locally-cached
 * freshly-issued code (the plaintext code is only served once, by the
 * `POST /channels/connect-codes` response):
 *
 *   not_connected -> "Создать код подключения" button
 *   pending       -> show code + deep-link + input for chat_id/@username
 *   connected     -> title + photo + "Проверить сейчас" (refetch)
 *   broken        -> Banner with last_verify_error + "Создать новый код"
 *
 * Decision derivation lives in `channelView.ts` (pure) so the same input ->
 * view mapping is unit-testable without React.
 *
 * Error UX taxonomy (architecture lines 597-603): a failed POST /channels/connect
 * surfaces as an inline Banner keyed on `ChannelApiError.code`. Dead-code errors
 * (`expired_code` / `reused_code`) replace the connect form with a "Создать
 * новый код" button so the user is never stuck on an unusable code.
 *
 * §16 Russian-only copy, §3 telegram-ui primitives only.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Banner,
  Button,
  CopyButton,
  InlineBanner,
  Placeholder,
  Section,
  Spinner,
  useSnackbar,
} from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { miniappEnv } from '../env.ts';
import { buildConnectDeepLink } from '@postdash/shared/channel-projection';
import { getChannels, postConnect, postConnectCode, ChannelApiError } from '../api/channels.ts';
import type {
  ChannelListProjection,
  ChannelProjection,
  ConnectCodeProjection,
} from '../api/types.ts';
import {
  channelErrorCopy,
  isDeadCodeError,
  parseConnectCodeFromSearch,
  selectChannelView,
  verifyStatusCopy,
  type PendingCodeViewModel,
} from './channelView.ts';

const CHANNELS_QUERY_KEY = ['channels'] as const;

export function ChannelScreen(): ReactNode {
  useBackButton({ visible: false, onClick: () => {} });
  const { showSnackbar } = useSnackbar();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const initData = session?.initData;

  const channelsQuery = useQuery<ChannelListProjection, Error>({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      if (!initData) throw new Error('initData is missing');
      return getChannels(initData, signal);
    },
    enabled: Boolean(initData),
  });

  // Plaintext code lives only in the POST response (or a `?code=` deep-link
  // query param). Cache it locally so the user keeps seeing it across
  // re-renders until the connect succeeds or they navigate away. The
  // discriminated union prevents the deep-link path from masquerading as a
  // server-shaped `ConnectCodeProjection` (no fake UUIDs).
  const [codeOverride, setCodeOverride] = useState<PendingCodeViewModel | null>(null);
  // `external_chat_id` input. Pre-filled from the `?code=...` deep-link param
  // on first mount when present (architecture line 614).
  const [chatIdInput, setChatIdInput] = useState('');
  const [connectError, setConnectError] = useState<ChannelApiError | null>(null);

  // Read the deep-link code from the URL once on mount. The boot-time
  // applyDeepLinkToHistory normalised `?startapp=connect_<code>` to
  // `?code=<code>` already (routing/routes.ts), so the value is already on
  // window.location.search by the time we mount.
  const deepLinkCode = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return parseConnectCodeFromSearch(window.location.search);
  }, []);

  // Seed the codeOverride from the deep-link so PendingView shows the code the
  // user already has in their share link. We only have the plaintext code
  // here (no projection id / expires_at), so we model the deep-link source as
  // its own union arm rather than synthesising a fake projection.
  useEffect(() => {
    if (deepLinkCode && !codeOverride) {
      setCodeOverride({ source: 'deep-link', code: deepLinkCode });
    }
  }, [deepLinkCode, codeOverride]);

  const createCodeMutation = useMutation<ConnectCodeProjection, Error, void>({
    mutationFn: async () => {
      if (!initData) throw new Error('initData is missing');
      return postConnectCode(initData);
    },
    onSuccess: (data) => {
      setCodeOverride({ source: 'fresh-post', projection: data });
      setConnectError(null);
    },
    onError: () => {
      showSnackbar({ text: 'Не удалось создать код. Попробуй ещё раз.', tone: 'danger' });
    },
  });

  const connectMutation = useMutation<
    ChannelProjection,
    Error,
    { code: string; external_chat_id: string }
  >({
    mutationFn: async (input) => {
      if (!initData) throw new Error('initData is missing');
      return postConnect(initData, input);
    },
    onSuccess: () => {
      setConnectError(null);
      setCodeOverride(null);
      setChatIdInput('');
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
    onError: (err) => {
      if (err instanceof ChannelApiError) {
        setConnectError(err);
      } else {
        showSnackbar({ text: 'Не удалось подключить канал. Попробуй ещё раз.', tone: 'danger' });
      }
    },
  });

  const view = useMemo(
    () => selectChannelView({ channels: channelsQuery.data ?? null, codeOverride }),
    [channelsQuery.data, codeOverride],
  );

  if (channelsQuery.isLoading) {
    return (
      <Section header="Канал">
        <div className="screen-center">
          <Spinner size="m" />
        </div>
      </Section>
    );
  }

  if (view.kind === 'not_connected') {
    return (
      <NotConnectedView
        onCreateCode={() => createCodeMutation.mutate()}
        creating={createCodeMutation.isPending}
      />
    );
  }

  if (view.kind === 'pending') {
    const plaintextCode =
      view.code === null
        ? null
        : view.code.source === 'fresh-post'
          ? view.code.projection.code
          : view.code.code;
    return (
      <PendingView
        code={view.code}
        chatIdInput={chatIdInput}
        onChatIdInput={setChatIdInput}
        onConnect={() => {
          if (!plaintextCode) return;
          connectMutation.mutate({
            code: plaintextCode,
            external_chat_id: chatIdInput.trim(),
          });
        }}
        connecting={connectMutation.isPending}
        error={connectError}
        onCreateNewCode={() => {
          setConnectError(null);
          setCodeOverride(null);
          createCodeMutation.mutate();
        }}
        creatingNewCode={createCodeMutation.isPending}
      />
    );
  }

  if (view.kind === 'connected') {
    return (
      <ConnectedView
        channel={view.channel}
        onRefresh={() => void channelsQuery.refetch()}
        refreshing={channelsQuery.isFetching}
      />
    );
  }

  // view.kind === 'broken'
  return (
    <BrokenView
      channel={view.channel}
      onCreateNewCode={() => {
        setConnectError(null);
        setCodeOverride(null);
        createCodeMutation.mutate();
      }}
      creatingNewCode={createCodeMutation.isPending}
    />
  );
}

interface NotConnectedViewProps {
  onCreateCode: () => void;
  creating: boolean;
}

function NotConnectedView({ onCreateCode, creating }: NotConnectedViewProps): ReactNode {
  return (
    <Section header="Канал">
      <Placeholder
        header="Канал не подключён"
        description="Создай код подключения, добавь бота админом в канал и заверши привязку."
      >
        <Button
          size="l"
          stretched
          loading={creating}
          disabled={creating}
          onClick={onCreateCode}
          aria-label="Создать код подключения"
        >
          Создать код подключения
        </Button>
      </Placeholder>
    </Section>
  );
}

interface PendingViewProps {
  code: PendingCodeViewModel | null;
  chatIdInput: string;
  onChatIdInput: (value: string) => void;
  onConnect: () => void;
  connecting: boolean;
  error: ChannelApiError | null;
  onCreateNewCode: () => void;
  creatingNewCode: boolean;
}

function PendingView({
  code,
  chatIdInput,
  onChatIdInput,
  onConnect,
  connecting,
  error,
  onCreateNewCode,
  creatingNewCode,
}: PendingViewProps): ReactNode {
  // Compose deep-link locally: prefer the server-supplied `deep_link` (fresh
  // POST /channels/connect-codes response), fall back to building one from
  // the configured bot username for the deep-link source path (where we only
  // have the plaintext code).
  const plaintextCode = code === null
    ? null
    : code.source === 'fresh-post'
      ? code.projection.code
      : code.code;

  const deepLink = useMemo(() => {
    if (!code) return '';
    if (code.source === 'fresh-post' && code.projection.deep_link) {
      return code.projection.deep_link;
    }
    if (miniappEnv.VITE_TELEGRAM_BOT_USERNAME && plaintextCode) {
      return buildConnectDeepLink(miniappEnv.VITE_TELEGRAM_BOT_USERNAME, plaintextCode);
    }
    return '';
  }, [code, plaintextCode]);

  const errBanner = error ? channelErrorCopy(error.code) : null;
  const dead = error ? isDeadCodeError(error.code) : false;

  return (
    <Section header="Подключение канала">
      <div className="channel-pending">
        <Placeholder
          header="Код подключения"
          description="Передай этот код боту через deep-link или введи @username канала вручную."
        />
        {plaintextCode && (
          <div className="channel-pending__code">
            <p className="channel-pending__code-label">Код:</p>
            <pre className="channel-pending__code-value" aria-label="Код подключения">
              {plaintextCode}
            </pre>
            {deepLink && (
              <CopyButton value={deepLink} label="Скопировать ссылку" successText="Скопировано" />
            )}
          </div>
        )}

        {errBanner && (
          <InlineBanner header={errBanner.header} description={errBanner.description} />
        )}

        {dead && (
          <InlineBanner
            header={error?.code === 'expired_code' ? 'Код истёк' : 'Код уже использован'}
            description="Создай новый код подключения, чтобы продолжить."
            action={{
              label: creatingNewCode ? 'Создаём…' : 'Создать новый код',
              onClick: onCreateNewCode,
            }}
          />
        )}

        {!dead && (
          <div className="channel-pending__form">
            <label className="channel-pending__field-label" htmlFor="channel-external-chat-id">
              Или введи @username или chat_id канала
            </label>
            <input
              id="channel-external-chat-id"
              className="channel-pending__input"
              type="text"
              value={chatIdInput}
              onChange={(e) => onChatIdInput(e.target.value)}
              placeholder="@mychannel или -1001234567890"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Username или chat_id канала"
            />
            <Button
              size="l"
              stretched
              loading={connecting}
              disabled={connecting || chatIdInput.trim().length === 0 || !code}
              onClick={onConnect}
              aria-label="Подключить"
            >
              Подключить
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

interface ConnectedViewProps {
  channel: ChannelProjection;
  onRefresh: () => void;
  refreshing: boolean;
}

function ConnectedView({ channel, onRefresh, refreshing }: ConnectedViewProps): ReactNode {
  return (
    <Section header="Канал подключён">
      <div className="channel-connected">
        <div className="channel-connected__header">
          {channel.photo_url ? (
            <img
              className="channel-connected__photo"
              src={channel.photo_url}
              alt=""
              aria-hidden
            />
          ) : (
            <div className="channel-connected__photo channel-connected__photo--placeholder" aria-hidden />
          )}
          <div className="channel-connected__title-block">
            <p className="channel-connected__title">{channel.title}</p>
            {channel.username && (
              <p className="channel-connected__username">@{channel.username}</p>
            )}
            <span className="channel-connected__badge" aria-label="Статус: подключён">
              Подключён
            </span>
          </div>
        </div>
        <Button
          size="m"
          mode="bezeled"
          loading={refreshing}
          disabled={refreshing}
          onClick={onRefresh}
          aria-label="Проверить сейчас"
        >
          Проверить сейчас
        </Button>
        <Button
          size="m"
          mode="plain"
          disabled
          aria-label="Отключить канал (появится в следующей фазе)"
        >
          Отключить канал
        </Button>
      </div>
    </Section>
  );
}

interface BrokenViewProps {
  channel: ChannelProjection;
  onCreateNewCode: () => void;
  creatingNewCode: boolean;
}

function BrokenView({ channel, onCreateNewCode, creatingNewCode }: BrokenViewProps): ReactNode {
  const description = channel.last_verify_error ?? verifyStatusCopy(channel.last_verify_status);
  return (
    <Section header="Канал не работает">
      <div className="channel-broken">
        <Banner type="inline" header={channel.title} subheader={description}>
          <Button
            size="s"
            mode="bezeled"
            loading={creatingNewCode}
            disabled={creatingNewCode}
            onClick={onCreateNewCode}
            aria-label="Создать новый код подключения"
          >
            Создать новый код
          </Button>
        </Banner>
      </div>
    </Section>
  );
}
