# Preset: python-backend

Detect when any of these files exist:

- `pyproject.toml`
- `requirements.txt`
- `setup.py`

Skills:

- `pre-flight-check`
- `bug-hunt`
- `safe-refactor`
- `dep-audit`
- `perfect-loop`
- `step-perfect-loop`
- `roadmap-keeper`

Agents:

- `code-reviewer`
- `test-writer`
- `debugger`
- `security-auditor`
- `perf-profiler`
- `refactor-planner`
- `roadmap-keeper-agent`

Hooks:

- `pre-write-guard`
- `block-dangerous-bash`
- `format-on-edit`
- `lint-on-edit`
- `roadmap-reminder`
- `stage-complete-detector`

Extra permissions:

- `Bash(pytest:*)`
- `Bash(ruff check:*)`
- `Bash(ruff format:*)`
- `Bash(mypy:*)`
- `Bash(pyright:*)`
- `Bash(pip install:*)`
- `Bash(python -m venv:*)`

