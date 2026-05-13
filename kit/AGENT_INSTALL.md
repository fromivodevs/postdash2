# Portable Agent Setup Install Guide

This portable setup is intentionally installer-free. A coding agent installs it by reading this file and applying the files from `kit/components/` into the current project.

The source bundle is platform-aware:

- Claude Code target: install into `.claude/*`.
- Codex target: install into `.codex/*` and append the Codex runtime mapping to `AGENTS.md`.
- Dual target: install both when the user asks for both or when both directories already exist.

## Goal

Install the reusable agent setup into any project:

- `.claude/skills/*`
- `.claude/agents/*`
- `.claude/hooks/*`
- `.claude/commands/*`
- `.claude/kit/*`
- `.codex/skills/*` when Codex target is selected
- `.codex/agents/*` when Codex target is selected
- `.codex/hooks/*` when Codex target is selected
- `.codex/kit/*` when Codex target is selected
- root `AGENTS.md` when Codex target is selected
- project templates: `PROJECT_MAP.md`, `ARCHITECTURE.md`, `architecture/_TEMPLATE.md`, `.gitattributes`
- merged `.claude/settings.json`
- optional `CLAUDE.md` addition

Do not run an installer script. Do the work directly as the acting agent.

## Non-Negotiable Rules

1. Never overwrite user-modified files blindly.
2. Merge `.claude/settings.json`; do not replace it.
3. Use absolute hook paths with forward slashes in settings, for example `C:/path/to/project/.claude/hooks/pre-write-guard.ps1`.
4. Copy subagent files in parallel when the tool environment supports parallel shell/file operations.
5. Do not copy runtime artifacts such as `.claude/perfect-loop-runs/`.
6. Keep PowerShell hooks ASCII-only.
7. After installation, run the diagnostic command or execute `.claude/kit/diagnose.ps1`.
8. Do not copy Claude model names into Codex agents. Use the model mapping below.

## Platform Detection

Pick targets like this:

1. If user explicitly says Claude Code, install Claude target.
2. If user explicitly says Codex, install Codex target.
3. If user says both, install both.
4. If running as Codex and no target is specified, install Codex target.
5. If `.claude/` already exists, keep Claude target up to date unless the user asked Codex-only.
6. If `.codex/` already exists, keep Codex target up to date unless the user asked Claude-only.

Codex model mapping:

| Claude model tier | Codex model |
|---|---|
| `claude-opus-*` / `opus` | `gpt-5.5` |
| `claude-sonnet-*` / `sonnet` | `gpt-5.4` |
| `claude-haiku-*` / `haiku` | `gpt-5.4-mini` |

Codex invocation mapping:

| Claude term | Codex behavior |
|---|---|
| `AskUserQuestion` | Ask a concise direct question, or use `request_user_input` only when available |
| `Agent()` | Use Codex subagents only when the user explicitly asks for subagents/parallel agent work; otherwise apply the role file locally |
| `.claude/kit/templates` | `.codex/kit/templates` |

## Install Steps

Assume:

- kit root: `./kit`
- project root: current working directory
- payload root: `./kit/components`

### 1. Inspect

Read:

