# Perfect Loop Spec

This is the current canonical contract for `perfect-loop`.

## Current Behavior

There is one default mode:

- `max_main_loops = 5`
- `max_sub_loops = 5`
- scoring = `MIN`
- roster = lean core

Do not ask for Quick, Default, or Thorough. The loop is always 5 x 5 by default,
but it does not call every installed specialist.

Customization is allowed only when the user explicitly asks to change depth,
add specialists, or run all specialists.

## Lean Core

Always use:

- `pl-architect` - structural integrity, decisions, contradictions.
- `pl-breaker` - adversarial break scenarios and edge cases.
- `pl-synthesizer` - aggregates scores and decides stop/continue.
- `pl-goal-keeper` - checks alignment with the original user goal.
- `pl-implementer` - applies fixes between sub-loops.
- `pl-fix-reviewer` - runs only when `pl-implementer` changed something.

`pl-implementer` and `pl-fix-reviewer` are not scoring reviewers for the same
artifact pass. They are used between passes.

## Optional Specialists

Install these agents, but do not call them by default:

- `pl-pessimist`: release, ops, SRE, rollback, incident scenarios, or
  long-lived production risk.
- `pl-ground-truth-verifier`: factual claims, external API limits, versions,
  numbers, or documentation claims.
- `pl-comparative-analyst`: architecture, product, stack, library, or approach
  decisions.
- `pl-security-auditor`: auth, secrets, PII, RLS, network, tokens, credentials,
  or tenant isolation.
- `pl-performance-analyst`: hot paths, scaling, N+1 queries, indexes, async, or
  concurrency.
- `pl-ux-critic`: UI, UX, accessibility, forms, frontend flows, or interaction
  design.
- `pl-cost-analyst`: paid APIs, quotas, infra spend, pricing, or plan tiers.
- `pl-domain-expert`: only by explicit user request or when `pl-synthesizer`
  proves that missing domain expertise blocks an honest score.

Do not launch all Tier 2 agents just because perfect-loop is running.

## Start Analysis

Before the first main loop:

1. Read the artifact.
2. Identify artifact type: code, plan, architecture, API, DB schema, UI, prompt,
   release plan, or mixed.
3. Detect explicit domain triggers for optional specialists.
4. Create the run directory.
5. Save runtime config for reproducibility.

Runtime state may use JSON files such as `config.json`, `scores.json`, or
`facts-cache.json`. These are run artifacts, not kit source files.

## Scoring

Each scoring reviewer returns:

```json
{
  "agent": "<name>",
  "tier": 1,
  "score": 7,
  "rationale": "...",
  "what_would_10_look_like": "...",
  "blockers": ["..."],
  "improvements": ["..."],
  "confidence": "high|medium|low",
  "reasoning": {}
}
```

The sub-loop score is the minimum reviewer score. The minimum is intentional:
one serious weakness should block a perfect result.

## Stop Rules

1. Score 10 in main loop 1: skip the rest of main loop 1 and confirm with main
   loop 2.
2. Score 10 on sub-loop 1 in main loop 2 or later: `PERFECT_FRESH`, stop.
3. Score 10 on sub-loop 2+ in main loop 2 or later: `PERFECT_REFINED`, continue
   to the next main loop for fresh confirmation unless the user asked to stop.
4. Delta below 0.5 for two consecutive sub-loops: stop the current main loop and
   continue with the next main loop.
5. Sub-loop limit reached: continue with the next main loop.
6. Main-loop limit reached: stop and report the best artifact.

## Anti-Inflation

- Reviewer scores are independent within a pass.
- A score jump greater than 3 points requires `delta_justification`.
- `pl-synthesizer` must explain disagreements when reviewer spread is high.
- Growth without score improvement is bloat and should be penalized.
- A 10 means no meaningful improvement remains in the reviewed scope.

## Token And Latency Controls

- Keep static rubric and role instructions stable.
- Put dynamic artifact content at the end of prompts.
- Slice artifact context for optional specialists.
- Re-run specialists only when the diff touches their `cares_about` scope.
- Prefer concise reviewer output: short rationale, top blockers, top
  improvements.
- Cache verified facts during a run.

## Run Artifacts

Expected runtime layout:

```text
.claude/perfect-loop-runs/<timestamp>-<slug>/
  target.md
  config.json
  facts-cache.json
  main-N/
    sub-M/
      scores.json
      tier-*.md
      implementer-output.md
      revised-artifact.md
    SUMMARY.md
    final-artifact.md
  REPORT.md
```

Codex may use `.codex/perfect-loop-runs/<timestamp>-<slug>/`.

Do not copy these runtime directories into the portable source files.
