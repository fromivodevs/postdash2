---
name: "dep-audit"
description: "Перед добавлением библиотеки — размер, последний релиз, альтернативы, лицензия, security advisories. Триггеры — \"добавь библиотеку\", `npm install X`, `pip install X`, `pnpm add X`, `cargo add X`."
trigger_patterns:
  - "добавь библиотеку"
  - "добавь зависимость"
  - "поставь пакет"
  - "npm install"
  - "pip install"
  - "pnpm add"
  - "yarn add"
  - "cargo add"
  - "go get"
---

# Dep Audit

Перед `npm install X` / `pip install X` / `pnpm add X` — 30-секундная проверка пакета.

## Чек-лист

1. **Размер бандла** (для frontend) — bundlephobia / packagephobia.
2. **Last release date** — если >2 года = warn (заброшен?).
3. **Альтернативы** (top 2-3) с кратким сравнением. Возможно есть мейнстрим-альтернатива получше.
4. **Лицензия** — MIT/Apache/BSD ok. GPL/AGPL — флаг для commercial проектов.
5. **Транзитивные зависимости** — top N по размеру/уязвимостям.
6. **Security advisories** — `npm audit` / `pip-audit` / GitHub advisory database.
7. **Maintainers** — один человек или org? GitHub stars / weekly downloads / open issues.

## Output

```
📦 Dep audit: <package>@<version>

Size: <N>kb (gzip: <M>kb) — bundlephobia link
Last release: <date> (<X> ago)
License: MIT
Alternatives:
  • <alt1> — <pro/con>
  • <alt2> — <pro/con>
Advisories: <N> open (<links>)
Verdict: ✓ ok / ⚠ warn / ✗ stop

Reason: <one-liner>
```

## Решение

- **ok** → молча ставим
- **warn** → показываем результат, спрашиваем подтверждение через AskUserQuestion
- **stop** → отказываем без подтверждения, объясняем почему

## Триггеры

`npm install X`, `pip install X`, `pnpm add X`, `yarn add X`, `cargo add X`, `go get X`. Также фразы "добавь библиотеку", "поставь пакет".

## Когда не запускать

- Уже установленная зависимость (только обновление версии — отдельный сценарий)
- dev-зависимости утилит (типа prettier) — silent ok если из allowlist
- Пакеты из internal registry компании
