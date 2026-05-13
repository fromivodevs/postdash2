# Edge Cases Catalog

Каталог обработки нестандартных и граничных ситуаций. Используется при code review каждой фазы roadmap и при написании integration tests.

Формат каждой записи:
- **Case** — что происходит;
- **Behavior** — ожидаемая реакция системы;
- **Phase** — фаза, в которой внедряется обработка.

Кейсы, помеченные **Out of MVP**, осознанно отложены — см. секцию 14 и `10-FUTURE-EXPANSION.md`.

---

## 1. Identity и auth

### 1.1 Expired initData
- **Case**: пользователь открыл Mini App из старой ссылки.
- **Behavior**: backend проверяет `auth_date` < 24h; иначе 401 + UX "переоткрой бота".
- **Phase**: 1.

### 1.2 Replay-атака initData
- **Case**: третье лицо перехватило initData.
- **Behavior**: проверка `auth_date` + HMAC-signature от bot token. MVP не вводит nonce.
- **Phase**: 1.

### 1.3 Telegram username/имя изменились
- **Case**: user переименовался.
- **Behavior**: на каждом `/auth/telegram` обновлять `telegram_identities.username/first_name/last_name`.
- **Phase**: 1.

### 1.4 User заблокировал бота
- **Case**: бот более не может слать сообщения user'у.
- **Behavior**: на 403 от sendMessage → `telegram_identities.status='blocked_bot'`. Не пытаться слать. Surface в Mini App баннером.
- **Phase**: 1+.

### 1.5 Mini App открыт вне Telegram
- **Case**: URL открыт в обычном браузере.
- **Behavior**: initData отсутствует → 401 + landing-page "открой бота".
- **Phase**: 1.

### 1.6 User имеет несколько TG-аккаунтов
- **Case**: разные telegram_user_id у одного человека.
- **Behavior**: каждый telegram_user_id → отдельный internal `user`. Слияние аккаунтов — out of MVP.
- **Phase**: 1.

### 1.7 Race: одновременное создание workspace
- **Case**: double-click на "Создать workspace".
- **Behavior**: `idempotency_key` на `CreateWorkspaceCommand`. Второй вызов возвращает существующий результат.
- **Phase**: 1.

### 1.8 IAM-token expired
- **Case**: Yandex IAM-токен протух.
- **Behavior**: refresh-loop в worker; force-refresh + retry один раз при 401.
- **Phase**: 0.

---

## 2. Workspace

### 2.1 User в нескольких workspaces
- **Case**: user — member двух+ workspaces.
- **Behavior**: `users.last_active_workspace_id` хранит default. UI MVP — один workspace per user, switcher позже.
- **Phase**: 1 (поле), 8+ (UI).

### 2.2 User удалён из workspace mid-session
- **Case**: owner удалил editor, у того Mini App открыт.
- **Behavior**: каждый API-запрос проверяет membership. Если revoked → 403 + redirect.
- **Phase**: 1+.

### 2.3 Workspace disabled
- **Case**: workspace помечен `status='disabled'`.
- **Behavior**: все commands → 403. Read-only access к истории — out of MVP.
- **Phase**: 1+.

---

## 3. Channel connection

### 3.1 Бот admin без post-permission
- **Case**: user добавил, но не дал право постить.
- **Behavior**: `verifyConnection` через `getChatMember`; `can_post_messages=false` → 400 "бот без права постить".
- **Phase**: 2.

### 3.2 Бота сняли с admin
- **Case**: между connect и publish бота лишили прав.
- **Behavior**: re-check прав в `PublishPostCommand`. Fail с clear UX.
- **Phase**: 7.

### 3.3 Канал уже подключён к другому workspace
- **Case**: попытка connect занятого канала.
- **Behavior**: UNIQUE `(platform, external_id)` на `channel_connections` → 409. UI: "канал занят другим workspace".
- **Phase**: 2.

