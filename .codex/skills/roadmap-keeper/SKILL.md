---
name: "roadmap-keeper"
description: "Поддерживает PROJECT_MAP.md и architecture/* в актуальном состоянии. Триггеры — \"/roadmap\", \"/update-map\", \"создал систему\", \"новый модуль\", \"added system\", авто после Write/Edit когда создан новый файл (через хук roadmap-reminder)."
trigger_patterns:
  - "/roadmap"
  - "/update-map"
  - "создал систему"
  - "новый модуль"
  - "добавил компонент"
  - "added system"
  - "new module"
---

# Roadmap Keeper

Поддерживает динамический роадмап и архитектурные файлы проекта.

## Файлы которые поддерживаются

### `PROJECT_MAP.md` в корне проекта
- быстрая навигация по структуре файлов (карта что где лежит)
- индекс систем со ссылками на ARCHITECTURE.md
- recent changes (auto-updated last 10 entries)

### `ARCHITECTURE.md` в корне проекта — оркестратор
- список всех систем со ссылками на architecture/<system>.md
- инструкция как добавить новую систему

### `architecture/<system>.md` — по системе
- Purpose, Main state, How it works
- Files (список с путями)
- Interfaces (входы/выходы)
- How to extend
- Status (Active / Deprecated / In progress)
- Last touched (дата)

## Когда триггерится

- Фразы: "создал систему", "новый модуль", "added system", "new module"
- Авто после Write/Edit когда создан новый файл (через хук roadmap-reminder)
- При запуске perfect-loop / step-perfect-loop как pre-step
- Slash: `/roadmap`, `/update-map`

## Что делает (алгоритм)

1. Читает текущий PROJECT_MAP.md и ARCHITECTURE.md (если есть)
2. Если нет — создаёт из шаблонов в `.codex/kit/templates/`
3. Сравнивает с актуальным состоянием:
   - новые файлы → добавить в PROJECT_MAP.md
   - удалённые файлы → убрать
   - новая система (несколько связанных файлов в одной папке/модуле) → создать `architecture/<system>.md` из template, добавить ссылку в ARCHITECTURE.md
   - изменения в существующей системе → обновить `Last touched` и `Files`
4. Записывает recent changes (последние 10 в PROJECT_MAP.md)

## Idempotency

Если diff между актуальным состоянием проекта и тем что уже записано в PROJECT_MAP.md / ARCHITECTURE.md == ∅ — НЕ переписывать файлы вообще, выйти silently. Это важно для частого вызова через хук — не должен на каждый Edit генерить commits в roadmap.

Признаки когда выходим silently:
- Все Quick navigation entries актуальны
- Все Active systems в ARCHITECTURE есть и Last touched ≥ сегодня (или равен дате последнего реального edit'а файла системы)
- Нет новых файлов которые не в PROJECT_MAP

Output в этом случае: `↻ Roadmap up-to-date, no changes.`

## Защита от "забыл обновить"

**1. Stop hook (`roadmap-reminder.ps1`):**
Срабатывает на Stop. Проверяет были ли в сессии Write/Edit и тронут ли PROJECT_MAP.md.
Если нет — блокирует Stop с сообщением. Сказать "skip-roadmap" если уверен что не нужно.

**2. Делегирование при тесном контексте:**
Если основной агент чувствует что контекст забит — вызывает `Agent(roadmap-keeper-agent)`.
Субагент в свежем контексте читает PROJECT_MAP.md, актуальное состояние, делает diff, обновляет.
Не загрязняет основной контекст.

## Триггеры

- `/roadmap`, `/update-map`
- "создал систему", "новый модуль"
- Авто от хука roadmap-reminder
- Pre-step при запуске perfect-loop / step-perfect-loop
