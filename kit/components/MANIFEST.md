# Portable Setup Manifest

This is the text manifest for the portable agent setup. Agents must read this file instead of any JSON manifest.

## Install Mode

- Mode: agent-direct
- Installer scripts: forbidden
- Runtime artifacts: never copy
- Supported targets: Claude Code, Codex, or both

## Platform Targets

### Claude Code

- Control directory: `.claude`
- Skills: `.claude/skills`
- Agents: `.claude/agents`
- Hooks: `.claude/hooks`
- Commands: `.claude/commands`
- Support files: `.claude/kit`
- Templates: `.claude/kit/templates`
- Presets: `.claude/kit/presets`
- Settings guidance: `kit/components/SETTINGS_TEMPLATE.md`
- Diagnose: `.claude/kit/diagnose.ps1`

### Codex

- Control directory: `.codex`
- Skills: `.codex/skills`
- Agents: `.codex/agents`
- Hooks: `.codex/hooks`
- Commands: `.codex/commands`
- Support files: `.codex/kit`
- Templates: `.codex/kit/templates`
- Settings guidance: `.codex/kit/SETTINGS_TEMPLATE.md` for dual-target installs and Claude settings merge from Codex
- Root instructions: append `kit/components/codex/AGENTS.md.addition` to root `AGENTS.md`
- Diagnose: `.codex/kit/diagnose.ps1`

Codex model mapping:

- `claude-opus-4-7`, `opus` -> `gpt-5.5`
- `claude-sonnet-4-6`, `sonnet` -> `gpt-5.4`
- `claude-haiku-4-5`, `haiku` -> `gpt-5.4-mini`

## Always Install

Skills:

- `kit-install`
- `kit-diagnose`

Hooks:

- `pre-write-guard`
- `block-dangerous-bash`
- `format-on-edit`
- `lint-on-edit`
- `roadmap-reminder`
- `stage-complete-detector`

Commands:

- `kit-install`
- `kit-diagnose`
- `kit-update`
- `encoding-check`

## Base Install

Skills:

- `fast-path`
- `context-pack`
- `impact-scan`
- `test-select`
- `fix-ci`
- `patch-review`
- `token-budget`
- `hook-health`
- `codex-sync`
- `release-check`
- `dep-risk`
- `migration-check`
- `api-contract`
- `prompt-cache-review`
- `dead-code-scan`
- `merge-conflict`
- `pre-flight-check`
- `bug-hunt`
- `safe-refactor`
- `dep-audit`
- `perfect-loop`
- `step-perfect-loop`
- `roadmap-keeper`

Universal agents:

- `work-router`
- `context-compressor`
- `impact-analyzer`
- `test-impact-selector`
- `ci-failure-triager`
- `patch-reviewer`
- `token-budgeter`
- `hook-doctor`
- `dependency-risk-reviewer`
- `migration-guard`
- `api-contract-reviewer`
- `prompt-cache-reviewer`
- `merge-conflict-resolver`
- `dead-code-finder`
- `release-readiness-reviewer`
- `code-reviewer`
- `test-writer`
- `debugger`
- `security-auditor`
- `perf-profiler`
- `refactor-planner`
- `docs-writer`
- `error-analyst`
- `roadmap-keeper-agent`
- `architect-designer`
- `code-simplifier`

Commands:

- `fast-path`
- `context-pack`
- `impact-scan`
- `test-select`
- `fix-ci`
- `patch-review`
- `token-budget`
- `hook-health`
- `codex-sync`
- `release-check`
- `dep-risk`
- `migration-check`
- `api-contract`
- `prompt-cache-review`
- `dead-code-scan`
- `merge-conflict`
- `perfect-loop`
- `step-perfect-loop`
- `roadmap`
- `preflight`
- `bug-hunt`
- `safe-refactor`
- `dep-audit`

## Perfect Loop Agents

Lean core:

- `pl-architect`
- `pl-breaker`
- `pl-synthesizer`
- `pl-goal-keeper`
- `pl-implementer`
- `pl-fix-reviewer`

Specialists installed but not called by default:

- `pl-pessimist`
- `pl-plan-keeper`
- `pl-ground-truth-verifier`
- `pl-comparative-analyst`
- `pl-security-auditor`
- `pl-performance-analyst`
- `pl-ux-critic`
- `pl-cost-analyst`
- `pl-domain-expert`

## Copy Policy

- Agents: copy in parallel.
- Skills: copy in parallel when safe.
- Hooks: copy all.
- Commands: copy all for the selected target when supported.
- Settings: merge only; never replace.
- Project templates: create only if missing, including `PROJECT_RULES.md`.
- `CLAUDE.md`: append only if missing for Claude target.
- `AGENTS.md`: append only if missing for Codex target.
- Runtime artifacts: never copy.

## Routing Policy

Copy `kit/components/SUBAGENT_ROUTING.md` into the selected target support directory.

Agents should use `work-router` before non-trivial work and follow `SUBAGENT_ROUTING.md` to decide which specialists to launch or apply locally.

## Runtime Artifact Excludes

- `.claude/perfect-loop-runs`
- `.codex/perfect-loop-runs`
- `.claude/scheduled_tasks.lock`
- `.codex/scheduled_tasks.lock`
- logs
