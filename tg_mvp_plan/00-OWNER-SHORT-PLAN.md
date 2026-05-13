# Короткий план для владельца проекта

## Что мы делаем

Мы делаем Telegram-first MVP продукта:

> AI-радар инфоповодов для Telegram-каналов.

Он помогает владельцам каналов и SMM-специалистам:
- находить новости по теме;
- оценивать важность новости;
- видеть объяснение score;
- получать AI-черновик поста;
- быстро редактировать его;
- публиковать в свой Telegram-канал.

## Как пользователь будет это видеть

Пользователь открывает Telegram-бота, нажимает кнопку “Открыть панель”, открывается Mini App.

В Mini App есть:
- Радар — найденные новости;
- Черновики — готовые посты;
- Источники — RSS/сайты/API;
- Канал — подключение Telegram-канала;
- Настройки — темы, стиль, лимиты.

## Главный flow

1. Пользователь пишет `/start` боту.
2. Открывает Mini App.
3. Создаёт workspace.
4. Задаёт темы канала.
5. Добавляет источники.
6. Добавляет нашего бота админом в канал.
7. Система ищет новости.
8. Mini App показывает новости со score.
9. Пользователь открывает новость.
10. AI показывает черновик поста.
11. Пользователь редактирует.
12. Нажимает “Опубликовать”.
13. Backend проверяет права и публикует в канал.

## Главная архитектурная идея

Не делаем “бот, который всё хранит в Telegram”.

Делаем:

```text
Telegram Bot + Mini App = интерфейс
Backend + DB + Workers = настоящий продукт
```

## Почему архитектура расширяемая

Сразу закладываем:
- `content_channel`, а не `telegram_channel` как core-сущность;
- `channel_adapter`, а не Telegram-only логику везде;
- source-centric ingestion;
- worker pool;
- command layer;
- policy checks;
- operation log;
- draft versions.

Поэтому потом можно добавить:
- VK;
- Discord;
- web dashboard;
- research agent;
- автопостинг;
- платные тарифы;
- agency accounts;
- white-label bots.

## Этапы разработки

### Этап 0 — Foundation
Что будет сделано:
- структура проекта;
- env config;
- база данных;
- базовые сущности;
- health check;
- coding rules.

Clear checkpoint:
- проект запускается;
- БД подключена;
- миграции работают;
- есть базовая структура модулей.

### Этап 1 — Telegram identity + workspace
Что будет сделано:
- Telegram Bot `/start`;
- Mini App opening;
- проверка Telegram WebApp initData;
- user/workspace;
- workspace membership;
- базовая auth.

Clear checkpoint:
- пользователь открывает Mini App из бота;
- backend понимает, кто это;
- создаётся workspace.

### Этап 2 — Channel connection
Что будет сделано:
- подключение Telegram-канала;
- connect code;
- проверка прав бота в канале;
- `content_channel` и `channel_connection`.

Clear checkpoint:
- пользователь может подключить канал;
- канал виден в Mini App;
- backend знает `chat_id` и workspace.

### Этап 3 — Sources and topics
Что будет сделано:
- topics;
- sources;
- workspace_source_subscription;
- UI для источников и тем.

Clear checkpoint:
- пользователь задаёт темы;
- добавляет RSS/manual источники;
- данные сохраняются.

### Этап 4 — Global ingestion workers
Что будет сделано:
- task system;
- worker pool;
- source fetch locks;
- global_news_items;
- news_clusters basic dedupe.

Clear checkpoint:
- backend сам проверяет источники;
- новости появляются в общей базе;
- один источник не fetch'ится параллельно дважды.

### Этап 5 — Matching and scoring
Что будет сделано:
- matching global news под workspace;
- score 1–10;
- relevance reason;
- workspace_news_match;
- экран Radar.

Clear checkpoint:
- пользователь видит новости, подходящие его темам;
- у каждой новости есть score и объяснение.

### Этап 6 — Draft generation and editor
Что будет сделано:
- AI draft generation;
- post_drafts;
- post_draft_versions;
- редактор в Mini App;
- AI-кнопки: короче, экспертнее, проще, убрать воду.

Clear checkpoint:
- пользователь открывает новость;
- видит черновик;
- редактирует;
- создаются версии.

### Этап 7 — Safe publishing
Что будет сделано:
- PublishPostCommand;
- policy check;
- Telegram adapter publish;
- publish_events;
- operation_log;
- UI кнопка “Опубликовать”.

Clear checkpoint:
- пользователь публикует пост в свой канал;
- нельзя опубликовать чужой draft;
- все действия логируются.

### Этап 8 — MVP polish
Что будет сделано:
- статусы;
- обработка ошибок;
- empty states;
- базовые лимиты;
- fallback при AI failure;
- UX улучшения.

Clear checkpoint:
- MVP можно дать первым 10–30 пользователям.

## Что не делаем до первой версии

- полный автопостинг;
- сложная оплата;
- парсинг Telegram-каналов;
- VK/Discord;
- агентский research prompt;
- white-label;
- сложная аналитика.

## Главный критерий успеха MVP

Пользователь должен за 5 минут получить пост, который не стыдно отправить в канал.

Главная метрика:

> сколько AI-черновиков реально публикуется.
