# Future Expansion Plan

## 1. Multi-platform channels

Because core uses `content_channel` and adapters, later add:
- VK groups;
- Discord channels;
- Slack channels;
- Web dashboard;
- email newsletter.

Add new adapter implementing:

```text
verifyConnection
getChannelInfo
publishPost
editPost optional
deletePost optional
handleIncomingEvent optional
```

## 2. Research Agent

After MVP, add user prompt search:

```text
Найди 10 важных новостей про AI coding за сегодня.
```

New entities:
- research_task;
- research_result;
- saved_research_rule.

Flow:

```text
user prompt -> research task -> source search -> results -> scoring -> draft/digest
```

## 3. Saved rules

User can save prompt as recurring rule:

```text
Каждое утро найди 5 главных новостей про AI за 24 часа.
```

This becomes automation rule.

## 4. Autopublish

Only after quality is proven.

Rules:
- source in whitelist;
- score >= threshold;
- no risk flags;
- workspace allowed autopublish;
- daily publish limit.

## 5. Billing and tiers

Suggested tiers:

### Free / Trial
- 1 channel;
- 5 sources;
- 5 drafts/day.

### Starter
- 1 channel;
- 20 sources;
- 30 drafts/day.

### Creator
- 3 channels;
- 100 sources;
- 100 drafts/day;
- scheduling.

### Agency
- 10+ channels;
- team members;
- client approvals;
- advanced reports.

## 6. Web dashboard

Mini App is MVP interface. Later add web dashboard for:
- agencies;
- bulk source management;
- analytics;
- billing;
- team members.

## 7. Source reputation

Track:
- source freshness;
- source quality;
- duplicate rate;
- publish conversion;
- user rejection rate.

Use to improve scoring.

## 8. Analytics

Add:
- drafts generated;
- drafts published;
- post performance if platform API supports;
- best sources;
- best topics;
- time saved estimate.

## 9. Agency workflows

Add:
- multiple workspaces;
- client approval flow;
- team roles;
- scheduled reports;
- white-label options.

## 10. White-label bots

Later, clients can connect their own bot token.

Keep as premium feature.

Architecture:
- channel_connection.credentials_ref;
- secure token storage;
- per-workspace bot adapter instance.

## 11. Template library

Add post templates:
- short news;
- expert take;
- digest;
- comparison;
- tool review;
- market insight.

## 12. Advanced safety

Add high-risk topic policies:
- finance;
- medicine;
- politics;
- legal.

Warnings, claim checks, restricted autopublish.

## 13. Deferred from MVP

Эти кейсы видимы в MVP, но осознанно отложены (см. `12-EDGE-CASES.md §14`):

- nonce-based replay protection поверх `auth_date`;
- авто-revalidate historical matches при изменении topic_profile;
- multi-channel publish одного draft;
- per-timezone quiet hours для notifications;
- self-healing crash window для `publish_events` (только manual review в MVP);
- RLS на Postgres (доверяем application policy + integration tests);
- soft delete с восстановлением для workspace / sources;
- transactional outbox для `domain_events`;
- per-source circuit breaker (вместо — manual disable);
- channel migration to supergroup auto-update;
- account merge между двумя `telegram_user_id` одного человека;
- per-source User-Agent rotation против Cloudflare;
- cluster cross-language merge validation (работает по факту, но не protected тестами).

Каждый кейс становится приоритетным если accumulates user complaints или incident.

## 14. Multi-LLM strategy

После MVP можно подключить:

- `YandexGPTProvider` — для чисто-RU каналов (более естественный русский);
- `OpenAIProvider` / `AnthropicProvider` — для special tasks (research agent, prompt search);
- A/B testing промптов через `prompt_version`;
- channel-style fine-tuning embeddings прошлых постов;
- semantic search по истории опубликованных drafts.

Интерфейс `AIProvider` остаётся неизменным — добавляется provider router (workspace settings → preferred provider).

## 15. Neutral news card (Phase MVP+1 cost optimization)

### Идея

Промежуточный глобальный слой между `global_news_items.extracted_text` и per-workspace draft.

Один LLM-вызов **глобально** (per cluster, не per workspace) производит structured news card:

```json
{
  "what_happened": "Cursor released X feature",
  "key_facts": ["fact1", "fact2", "fact3"],
  "key_quotes": ["...exact quote..."],
  "stakeholders": ["company A", "competitor B"],
  "freshness_relevance_hours": 24,
  "risk_flags": ["unverified_stat", "promotional_tone"],
  "sources": ["url1", "url2"],
  "prompt_version": "news_card@v1.0"
}
```

Это **не пост**. Это pre-digested факты для дальнейшего рендера.

Каждый workspace потом генерирует **свой** draft на основе карточки + `tone_profile` + `topic_profile`. Draft prompt получает короткие structured факты вместо raw 8k текста.

### Pros
- значимая экономия токенов на масштабе: cheap per-workspace draft prompt;
- консистентные `risk_flags` между workspace'ами;
- anti-hallucination сильнее: модель работает с verified factual subset, а не пытается их извлечь из шумного раw текста;
- проще отслеживать качество новостей независимо от tone_profile конкретного workspace.

### Cons
- ещё один LLM-вызов глобально (per cluster). На малой шкале (10–30 user'ов) выигрыш почти нулевой;
- двухслойный prompt versioning (`news_card@v1.x` + `draft@v1.x`);
- ещё одна таблица + pipeline + cache invalidation;
- если news card сгенерирован неверно — все workspace получают плохие drafts (single point of failure).

### Strict NO: дословный sharing draft текста

Шарить **полный draft текст** между workspace'ами нельзя:

1. **Tone mismatch** — workspace с разными `tone_profile` (формат, эмодзи, аудитория) получают пост в чужом стиле.
2. **Brand risk** — два канала с пересекающейся аудиторией могут опубликовать дословно одинаковый пост → видимый "копипаст" → репутационный урон.

### Когда переключаться

Триггеры для добавления neutral news card:
- 100+ active workspaces;
- median 30%+ overlap по `news_clusters` между workspace'ами;
- AI cost растёт быстрее, чем revenue per workspace;
- repeated complaints о "разный draft для одной и той же новости несогласован между темами" (что говорит о том, что factual layer нужно зафиксировать).

### Required schema additions (когда триггеры выполнятся)

```text
news_cards
  id uuid pk
  cluster_id uuid fk news_clusters.id unique
  representative_news_item_id uuid fk global_news_items.id
  structured_facts jsonb
  risk_flags text[]
  prompt_version text
  ai_model text
  cost_rub numeric
  created_at timestamptz
```

И поле `news_card_id` в `post_draft_versions` для traceability.
