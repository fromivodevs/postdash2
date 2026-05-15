# Project Rules

This file is the shared place for project-specific rules.

`CLAUDE.md` and `AGENTS.md` should stay runtime shims. Put durable project
policy here so Claude, Codex, and future agents read the same source.

## Rule Placement

- Put rules that name this product, repository, roadmap, branches, cloud
  provider choices, deployment choices, or local scripts in this file.
- Keep portable kit files generic. Do not put project-specific product names,
  branch names, provider choices, or roadmap details into kit templates, skills,
  agents, or hooks.
- If a rule is universal for every project, it may go into kit. If it depends on
  this project, keep it here.

## Project Rules Merge Policy

Kit installation must never overwrite this file.

- If `PROJECT_RULES.md` is missing, create it from the kit template.
- If `PROJECT_RULES.md` already exists, preserve all existing content and append
  only missing generic sections from the kit template.
- Do not delete, reorder, or rewrite project-specific sections during kit
  install/update.
- If a generic section has the same heading but different content, leave the
  project version intact and report the difference as a skipped merge.
- Any manual cleanup of project rules must be a separate explicit change, not an
  implicit side effect of kit installation.

## Startup Entry

- Keep one canonical project startup entrypoint. If the project already has
  `start.*`, `dev.*`, `Makefile`, `justfile`, or package scripts documenting
  the main startup path, update that path when adding required services, setup,
  env vars, migrations, or runtime prerequisites.
- Manual commands are allowed, but they must not become the only working
  startup path.

## Stage Closure

- When a phase, milestone, or major roadmap step is completed, the closing
  response should suggest `/clear` or restarting the session before starting the
  next step, so stale context does not leak forward.
- Include a short handoff: current branch/commit, what completed, checks run,
  checks skipped, dirty files, next task, and first command for the next
  session.

## Validation Evidence

- Final status reports must distinguish automated checks from live/manual
  checks.
- If external services, credentials, tunnels, webhooks, or live integrations
  were not tested, say so explicitly.