### 3.4 Connect code истёк
- **Case**: TTL прошёл.
- **Behavior**: 410 + "создай новый".
- **Phase**: 2.

### 3.5 Connect code использован дважды
- **Case**: повтор кода.
- **Behavior**: `status='used'` после первого. Вторая попытка → 409.
- **Phase**: 2.

### 3.6 Channel migrated to supergroup
- **Case**: chat_id сменился.
- **Behavior**: webhook `migrate_from_chat_id` → обновить `channel_connections.external_id`. **Out of MVP**, документируется manual reconnect.
- **Phase**: 8+.

### 3.7 Канал удалён владельцем
- **Case**: канал deleted.
- **Behavior**: publish получит 400 от Telegram → `channel_connections.status='broken'`. UI: баннер.
- **Phase**: 7+.

### 3.8 Private channel
- **Case**: канал приватный, бот в нём admin.
- **Behavior**: работает (бот публикует). Документировать.
- **Phase**: 2.

---

## 4. Source ingestion

### 4.1 Invalid RSS XML / 404 / 5xx
- **Case**: feed сломан.
- **Behavior**: retry с exponential backoff (`max_attempts=3`). После — `source.status='error'`, `last_fetch_error` сохраняется, surface в UI.
- **Phase**: 4.

### 4.2 Feed обновил существующий item
- **Case**: статья переиздана с правками.
- **Behavior**: recompute `content_hash`. Если изменилось существенно (text similarity < 0.9) — update, флаг `was_updated=true`, optional re-score. Иначе skip.
- **Phase**: 4.

### 4.3 Feed flood (500 items на первом fetch)
- **Case**: новый источник отдал большую историю.
- **Behavior**: `max_items_per_fetch` (env, default 50). Остаток `status='skipped_volume_cap'`, забирается следующими тиками. Сорт по `published_at desc`.
- **Phase**: 4.

### 4.4 Пустой feed
- **Case**: 0 items.
- **Behavior**: успешный fetch, `last_fetched_at` обновляется. Без шума.
- **Phase**: 4.

### 4.5 Та же новость в нескольких источниках
- **Case**: 5 источников опубликовали один event.
- **Behavior**: embedding-based dedup (cosine < `AI_DEDUPE_COSINE_THRESHOLD`) в окне `AI_DEDUPE_WINDOW_HOURS`. Линкуются в один `news_cluster`. Workspace matching — по cluster_id.
- **Phase**: 4–5.

### 4.6 Разные URL-формы того же source
- **Case**: `https://example.com/post/1?utm=x` и `https://example.com/post/1`.
- **Behavior**: canonicalization rules одинаковые → одинаковый `canonical_url`. Один global source, разные subscriptions.
- **Phase**: 3.

### 4.7 Redirect chain
- **Case**: `bit.ly/x` → `medium.com/y`.
- **Behavior**: resolve один раз при создании source; хранить final canonical. В каждый fetch не следуем.
- **Phase**: 3.

### 4.8 Paywalled / login-required content
- **Case**: extract_text не доступен.
- **Behavior**: fallback на title + summary из RSS metadata. `extracted_text=null`. Don't fail.
- **Phase**: 4.

### 4.9 Site блокирует bot UA
- **Case**: 403 Cloudflare.
- **Behavior**: используем разумный UA (с email-контактом). Без обхода. После 3 fails source помечается `error`.
- **Phase**: 4.

### 4.10 Embedding API failure
- **Case**: Yandex embeddings 5xx.
- **Behavior**: `global_news_items.embedding_status='failed'`. News доступна без semantic dedup. Janitor retry'ит позже.
- **Phase**: 4.

### 4.11 Source URL с query-параметром даты
- **Case**: `https://news.example/today?date=2026-05-13`.
- **Behavior**: canonicalization включает `date` если он стабилизирует контент. Документируй edge — добавь override в `packages/sources/canonicalize.ts`.
- **Phase**: 3.

---

## 5. Topic profile и matching

