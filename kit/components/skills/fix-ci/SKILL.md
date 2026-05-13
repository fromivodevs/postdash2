---
name: "fix-ci"
description: "Triage CI/log failures and choose the smallest fix. Trigger: `/fix-ci`, \"почини CI\", \"CI failed\"."
trigger_patterns:
  - "/fix-ci"
  - "CI failed"
  - "почини CI"
  - "разбери логи"
---

# Fix CI

Use `ci-failure-triager`.

Classify the failure, identify evidence, apply the smallest fix if asked to fix, and run the relevant verification.

