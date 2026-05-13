# Telegram Bot and Mini App UX

## 1. Product structure

MVP consists of:
- one common Telegram bot for all users;
- Telegram Mini App opened from the bot;
- backend API;
- connected Telegram channels where posts are published.

## 2. Bot role

The bot is not the full product. It is the entry point and notification layer.

Bot responsibilities:
- `/start` onboarding;
- open Mini App button;
- notify about new high-score drafts;
- support channel connection flow;
- later quick approve/reject buttons.

Bot must not:
- store state locally;
- decide permissions;
- publish without backend command;
- trust callback data without backend verification.

## 3. Bot commands MVP

### /start

Message:

```text
Привет! Я AI-радар инфоповодов для Telegram-каналов.

Я нахожу новости по твоим темам, оцениваю важность и готовлю посты на публикацию.

Нажми кнопку ниже, чтобы открыть панель.
```

Buttons:
- `Открыть панель`

### /help

Message:

```text
Как это работает:
1. Открой панель
2. Задай темы
3. Подключи источники
4. Добавь бота админом в канал
5. Получай черновики постов
6. Публикуй после проверки
```

### /connect

Optional shortcut to channel connection instructions.

### /start с deep-link payload

Bot принимает `/start <payload>`. Поддерживаемые payload-форматы MVP:

- `connect_<code>` — payload содержит channel connect code. Бот вызывает backend, проверяет владельца кода, открывает Mini App с prefilled code.
- `draft_<id>` — payload deep-links в редактор draft (используется в notifications).

Bot должен:
- проверить, что payload подписан / валиден на backend;
- ответить human-readable сообщением даже если payload неверный (без stack trace).

## 4. Mini App navigation

Primary tabs:

```text
Радар
Черновики
Источники
Канал
Настройки
```

## 5. Screen: Радар

Purpose: show found news and candidates.

Cards:

```text
[Score 8.7] Cursor выпустил новую функцию для AI coding
Источник: Cursor Blog
Почему важно: свежая официальная новость, релевантна теме AI coding
Статус: Кандидат

[Открыть] [Создать пост] [Пропустить]
```

Filters:
- all;
- score 7+;
- new;
- drafted;
- rejected.

Empty state:

```text
Пока нет новостей.
Добавь источники или нажми “Проверить сейчас”.
```

## 6. Screen: News detail

Fields:
- title;
- source;
- url;
- published_at;
- score;
- relevance reason;
- summary;
- linked cluster if any;
- button to create draft.

Buttons:
- `Создать черновик`
- `Пропустить`
- `Открыть источник`

## 7. Screen: Черновики

Shows drafts grouped by status:
- Draft;
- Ready;
- Published;
- Rejected.

Draft card:

```text
Черновик по новости: Cursor выпустил...
Канал: AI Tools Daily
Статус: Draft
Версия: 3

[Редактировать] [Опубликовать] [Отклонить]
```

## 8. Screen: Draft editor

Main elements:
- title input optional;
- textarea for post text;
- source links;
- version history dropdown;
- AI rewrite buttons;
- save button;
- publish button.

AI buttons MVP:
- `Короче`
- `Экспертнее`
- `Проще`
- `Убрать воду`
- `3 варианта`

Important: each rewrite creates a new draft version.

Publish confirmation modal:

```text
Опубликовать этот пост в канал “AI Tools Daily”?

Пост будет отправлен от имени подключённого Telegram-бота.

[Опубликовать] [Отмена]
```

### Preview rendering перед publish

Editor рендерит preview через тот же telegram-format-parser, что использует backend при отправке. Общий код — `packages/shared/telegram-format.ts`.

Это защищает от рассинхрона "пост в редакторе выглядит ок, в канале — со сломанными entities".

Counter символов: `X / 4096`. Подсветка красным при превышении. Disable publish, пока не исправлено.

## 9. Screen: Источники

Source list:

```text
OpenAI Blog — RSS — active
Hacker News — API/RSS — active
Product Hunt — API/manual — active
```

Actions:
- add source;
- enable/disable;
- check now;
- remove subscription.

Add source form:
- URL;
- type auto-detect or manual;
- name;
- topic profile.

## 10. Screen: Канал

States:

### Not connected

```text
Канал не подключён.

1. Нажми “Создать код подключения”
2. Добавь нашего бота админом в свой канал
3. Отправь код боту или вставь его здесь
```

Buttons:
- `Создать код подключения`
- `Проверить подключение`

Deep-link UX (preferred): после создания кода Mini App показывает кнопку **Скопировать ссылку для бота**: `https://t.me/<bot>?start=connect_<code>`. User в канале нажимает share — бот автоматически активирует код.

### Connected

Show:
- channel name;
- platform: Telegram;
- status;
- bot admin check;
- last publish;
- disconnect button.

## 11. Screen: Настройки

MVP settings:
- topics;
- keywords;
- negative keywords;
- language;
- tone:
  - кратко/подробно;
  - строго/живо;
  - с эмодзи/без эмодзи;
  - экспертно/простым языком.

## 12. Notification UX

Bot can notify:

```text
Найдено 5 новых инфоповодов с score > 7.

3 черновика готовы к проверке.

[Открыть панель]
```

No auto-spam. Add notification settings later.

## 13. Visual style direction

Brand style:
- energetic tech SaaS;
- clean cards;
- radar/signal metaphor;
- not too corporate;
- not too meme-like.

Mini App should feel like:

```text
AI editorial cockpit inside Telegram.
```

Theme: использовать `themeParams` из Telegram WebApp SDK. Поддерживаются `dark` и `light` с Phase 1.

iOS viewport: вызывать `WebApp.expand()` при загрузке; listener на `viewportChanged` чтобы textarea не скрывалась за клавиатурой.

## 14. UX rules

- Always show source link.
- Always show why score is high.
- Never hide publish action behind unclear UI.
- Always require confirmation before publishing.
- Use clear statuses.
- Avoid too many settings in MVP.
- Empty states must guide user to next action.
- Offline state: показывать indicator, disable mutation buttons; не queue'ить mutations локально.
- Не optimistic UI для publish — clear "publishing..." state до server-confirm.

## 15. Mini App cache-busting

Bot отправляет `web_app.url` с query `?v=<commit_sha>` при отправке кнопок открытия. Это автоматический cache-bust после deploy'я — иначе у пользователей застрянет старая версия Mini App.

Реализация:
- env `MINIAPP_BUILD_VERSION` (CI sets to git short sha);
- Bot inline-keyboard builder добавляет `?v=<version>` к base URL;
- Mini App может читать `?v=` параметр для отображения версии в Settings → About.

## 16. Notifications UX rules

- Auto-notify в MVP **off by default**. Пользователь явно включает в Settings → Notifications.
- Throttle: не более 1 notification / workspace / 30 минут.
- Coalesce: "5 новых high-score за час" вместо отдельных пушей.
- Quiet hours: не реализованы в MVP (документировано в `12-EDGE-CASES.md`).
- Deep-link в notification: кнопка ведёт сразу в редактор draft или в filtered Radar.
- Если бот заблокирован — notification помечается `blocked`, `telegram_identities.status='blocked_bot'`. Retry'ев нет.

## 17. Multi-workspace UI

MVP предполагает один workspace per user, но `users.last_active_workspace_id` есть с Phase 1. Switcher в header — Phase 8+.
