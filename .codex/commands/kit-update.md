# /kit-update

Update an existing project installation from the local portable source folder.

Rules:

1. Read `kit/AGENT_INSTALL.md`.
2. Compare `kit/VERSION` with `.claude/kit/VERSION`.
3. Copy new files only when the target does not exist or still matches the previous installed version.
4. Do not overwrite user-modified skills, agents, commands, or settings without reporting the conflict.
5. Merge settings instead of replacing them.
6. Run `.claude/kit/diagnose.ps1`.
