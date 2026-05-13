# Product Spec: Telegram MVP

## 1. Product name placeholder

Рабочее название: **Signal Radar** / **Content Radar** / **Radar AI**.

Название можно поменять позже. В коде не хардкодить бренд в доменной модели.

## 2. One-liner

AI-радар инфоповодов для Telegram-каналов: находит новости по теме, оценивает важность, пишет черновики постов и публикует после одобрения.

## 3. Первый ICP

Первый сегмент:
- владельцы Telegram-каналов про AI, IT, стартапы, dev tools, vibe coding;
- SMM-специалисты, ведущие несколько каналов;
- маленькие нишевые медиа.

Почему этот ICP:
- новости нужны каждый день;
- аудитория понимает AI;
- можно быстро проверить ценность;
- Telegram-first UX для них естественный.

## 4. Главная боль

Владельцу канала нужно регулярно:
- искать инфоповоды;
- фильтровать мусор;
- читать источники;
- понимать, что важно;
- писать пост;
- публиковать.

Это занимает время и требует дисциплины.

## 5. Решение

Система делает:
- source monitoring;
- deduplication;
- relevance scoring;
- draft generation;
- quick editing;
- Telegram publishing.

## 6. MVP value proposition

```text
Каждый день получай готовые посты из лучших инфоповодов по твоей теме. Ты только проверяешь, редактируешь и публикуешь.
```

## 7. MVP user roles

### Owner
- создаёт workspace;
- подключает канал;
- настраивает источники;
- публикует;
- меняет темы.

### Member / Editor
- смотрит новости;
- редактирует черновики;
- может публиковать, если разрешено.

Для MVP можно реализовать owner-only, но schema должна позволять роли.

## 8. MVP screens

Mini App:
- Radar / Новости;
- Drafts / Черновики;
- Sources / Источники;
- Channel / Канал;
- Settings / Настройки.

Bot:
- `/start`;
- open Mini App;
- notify about new high-score drafts;
- quick buttons later.

## 9. MVP feature list

### Account
- Telegram identity linking;
- workspace creation;
- owner role.

### Channel
- connect Telegram channel;
- verify bot admin rights;
- save channel connection.

### Topics
- add topics;
- add keywords;
- add negative keywords;
- language;
- tone settings.

### Sources
- RSS source;
- manual URL source;
- official blog source;
- source enable/disable.

### Radar
- list news candidates;
- score;
- relevance reason;
- source;
- status.

### Draft
- generate AI draft;
- edit manually;
- rewrite buttons;
- save version;
- publish.

### Publishing
- safe backend publish;
- operation log;
- publish event.

## 10. Out of scope for MVP

- autoposting without approval;
- Telegram channel scraping;
- multi-platform publishing;
- billing/subscriptions;
- full analytics;
- team management beyond basic schema;
- white-label bot;
- complex scheduling;
- research agent prompt search.

## 11. Core metrics

- number of connected channels;
- sources per workspace;
- news found per day;
- high-score matches per day;
- drafts generated;
- drafts edited;
- drafts published;
- rejected drafts;
- time from news found to post published;
- day-7 retention.

## 12. Quality bar

MVP is successful if:
- user can connect a channel without developer help;
- user sees relevant news;
- at least 20–40% generated drafts are good enough to edit/publish;
- publishing is safe and reliable;
- no workspace can affect another workspace.
