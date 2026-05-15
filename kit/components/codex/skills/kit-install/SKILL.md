---
name: "kit-install"
description: "Agent-direct installation of the local portable setup into the current project for Codex and optionally Claude Code. No installer script. Copies skills, role agents, hooks, root instructions, templates, and runs diagnose. Trigger: `/kit-install`, \"install kit\", \"настрой проект\"."
trigger_patterns:
  - "/kit-install"
  - "install kit"
  - "настрой проект"
  - "инициализируй .codex"
  - "set up codex"
---

# Portable Setup Install For Codex

This skill installs the local portable source folder into the current project without an installer script.

Primary source of truth:

- `kit/AGENT_INSTALL.md`
- `kit/components/MANIFEST.md`
- `kit/components/codex/CODEX_INSTALL.md`

## Rules

1. Do not run `install.ps1`; this setup intentionally has no installer.
2. Copy files directly as the acting Codex agent.
3. Copy role agents in parallel when tool support allows it.
4. Do not overwrite user-modified files blindly.
5. Do not copy runtime artifacts.
6. Run `.codex/kit/diagnose.ps1` before reporting success.
7. Use Codex model mapping: opus -> `gpt-5.5`, sonnet -> `gpt-5.4`, haiku -> `gpt-5.4-mini`.

## Workflow

1. Read `kit/AGENT_INSTALL.md`.
2. Read `kit/components/codex/CODEX_INSTALL.md`.
3. Detect project type from root files.
4. Create `.codex/skills`, `.codex/agents`, `.codex/hooks`, `.codex/kit/templates`.
5. Copy `kit/components/codex/agents/*.md` to `.codex/agents/*.md` in parallel.
6. Copy `kit/components/codex/skills/*` to `.codex/skills/*` in parallel when safe.
7. Copy hooks and support files to `.codex/hooks` and `.codex/kit`.
8. Append `kit/components/codex/AGENTS.md.addition` to root `AGENTS.md` if missing.
9. Create project templates if missing:
   - `PROJECT_RULES.md`
   - `PROJECT_MAP.md`
   - `ARCHITECTURE.md`
   - `architecture/_TEMPLATE.md`
10. Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.codex\kit\diagnose.ps1
```

## Codex Invocation Mapping

- If a skill says `Agent(<role>)`, use Codex subagents only when the user explicitly asked for subagents/parallel agent work.
- Otherwise read `.codex/agents/<role>.md` and apply that role locally.
- If a skill says `AskUserQuestion`, ask a concise direct question unless `request_user_input` is available.