### 5.1 Пустые topics + keywords
- **Case**: user не задал темы.
- **Behavior**: warning баннер "добавь темы — радар пустой". Match-job skips workspace.
- **Phase**: 5.

### 5.2 Topic изменён
- **Case**: user обновил `topic_profile`.
- **Behavior**: MVP forward-only — ранее matched news не пересчитываются. Документируется в UI.
- **Phase**: 5.

### 5.3 Negative keyword vs high score
- **Case**: новость со score 9, но содержит negative keyword.
- **Behavior**: hidden, `workspace_news_matches.status='filtered_negative'`. Не показывать в Radar.
- **Phase**: 5.

### 5.4 Много topic_profiles per workspace
- **Case**: schema допускает много, UI ограничен одним.
- **Behavior**: MVP — один default profile per workspace. Прочее ignored. Документируется.
- **Phase**: 3.

### 5.5 News mixed language
- **Case**: title RU, body EN.
- **Behavior**: cyrillic-vs-latin heuristic по title для `global_news_items.language`. Embedding генерируется по полному тексту (Yandex model handles both).
- **Phase**: 4.

### 5.6 Topic-profile embedding не пересчитан после изменения
- **Case**: user изменил темы, эмбеддинг профиля устарел.
- **Behavior**: при `UpdateTopicProfileCommand` → enqueue `recompute_topic_embedding` task.
- **Phase**: 5.

### 5.7 Одна новость из нескольких источников → дубль в Radar
- **Case**: cluster содержит 5 `news_items` (одна история из 5 источников), workspace подписан на все 5 → потенциально 5 entries в `workspace_news_matches`.
- **Behavior**: matching на cluster-level (см. `06-WORKERS-AND-INGESTION.md §12.1`). Partial unique `(workspace_id, cluster_id) WHERE cluster_id IS NOT NULL` защищает на DB-уровне. В Radar — одна карточка с pointer на main_url (highest reliability_score).
- **Phase**: 5.

### 5.8 Cluster пополнился новым source после matching
- **Case**: первая новость в cluster'е уже scored для workspace, потом приходит та же история из шестого источника.
- **Behavior**: `workspace_news_matches` остаётся одна (идемпотентно), `news_clusters.sources_count` инкрементируется. Re-score НЕ запускается. UI может показать badge "+1 source".
- **Phase**: 5.

### 5.9 Re-score после промпт-апгрейда
- **Case**: deployed new `score@v1.1`, хочется backfill для последних 7 дней.
- **Behavior**: explicit admin-task `rescore_recent` принимает `prompt_version` и `days`. Не auto. В MVP кнопка не выставлена; SQL-job вручную.
- **Phase**: 8+.

---

## 6. AI scoring

### 6.1 Invalid JSON output
- **Case**: DeepSeek вернул сломанный JSON.
- **Behavior**: один repair-prompt attempt; иначе TemplateProvider (score=5, draft=Format A).
- **Phase**: 5–6.

### 6.2 Score out of range
- **Case**: модель вернула 12 или -1.
- **Behavior**: clamp [0..10]. Log anomaly в `ai_usage_events.payload_summary`.
- **Phase**: 5.

### 6.3 Content refused by safety filter
- **Case**: модель отказала.
- **Behavior**: `risk_flags=['refused']`, score=null, draft не генерируется, news хранится со статусом `ai_refused`. UI показывает badge.
- **Phase**: 5–6.

### 6.4 Двойной scoring одного item
- **Case**: scoring job снова запускается на уже scored news.
- **Behavior**: `workspace_news_matches` UNIQUE `(workspace_id, news_item_id)`. Re-score только при explicit user-trigger.
- **Phase**: 5.

### 6.5 Embedding dim mismatch
- **Case**: provider вернул вектор не той размерности.
- **Behavior**: validate length == `AI_EMBEDDING_DIM` (256). Reject, log, don't crash worker. Task → `failed_permanent` после max attempts.
- **Phase**: 4.

