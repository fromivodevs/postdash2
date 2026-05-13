---
name: "test-select"
description: "Selects the minimal useful test/check set for current changes. Trigger: `/test-select`, \"какие тесты запустить\", \"minimal tests\"."
trigger_patterns:
  - "/test-select"
  - "minimal tests"
  - "какие тесты запустить"
---

# Test Select

Use `test-impact-selector`.

Prefer focused tests and package-local checks. Avoid running everything unless the impact is broad or contracts changed.

