# Settings Template

This is a text description of the Claude Code runtime settings that the agent must merge into `.claude/settings.json`.

Do not keep a JSON settings template in the kit. Generate or merge the runtime JSON only inside the target project because Claude Code requires `.claude/settings.json` to register hooks.

Replace `<PROJECT_DIR>` with the absolute project root path using forward slashes, for example `C:/bot`.

## Hook Entries

### PreToolUse: Write or Edit

Matcher:

- `Write|Edit`

Command:

- `powershell -NoProfile -ExecutionPolicy Bypass -File <PROJECT_DIR>/.claude/hooks/pre-write-guard.ps1`

### PreToolUse: Bash

Matcher:

- `Bash`

Command:

- `powershell -NoProfile -ExecutionPolicy Bypass -File <PROJECT_DIR>/.claude/hooks/block-dangerous-bash.ps1`

### PostToolUse: Edit or Write

Matcher:

- `Edit|Write`

Commands:

- `powershell -NoProfile -ExecutionPolicy Bypass -File <PROJECT_DIR>/.claude/hooks/format-on-edit.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File <PROJECT_DIR>/.claude/hooks/lint-on-edit.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File <PROJECT_DIR>/.claude/hooks/stage-complete-detector.ps1`

### Stop

Command:

- `powershell -NoProfile -ExecutionPolicy Bypass -File <PROJECT_DIR>/.claude/hooks/roadmap-reminder.ps1`

## Permission Allowlist

Add these if missing:

- `Bash(git status)`
- `Bash(git log:*)`
- `Bash(git diff:*)`
- `Bash(git branch:*)`
- `Bash(git show:*)`
- `Bash(git add:*)`
- `Bash(git commit:*)`
- `Bash(npm run build:*)`
- `Bash(npm run dev:*)`
- `Bash(npm run lint:*)`
- `Bash(npm test:*)`
- `Bash(pnpm test:*)`
- `Bash(yarn test:*)`
- `Bash(pytest:*)`
- `Bash(ruff check:*)`
- `Bash(ruff format:*)`
- `Bash(eslint:*)`
- `Bash(mypy:*)`
- `Bash(pyright:*)`
- `Bash(tsc --noEmit)`
- `Bash(ls:*)`
- `Bash(pwd)`

## Permission Denylist

Add these if missing:

- `Bash(rm -rf /:*)`
- `Bash(rm -rf ~:*)`
- `Bash(rm -rf C:*)`
- `Bash(git push --force origin main)`
- `Bash(git push --force origin master)`
- `Bash(git reset --hard:*)`
- `Bash(git clean -fdx:*)`
- `Bash(npm publish)`
- `Bash(pnpm publish)`
- `Bash(pypi-cli upload:*)`
- `Write(<PROJECT_DIR>/.env)`
- `Write(<PROJECT_DIR>/.env.local)`
- `Edit(<PROJECT_DIR>/.env)`
- `Edit(<PROJECT_DIR>/.env.local)`

## Merge Rules

- Preserve all existing hooks.
- Preserve all existing allow and deny permissions.
- Add only missing entries.
- Do not duplicate commands or permissions.
- Use absolute paths with forward slashes.