### 6.6 Cost cap reached during scoring
- **Case**: workspace исчерпал AI бюджет на день.
- **Behavior**: scoring tasks → `deferred`. UI: баннер "AI лимит до 00:00 UTC".
- **Phase**: 6.

---

## 7. Draft и rewrite

### 7.1 Source text слишком короткий
- **Case**: < 50 chars (только title).
- **Behavior**: TemplateProvider fallback. UX: "источник без deep-контента".
- **Phase**: 6.

### 7.2 Source text слишком длинный
- **Case**: > 32k токенов.
- **Behavior**: truncate до 8k токенов (выбор: первые + последние chunks + summary). Don't fail.
- **Phase**: 6.

### 7.3 Сломанное форматирование
- **Case**: модель вернула `*bold` без закрытия.
- **Behavior**: validate через telegram-entity-parser перед сохранением версии. Auto-clean (escape `*`, `_`, `[`, `]`) или fallback на plain. Не сохранять broken текст.
- **Phase**: 6.

### 7.4 Concurrent rewrite на одном draft
- **Case**: два rewrite-task'а одновременно.
- **Behavior**: `post_drafts.status='rewriting'` блокирует. Второй → 409 "rewrite уже идёт".
- **Phase**: 6.

### 7.5 Manual edit пока rewrite в queue
- **Case**: user сохранил v3, AI rewrite (snapshot v2) завершился позже.
- **Behavior**: AI создаёт v4 на основе v2. `current_version_id` остаётся на v3 (manual). UI показывает обе, user выбирает.
- **Phase**: 6.

### 7.6 Three-variants rewrite
- **Case**: `instruction='three_variants'`.
- **Behavior**: одна task создаёт 3 версии. `current_version_id=null` до выбора user. UI показывает все 3 со swipe.
- **Phase**: 6.

### 7.7 Edit после publish
- **Case**: post опубликован, user хочет править.
- **Behavior**: published drafts read-only. "Edit" создаёт новый `post_drafts` row, опционально `parent_draft_id`. Не вызываем Telegram `editMessage` в MVP.
- **Phase**: 7+.

### 7.8 Preview mismatch
- **Case**: preview в Mini App рендерится иначе, чем Telegram.
- **Behavior**: общий parser в `packages/shared/telegram-format.ts`. Preview и backend используют один и тот же код.
- **Phase**: 6–7.

### 7.9 Rewrite после publish
- **Case**: user пытается rewrite опубликованный draft.
- **Behavior**: 409 "draft published, create new from same news".
- **Phase**: 6–7.

---

## 8. Publishing

### 8.1 Double-click "Опубликовать"
- **Case**: user дабл-кликнул.
- **Behavior**: `idempotency_key` на `PublishPostCommand`. Второй вызов возвращает результат первого через `command_idempotency` таблицу.
- **Phase**: 7.

### 8.2 Network failure mid-publish
- **Case**: Telegram API получил вызов, ответ потерян.
- **Behavior**:
  1. `INSERT INTO publish_events (status='pending', idempotency_key)` ДО Telegram-call.
  2. Call Telegram API.
  3. `UPDATE publish_events SET status='success'/'failed', external_message_id=...`.
  4. Janitor: pending older than 5min → `status='unknown'`, surface в UI для manual review.
- **Phase**: 7.

### 8.3 Telegram rate-limit 429
- **Case**: канал hit rate-limit.
- **Behavior**: Telegram возвращает `retry_after`; worker ждёт указанное время и retry.
- **Phase**: 7.

### 8.4 Telegram entity parse error
- **Case**: 400 от Telegram, broken formatting.
- **Behavior**: `publish_events.status='failed'`, `error_message='telegram_400_entities'`. UI: "формат поста сломан".
- **Phase**: 7.

### 8.5 Cross-workspace publish attempt
- **Case**: malicious frontend пытается опубликовать чужой draft в свой channel.
- **Behavior**: policy-check: `draft.workspace_id == channel.workspace_id == user.workspace`. **Integration-test обязателен** в Phase 7.
- **Phase**: 7.