- `kit/components/MANIFEST.md`
- `kit/components/SUBAGENT_ROUTING.md`
- `kit/components/presets/*.md`
- existing `.claude/settings.json` if present
- existing `CLAUDE.md` if present
- root files: `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `next.config.*`, `pnpm-workspace.yaml`, `turbo.json`

Select one or more presets, then include all `always_install` items from the manifest.

### 2. Create Directories

Create these directories if missing:

- `.claude/skills`
- `.claude/agents`
- `.claude/hooks`
- `.claude/commands`
- `.claude/kit/templates`
- `.claude/kit/presets`
- `.codex/skills` for Codex target
- `.codex/agents` for Codex target
- `.codex/hooks` for Codex target
- `.codex/kit/templates` for Codex target
- `architecture`

### 3. Copy Components

Copy selected skills from:

- `kit/components/skills/<name>/` to `.claude/skills/<name>/`

Copy selected agents from:

- `kit/components/agents/<name>.md` to `.claude/agents/<name>.md`

Copy all hooks from:

- `kit/components/hooks/*.ps1` to `.claude/hooks/*.ps1`

Copy support files:

- `kit/components/templates/*` to `.claude/kit/templates/*`
- `kit/components/presets/*` to `.claude/kit/presets/*`
- `kit/components/kit/*` to `.claude/kit/*`
- `kit/components/MANIFEST.md` to `.claude/kit/MANIFEST.md`
- `kit/components/SUBAGENT_ROUTING.md` to `.claude/kit/SUBAGENT_ROUTING.md`
- `kit/components/SETTINGS_TEMPLATE.md` to `.claude/kit/SETTINGS_TEMPLATE.md`
- `kit/VERSION` to `.claude/kit/VERSION`

Copy slash commands:

- `kit/components/commands/*.md` to `.claude/commands/*.md`

For Codex target:

- `kit/components/codex/skills/<name>/` to `.codex/skills/<name>/`
- `kit/components/codex/agents/<name>.md` to `.codex/agents/<name>.md`
- `kit/components/codex/hooks/*.ps1` to `.codex/hooks/*.ps1`
- `kit/components/codex/kit/*` to `.codex/kit/*`
- `kit/components/codex/templates/*` to `.codex/kit/templates/*`
- `kit/components/MANIFEST.md` to `.codex/kit/MANIFEST.md`
- `kit/components/SUBAGENT_ROUTING.md` to `.codex/kit/SUBAGENT_ROUTING.md`
- `kit/components/SETTINGS_TEMPLATE.md` to `.codex/kit/SETTINGS_TEMPLATE.md`
- `kit/VERSION` to `.codex/kit/VERSION`
- append `kit/components/codex/AGENTS.md.addition` to root `AGENTS.md` if missing

Parallelization requirement:

- Copy agents in parallel by independent file operations.
- Copy skills in parallel by independent directory operations when available.
- If a tool cannot run parallel writes safely, batch by category: agents, then skills, then hooks.

### 4. Project Templates

Create only if missing:

- `PROJECT_MAP.md` from `kit/components/templates/PROJECT_MAP.md`
- `ARCHITECTURE.md` from `kit/components/templates/ARCHITECTURE.md`
- `architecture/_TEMPLATE.md` from `kit/components/templates/architecture-system-template.md`

Merge `.gitattributes`:

- ensure `*.ps1 text eol=crlf`
- ensure `*.bat text eol=crlf`
- ensure `*.cmd text eol=crlf`
- ensure common source files use LF

Append `kit/components/templates/CLAUDE.md.addition` to `CLAUDE.md` only if the marker sections are not already present.

For Codex target, append `kit/components/codex/AGENTS.md.addition` to root `AGENTS.md` only if the "Agent Runtime Mapping" section is not already present.

### 5. Merge Settings

Read `kit/components/SETTINGS_TEMPLATE.md`.

Replace `{{PROJECT_DIR}}` with the absolute project root path using forward slashes.

Merge into `.claude/settings.json`:

- preserve existing hooks
- preserve existing permissions
- add missing hook entries
- add missing allow/deny permissions
- do not duplicate entries

### 6. Diagnose

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\kit\diagnose.ps1
```

For Codex target also run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.codex\kit\diagnose.ps1
```

If diagnostics fail:

- fix hook syntax first
- fix settings path issues second
- fix encoding warnings third
- do not claim the setup is active until diagnostics pass

## Success Criteria

Report:

- selected presets
- installed platform targets: Claude Code, Codex, or dual
- installed skills count
- installed agents count
- installed hooks count
- installed commands count
- whether settings were merged or created
- diagnostic result
- any files skipped because the project already had user-modified versions
