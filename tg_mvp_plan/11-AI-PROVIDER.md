# AI Provider: Yandex AI Studio + DeepSeek 3.2

## 1. Provider choice

LLM: **DeepSeek 3.2** через **Yandex AI Studio** (`deepseek-ai/deepseek-v3.2-exp` или текущий MVP-pin).
Embeddings: **YandexGPT Embeddings** (`text-search-doc` / `text-search-query`, dim=256) через тот же Yandex AI Studio.

Решение фиксируется до Phase 0, чтобы:
- domain core не зависел от конкретного провайдера (только от `AIProvider` interface);
- cost guard работал в рублях с первого дня;
- prompt-инструкции учитывали особенности модели (structured JSON output, RU-стиль, длина контекста).

## 2. Why this provider

- доступ из РФ, низкая latency для RU-аудитории;
- оплата в рублях, прозрачные лимиты, один биллинг-аккаунт на LLM и embeddings;
- DeepSeek 3.2 — сильный reasoning, держит structured JSON output;
- альтернативы (OpenAI / Anthropic напрямую) дороже в РФ-инфраструктуре и требуют отдельной интеграции платежей.

## 3. AIProvider interface

`packages/ai/src/provider.ts`:

```ts
export interface ScoreInput {
  workspace_id: string;
  topic_profile: TopicProfile;
  news: {
    title: string;
    summary?: string;
    extracted_text?: string;
    url: string;
    published_at?: Date;
  };
  language: 'ru' | 'en';
}

export interface ScoreOutput {
  score: number;             // 0..10, clamped
  relevance_reason: string;  // < 280 chars
  should_create_draft: boolean;
  risk_flags: string[];
  used_model: string;
  prompt_version: string;
}

export interface DraftInput {
  workspace_id: string;
  topic_profile: TopicProfile;
  tone_profile: ToneProfile;
  news: NewsRef;
  format: 'short_news' | 'expert_angle';
  language: 'ru' | 'en';
}

export interface DraftOutput {
  title?: string;
  post_text: string;
  source_links: string[];
  notes?: string;
  risk_flags: string[];
  used_model: string;
  prompt_version: string;
}

export interface RewriteInput extends DraftInput {
  current_text: string;
  instruction:
    | 'shorter'
    | 'more_expert'
    | 'simpler'
    | 'remove_fluff'
    | 'add_hook'
    | 'three_variants'
    | string;
}

export interface EmbedInput {
  text: string;
  kind: 'doc' | 'query';
}

export interface EmbedOutput {
  vector: number[];   // length must equal EMBEDDING_DIM (256)
  used_model: string;
}

export interface AIProvider {
  score(input: ScoreInput): Promise<ScoreOutput>;
  generateDraft(input: DraftInput): Promise<DraftOutput>;
  rewriteDraft(input: RewriteInput): Promise<DraftOutput | DraftOutput[]>;
  embed(input: EmbedInput): Promise<EmbedOutput>;
}
```

Все вызовы — только из worker-tasks, не из HTTP-handler'ов. API endpoints возвращают `task_id`; UI поллит/слушает.

## 4. Implementations

### 4.1 YandexAIStudioDeepSeekProvider (primary)

HTTP-клиент к Yandex Foundation Models API.

- LLM endpoint: `https://llm.api.cloud.yandex.net/foundationModels/v1/completion`
- Embeddings endpoint: `https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding`

Header: `Authorization: Bearer <iam_token>`.
Body: includes `modelUri` (с folder_id), `messages`, `completionOptions`, и опционально `jsonSchema` для structured output.

### 4.2 TemplateProvider (fallback, no AI)

Используется когда:
- cost guard блокирует;
- LLM endpoint вернул 5xx после retry;
- ответ модели не парсится после repair-attempt;
- safety-фильтр модели отказал.

Score-fallback:

```
score = 5.0
relevance_reason = "LLM unavailable, candidate based on source"
should_create_draft = false
risk_flags = ["fallback"]
```

Draft-fallback (Format A):

```
Новость: {title}

Кратко: {summary or first 400 chars of extracted_text}

Источник: {url}
```

Embedding fallback отсутствует — без embedding'а news хранится с `embedding_status='failed'` и retry'ится janitor'ом.