### 8.6 Publish после потери admin
- **Case**: между scheduling и execute бота сняли.
- **Behavior**: re-check `can_post_messages` в `PublishPostCommand`. Fail с clear UX.
- **Phase**: 7.

### 8.7 Publish в read-only channel
- **Case**: канал переведён в slow-mode или admin-only.
- **Behavior**: Telegram 400, mark `channel_connections.status='broken'`, surface UI.
- **Phase**: 7.

### 8.8 Multi-target publish
- **Case**: один draft в несколько каналов.
- **Behavior**: **Out of MVP**. partial unique `(post_draft_id) WHERE status='success'` enforces.
- **Phase**: 7.

### 8.9 Publish empty / too long
- **Case**: text пустой или > 4096 chars (Telegram message limit).
- **Behavior**: client-side + server-side validation перед send. 400 с указанием поля.
- **Phase**: 6–7.

---

## 9. Task system

### 9.1 Worker crash mid-task
- **Case**: worker умер после lock'а.
- **Behavior**: `locked_until` timestamp. Janitor: `WHERE locked_until < now() AND status='running'` → reset to `pending`, increment `attempts`.
- **Phase**: 4.

### 9.2 Race: два worker'а взяли одну task
- **Case**: concurrent poll.
- **Behavior**:
  ```sql
  UPDATE tasks
  SET status='running', locked_by=$worker, locked_until=now() + interval '5 min'
  WHERE id=$1 AND status='pending'
  RETURNING *;
  ```
  Только один worker получит RETURNING-row.
- **Phase**: 4.

### 9.3 Duplicate fetch task
- **Case**: scheduler два раза создал fetch_source.
- **Behavior**: partial UNIQUE index `tasks (source_id) WHERE type='fetch_source' AND status IN ('pending','running')`.
- **Phase**: 4.

### 9.4 Стабильно фейлится
- **Case**: 3 attempts, одна и та же ошибка.
- **Behavior**: `status='failed_permanent'`. Surface в admin/log. Не retry'ить далее без manual.
- **Phase**: 4.

### 9.5 Stuck source_fetch_lock
- **Case**: предыдущий worker умер с lock'ом источника.
- **Behavior**: janitor освобождает по `locked_until`. Параллельно — основная защита через `tasks` partial unique.
- **Phase**: 4.

### 9.6 Priority inversion
- **Case**: 10 fetch-tasks забили worker pool, rewrite (priority=90) ждёт.
- **Behavior**: `ORDER BY priority DESC, scheduled_at ASC`. With concurrency=10, fetch-tasks обычно быстрые (1-5s). Если станет узким — split worker pools (Phase 8+).
- **Phase**: 4–8.

### 9.7 Deferred tasks (cost cap)
- **Case**: AI бюджет исчерпан, tasks отложены.
- **Behavior**: `status='deferred'`. Cron на 00:00 UTC промотирует deferred → pending.
- **Phase**: 6.

### 9.8 Scheduled tasks pile-up на старте
- **Case**: после downtime scheduler создал много backfill-tasks.
- **Behavior**: scheduler видит `last_fetched_at` и не создаёт historic gap'ы. Если source давно не fetched — один fetch с current state, не серия catch-up.
- **Phase**: 4.

---

## 10. Cost guard

### 10.1 Cap превышен mid-day
- **Case**: workspace потратил daily limit.
- **Behavior**: новые AI-tasks → `deferred`. UI: баннер с countdown до 00:00 UTC.
- **Phase**: 6.

### 10.2 Cap reset window confusion
- **Case**: user в UTC+5 не понимает "завтра 00:00 UTC".
- **Behavior**: UI показывает "next reset in Xh Ym" relative. Per-timezone — out of MVP.
- **Phase**: 6.

