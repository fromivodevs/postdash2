/**
 * Add-source screen — Phase 3.
 *
 * URL + type form. On submit POSTs to /sources and navigates back to the
 * list on success. The server handles redirect resolution + canonicalization;
 * the form just collects the raw user input.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useState, type ReactNode } from 'react';
import { Button, FieldError, Placeholder, Section, useSnackbar } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useMainButton } from '../telegram/useMainButton.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { ROUTES } from '../routing/routes.ts';
import { postSource, type PostSourceInput } from '../api/sources.ts';
import type { SourceSubscriptionProjection } from '../api/types.ts';

const SOURCES_QUERY_KEY = ['sources'] as const;

type SourceType = PostSourceInput['type'];

export function AddSourceScreen(): ReactNode {
  const [, navigate] = useLocation();
  useBackButton({ visible: true, onClick: () => navigate(ROUTES.sources) });
  const { showSnackbar } = useSnackbar();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const initData = session?.initData;

  const [url, setUrl] = useState('');
  const [type, setType] = useState<SourceType>('rss');
  const [name, setName] = useState('');
  // §7 FieldError: validation lives next to the bad input, not in a toast.
  const [urlError, setUrlError] = useState<string | null>(null);

  const createMutation = useMutation<SourceSubscriptionProjection, Error, PostSourceInput>({
    mutationFn: async (input) => {
      if (!initData) throw new Error('initData is missing');
      return postSource(initData, input);
    },
    onSuccess: () => {
      showSnackbar({ text: 'Источник добавлен.' });
      void queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
      navigate(ROUTES.sources);
    },
    onError: () => {
      showSnackbar({ text: 'Не удалось добавить источник.', tone: 'danger' });
    },
  });

  const onSubmit = (): void => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setUrlError('Укажи URL.');
      return;
    }
    setUrlError(null);
    const trimmedName = name.trim();
    createMutation.mutate({
      url: trimmedUrl,
      type,
      ...(trimmedName ? { name: trimmedName } : {}),
    });
  };

  // §4 native chrome: sticky-bottom MainButton is the primary CTA. The
  // in-page "Добавить" Button below stays for non-Telegram dev.
  useMainButton({
    visible: true,
    text: 'Добавить',
    onClick: onSubmit,
    loading: createMutation.isPending,
    enabled: !createMutation.isPending && url.trim().length > 0,
  });

  return (
    <Section header="Новый источник">
      <Placeholder
        header="Добавь источник"
        description="Вставь URL RSS-ленты или сайта. Если URL короткий — сервер сам найдёт целевую страницу."
      />
      <div className="add-source-form">
        <label className="add-source-form__field">
          <span className="add-source-form__label">URL</span>
          <input
            className="add-source-form__input"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (urlError) setUrlError(null);
            }}
            placeholder="https://example.com/feed.xml"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="URL источника"
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? 'source-url-error' : undefined}
          />
          <FieldError id="source-url-error" message={urlError} />
        </label>

        <label className="add-source-form__field">
          <span className="add-source-form__label">Тип</span>
          <select
            className="add-source-form__input"
            value={type}
            onChange={(e) => setType(narrowType(e.target.value))}
            aria-label="Тип источника"
          >
            <option value="rss">RSS</option>
            <option value="website">Веб-сайт</option>
            <option value="manual">Вручную</option>
          </select>
        </label>

        <label className="add-source-form__field">
          <span className="add-source-form__label">Название (опционально)</span>
          <input
            className="add-source-form__input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, Hacker News"
            aria-label="Название источника"
          />
        </label>

        <Button
          size="l"
          stretched
          loading={createMutation.isPending}
          disabled={createMutation.isPending || !url.trim()}
          onClick={onSubmit}
          aria-label="Добавить"
        >
          Добавить
        </Button>
      </div>
    </Section>
  );
}

function narrowType(s: string): SourceType {
  if (s === 'website') return 'website';
  if (s === 'manual') return 'manual';
  if (s === 'api') return 'api';
  return 'rss';
}
