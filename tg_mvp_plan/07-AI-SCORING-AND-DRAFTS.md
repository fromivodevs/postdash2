# AI Scoring and Draft Generation

Этот документ описывает **что** делает AI и **как** валидируются результаты.

**Как** AI устроен технически — провайдер, auth, JSON-валидация, cost guard, retry, env-vars — описано в `11-AI-PROVIDER.md`.

## 1. AI role in MVP

AI помогает с:
- relevance scoring;
- summary;
- draft generation;
- rewrite actions;
- semantic embeddings (для dedup и matching).

AI **никогда** не:
- публикует автоматически;
- выдумывает факты;
- скрывает source links;
- переписывает claims без основания;
- мутирует важный domain state без command handler.

## 2. Two-level scoring

### 2.1 Global quality score (`global_news_items.global_quality_score`)

General quality:
- reliable source;
- real event;
- fresh;
- not spam;
- not duplicate.

В MVP можно начать с heuristic (`source.reliability_score * freshness_factor`); LLM-вызов опционален.

### 2.2 Workspace relevance score (`workspace_news_matches.score`)

Personal relevance:
- matches topics;
- matches audience;
- not blocked by negative keywords;
- fits channel style;
- postability.

Считается через AI-вызов (`AIProvider.score`).

## 3. Scoring composition

Final score = **min(10, max(0, weighted_avg))**:
- 50% — LLM-judged relevance;
- 30% — semantic cosine (1.0 — distance) от news.embedding до topic_profile.embedding;
- 10% — freshness (`exp(-hours_since_published / 24)`);
- 10% — source reliability (`sources.reliability_score`).

Веса tunable через env. В MVP можно начать с pure LLM score, добавив компоненты в Phase 5+.

Показывать пользователю одно число + reasoning от LLM:

```text
Score: 8.4
Почему высоко:
- официальный источник
- свежая новость
- напрямую связана с AI coding
- можно сделать полезный пост
```

## 4. Draft generation rules

Draft основан на source content.

Required output (`DraftOutput`):
- `post_text`;
- `source_links` (хотя бы один URL);
- `title?`;
- `notes?`;
- `risk_flags` (medical, financial, unverified, etc.);
- `used_model`, `prompt_version` для observability.

Запреты:
- unsupported facts (без указания source);
- прямые цитаты > 200 символов (защита от копирайта);
- statistics без указания источника;
- official confirmation language без подтверждения в source.

Validation после получения output:
- zod-schema на структуру;
- character count ≤ 4096 (Telegram message limit);
- хотя бы один URL в `source_links`;
- markdown/HTML entity parse (через общий `packages/shared/telegram-format.ts`) — если invalid, repair-attempt или TemplateProvider fallback.

## 5. Draft post formats

### Format A: Short news

```text
Заголовок / hook

Что случилось:
...

Почему важно:
...

Источник: ...
```

### Format B: Expert angle

```text
Новость: ...

Главное не в том, что ..., а в том, что ...

Для аудитории это значит:
...

Источник: ...
```

### Format C: Daily digest (later)

```text
5 главных новостей дня

1. ...
2. ...
3. ...

Главный вывод:
...

Источники: ...
```

MVP: Format A и B. Format C — Phase 8+.

## 6. Tone profile

Workspace `topic_profiles.tone_profile` jsonb:

```text
length: short / medium / long
style: strict / lively / expert / simple
emoji: none / light / medium
language: ru / en
cta_style: none / soft / direct
```

AI promp template параметризуется этими полями.

## 7. Rewrite buttons

MVP rewrite actions:

- `shorter`;
- `more_expert`;
- `simpler`;
- `remove_fluff`;
- `add_hook`;
- `three_variants`.

Каждый rewrite создаёт новую `post_draft_version` (см. правила concurrent rewrite в `06-WORKERS-AND-INGESTION.md` §14 и `12-EDGE-CASES.md` §7.4–7.6).

## 8. Prompt structure

### 8.1 Score prompt input

```text
SYSTEM:
You are an editorial assistant scoring news relevance for a Telegram channel.
Output strict JSON matching the schema. No prose, no markdown.

USER:
Workspace topics: {main_topics}
Negative keywords: {negative_keywords}
Audience: {audience_description}
Channel tone: {tone_profile}
Language: {target_language}

News:
- Title: {title}
- Published: {published_at}
- Source: {source_name} ({source_url})
- Text: {extracted_text_truncated_8k}

Schema:
{"score": 0-10, "relevance_reason": str<280, "should_create_draft": bool, "risk_flags": [str]}
```

### 8.2 Score prompt output

