---
name: "perfect-loop"
description: "Итеративное доведение артефакта (план / архитектура / код / текст) до идеала через состязательную оценку несколькими тирами субагентов. Триггеры: \"/perfect-loop\", \"довести до идеала\", \"максимально улучшить\"."
trigger_patterns:
  - "/perfect-loop"
  - "довести до идеала"
  - "максимально улучшить"
  - "сделай идеально"
---

# Perfect Loop

Итеративный механизм улучшения артефакта через состязательную оценку.

## Концепция

- Максимум **5 main loops × 5 sub-loops × 3 тира агентов**
- Каждый агент оценивает 0-10
- Итоговый score sub-loop'а = **MIN всех оценок** (не среднее — слабое звено ломает цепь)
- Каждый main loop создаёт **АБСОЛЮТНО СВЕЖИХ агентов** через `Agent()`. Им передаётся только текущий артефакт, без истории предыдущих критик.

## Параметры запуска

Behavior always:

- `max_main_loops = 10` (hard ceiling — loop НЕ останавливается раньше достижения score == 10; см. STOP RULES)
- `max_sub_loops = 5` (per main loop)
- scoring = MIN (одно слабое звено блокирует PERFECT)
- roster = **lean core**
- **target_score = 10** — единственный естественный stop condition

Не спрашивай Quick/Default/Thorough. Perfect-loop НЕ останавливается на VERY_GOOD/GOOD — только PERFECT (score == 10) или hard ceiling.

**Token warning**: 10 × 5 = до 50 sub-loops. Каждый sub-loop = 3-6 параллельных agent-вызовов + synth + (по необходимости) implementer. Это значимый расход. Пользователь может прервать Ctrl+C в любой момент — `<run_dir>/main-<N>/SUMMARY.md` сохраняет промежуточный best артефакт.

Customize разрешён только если пользователь явно просит изменить глубину, добавить специалистов или "thorough/all specialists".

Конфиг сохраняется в `<run_dir>/config.json` для воспроизводимости.

## Анализ артефакта на старте

Перед main_loop 1:
1. Читаем артефакт, определяем тип (архитектура / код / план / API / схема БД / UI / промпт), домен, чувствительные оси
2. Определяем, есть ли явный доменный риск: security, DB/migration, API contract, performance, UI/UX, cost, factual claims.
3. Новых субагентов не создаём автоматически. Если `pl-synthesizer` просит missing_expertise, сначала продолжай lean core; предлагай нового specialist только если без него нельзя честно оценить артефакт.

## Тиры

**Tier 1 core (всегда параллельно, opus):**
- pl-architect — целостность, structure, decisions
- pl-breaker — состязательное "как это сломать"

**Tier 2 core (условно-обязательные, только когда есть сигнал):**
- pl-ground-truth-verifier (haiku) — только если есть factual claims: API limits, версии, цифры, внешние спецификации
- pl-comparative-analyst (sonnet) — только один раз на main loop, если артефакт содержит architectural/product/stack decisions

**Specialists (только по явному доменному сигналу):**
- pl-security-auditor — auth, secrets, network, RLS, tokens, credentials
- pl-performance-analyst — hot paths, scaling, N+1, indexes, async/concurrency
- pl-ux-critic — UI, UX, frontend flows, forms, accessibility
- pl-cost-analyst — pricing, paid APIs, quotas, infra spend
- pl-pessimist — только для release/ops/SRE/long-lived production risk
- pl-domain-expert — только если пользователь явно просит доменную экспертизу или synthesizer доказал blocker

**Tier 3 core (всегда):**
- pl-synthesizer (opus) — взвешивает оценки, решает stop/continue
- pl-goal-keeper (opus) — соответствует ли артефакт исходному запросу пользователя

**Между sub-loops:**
- pl-implementer (opus) — применяет правки
- pl-fix-reviewer (haiku) — проверяет diff после implementer только если applied != []

## Условия остановки (точно)

**Natural STOP (только при достижении PERFECT):**

