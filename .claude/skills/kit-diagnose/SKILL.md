---
name: "kit-diagnose"
description: "Health-check for the installed portable agent setup. Checks files, hook smoke tests, settings paths, and encoding safety. Trigger: `/kit-diagnose`, \"проверь настройки\", \"agent health\"."
trigger_patterns:
  - "/kit-diagnose"
  - "проверь настройки"
  - "agent health"
  - "diagnose agents"
---

# Agent Setup Diagnose

Run after `/kit-install`, after `/kit-update`, or when hooks/settings behave strangely.

## Command

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\kit\diagnose.ps1
```

## What It Checks

- `.claude/hooks/*.ps1` exist.
- Hooks are ASCII-only.
- Hooks have no BOM and use CRLF line endings.
- Hooks parse in PowerShell.
- Hooks accept mock stdin and exit cleanly.
- Hook mock output contains no warning/error text.
- Blocking PreToolUse hooks use `hookSpecificOutput.permissionDecision`, not deprecated top-level `decision`.
- PostToolUse hooks use valid `hookSpecificOutput` JSON when they emit context.
- Stop hooks use valid `decision = block` plus `reason` and avoid stop-hook recursion.
- `.claude/settings.json` is valid JSON.
- Hook settings do not contain unreplaced `{{PROJECT_DIR}}`.
- Hook settings do not use backslash hook paths.
- Core `.claude/*` directories exist.
- Installed and source `SKILL.md` frontmatter is YAML-safe.
- `description` fields are quoted so colon-space text cannot break YAML parsing.
- `kit/` contains no JSON source files when present.
- `git diff --check` emits no warnings or errors when Git is available.
- Any diagnostic WARN is treated as failure.

## Manual Follow-Up

If needed, also inspect:

- `kit/components/MANIFEST.md` versus installed files.
- agent frontmatter fields: `name`, `description`, `model`, `tools`.
- `.gitattributes` contains CRLF rules for `.ps1`, `.bat`, `.cmd`.

## Encoding Rules

- `.ps1`, `.bat`, `.cmd`: ASCII-only, no BOM, CRLF required.
- `.md`, `.ts`, `.tsx`, `.js`, `.py`, `.sql`, `.yml`, `.yaml`: UTF-8 without BOM, LF preferred.
- Any PowerShell command reading markdown/json should use `-Encoding UTF8`.