### 10.3 Cost spike от длинного контента
- **Case**: один draft съел половину бюджета.
- **Behavior**: `YA_LLM_MAX_TOKENS=2000` на output. Input ограничен truncation до 8k tokens.
- **Phase**: 6.

### 10.4 Pricing change
- **Case**: Yandex изменил тариф.
- **Behavior**: env-vars `AI_*_RUB_PER_1M_TOKENS` обновляются deploy'ем. Historical `ai_usage_events.cost_rub` остаётся как было.
- **Phase**: 6.

### 10.5 Embedding cost накапливается
- **Case**: тысячи новостей emb'ятся ежедневно.
- **Behavior**: embeddings НЕ в cap (дёшевы), но логируются. Monitoring через `ai_usage_events` daily sum.
- **Phase**: 4.

### 10.6 Race: одновременное обновление spent_rub
- **Case**: два worker'а одновременно увеличивают `spent_rub`.
- **Behavior**: `UPDATE ai_budget_state SET spent_rub = spent_rub + $1 WHERE workspace_id=$2 AND day=$3` — atomic. Не блокирующий read.
- **Phase**: 6.

---

## 11. Embeddings и dedupe

### 11.1 Cluster grows huge
- **Case**: viral story, 50 источников.
- **Behavior**: cluster содержит все items. UI top-1 по `source.reliability_score`, остальные collapsed. Хранение OK (256-dim векторы дешёвые).
- **Phase**: 5.

### 11.2 Mixed-language news
- **Case**: title RU, body EN.
- **Behavior**: embedding на полном тексте. `language` detection по title.
- **Phase**: 4.

### 11.3 Identical reposts с разным wording
- **Case**: rephrased news.
- **Behavior**: cosine < `AI_DEDUPE_COSINE_THRESHOLD` → same cluster. Threshold tunable.
- **Phase**: 4.

### 11.4 Embedding daily quota hit
- **Case**: Yandex quota exhausted.
- **Behavior**: tasks retry в следующем часе. Документируется квота в monitoring.
- **Phase**: 4.

### 11.5 Old news без embedding после feature deploy
- **Case**: до Phase 4 news были без embedding.
- **Behavior**: backfill-task: enqueue embed для всех `embedding IS NULL` (rate-limited).
- **Phase**: 4.

### 11.6 Cluster cross-language merge
- **Case**: одна новость на RU и EN.
- **Behavior**: Yandex embeddings робастны к языку — cluster merge работает. Документируй.
- **Phase**: 4–5.

---

## 12. Notifications

### 12.1 Duplicate notification
- **Case**: scheduled job дважды сработал.
- **Behavior**: `notification_events` UNIQUE `(workspace_id, user_id, kind, related_object_id)`.
- **Phase**: 8.

### 12.2 Bot blocked при notify
- **Case**: 403 sendMessage.
- **Behavior**: `notification_events.status='blocked'`. Метим `telegram_identities.status='blocked_bot'`. Не пытаемся retry.
- **Phase**: 8.

### 12.3 Quiet hours
- **Case**: уведомление в 3am user-time.
- **Behavior**: MVP не делает quiet hours. Auto-notify opt-in, default off.
- **Phase**: 8.

### 12.4 Notification flood
- **Case**: 20 high-score новостей за час.
- **Behavior**: coalesce: "5 новых high-score за час". Throttle: не более 1 notification / workspace / 30min.
- **Phase**: 8.

### 12.5 Deep-link target deleted
- **Case**: notification ссылается на draft, который user удалил.
- **Behavior**: Mini App открывается, видит missing target → graceful "draft no longer available" + redirect в Drafts list.
- **Phase**: 8.

---

## 13. UI / Mini App

### 13.1 Stale cache после deploy
- **Case**: user видит старый Mini App build.
- **Behavior**: URL `?v=<commit-sha>` в `web_app.url` при отправке кнопок. Cache-bust автоматический.
- **Phase**: 8.

