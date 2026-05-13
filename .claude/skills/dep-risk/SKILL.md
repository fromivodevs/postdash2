---
name: "dep-risk"
description: "Supply-chain focused dependency review before install/update. Trigger: `/dep-risk`, \"проверь зависимость\", \"dependency risk\"."
trigger_patterns:
  - "/dep-risk"
  - "dependency risk"
  - "проверь зависимость"
---

# Dependency Risk

Use `dependency-risk-reviewer`.

Return allow/warn/block with reasons, alternatives, pinning, and follow-up checks.

