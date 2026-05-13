# Telegram MVP Plan: AI Content Radar

Этот архив — полный план MVP Telegram-first продукта: AI-радара инфоповодов для Telegram-каналов.

Продукт состоит из:
- общего Telegram-бота;
- Telegram Mini App внутри бота;
- отдельного backend;
- Postgres database;
- worker pool для источников, скоринга, генерации и публикации;
- source-centric ingestion, чтобы один источник проверялся один раз и переиспользовался многими workspace.

Главная идея MVP:

> Пользователь подключает свой Telegram-канал, задаёт темы и источники. Система находит новости, оценивает их, создаёт черновики постов. Пользователь редактирует и публикует пост в канал через Mini App.

## Документы в архиве

1. `00-OWNER-SHORT-PLAN.md` — короткий план для владельца проекта: что строим, этапы, что получится после каждого этапа.
2. `01-PRODUCT-SPEC.md` — продуктовая спецификация MVP.
3. `02-ARCHITECTURE.md` — расширяемая архитектура без костылей.
4. `03-DATABASE-SCHEMA.md` — таблицы, связи, статусы, индексы.
5. `04-TELEGRAM-BOT-AND-MINIAPP-UX.md` — как выглядит бот и Mini App.
6. `05-SECURITY-AND-ACCOUNTS.md` — аккаунты, workspace, Telegram identity, роли, безопасная публикация.
7. `06-WORKERS-AND-INGESTION.md` — source-centric ingestion, task queue, workers, locks, priorities.
8. `07-AI-SCORING-AND-DRAFTS.md` — scoring, prompts, draft generation, rewrite buttons, fallbacks.
9. `08-IMPLEMENTATION-ROADMAP.md` — этапы реализации для Codex/Claude Code с clear checkpoints.
10. `09-CODEX-CLAUDE-INSTRUCTIONS.md` — правила для coding agent, как реализовывать без разрушения архитектуры.
11. `10-FUTURE-EXPANSION.md` — как расширять на VK/Discord/web dashboard/research agent/paid tiers.
12. `11-AI-PROVIDER.md` — Yandex AI Studio + DeepSeek 3.2 + YandexGPT Embeddings: AIProvider interface, auth, JSON validation, retry, cost guard, env-vars.
13. `12-EDGE-CASES.md` — каталог граничных кейсов (identity, channels, sources, AI, publishing, tasks, embeddings, notifications, UI) с привязкой к фазам roadmap.
14. `13-MINIAPP-DESIGN-SYSTEM.md` — design tokens, stack pick (Vite + @telegram-apps/sdk-react + @telegram-apps/telegram-ui), performance budget, accessibility baseline, native Telegram chrome integration, error UX taxonomy, onboarding wizard, QA checklist per screen.

## Главные архитектурные правила

- Telegram — это adapter, а не core продукта.
- AI — тоже adapter (см. `11-AI-PROVIDER.md`), domain core не импортирует LLM SDK напрямую.
- Core работает с `content_channel`, `post_draft`, `workspace`, `source`, `news_item`, `publish_target`.
- Один общий Telegram-бот для всех клиентов.
- Для каждого workspace отдельные настройки, темы, источники, каналы, черновики и права.
- Источники глобальные, подписки на источники — per workspace.
- Fetch источника выполняется один раз, matching и draft generation — per workspace.
- Все действия проходят через command layer и policy checks.
- Критичные команды (`PublishPost`, `GenerateDraft`, `RewriteDraft`, `CreateConnectCode`) идемпотентны через `idempotency_key`.
- Нельзя публиковать пост напрямую из UI без backend-проверки.
- Любая AI-правка создаёт новую версию draft.
- OperationLog обязателен с MVP.
- AI cost guard per workspace per day с MVP.

## MVP scope

В MVP входит:
- Telegram Bot `/start`;
- Mini App;
- создание workspace;
- привязка Telegram identity;
- подключение Telegram-канала;
- настройка тем;
- настройка источников;
- глобальный fetch источников;
- matching новостей под workspace;
- score 1–10;
- AI draft;
- редактор поста;
- publish в Telegram-канал;
- operation log;
- базовые роли и policy checks.

Не входит в MVP:
- автопостинг без одобрения;
- парсинг чужих Telegram-каналов;
- VK/Discord/WhatsApp;
- сложная аналитика;
- агентские autonomous actions;
- white-label bots;
- enterprise roles;
- сложный billing.
