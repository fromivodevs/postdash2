---
name: "step-perfect-loop"
description: "Вариант perfect-loop, валидирует завершение этапа из плана. Авто-триггер от хука stage-complete-detector при `- [ ]` → `- [x]` в PLAN.md/ROADMAP.md. Также явно через /step-perfect-loop <этап>."
trigger_patterns:
  - "/step-perfect-loop"
  - "валидируй этап"
  - "проверь что этап готов"
---

# Step Perfect Loop

> See `perfect-loop` skill for base mechanics. Этот скилл наследует ВСЁ из perfect-loop, добавляя только plan-aware логику и pl-plan-keeper.

## Отличия от perfect-loop

### a) Plan-aware
На старте читает `PLAN.md` (или `ROADMAP.md`, `.claude/plan.md`) проекта,
находит этап который только что завершился (помечен `- [x]`).

**Артефакт оценки** = git diff с момента начала этапа + список файлов из чек-листа этапа.

```
git log --oneline <stage_start>..HEAD
git diff <stage_start>..HEAD -- <stage_files>
```

Если граница этапа неясна — оркестратор спрашивает у пользователя через AskUserQuestion: "С какого коммита считать diff этапа?" с опциями (auto-detect / last commit on PLAN edit / manual sha).

### b) Новый обязательный Tier 3 агент: pl-plan-keeper

Проверяет: "результат соответствует тому что **ОБЕЩАЛ** план для этого этапа?"

Получает:
- Текст этапа из PLAN.md (включая чек-лист)
- Actual diff
- Список изменённых/созданных файлов

Score 0-10 за соответствие плану.

**Это отдельная роль от pl-goal-keeper:**
- goal-keeper — смотрит на исходный запрос пользователя в целом
- plan-keeper — смотрит на конкретный этап в плане

### c) Авто-триггер через хук

Хук `.claude/hooks/stage-complete-detector.ps1` срабатывает на PostToolUse Edit/Write
когда в PLAN.md/ROADMAP.md/.claude/plan.md появляется новая `- [x]` где была `- [ ]`.

Вывод хука:
```
✓ Этап завершён: <название этапа>
Запусти /step-perfect-loop для валидации.
```

Оркестратор может запустить /step-perfect-loop автоматически (если в auto mode) или ждать явный вызов.

### d) Действие при не-PERFECT

Спрашивает пользователя через AskUserQuestion:
- "Этап получил VERY_GOOD/GOOD/BAD. Откатить отметку `- [x]` обратно в `- [ ]`? Принять с замечаниями? Доделать перед откатом?"

### e) Действие при PERFECT

Авто:
1. Добавляет в PROJECT_MAP.md строку про новые/изменённые системы (вызывает roadmap-keeper)
2. Если новая система — создаёт architecture/<system>.md из шаблона
3. Сохраняет полный отчёт в `.claude/perfect-loop-runs/<ts>-<stage-slug>/REPORT.md`

## Конфиг по умолчанию

Step-perfect-loop не использует Quick/Default/Thorough presets.

- max_main_loops = 3 (step-default; full 5×5 если пользователь явно просит "with full 5x5 depth")
- max_sub_loops = 3 (step-default) или 5 (full 5×5)
- aggregation = MIN
- roster = lean perfect-loop core
- domain specialists = только по явному сигналу в diff/плане
- pl-plan-keeper = всегда включён
- pl-goal-keeper = включён, но с пониженным весом (этап ≠ полный запрос)
- **target_score = 10** — единственный естественный stop (наследуется от perfect-loop)
- **hard ceiling**:
  - step-default (3×3) = 9 sub-loops максимум; при недостижении 10 → ⚠ **UNREACHABLE_10**;
  - full 5×5 = 25 sub-loops максимум; та же логика;
  - при `UNREACHABLE_10` step-perfect-loop предлагает пользователю откатить `- [x]` обратно в `- [ ]` либо принять с явным explanation.

См. STOP RULES в `.claude/skills/perfect-loop/SKILL.md` — step-perfect-loop наследует их полностью с поправкой на меньший ceiling в step-default.

## Триггеры

- Хук stage-complete-detector → "✓ Этап завершён" → можно запустить
- Явный `/step-perfect-loop <этап>`
- Фразы "валидируй этап", "проверь что этап X готов"
