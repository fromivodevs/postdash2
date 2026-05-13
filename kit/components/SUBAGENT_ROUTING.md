# Subagent Routing

This file tells Claude Code and Codex when to use role agents.

## Core Rule

Start with `work-router` for any non-trivial task unless the user already named a specific skill/agent.

Non-trivial means any task that:

- edits more than one file
- touches tests, build, CI, release, security, DB, API, hooks, dependencies, or LLM prompts
- asks for review, optimization, quality, speed, or "do it properly"
- is ambiguous enough that a wrong path would waste work

## Auto-Launch Rules

Use these specialists when their trigger appears. Run independent specialists in parallel where the platform allows it.

| Trigger | Agents |
|---|---|
| unclear/large context | `context-compressor` |
| broad change/diff impact | `impact-analyzer` |
| choosing tests/checks | `test-impact-selector` |
| CI/log failure | `ci-failure-triager` |
| before final response after edits | `patch-reviewer` for risky changes |
| token/cost concern | `token-budgeter` |
| hooks/settings/encoding/Windows | `hook-doctor` |
| dependency install/update | `dependency-risk-reviewer` |
| migration/schema/RLS/data loss | `migration-guard` |
| API boundary/DTO/status/errors | `api-contract-reviewer` |
| LLM prompt/cache/tool-output | `prompt-cache-reviewer` |
| merge conflicts | `merge-conflict-resolver` |
| dead code/stale code | `dead-code-finder` |
| release/deploy readiness | `release-readiness-reviewer` |

## Quality Gates

Use `patch-reviewer` before final response when:

- more than one file changed
- settings/hooks were changed
- tests were not run
- user changes existed in the worktree
- security, migration, API contract, dependency, or release surface was touched

Use `token-budgeter` before any heavy loop unless the user explicitly asked for thorough mode.

## Perfect Loop Lean Mode

`perfect-loop` always keeps its 5 main loops x 5 sub-loops depth.

However, it should call only the lean core by default:

- `pl-architect`
- `pl-breaker`
- `pl-synthesizer`
- `pl-goal-keeper`
- `pl-implementer`
- `pl-fix-reviewer` only when `pl-implementer` applied changes

Call these only when their trigger is explicit:

- `pl-pessimist`: release, ops, long-lived production risk, SRE, rollback, incident scenarios
- `pl-ground-truth-verifier`: factual claims, external API limits, versions, numbers, docs
- `pl-comparative-analyst`: architecture/product/stack decisions
- `pl-security-auditor`: auth, secrets, PII, RLS, network, credentials
- `pl-performance-analyst`: hot path, scaling, N+1, indexes, async/concurrency
- `pl-ux-critic`: UI, UX, accessibility, forms, frontend flows
- `pl-cost-analyst`: paid APIs, quotas, infra cost, pricing
- `pl-domain-expert`: only by explicit user request or proven blocker from synthesizer

Do not launch all Tier 2 agents just because the loop is running.

## Codex Rule

For Codex, this project-level kit instruction is the standing routing policy. If the environment permits subagents and the trigger is present, use them. If a higher-priority runtime rule prevents spawning, read the matching `.codex/agents/<role>.md` file and apply the role locally.

## Claude Code Rule

For Claude Code, use the matching `.claude/agents/<role>.md` role agent. Prefer parallel calls for independent read-only reviews.
