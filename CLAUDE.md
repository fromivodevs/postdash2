## Navigation

- **PROJECT_MAP.md** — карта файлов и систем. Читать перед навигацией
  по проекту вместо `Glob` всего подряд.
- **ARCHITECTURE.md** — индекс систем. Каждая система — `architecture/<name>.md`.
- ОБЯЗАТЕЛЬНО обновлять PROJECT_MAP.md при создании файлов / систем.
  Если контекст тесный — делегируй roadmap-keeper-agent (Subagent в свежем
  контексте).

## Workflow

- Phase branches are cumulative and mandatory for phase validation:
  - `phase/base` is the baseline before Phase 0 when available.
  - `phase/0-foundation` contains only Phase 0.
  - `phase/1-identity` contains Phase 0 plus Phase 1.
  - `phase/N-<slug>` contains phases `0..N`, and no later phase.
- Run phase-level `step-perfect-loop` only from the matching `phase/N-*` branch.
  Use the phase-only branch diff as the artifact:
  - Phase 0: `phase/base..phase/0-foundation`
  - Phase N: `phase/(N-1)-<slug>..phase/N-<slug>`
- Every phase commit subject starts with `[phase N]`, `[phase N fix]`,
  `[phase N loop]`, or `[phase N docs]`.
- If Phase K needs a fix after later phases exist, commit it first on
  `phase/K-*`, then propagate the same logical fix forward into every branch
  that includes Phase K and finally `main`. Do not propagate it backward.

- pre-flight-check скилл срабатывает на triggering фразы перед
  non-trivial изменениями.
- bug-hunt: тесты до фикса.
- **Чек-боксы `- [x]` — только на уровне завершения фазы** (секция
  "Roadmap progress" в `tg_mvp_plan/08-IMPLEMENTATION-ROADMAP.md`).
  Под-таски внутри фазы — обычные bullet points без чек-боксов
  (иначе хук stage-complete-detector предлагает запускать validation
  на каждый микро-шаг — это шум).
- Хук `stage-complete-detector` детектит `- [x]`, и:
  - если текст содержит "Phase N" → подсказывает запустить
    `/step-perfect-loop with full 5x5 depth` (phase-level validation
    через lean core + pl-plan-keeper + git diff всей фазы);
  - иначе → подсказывает `/step-perfect-loop` 3×3 (для редких ad-hoc
    step-level чек-боксов).
- Perfect-loop без plan-link — `/perfect-loop`, для крупного artifact'а
  без привязки к чек-листу.
- Перед новой системой / фичей >3 файлов — вызывать `architect-designer`,
  результат → `architecture/<system>.md`.
- Для non-trivial задач сначала использовать `work-router` и правила
  `.claude/kit/SUBAGENT_ROUTING.md`, чтобы выбирать нужных субагентов без
  лишнего расхода токенов.

## Кодировки (NON-NEGOTIABLE на Windows)

- **Все файлы — UTF-8.** Никаких CP866 / CP1251 / Windows-1252.
- **`.ps1` / `.bat` / `.cmd`** — ASCII-only содержимое + CRLF. PowerShell 5.1 ломается на UTF-8 без BOM с не-ASCII; cmd.exe ломается на не-ASCII.
- **Source code** (`.py`, `.ts`, `.tsx`, `.js`, `.json`, `.sql`, `.md`, `.yml`) — UTF-8 без BOM + LF.
- **Hooks в `.claude/settings.json`** — путь через `%CLAUDE_PROJECT_DIR%\\.claude\\hooks\\<name>.ps1` (полный, не относительный — иначе файл не найдётся).
- **`.gitattributes` обязателен** — нормализует EOL автоматически:
  ```
  * text=auto eol=lf
  *.ps1 text eol=crlf
  *.bat text eol=crlf
  ```

## Архитектурный приоритет (NON-NEGOTIABLE)

**Если выбор между "меньше кода + хуже архитектурой" vs "больше кода + лучше архитектурой" — всегда второе.**

- Explicit DTO с типами > dict
- Отдельный модуль на одну ответственность > smashed-together
- Cross-module связи явные (типизированные импорты сверху) > hidden inside-function
- code-simplifier НЕ упрощает если упрощение ломает видимость связей
- pl-architect отдельно оценивает `interconnections_clarity` (см. agents/pl-architect.md)

## Project context

PostDash / Content Radar — Telegram-first MVP AI-радара инфоповодов.

- Полный план: `tg_mvp_plan/` (см. `tg_mvp_plan/README.md` как точку входа).
- Архитектурные non-negotiable rules: `tg_mvp_plan/02-ARCHITECTURE.md` и `tg_mvp_plan/09-CODEX-CLAUDE-INSTRUCTIONS.md`.
- Roadmap по фазам: `tg_mvp_plan/08-IMPLEMENTATION-ROADMAP.md`.
- Telegram — это adapter, а не core. Core: `content_channel`, `workspace`, `source`, `news_item`, `post_draft`, `publish_target`.
- Source-centric ingestion: fetch один раз глобально, matching/scoring/drafts — per workspace.
- Все мутации через command layer + policy checks. AI rewrite = новая draft version. OperationLog обязателен.
