# Agent Runtime Mapping

This project has Claude/Codex-compatible agent instructions installed.

## Platform Mapping

When a Claude Code concept appears in shared instructions, translate it as follows:

| Shared term | Codex behavior |
|---|---|
| `.claude/skills` | `.codex/skills` |
| `.claude/agents` | `.codex/agents` |
| `.claude/hooks` | `.codex/hooks` |
| `.claude/kit` | `.codex/kit` |
| `AskUserQuestion` | Ask a concise direct question, or use `request_user_input` only when available |
| `Agent()` | Use Codex subagents only when the user explicitly asks for subagents/parallel agent work; otherwise apply the referenced role locally |
| `opus` / `claude-opus-*` | `gpt-5.5` |
| `sonnet` / `claude-sonnet-*` | `gpt-5.4` |
| `haiku` / `claude-haiku-*` | `gpt-5.4-mini` |

## Codex Subagent Rule

Use `.codex/kit/SUBAGENT_ROUTING.md` to decide when specialist role agents are needed.

This is a standing project-level routing policy. If the runtime permits subagents and a routing trigger is present, use the matching `.codex/agents/<role>.md` roles. If a higher-priority runtime rule prevents spawning, read `.codex/agents/<role>.md` and apply that role locally in the main thread.

Start non-trivial tasks with `work-router` unless the user named a specific skill or agent.

## Phase Branch Rules

Phase work must be recoverable by branch and reviewable by phase-only diff.

- Keep one cumulative branch per phase: `phase/0-foundation`, `phase/1-identity`, `phase/2-channel-connection`, etc.
- `phase/0-*` contains only Phase 0. `phase/1-*` contains Phase 0 plus Phase 1. `phase/N-*` contains all phases `0..N`, and nothing from later phases.
- Keep `phase/base` as the baseline before Phase 0 implementation when available. If the old baseline is missing, document the inferred base commit in the loop report.
- Phase boundaries are defined by branch diffs, not by the dirty working tree:
  - Phase 0 diff: `phase/base..phase/0-foundation`
  - Phase N diff: `phase/(N-1)-<slug>..phase/N-<slug>`
- Every phase commit subject must start with `[phase N]`, `[phase N fix]`, `[phase N loop]`, or `[phase N docs]`. This lets agents identify where each phase starts and ends.
- Add immutable closure tags after successful validation: `phase-N-start` at the previous phase branch head, and `phase-N-perfect` at the validated phase branch head. If a later fix changes the branch, add a new tag such as `phase-N-perfect-r2`; do not move old tags.
- Run `step-perfect-loop` only after checking out the matching `phase/N-*` branch, and use only the phase diff above as the artifact. Do not validate Phase N from `main` if `main` already contains later phases.
- If Phase K needs a fix after later phases exist, apply and commit it first on `phase/K-*`, then propagate the same logical fix forward into every branch that includes it: `phase/(K+1)-*`, `phase/(K+2)-*`, ..., current phase branch, and then `main`. Do not propagate fixes backward into earlier branches that should not contain that phase.
- After propagating a fix, rerun the relevant `step-perfect-loop` on `phase/K-*`. For later branches, rerun checks only when the propagation caused conflicts or changed their phase-only diff.

## Install Expectations

The portable setup should create:

- `.codex/skills/*`
- `.codex/agents/*`
- `.codex/hooks/*`
- `.codex/kit/*`
- `.codex/kit/SUBAGENT_ROUTING.md`
- root `AGENTS.md` with this runtime mapping section
- project navigation files if missing: `PROJECT_MAP.md`, `ARCHITECTURE.md`, `architecture/_TEMPLATE.md`

For Claude Code compatibility, `.claude/*` may also be installed in the same project.

## Encoding

- PowerShell hooks must stay ASCII-only.
- `.ps1`, `.bat`, `.cmd` should use CRLF.
- Markdown, JSON, TypeScript, Python, SQL, YAML should use UTF-8 without BOM and LF.