```json
{
  "score": 8.4,
  "relevance_reason": "Официальный анонс новой функции Cursor для AI coding...",
  "should_create_draft": true,
  "risk_flags": []
}
```

### 8.3 Draft prompt input

```text
SYSTEM:
You are a writer for a Telegram channel.
Format: {format}.
Tone: {tone_profile}.
Language: {target_language}.
Never invent facts. Always include source URL.

USER:
News:
- Title: {title}
- Source: {url}
- Body: {extracted_text_truncated_8k}

Constraints:
- max 4096 chars
- valid Telegram MarkdownV2
- at least one source URL in source_links

Output strict JSON:
{"title": str?, "post_text": str, "source_links": [str], "notes": str?, "risk_flags": [str]}
```

### 8.4 Rewrite prompt input

```text
SYSTEM: same as draft.
USER:
Current text:
{current_text}

Instruction: {instruction}
News context: {title + source}

Output JSON: same schema as draft.
```

## 9. Two-language strategy

Один LLM (DeepSeek 3.2), два набора промптов: `ru` и `en` шаблоны в `packages/ai/prompts/`.

Если `target_language=ru` и `news.language=en` — system-промпт добавляет: "Source is in English, write the post in Russian. Translate accurately, don't paraphrase the facts."

Translation выполняется самой моделью; отдельный translation-провайдер не нужен.

## 10. Fallback strategy

Source of truth: `AI_FALLBACK_TO_TEMPLATE=true` (env, default).

Когда срабатывает fallback:
- LLM endpoint 5xx после `max_attempts` retry;
- output JSON не распарсился после repair-attempt;
- content refused by safety filter (`risk_flags=['refused']`);
- cost guard блокирует (task → `deferred`, не fallback);
- network timeout после `max_attempts`.

Fallback action:
- Score: `score=5.0`, `relevance_reason="LLM unavailable, candidate based on source"`, `should_create_draft=false`, `risk_flags=['fallback']`.
- Draft: Format A template из title + summary + URL.

UI помечает такие drafts badge'ом "no AI" — пользователь понимает, что нужно отредактировать вручную.

## 11. Cost control

Pipeline для экономии:
- **cheap pre-filter**: keyword + negative_keyword match;
- **embedding pre-score**: cosine similarity (дёшево, ~250 токенов);
- **LLM scoring** только если cosine > MATCHING_MIN_COSINE;
- **LLM draft** только если `score >= AUTO_DRAFT_SCORE_THRESHOLD`;
- **LLM rewrite** — по user-request, всегда (с cost guard).

Cost guard per workspace per day — см. `11-AI-PROVIDER.md` §10. Tasks → `deferred` при превышении.

## 12. Anti-hallucination rules

Промпт обязательно содержит:
- "use only provided source text";
- "if source is insufficient, state uncertainty";
- "never invent statistics, dates, names";
- "never claim official confirmation unless source uses that language";
- "no medical/financial/legal guarantees";
- "include source URL in output".

Post-validation:
- `risk_flags` non-empty → UI badge "AI flagged: ...";
- если URL отсутствует в output — fallback на template.

## 13. Refused content path

Если LLM отказал (safety filter):
- `workspace_news_matches.status='ai_refused'`;
- `risk_flags=['refused']`, score=null;
- draft не генерируется автоматически;
- UI: badge "AI отказал в анализе", user может сам сделать draft вручную.

## 14. Embedding pipeline

См. `06-WORKERS-AND-INGESTION.md` §11.2 для full flow.

Кратко:
- `embed_news_item` task получает embedding для `extracted_text` (или title+summary если text отсутствует);
- `recompute_topic_embedding` task — для topic_profile при `UpdateTopicProfileCommand`;
- query embeddings (`text-search-query`) используются при матчинге.

Embedding model: `text-search-doc/latest` для документов, `text-search-query/latest` для запросов. Dim=256.

## 15. Observability

Каждый AI-вызов пишется в `ai_usage_events`:
- workspace_id, user_id, task_id;
- action_type (score / generate / rewrite / embed);
- model, prompt_version;
- input_tokens, output_tokens;
- cost_rub;
- duration_ms;
- status (success / failed / refused / parse_error / fallback);
- error_message.

См. дашборд-запросы в `11-AI-PROVIDER.md` §11.

## 16. Future improvements

После MVP можно добавить:
- channel style learning через embeddings прошлых постов канала;
- source reputation scoring через user-actions (publish vs reject);
- semantic dedup на cluster-level (а не item-level);
- saved research prompts (user prompt → recurring task);
- autopublish для trusted sources + high score (Phase MVP+1);
- multi-language workspace (RU + EN канал одновременно);
- per-channel A/B testing prompt versions.
