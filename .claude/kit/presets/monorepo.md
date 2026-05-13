# Preset: monorepo

Detect when any of these files exist:

- `pnpm-workspace.yaml`
- `turbo.json`
- `lerna.json`
- `nx.json`

Behavior:

- Detect each workspace.
- Apply matching base presets per workspace.
- Merge all hooks and permissions at the root control directory.
- Do not duplicate shared skills or agents.

