---
name: "migration-check"
description: "Reviews DB/schema/migration changes for data loss, rollback, indexes, constraints, tenant isolation. Trigger: `/migration-check`, \"проверь миграцию\"."
trigger_patterns:
  - "/migration-check"
  - "проверь миграцию"
  - "migration review"
---

# Migration Check

Use `migration-guard`.

Find blockers, warnings, required tests, and safe rollout notes.

