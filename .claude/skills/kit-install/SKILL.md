---
name: "kit-install"
description: "Agent-direct installation of the local portable setup into the current project for Claude Code and/or Codex. No installer script. Copies skills, agents, hooks, commands/templates, merges settings, and runs diagnose. Trigger: `/kit-install`, \"install kit\", \"настрой проект\"."
trigger_patterns:
  - "/kit-install"
  - "install kit"
  - "настрой проект"
  - "инициализируй .claude"
  - "set up claude code"
---

# Portable Setup Install

This skill installs the local portable source folder into the current project without an installer script.

It is platform-aware:

- Claude Code target -> `.claude/*`
- Codex target -> `.codex/*` plus root `AGENTS.md`
- Dual target -> both

Primary source of truth:

- `kit/AGENT_INSTALL.md`
- `kit/components/MANIFEST.md`
- `kit/components/SETTINGS_TEMPLATE.md`
- `kit/components/presets/*.md`

## Rules

1. Do not run `install.ps1`; this setup intentionally has no installer.
2. Copy files directly as the acting agent.
3. Copy subagents/role agents in parallel when tool support allows it.
4. Merge `.claude/settings.json`; never replace it wholesale.
5. Do not overwrite user-modified files blindly.
6. Treat `PROJECT_RULES.md` as merge-only: create it when missing; when present,
   append only missing generic sections from the kit template, preserve all
   project-specific content, and report skipped conflicting sections.
7. Do not copy runtime artifacts.
8. Run platform diagnostics before reporting success.
9. For Codex, use model mapping: opus -> `gpt-5.5`, sonnet -> `gpt-5.4`, haiku -> `gpt-5.4-mini`.

## Workflow

1. Read `kit/AGENT_INSTALL.md`.
2. Detect project type using root files:
   - `package.json`
   - `pyproject.toml`
   - `requirements.txt`
   - `Cargo.toml`
   - `go.mod`
   - `next.config.*`
   - `pnpm-workspace.yaml`
   - `turbo.json`
3. Select matching presets from `kit/components/presets/`.
4. Include `always_install`, `base`, and applicable overlay components from `kit/components/MANIFEST.md`.
5. Detect target platform from the user request and existing directories.
6. For Claude target, create `.claude/skills`, `.claude/agents`, `.claude/hooks`, `.claude/commands`, `.claude/kit/templates`, `.claude/kit/presets`.
7. For Codex target, create `.codex/skills`, `.codex/agents`, `.codex/hooks`, `.codex/kit/templates`.
8. Copy selected agents/role agents in parallel.
9. Copy selected skills in parallel when safe.
10. Copy all hooks, commands, templates, presets, root instructions, and support files.
11. Create missing project templates:
   - `PROJECT_RULES.md`
   - `PROJECT_MAP.md`
   - `ARCHITECTURE.md`
   - `architecture/_TEMPLATE.md`
12. If `PROJECT_RULES.md` already exists, merge only missing generic sections
    from the template. Do not overwrite or rewrite existing sections.
13. Merge `.gitattributes` rules for PowerShell/script safety.
14. Append `CLAUDE.md.addition` if missing for Claude target.
15. Append `codex/AGENTS.md.addition` if missing for Codex target.
16. Merge settings from `SETTINGS_TEMPLATE.md`, replacing `<PROJECT_DIR>` with absolute project path using `/`.
17. Run Claude target diagnostic when installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\kit\diagnose.ps1
```

18. Run Codex target diagnostic when installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.codex\kit\diagnose.ps1
```

## Output

Report:

- selected presets
- selected targets
- installed skills count
- installed agents count
- installed hooks count
- installed commands count
- settings created or merged
- diagnostics result
- skipped/conflicted files
