---
name: "fast-path"
description: "Fast workflow router for normal coding tasks. Uses work-router, then chooses local work, focused checks, or a small specialist set. Trigger: `/fast-path`, \"быстро сделай\", \"fast path\"."
trigger_patterns:
  - "/fast-path"
  - "fast path"
  - "быстро сделай"
  - "сделай быстро"
---

# Fast Path

Use the cheapest safe workflow.

1. Ask `work-router` for mode and specialists.
2. If `local_fast`, work locally.
3. If `local_with_checks`, edit locally and run minimal checks.
4. If `specialist_parallel`, run only listed specialists.
5. Finish with `patch-reviewer` only when code changed.

Default: no heavy loop unless the router marks high risk or the user asks for a loop.

