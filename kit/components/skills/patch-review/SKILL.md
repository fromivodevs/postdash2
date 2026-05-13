---
name: "patch-review"
description: "Reviews the current patch before final response or commit. Trigger: `/patch-review`, \"проверь патч\", \"review diff\"."
trigger_patterns:
  - "/patch-review"
  - "проверь патч"
  - "review diff"
---

# Patch Review

Use `patch-reviewer`.

Findings first. Focus on regressions, accidental edits, missing tests, and user-change conflicts.

