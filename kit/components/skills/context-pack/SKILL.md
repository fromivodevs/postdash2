---
name: "context-pack"
description: "Builds a compact context pack for long tasks, handoff, or subagents. Trigger: `/context-pack`, \"сожми контекст\", \"context pack\"."
trigger_patterns:
  - "/context-pack"
  - "context pack"
  - "сожми контекст"
---

# Context Pack

Use `context-compressor`.

Output a short pack with goal, state, files, constraints, decisions, risks, and next steps.

Do not solve the task unless the user also asks for implementation.

