# Install Contract

This file is a compact reference for humans. The canonical agent-facing
workflow is `AGENT_INSTALL.md`.

## Current Install Model

- The portable setup is installer-free.
- The acting agent reads text files and copies or merges the source files.
- The source manifest is `components/MANIFEST.md`, not a JSON manifest.
- Presets are Markdown files in `components/presets/`.
- Runtime JSON may be created only where the host tool requires it, such as
  `.claude/settings.json`.

## Targets

Claude Code:

- `.claude/skills`
- `.claude/agents`
- `.claude/hooks`
- `.claude/commands`
- `.claude/kit`
- merged `.claude/settings.json`

Codex:

- `.codex/skills`
- `.codex/agents`
- `.codex/hooks`
- `.codex/commands`
- `.codex/kit`
- root `AGENTS.md` runtime mapping

Dual target installs both when requested or when both target directories
already exist.

## Required Rules

1. Never overwrite user changes blindly.
2. Merge settings; never replace runtime settings files.
3. Copy agents in parallel where the environment supports safe parallel writes.
4. Copy skills in parallel where safe.
5. Keep PowerShell hooks ASCII-only.
6. Use absolute hook paths with forward slashes in Claude runtime settings.
7. Install `.gitattributes` rules so hooks remain CRLF and source files remain
   UTF-8 without BOM and LF.
8. Exclude runtime artifacts such as `.claude/perfect-loop-runs/`,
   `.codex/perfect-loop-runs/`, lock files, and logs.
9. For Codex, map Claude model tiers to Codex model names:
   `opus -> gpt-5.5`, `sonnet -> gpt-5.4`, `haiku -> gpt-5.4-mini`.

## Perfect Loop Contract

`perfect-loop` has one default mode:

- **`target_score = 10`** — the only natural stop. Loop continues until score 10 is fresh-confirmed.
- `max_main_loops = 10` (hard ceiling against infinite loop). At ceiling without 10 → ⚠ UNREACHABLE_10 status with required cause from synthesizer.
- `max_sub_loops = 5` per main loop.
- MIN scoring.
- Lean core roster only.
- No Quick, Default, or Thorough prompt.
- Specialists run only on explicit domain signal.
- Delta < 0.5 across two sub-loops does NOT stop the loop — it escalates (new specialist or non-trivial implementer fix).

Lean core:

- `pl-architect`
- `pl-breaker`
- `pl-synthesizer`
- `pl-goal-keeper`
- `pl-implementer`
- `pl-fix-reviewer` only when changes were applied

Optional specialists:

- `pl-pessimist` for release, ops, SRE, rollback, or long-lived production risk.
- `pl-ground-truth-verifier` for factual claims, versions, limits, numbers, or
  external docs.
- `pl-comparative-analyst` for architecture, product, or stack decisions.
- `pl-security-auditor` for auth, secrets, PII, RLS, network, or credentials.
- `pl-performance-analyst` for hot paths, scaling, N+1, indexes, async, or
  concurrency.
- `pl-ux-critic` for UI, UX, accessibility, forms, or frontend flows.
- `pl-cost-analyst` for paid APIs, quotas, infra cost, or pricing.
- `pl-domain-expert` only by explicit user request or a proven blocker from
  `pl-synthesizer`.

## Step Perfect Loop

`step-perfect-loop` is a plan-step validator. It inherits perfect-loop scoring,
stop rules, and lean specialist gating. Step-default budget is smaller; phase-
level validation requires explicit "with full 5x5 depth":

- 3 main loops x 3 sub-loops (step-default).
- 5 main loops x 5 sub-loops (when user asks "with full 5x5 depth").
- `target_score = 10` inherited from perfect-loop.
- Hard ceiling: 9 sub-loops (step-default) or 25 (full). At ceiling without 10 → ⚠ UNREACHABLE_10; offers user to revert `- [x]` to `- [ ]`.
- `pl-plan-keeper` is always added.
- Domain specialists still require explicit triggers.
- Do not call this "Quick"; there are no Quick/Default/Thorough presets.

## Verification

After installation, run diagnostics for each installed target:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\kit\diagnose.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\.codex\kit\diagnose.ps1
```

The setup is not considered active until diagnostics pass or failures are
reported with concrete reasons.