1. score == 10 на любом sub-loop в main_loop 1 → пропустить остаток main 1, идти в main 2 (для fresh-confirm на свежих агентах).
2. score == 10 на sub_loop == 1 в main_loop ≥ 2 → ⭐ **PERFECT_FRESH** → STOP (единственный естественный stop loop'а).
3. score == 10 на sub_loop > 1 в main_loop ≥ 2 → PERFECT_REFINED → следующий main loop для fresh-confirm.

**Continuation (loop НЕ останавливается):**

4. delta < 0.5 два sub-loop'а подряд → **эскалация**, не stop:
   - pl-implementer обязан применить нетривиальный fix (`applied != []`);
   - если pl-implementer уже всё применил, что мог — pl-synthesizer должен запросить НОВОГО specialist'а из Tier 2 списка (свежий взгляд на застрявшую часть);
   - переходим в следующий main loop со свежими агентами.
5. лимит sub_loops в текущем main loop → следующий main loop.

**Hard ceiling (safety net против infinite loop):**

6. Достигнут `max_main_loops` (default 10) И score всё ещё < 10 → STOP с финальным статусом ⚠ **UNREACHABLE_10**.

   pl-synthesizer обязан в финальном отчёте назвать причину (одну из):
   - (a) **scope артефакта объективно ограничивает 10** — например, scaffold-фаза без бизнес-логики, где архитектор всегда найдёт «но layering enforcement отсутствует»;
   - (b) **reviewer-калибровка слишком строгая** — некоторые reviewer'ы дают <10 на всё (надо смягчить anchors или сменить reviewer);
   - (c) **не хватает домен-специалиста**, замена которым lean core невозможна;
   - (d) **противоречивые требования** в исходном запросе — невозможно одновременно удовлетворить всем.

   Решение (продолжить с поднятым ceiling, принять текущий best или отклонить артефакт) принимает пользователь.

7. **Token / latency soft-abort**: если оркестратор имеет `token_budget` в конфиге И накопленный расход > 80% от него → пауза с прогресс-отчётом, ждём команду user'а continue / stop / raise-budget.

## Финальные статусы

Только два финальных статуса (loop не останавливается между ними):

- 🏆 **PERFECT** — perfect_fresh достигнут (score == 10 на sub_loop_1 в main_loop ≥ 2).
- ⚠ **UNREACHABLE_10** — hard ceiling достигнут, score всё ещё < 10. Synthesizer обязан назвать причину (см. STOP RULES §6).

Промежуточные tracking-метки (НЕ stop conditions, только в `SUMMARY.md`):

- ✨ **VERY_GOOD** — score 10 был хоть раз, но без fresh-confirm.
- ✅ **GOOD** — best_score в [9, 10).
- ⚠️ **BAD** — best_score < 9.

Эти метки могут появляться в `main-N/SUMMARY.md` как трекинг прогресса. Loop их игнорирует и продолжает.

## Анти-инфляционные правила

- Параллельный независимый скоринг (агенты одного тира не видят друг друга)
- **Калибровочные якоря в промпте каждого оценщика:** 5 = базовое с очевидными недостатками; 7 = рабочее, но упущения проявятся в проде; 9 = можно деплоить, остались edge cases; 10 = идеально, нет улучшений
- Обязательное поле `what_would_10_look_like` в JSON каждого оценщика
- Стресс-клик breaker'а по результатам specialist/Tier 2 оценок только если такие оценки запускались
- **Потолок дельты:** рост >3 за sub-loop требует `delta_justification` в synth, иначе откат
- Отслеживание раздувания (length growth без score growth = bloat)
- Третейский pl-tiebreaker на сигнале: `max-min > 4` AND `synth.confidence == low`

## Оптимизация (правила пропуска)

- **Relevance gating** через `applies_when` в frontmatter
- Specialists только на sub-loop 1 каждого main loop, если diff не задел их `cares_about`
- Кэш фактов у verifier'а (`facts-cache.json` в папке прогона)
- Diff-driven re-evaluation через `cares_about`
- No-op short-circuit: если implementer applied=[] → следующий main loop
- comparative-analyst максимум один раз на main loop
- goal-keeper полная проверка только sub-loop 1 и последнем
- pl-pessimist не входит в core; вызывается только для release/ops/production-risk артефактов

## Ускорение

- Параллелизация core + применимых specialists в одном Agent()-батче
- Prompt caching: статика впереди (роль, шкала, формат), динамика (артефакт) в конце
- Slicing артефакта по `cares_about` для specialists (не передавать весь)
- Лимиты выходных токенов: rationale ≤150 слов, ≤5 blockers, ≤5 improvements
- Streaming прогресса в чат после каждого sub-loop

## State прогона

`.claude/perfect-loop-runs/<timestamp>-<slug>/`:
- `target.md`, `config.json`, `facts-cache.json`
- `main-N/sub-M/{scores.json, tier-*.md, implementer-output.md, revised-artifact.md}`
- `main-N/SUMMARY.md` — траектория score, что находил breaker, что менял implementer
- `main-N/final-artifact.md`
- `REPORT.md` — итог + FINAL STATUS + ссылки

## JSON-формат оценки

```json
{
  "agent": "<name>",
  "tier": 1,
  "score": 7,
  "rationale": "...",
  "what_would_10_look_like": "...",
  "blockers": ["..."],
  "improvements": ["..."],
  "confidence": "high|medium|low",
  "reasoning": { /* role-specific */ }
}
```

## Алгоритм оркестратора (high-level)

```
1. Спросить параметры (если не "with defaults")
2. Прочитать артефакт, проанализировать тип/домен
3. Проверить roster, при необходимости предложить новых субагентов
4. Создать <run_dir>, сохранить config.json
5. for main_loop in 1..max_main_loops:
     fresh_agents = spawn fresh Agent() instances
     for sub_loop in 1..max_sub_loops:
       parallel: core reviewers + applicable specialists
       Tier3: synthesizer + goal-keeper
       check stop conditions
       if not stopped:
         pl-implementer applies fixes
         pl-fix-reviewer verifies diff
     write main-N/SUMMARY.md
6. Write REPORT.md with FINAL STATUS
```