### 13.2 Slow network на mobile
- **Case**: 3G.
- **Behavior**: optimistic UI для edit, retry в фоне. Publish — без optimistic, clear "publishing..." state.
- **Phase**: 6+.

### 13.3 Dark/light theme
- **Case**: Telegram theme переключился.
- **Behavior**: использовать `themeParams` из Telegram WebApp SDK. Поддержать оба с Phase 1.
- **Phase**: 1.

### 13.4 iOS viewport bug
- **Case**: keyboard перекрывает textarea.
- **Behavior**: вызывать `WebApp.expand()`. Listener на viewport resize.
- **Phase**: 6.

### 13.5 Mini App offline
- **Case**: user без сети.
- **Behavior**: offline indicator. Disable mutation buttons. Don't queue mutations локально (избегаем "did I publish?" вопроса).
- **Phase**: 8.

### 13.6 Multi-workspace switcher
- **Case**: user в нескольких workspace.
- **Behavior**: MVP — один workspace в UI. Field `last_active_workspace_id` уже в БД. Switcher позже.
- **Phase**: 1 (field), 8+ (UI).

### 13.7 Deep-link к draft из notification
- **Case**: notification ведёт сразу в редактор.
- **Behavior**: `web_app.url?startapp=draft_<id>`. Mini App читает param и open editor. Если target deleted — graceful fallback.
- **Phase**: 8.

### 13.8 Deep-link connect-code
- **Case**: user шарит код через t.me-ссылку.
- **Behavior**: `https://t.me/<bot>?start=connect_<code>`. Bot `/start` парсит payload, открывает Mini App с кодом prefilled.
- **Phase**: 2.

### 13.9 Long text в textarea
- **Case**: пост 3000+ chars.
- **Behavior**: показывать counter "X / 4096". Подсветка красным при превышении. Disable publish.
- **Phase**: 6.

### 13.10 Bot rate-limit касается user
- **Case**: user заспамил `/start` 50 раз.
- **Behavior**: bot middleware rate-limit (10 msg/min/user). Игнорировать сверх лимита.
- **Phase**: 1.

---

## 14. Что не покрываем в MVP

Эти кейсы видимы, но осознанно отложены:

- nonce-based replay protection (поверх базового `auth_date`);
- авто-revalidate historical matches при изменении topic_profile;
- multi-channel publish одного draft;
- автоматический quiet-hours по timezone user'а;
- self-healing crash window для publish_events (только manual review);
- RLS на Postgres (доверяем application policy layer + integration tests);
- soft delete для workspace / sources с восстановлением;
- transactional outbox для `domain_events`;
- per-source circuit breaker (manual disable вместо);
- channel migration to supergroup auto-update (рекомендация: manual reconnect);
- account merge между двумя telegram_user_id у одного человека;
- цензурирование/блокировка по политикам контента (только LLM-side safety).

Каждый перенесённый кейс — в `10-FUTURE-EXPANSION.md` (или будет добавлен туда, если станет критичным).

---

## 15. Edge cases checklist per phase

Используется как acceptance criteria перед commit'ом фазы.

### Phase 1
- 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 13.3, 13.10.

### Phase 2
- 3.1, 3.3, 3.4, 3.5, 3.8, 13.8.

### Phase 3
- 4.6, 4.7, 4.11, 5.4.

### Phase 4
- 4.1, 4.2, 4.3, 4.4, 4.5, 4.8, 4.9, 4.10, 5.5, 6.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.8, 10.5, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6.

### Phase 5
- 5.1, 5.2, 5.3, 5.6, 5.7, 5.8, 6.1, 6.2, 6.3, 6.4.

### Phase 6
- 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8, 7.9, 9.7, 10.1, 10.2, 10.3, 10.4, 10.6, 13.2, 13.4, 13.9.

### Phase 7
- 3.2, 3.7, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.9.

### Phase 8
- 3.6, 12.1, 12.2, 12.3, 12.4, 12.5, 13.1, 13.5, 13.6, 13.7.
