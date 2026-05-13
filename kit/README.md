# Portable Agent Setup

The `kit/` directory is the transfer source for Claude Code and Codex project
instructions. Copy it into a project and ask the acting agent to read
`kit/AGENT_INSTALL.md`. The agent applies the files directly. There is no
installer script and no JSON source file inside the transfer source.

Runtime tools may still need runtime JSON files, for example
`.claude/settings.json` or loop run state such as `config.json`. Those are
generated or merged by the acting agent after installation; they are not kit
source files.

## Canonical Files

Read these first:

- `AGENT_INSTALL.md` - installation workflow for agents.
- `components/MANIFEST.md` - text manifest and copy policy.
- `components/SUBAGENT_ROUTING.md` - routing rules for Claude and Codex.
- `components/SETTINGS_TEMPLATE.md` - text description for runtime settings.
- `PERFECT_LOOP_SPEC.md` - current perfect-loop contract.
- `VERSION` - kit version.

Design history in older docs has been collapsed into the current canonical
files above. If a file conflicts with `AGENT_INSTALL.md`,
`components/MANIFEST.md`, or `components/SUBAGENT_ROUTING.md`, treat that as a
bug and fix the file.

## Source Contents

- `components/skills/` - Claude skill payloads.
- `components/agents/` - Claude subagent role files.
- `components/hooks/` - PowerShell hooks.
- `components/commands/` - slash command templates.
- `components/templates/` - project docs and `.gitattributes` templates.
- `components/presets/` - project-type presets in Markdown.
- `components/kit/diagnose.ps1` - Claude installation health check.
- `components/codex/` - Codex-adapted skills, agents, hooks, templates,
  diagnostics, and root `AGENTS.md` runtime mapping text.

## Install Request

Use this prompt in a target project:

```text
Read kit/AGENT_INSTALL.md and install the portable agent setup into this project.
Install the Claude target, the Codex target, or both based on the current agent
and existing project directories. Copy agents and skills in parallel where the
tool environment permits it. After installation, run diagnostics.
```

## Invariants

- No installer script.
- No JSON source files in `kit/`.
- Text manifest only: `components/MANIFEST.md`.
- Settings are merged, never replaced.
- Hooks are ASCII-only PowerShell.
- Hook paths in Claude settings are absolute and use forward slashes.
- Source files use UTF-8 without BOM and LF unless a platform script requires
  CRLF.
- Codex agents must use Codex model names, not Claude model names.
- Runtime artifacts are never copied back into the transfer source.

## Perfect Loop

`perfect-loop` is always a 5 main loop x 5 sub-loop workflow. It uses the lean
core roster by default:

- `pl-architect`
- `pl-breaker`
- `pl-synthesizer`
- `pl-goal-keeper`
- `pl-implementer`
- `pl-fix-reviewer` only when changes were applied

Specialists are installed but not launched by default. They run only when their
domain trigger is explicit. Do not launch all Tier 2 agents just because
perfect-loop is running.

## Diagnostics

Claude target:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\kit\diagnose.ps1
```

Codex target:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.codex\kit\diagnose.ps1
```
