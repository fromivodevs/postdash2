# /kit-install

Install the portable agent setup into the current project without running an installer script.

Steps:

1. Read `kit/AGENT_INSTALL.md`.
2. Read `kit/components/MANIFEST.md`.
3. Detect applicable presets from `kit/components/presets/*.md`.
4. Detect target: Claude, Codex, or both.
5. Copy selected components into `.claude/` and/or `.codex/`.
6. Copy agents and skills in parallel when tool support allows it.
7. Merge `.claude/settings.json` from `kit/components/SETTINGS_TEMPLATE.md` when Claude target is installed.
8. Copy `MANIFEST.md`, `SUBAGENT_ROUTING.md`, `SETTINGS_TEMPLATE.md`, and `VERSION` into the target support directory.
9. Run `.claude/kit/diagnose.ps1` and/or `.codex/kit/diagnose.ps1`.
10. Report targets, counts, diagnostics, and skipped files.

Do not overwrite user-modified files blindly.
