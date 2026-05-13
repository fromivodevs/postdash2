---
name: "codex-sync"
description: "Keeps Claude and Codex portable setup files aligned. Checks .claude/.codex roles, model mapping, hooks, and root instruction docs. Trigger: `/codex-sync`, \"синхронизируй codex\", \"sync codex\"."
trigger_patterns:
  - "/codex-sync"
  - "sync codex"
  - "синхронизируй codex"
---

# Codex Sync

Use `hook-doctor` plus `patch-reviewer`.

Check:

- `.claude` and `.codex` both have expected skills/agents/hooks.
- Codex agents do not contain Claude model names.
- `AGENTS.md` includes Agent Runtime Mapping.
- Diagnostics pass for both targets.
