# /perfect-loop

Use the `perfect-loop` skill.

Behavior:

- Always 5 main loops x 5 sub-loops.
- Use lean core roster only: `pl-architect`, `pl-breaker`, `pl-synthesizer`, `pl-goal-keeper`, `pl-implementer`, and `pl-fix-reviewer` when changes were applied.
- Run domain specialists only when there is an explicit domain signal.
- Do not copy `.claude/perfect-loop-runs/` into the portable source files.
- Store only useful reports and final artifacts.
- Final response must include a short next-session handoff and suggest `/clear`
  or restarting the session before the next major step.
