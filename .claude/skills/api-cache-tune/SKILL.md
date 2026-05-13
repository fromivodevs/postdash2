---
name: "api-cache-tune"
description: "Тюнинг prompt caching для Anthropic SDK. Триггер — файл импортирует `anthropic` или `@anthropic-ai/sdk`. Проверяет cache_control, порядок static/dynamic, hit rate."
trigger_patterns:
  - "anthropic"
  - "@anthropic-ai/sdk"
  - "claude-opus"
  - "claude-sonnet"
  - "claude-haiku"
---

# API Cache Tune

Срабатывает когда файл импортирует Anthropic SDK. Проверяет настройку prompt caching и предлагает оптимизации.

## Что проверять

1. **`cache_control: {"type": "ephemeral"}`** есть на блоках system?
2. **Порядок:** статика впереди (роль, шкала, формат, документация), динамика (артефакт, query) в конце? Cache key — по префиксу.
3. **Размер cached блоков** ≥1024 токенов? Иначе caching не активируется.
4. **Cache hit rate** в логах если есть. Если <50% — почему? Меняется ли префикс?
5. **TTL =5 минут** по умолчанию. Для долгих сессий — `ttl: "1h"` (если paid).
6. **Извлекать tools и system_prompt в константы** — чтобы не пересоздавать каждый раз с разным форматированием.

## Output

```
🔧 API cache tune: <file>:<line>

Issues found:
  • Static prompt после dynamic input — cache key не стабилен
  • cache_control отсутствует на system block
  • System prompt 600 токенов — недостаточно для caching (нужно 1024+)

Suggested fixes:
  1. Переместить документацию в начало system prompt
  2. Добавить cache_control breakpoint после статики
  3. Увеличить static context (например, добавить examples)

Estimated improvement: cache hit rate <50% → ~80%
```

## Не запускать

- Файл импортирует другой LLM SDK (openai, mistralai)
- Файл — тест, fixture, или mock
- Файл — provider-agnostic (`generic_llm.py`)

## Делегирование

Для глубокой оптимизации (с рефакторингом call sites) — использовать skill `claude-api` (если установлен).
