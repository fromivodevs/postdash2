---
name: "release-check"
description: "Pre-release readiness gate: env, migrations, rollback, monitoring, smoke checks, docs. Trigger: `/release-check`, \"готово к релизу\", \"release ready\"."
trigger_patterns:
  - "/release-check"
  - "release ready"
  - "готово к релизу"
---

# Release Check

Use `release-readiness-reviewer`.

Return blockers, warnings, smoke checks, and rollback notes.

