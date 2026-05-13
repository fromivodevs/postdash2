# Codex Install Notes

Use this when the acting agent is Codex or the user asks for Codex support.

Install target:

- `.codex/skills`
- `.codex/agents`
- `.codex/hooks`
- `.codex/kit`
- root `AGENTS.md`

Copy policy:

- Copy `kit/components/codex/skills/*` to `.codex/skills/*`.
- Copy `kit/components/codex/agents/*.md` to `.codex/agents/*.md`.
- Copy `kit/components/codex/hooks/*.ps1` to `.codex/hooks/*.ps1`.
- Copy `kit/components/codex/kit/*` to `.codex/kit/*`.
- Copy `kit/components/MANIFEST.md` to `.codex/kit/MANIFEST.md`.
- Copy `kit/components/SUBAGENT_ROUTING.md` to `.codex/kit/SUBAGENT_ROUTING.md`.
- Copy `kit/components/SETTINGS_TEMPLATE.md` to `.codex/kit/SETTINGS_TEMPLATE.md`.
- Copy `kit/components/codex/templates/*` to `.codex/kit/templates/*`.
- Copy `kit/VERSION` to `.codex/kit/VERSION`.
- Append `kit/components/codex/AGENTS.md.addition` to root `AGENTS.md` if missing.

Parallelization:

- Copy `.codex/agents/*.md` in parallel when the tool environment allows it.
- Copy `.codex/skills/*` in parallel when safe.

Do not overwrite user-modified files blindly.