## 5. Auth flow

Yandex AI Studio использует IAM-токен + folder_id.

Worker spawn-time:
1. Прочитать Service Account JSON Key из secret (env `YA_SA_KEY_JSON`).
2. POST к `https://iam.api.cloud.yandex.net/iam/v1/tokens` с JWT, подписанным приватным ключом.
3. Получить IAM-токен. Кешировать in-memory + writethrough в `system_state(key='ya_iam_token', expires_at)`.
4. Refresh каждые 10 часов (живёт 12).
5. При 401 от Foundation Models API — force-refresh и retry один раз.

API-вызовы передают `modelUri` в формате:
```
gpt://<folder_id>/deepseek-ai/deepseek-v3.2-exp/latest
emb://<folder_id>/text-search-doc/latest
emb://<folder_id>/text-search-query/latest
```

## 6. Output validation (JSON mode)

DeepSeek 3.2 поддерживает structured output, но **всегда** валидируй на стороне приложения.

Каждый `ScoreOutput` / `DraftOutput` валидируется через zod-схему сразу после получения.

При parse error:
1. Один repair-attempt: те же messages + system "Your previous output was not valid JSON matching the schema. Return ONLY a JSON object matching: <schema>. No prose, no markdown.".
2. Если снова не парсится — TemplateProvider fallback.
3. Лог: `ai_usage_events.payload_summary = { parse_error: true, raw_excerpt: <first 200 chars> }`.

## 7. Prompt versioning

Каждый шаблон промпта имеет `prompt_version` строкой (`score@v1.0`, `draft_short_news@v1.0`, и т.д.).

Записывается в:
- `post_draft_versions.prompt_version`;
- `ai_usage_events.prompt_version`.

При смене промпта:
1. bump version (`v1.0 → v1.1`);
2. короткая запись в `packages/ai/prompts/CHANGELOG.md` (что и зачем);
3. старая версия не удаляется — нужна для воспроизводимости старых drafts.

## 8. Two-language strategy

Один LLM-провайдер, два набора промптов: `ru` и `en`.

Определение языка:
- `topic_profile.language` — primary signal;
- `global_news_items.language` — secondary (heuristic cyrillic vs latin);
- mismatch (RU-канал, EN-источник) → промпт получает явную инструкцию: "source in EN, write post in RU".

Translation-on-the-fly выполняется самой моделью. Отдельный translation-провайдер не нужен.

## 9. Retry and error policy

| Error class | Retry | Action |
|---|---|---|
| 429 rate-limit | exponential backoff (3 attempts, jitter 100-500ms) | retry |
| 5xx server error | exponential backoff (3 attempts) | retry, иначе TemplateProvider |
| 4xx validation | нет | task `failed`, error surface |
| Safety refused | нет | `risk_flags=['refused']`, TemplateProvider |
| JSON parse error | repair-attempt (1) | если не помогло — TemplateProvider |
| Embedding 5xx | retry (3) | если упало — `embedding_status='failed'`, janitor retry |
| IAM token expired | force-refresh + retry (1) | автоматически |
| Network timeout | retry (3) с увеличением timeout | TemplateProvider |
| Context length exceeded | truncate input | re-call с usebar safe limit |

`retry_after` из ответа Yandex/Telegram уважается всегда.

## 10. Cost guard

См. `ai_budget_state` в `03-DATABASE-SCHEMA.md`.

Перед каждым **generative**-вызовом (score / draft / rewrite):

1. `INSERT ... ON CONFLICT DO UPDATE` строку `ai_budget_state(workspace_id, day=today_utc)` — atomic.
2. Прочитать текущий `spent_rub`.
3. Рассчитать `estimated_cost`:
   ```
   estimated_cost = (prompt_tokens_estimate * AI_INPUT_RUB_PER_1M_TOKENS / 1_000_000)
                  + (YA_LLM_MAX_TOKENS * AI_OUTPUT_RUB_PER_1M_TOKENS / 1_000_000)
   ```
4. Если `spent_rub + estimated_cost > AI_DAILY_CAP_RUB_PER_WORKSPACE`:
   - task → `status='deferred'`, `last_error='cost_cap_reached'`;
   - UI: баннер "AI лимит исчерпан до 00:00 UTC";
   - cron на 00:00 UTC промотирует deferred → pending следующего дня.
