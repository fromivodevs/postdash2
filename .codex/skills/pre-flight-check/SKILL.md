---
name: "pre-flight-check"
description: "Перед non-trivial изменениями кода. Проверяет git статус, ветку, uncommitted, читает CLAUDE.md / PROJECT_MAP.md проекта. Триггеры — \"implement\", \"add feature\", \"rewrite\", \"refactor\", \"fix bug\"."
trigger_patterns:
  - "implement"
  - "add feature"
  - "rewrite"
  - "refactor"
  - "fix bug"
  - "почему не работает"
---

# Pre-Flight Check

Срабатывает перед non-trivial изменениями кода — чтобы агент стартовал в безопасном состоянии и с пониманием конвенций проекта.

## Алгоритм

1. **`git status`** — есть ли uncommitted? есть ли untracked которые могут быть забыты?
2. **`git branch --show-current`** — на какой ветке. Если main/master — предупредить и предложить `git checkout -b feat/<slug>`.
3. **Uncommitted changes:**
   - Если есть и не относятся к текущей задаче — предложить `git stash push -m "wip before <task>"`
   - Если относятся — продолжать.
4. **Читать CLAUDE.md** (если есть) — конвенции проекта.
5. **Читать PROJECT_MAP.md / ARCHITECTURE.md** — где что лежит, не делать `Glob *` по всему проекту.
6. **Читать relevant `architecture/<system>.md`** для затрагиваемой системы.

## Output

Краткий отчёт:
```
✓ Pre-flight check
  Branch: feat/news-pipeline (ok)
  Uncommitted: 2 files (related to task — keeping)
  Conventions read: CLAUDE.md, PROJECT_MAP.md, architecture/news-pipeline.md
  Ready to start.
```

## Триггеры

Фразы: "implement X", "add feature X", "rewrite Y", "refactor Z", "fix bug", "почему не работает".

## Не запускать когда

- Это просто вопрос о коде ("explain this function")
- Юзер просит read-only операцию
- В сессии уже был pre-flight на ту же задачу
