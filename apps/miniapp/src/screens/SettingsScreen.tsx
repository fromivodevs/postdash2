/**
 * Settings screen — Phase 3.
 *
 * Renders a single editable topic profile (MVP single-default UX). The form
 * is upserted via `POST /topics`: a fresh save creates a profile if none
 * exists, otherwise it updates the existing one (see
 * `createTopicProfile` upsert semantics).
 *
 * State machine:
 *   loading -> empty (no profile yet, blank form)
 *   loading -> loaded (existing profile pre-fills form)
 *   error   -> ErrorState with retry
 *
 * Edge case 5.4 (many topic profiles per workspace): the schema permits many,
 * UI ignores all but the first active one. If `items.length > 1` we still
 * show only `items[0]`. Phase 5+ multi-profile lifts this.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  ErrorState,
  FieldError,
  Placeholder,
  Section,
  Spinner,
  useSnackbar,
} from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useMainButton } from '../telegram/useMainButton.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { getTopics, postTopic, type PostTopicInput } from '../api/topics.ts';
import type { TopicProfileListProjection, TopicProfileProjection } from '../api/types.ts';

const TOPICS_QUERY_KEY = ['topics'] as const;

export function SettingsScreen(): ReactNode {
  useBackButton({ visible: false, onClick: () => {} });
  const { showSnackbar } = useSnackbar();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const initData = session?.initData;

  const topicsQuery = useQuery<TopicProfileListProjection, Error>({
    queryKey: TOPICS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      if (!initData) throw new Error('initData is missing');
      return getTopics(initData, signal);
    },
    enabled: Boolean(initData),
  });

  const existing: TopicProfileProjection | null = topicsQuery.data?.items[0] ?? null;

  // Local form state. Initialised from the loaded profile on first mount and
  // refilled when the loaded profile changes (e.g. after a save).
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<'ru' | 'en'>('ru');
  const [mainTopics, setMainTopics] = useState('');
  const [keywords, setKeywords] = useState('');
  const [negativeKeywords, setNegativeKeywords] = useState('');
  // §7 FieldError tier — validation messages live next to the offending
  // input, not in a transient bottom toast that disappears in 3 seconds.
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setLanguage(existing.language);
      setMainTopics(existing.main_topics.join(', '));
      setKeywords(existing.keywords.join(', '));
      setNegativeKeywords(existing.negative_keywords.join(', '));
    }
  }, [existing]);

  const saveMutation = useMutation<TopicProfileProjection, Error, PostTopicInput>({
    mutationFn: async (input) => {
      if (!initData) throw new Error('initData is missing');
      return postTopic(initData, input);
    },
    onSuccess: () => {
      showSnackbar({ text: 'Темы сохранены.' });
      void queryClient.invalidateQueries({ queryKey: TOPICS_QUERY_KEY });
    },
    onError: () => {
      showSnackbar({ text: 'Не удалось сохранить. Попробуй ещё раз.', tone: 'danger' });
    },
  });

  const onSave = (): void => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      // Inline field error per §7 (FieldError tier), not snackbar — snackbars
      // disappear and don't tell screen readers WHICH field is wrong.
      setNameError('Укажи название.');
      return;
    }
    setNameError(null);
    saveMutation.mutate({
      name: trimmedName,
      language,
      main_topics: splitTags(mainTopics),
      keywords: splitTags(keywords),
      negative_keywords: splitTags(negativeKeywords),
    });
  };

  // §4 native chrome: sticky-bottom MainButton is the primary CTA. Hook
  // ALWAYS runs (Rules of Hooks) — visibility is gated on the loaded state
  // so the button hides during initial load + error states. The in-page
  // "Сохранить" Button below stays for non-Telegram dev (useMainButton no-ops
  // outside Telegram).
  useMainButton({
    visible: !topicsQuery.isLoading && !topicsQuery.isError,
    text: 'Сохранить',
    onClick: onSave,
    loading: saveMutation.isPending,
    enabled: !saveMutation.isPending && name.trim().length > 0,
  });

  if (topicsQuery.isLoading) {
    return (
      <Section header="Настройки">
        <div className="screen-center">
          <Spinner size="m" />
        </div>
      </Section>
    );
  }

  if (topicsQuery.isError) {
    return (
      <Section header="Настройки">
        <ErrorState error={topicsQuery.error} onRetry={() => void topicsQuery.refetch()} />
      </Section>
    );
  }

  return (
    <Section header="Настройки">
      {!existing && (
        <Placeholder
          header="Темы ещё не заданы"
          description="Опиши, какие новости тебе интересны. Радар будет искать по этим темам."
        />
      )}

      <div className="settings-form">
        <label className="settings-form__field">
          <span className="settings-form__label">Название</span>
          <input
            className="settings-form__input"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            placeholder="Например, Tech"
            aria-label="Название темы"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'topic-name-error' : undefined}
          />
          <FieldError id="topic-name-error" message={nameError} />
        </label>

        <label className="settings-form__field">
          <span className="settings-form__label">Язык контента</span>
          <select
            className="settings-form__input"
            value={language}
            onChange={(e) => setLanguage(e.target.value === 'en' ? 'en' : 'ru')}
            aria-label="Язык контента"
          >
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>

        <label className="settings-form__field">
          <span className="settings-form__label">Основные темы (через запятую)</span>
          <input
            className="settings-form__input"
            type="text"
            value={mainTopics}
            onChange={(e) => setMainTopics(e.target.value)}
            placeholder="AI, стартапы, разработка"
            aria-label="Основные темы"
          />
        </label>

        <label className="settings-form__field">
          <span className="settings-form__label">Ключевые слова (через запятую)</span>
          <input
            className="settings-form__input"
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="LLM, GPT, Anthropic"
            aria-label="Ключевые слова"
          />
        </label>

        <label className="settings-form__field">
          <span className="settings-form__label">Стоп-слова (через запятую)</span>
          <input
            className="settings-form__input"
            type="text"
            value={negativeKeywords}
            onChange={(e) => setNegativeKeywords(e.target.value)}
            placeholder="спам, реклама"
            aria-label="Стоп-слова"
          />
        </label>

        <Button
          size="l"
          stretched
          loading={saveMutation.isPending}
          disabled={saveMutation.isPending || !name.trim()}
          onClick={onSave}
          aria-label="Сохранить темы"
        >
          Сохранить
        </Button>
      </div>
    </Section>
  );
}

/**
 * Splits a comma-separated string into trimmed, non-empty tags. Used for the
 * three tag-style fields (main_topics, keywords, negative_keywords).
 */
export function splitTags(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