5. После успешного вызова `UPDATE ai_budget_state SET spent_rub = spent_rub + actual_cost`.

**Embeddings НЕ учитываются в cap** (дёшевы), но логируются.

Cost estimation env:
```
AI_INPUT_RUB_PER_1M_TOKENS=8        # пример, актуальный тариф
AI_OUTPUT_RUB_PER_1M_TOKENS=24
AI_EMBED_RUB_PER_1M_TOKENS=2
AI_DAILY_CAP_RUB_PER_WORKSPACE=200  # ≈ 2-3 USD
```

Pricing-сдвиги: меняем env-vars deployment'ом; уже записанные строки в `ai_usage_events` хранят исторический cost.

## 11. Observability

`ai_usage_events` пишется для **каждого** вызова:

- workspace_id, user_id (если из user-action), task_id;
- action_type: `score | generate | rewrite | embed`;
- used_model, prompt_version;
- input_tokens, output_tokens (точные);
- cost_rub (точный, после ответа);
- duration_ms;
- status: `success | failed | refused | parse_error | fallback`;
- error_message nullable;
- payload_summary jsonb (краткое — без PII, без полного output'а).

MVP-дашборд:
```sql
SELECT date_trunc('day', created_at) AS day,
       action_type,
       status,
       SUM(cost_rub) AS spent_rub,
       SUM(input_tokens + output_tokens) AS total_tokens,
       COUNT(*) AS calls
FROM ai_usage_events
GROUP BY 1, 2, 3
ORDER BY 1 DESC;
```

## 12. Anti-abuse and safety rules

- AI **никогда** не публикует. Всегда через `PublishPostCommand` с user-confirmation.
- Source URL обязателен в каждом draft. Если AI его не вернул — TemplateProvider fallback.
- `risk_flags` из LLM (e.g., `['medical_claim']`, `['unverified_statistic']`) → surface в Mini App badge'ом. В MVP не блокируют публикацию.
- Если `topic_profile` содержит финансовые / медицинские / юридические темы — system-промпт добавляет дисклеймер автоматически.
- Прямые цитаты длиннее 200 символов из source запрещены промптом (защита от копирайт-проблем).

## 13. Env-vars catalog

```text
YA_SA_KEY_JSON                           # service account JSON, secret
YA_FOLDER_ID                             # Yandex Cloud folder id
YA_LLM_MODEL_URI                         # gpt://<folder>/deepseek-ai/deepseek-v3.2-exp/latest
YA_EMBED_DOC_MODEL_URI                   # emb://<folder>/text-search-doc/latest
YA_EMBED_QUERY_MODEL_URI                 # emb://<folder>/text-search-query/latest
YA_LLM_REQUEST_TIMEOUT_MS=60000
YA_LLM_MAX_TOKENS=2000
YA_LLM_TEMPERATURE=0.3                   # для score; 0.7 для draft (override per call)
AI_INPUT_RUB_PER_1M_TOKENS=8
AI_OUTPUT_RUB_PER_1M_TOKENS=24
AI_EMBED_RUB_PER_1M_TOKENS=2
AI_DAILY_CAP_RUB_PER_WORKSPACE=200
AI_FALLBACK_TO_TEMPLATE=true
AI_EMBEDDING_DIM=256
AI_DEDUPE_COSINE_THRESHOLD=0.15
AI_DEDUPE_WINDOW_HOURS=48
```

## 14. Migration path

После MVP можно добавить:

- second LLM provider (YandexGPT для чисто-RU каналов, или OpenAI/Anthropic для специальных задач);
- A/B тестирование промптов через `prompt_version`;
- channel-style fine-tuning через embeddings прошлых постов канала;
- semantic search по истории drafts.

Interface `AIProvider` остаётся неизменным; добавляются новые имплементации и роутер.

## 15. Domain rule

В `02-ARCHITECTURE.md` зафиксировано как **Rule 9**: AI — adapter, не core. Domain core не импортирует LLM SDK напрямую. Все AI-операции проходят через `AIProvider`.
