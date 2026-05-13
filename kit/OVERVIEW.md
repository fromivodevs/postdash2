# Portable Setup Overview

The `kit/` directory is a portable source bundle for projects that use Claude
Code, Codex, or both. It is optimized for direct agent installation: copy it
into a project, then ask the acting agent to read `kit/AGENT_INSTALL.md` and
apply the files.

## Design Goals

- Portable across projects.
- Text-only source bundle.
- No installer script.
- No JSON source files inside `kit/`.
- Parallelizable agent and skill copy operations.
- Claude and Codex variants kept in sync.
- Hooks and encoding rules included so Windows paths and file encodings do not
  drift.
- Token cost controlled by routing rules and lean perfect-loop defaults.

## Source Layout

```text
kit/
  AGENT_INSTALL.md
  README.md
  INSTALL.md
  OVERVIEW.md
  PERFECT_LOOP_SPEC.md
  VERSION
  components/
    MANIFEST.md
    SETTINGS_TEMPLATE.md
    SUBAGENT_ROUTING.md
    agents/
    skills/
    hooks/
    commands/
    templates/
    presets/
    kit/
      diagnose.ps1
    codex/
      AGENTS.md.addition
      CODEX_INSTALL.md
      agents/
      skills/
      hooks/
      commands/
      templates/
      kit/
        diagnose.ps1
```

## Runtime Layout After Install

Claude target:

```text
.claude/
  agents/
  commands/
  hooks/
  kit/
  skills/
  settings.json
```

Codex target:

```text
.codex/
  agents/
  commands/
  hooks/
  kit/
  skills/
AGENTS.md
```

`settings.json` is runtime config, not kit source. It is generated or merged
from the text guidance in `components/SETTINGS_TEMPLATE.md`.

## Routing

`components/SUBAGENT_ROUTING.md` is the routing source of truth.

Use `work-router` for non-trivial work. It chooses local work, a focused
specialist, or a loop. Independent specialists may run in parallel when the
host agent platform permits it.

For Codex, if higher-priority runtime rules prevent spawning subagents, read the
matching `.codex/agents/<role>.md` file and apply that role locally.

## Token Controls

- Use lean perfect-loop core by default.
- Run specialists only on explicit domain triggers.
- Use `context-compressor` before broad analysis.
- Use `impact-analyzer` and `test-impact-selector` to avoid running unrelated
  checks.
- Use `token-budgeter` before heavy loops when cost or latency matters.
- Keep old design history out of active instructions; canonical docs are short
  and current.

## Encoding And Hooks

- PowerShell hooks are ASCII-only.
- Hooks tolerate missing or malformed JSON input and exit cleanly.
- `.gitattributes` should keep `.ps1`, `.bat`, and `.cmd` as CRLF while common
  source files stay UTF-8 without BOM and LF.
- Claude hook commands should use absolute paths with forward slashes.

## Consistency Rule

When changing the kit, update all relevant places:

- `kit/components/*` source payload.
- `.claude/*` installed Claude target when this repository is the active target.
- `.codex/*` installed Codex target when this repository is the active target.
- `AGENTS.md` or `CLAUDE.md` only when their installed instruction text changes.

Then run both diagnostics and check that no JSON files exist under `kit/`.
