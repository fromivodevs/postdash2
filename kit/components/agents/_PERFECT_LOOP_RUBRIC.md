# Perfect Loop — общая рубрика для оценщиков

> Этот файл — **shared spec** для всех `pl-*` агентов. Каждый агент ссылается на него, не дублирует у себя. Так избегается drift при правках.

---

## Калибровочная шкала (строго одинаковая для всех Tier 1/2/3 оценщиков)

- **5/10** — базовое решение с очевидными недостатками. В контексте моей роли — чётко вижу несколько серьёзных проблем.
- **7/10** — рабочее, но с упущениями которые проявятся в проде. 1-2 серьёзных упущения в моей зоне.
- **9/10** — можно деплоить, остались только редкие edge cases или мелочи в моей зоне.
- **10/10** — идеально. После серьёзного поиска проблем в моей зоне — не нашёл ничего.

**Что значит "в моей зоне"** — каждый агент применяет шкалу к СВОЕЙ области ответственности (architect — целостность, breaker — атаки, security-auditor — security и т.д.).

## Стандартный JSON-формат ответа

```json
{
  "agent": "<name>",
  "tier": 1 | 2 | 3,
  "score": 0-10,
  "rationale": "<≤150 слов почему такой score>",
  "what_would_10_look_like": "<обязательно, даже если score == 10 — тогда почему именно ЭТО артефакт = 10>",
  "blockers": ["<≤5 элементов, что MUST исправить чтобы артефакт был приемлем>"],
  "improvements": ["<≤5 элементов, что nice to have>"],
  "confidence": "high | medium | low",
  "reasoning": { /* role-specific поля — см. agent-specific.md */ }
}
```

## Лимиты (общие)

- `rationale` ≤ 150 слов
- `blockers` ≤ 5 (только critical/high severity)
- `improvements` ≤ 5
- Role-specific listings (failure_modes, break_scenarios, ux_issues etc.) ≤ 5-8

## Архитектурный приоритет (для всех оценщиков и для implementer'а)

**Правило: "лучше больше кода + чёткая архитектура" чем "меньше кода + плохая видимость связей".**

Применяй так:
- Score не штрафуй за: explicit DTO с типами вместо dict, отдельный модуль на одну ответственность, abstract base class когда возможна вторая реализация, явные boundaries между системами.
- Score штрафуй за: implicit shared state, magic строки/числа без имён, mega-функции на 200 строк, mixed concerns в одном модуле, hidden dependencies (импорт глубоко внутри функции), неясные интерфейсы.
- Если pl-implementer должен выбирать между "elegant compact" и "verbose explicit" — выбирает verbose explicit.
- code-simplifier НЕ упрощает если упрощение ухудшает видимость связей (см. его spec).
- pl-architect отдельно оценивает `interconnections_clarity` (см. его reasoning schema).

Это правило выше остальных дискуссий о стиле. Стиль (имена, форматирование) — вторично; видимость связей — первично.

## Правила скоринга — анти-инфляция

1. **`what_would_10_look_like` обязательно** в каждом ответе. Это якорь — если не можешь описать что было бы 10/10, значит не понимаешь что оцениваешь.

2. **Не округляй вверх**. Если найдено 3 medium issues — это 7, не 8.

3. **Слабое звено решает (для синтезатора)**: final_score = MIN всех scores. Это не среднее.

4. **Confidence honest**: если артефакт за пределами твоей квалификации — `confidence: low`, не делай вид что разобрался.

5. **Не прячь blockers под improvements** чтобы поднять score. Critical/high-severity finding → blocker.

6. **Дельта-rule для синтезатора**: рост >3 за один sub-loop требует обоснования (`delta_justification`). Если нет — флаг `delta_inflated: true`.

## Prompt order (для prompt caching)

Системный промпт каждого pl-* агента собирается в этом порядке:

1. **Роль** (статика, role-specific, ≤2 предложения)
2. **Reference на этот файл** (`см. _PERFECT_LOOP_RUBRIC.md`) — статика
3. **Role-specific reasoning schema** (статика, JSON-поля уникальные для роли)
4. **Артефакт** — динамика, в самом конце

Только финальный блок (артефакт) меняется между sub-loops. Cache key стабилен — caching работает.

## Output dependencies

- `pl-implementer` получает priority_fixes от synthesizer + полные blockers/improvements от Tier 1/2.
- `pl-fix-reviewer` получает diff + applied/skipped lists от implementer.
- `pl-synthesizer` получает все JSON оценки текущего sub-loop.
- `pl-tiebreaker` (вызывается опционально) — при `max(scores) - min(scores) > 4` AND `synth.confidence == low`.

## Версия

v1.0 — 2026-05-07. При изменениях формата JSON или калибровочной шкалы — bump version, отметить в commit message, прогнать smoke-tests на тестовом артефакте.
