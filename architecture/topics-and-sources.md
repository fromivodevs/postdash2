# Topics and Sources (Phase 3)

## Purpose

Per-workspace **topic profiles** (what kind of news this workspace cares about) and **source subscriptions** (which RSS/web sources to pull from). Sources themselves are **global** — one row per canonical URL, shared across all workspaces; the subscription table is the per-workspace M:N glue.

Phase 3 sets up the *configuration* layer that Phase 4 (`fetch_source` task system + embeddings) and Phase 5 (matching/scoring) will consume.

## Main state

Three new tables (mirrored in `packages/db/src/schema.ts` and `packages/db/migrations/0003_phase3.sql`):

- **`topic_profiles`** — `(workspace_id, name, language, main_topics[], keywords[], negative_keywords[], tone_profile jsonb, embedding vector(256) NULL, embedding_status, status)`. Embedding column is provisioned but stays `NULL` until Phase 4 (`recompute_topic_embedding` task).
- **`sources`** — `(type, url, canonical_url UNIQUE, name, fetch_interval_minutes, max_items_per_fetch, last_fetched_at, last_fetch_status, last_fetch_error, canonicalization_rule_version, status)`. **Global**. No `workspace_id` column.
- **`workspace_source_subscriptions`** — `(workspace_id, source_id, topic_profile_id NULL, enabled, priority, custom_rules jsonb)`. UNIQUE `(workspace_id, source_id, topic_profile_id)`.

## How it works

```
User                Mini App           apps/api              packages/commands       Postgres
 │                    │                   │                       │                     │
 │  add topic         │ POST /topics      │  createTopicProfile   │ INSERT topic_profile│
 ├───────────────────►├──────────────────►├──────────────────────►├────────────────────►│
 │                    │                   │                       │                     │
 │  add source        │ POST /sources     │  createSource         │ resolveRedirect()   │
 ├───────────────────►├──────────────────►├──────────────────────►│  ↓ (one-time HEAD)  │
 │                    │                   │                       │ canonicalize()      │
 │                    │                   │                       │ INSERT/SELECT source│
 │                    │                   │                       │  ON CONFLICT        │
 │                    │                   │                       │   canonical_url     │
 │                    │                   │                       │ INSERT subscription │
 │                    │                   │                       │                     │
 │  toggle source     │ PATCH /sources/:id│  updateSubscription   │ UPDATE subscription │
 ├───────────────────►├──────────────────►├──────────────────────►├────────────────────►│
```

### Canonicalization (the deduplication backbone)

`packages/sources/canonicalize.ts` is the source of truth. Rules per `tg_mvp_plan/06-WORKERS-AND-INGESTION.md §9`:

1. Scheme → `https://`.
2. Host → lowercase, strip leading `www.` (but NOT `m.`).
3. Path → strip trailing slash (except root `/`).
4. Query → drop tracking params (`utm_*`, `fbclid`, `gclid`, `yclid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `ref`, `ref_src`, `igshid`, `si`); alphabetically sort the rest.
5. Fragment → always dropped.
6. Specific overrides:
   - `news.ycombinator.com` → `https://news.ycombinator.com/item?id=<id>`
   - `reddit.com/r/<sub>/comments/<id>/<slug>/` → `https://reddit.com/comments/<id>`
   - `twitter.com/...` / `x.com/...` → `https://x.com/<user>/status/<id>`

`canonicalization_rule_version` is a string stored on the `sources` row, bumped here when the rule set changes; Phase 4+ uses it to know whether to re-canonicalize old rows.

### Redirect resolution (one-time, at source creation)

`packages/sources/redirect-resolver.ts` exposes `resolveRedirect(rawUrl)` — issues an HTTP request with `redirect: 'follow'`, max 5 hops, 10s timeout, polite UA. Used **once** when the source is created, then never again per fetch (per edge case 4.7). The resolved URL is then canonicalized and stored as `canonical_url`. Failures (timeout, network error, max-hop) fall back to canonicalizing the raw input URL — we never block source creation on redirect resolution.

### Source vs subscription separation

The hardest concept to get right: a source is **global**, a subscription is **per-workspace**.

- `POST /sources` body has `{ url, type, name? }`. Server: resolve redirect → canonicalize → `INSERT INTO sources ... ON CONFLICT (canonical_url) DO UPDATE SET updated_at=now() RETURNING id`. Returns either the new `source_id` or the existing one. Then `INSERT INTO workspace_source_subscriptions (workspace_id, source_id, enabled=true) ON CONFLICT DO NOTHING`.
- `GET /sources` returns subscriptions for the caller's workspace JOINed with the global `sources` row.
- `PATCH /sources/:source_id` updates only the **subscription** (enabled, priority, custom_rules) — never the global `sources` row, because that's shared with other workspaces.
- `DELETE /sources/:source_id` deletes the subscription only (the global row stays).

This means: two workspaces adding `https://example.com/feed.xml?utm=x` and `https://example.com/feed.xml` end up sharing **one** `sources` row.

### Single-default topic profile per workspace (MVP constraint)

Schema allows many `topic_profiles` per workspace (Phase 5+ may extend). MVP UI restricts to one — the Mini App Settings screen shows a single editable topic form. The DB has no `UNIQUE (workspace_id) WHERE status='active'` constraint because we want to keep the door open without a migration.

The `createTopicProfile` command checks at write time: if an active profile already exists for the workspace, it `UPDATE`s it instead of inserting (upsert semantics from the UI's perspective). Explicit multi-profile support waits for Phase 5+.

## Files

- `packages/db/migrations/0003_phase3.sql` + `.down.sql` — Phase 3 schema (3 tables).
- `packages/db/migrations/0004_phase3_hardening.sql` + `.down.sql` — partial UNIQUE indices closing two race windows (added during step-perfect-loop main-1).
- `packages/db/src/schema.ts` — Drizzle definitions (mirrors both 0003 and 0004 exactly).
- `packages/sources/src/canonicalize.ts` — URL canonicalization rules + `canonicalize(url)` + `CANONICALIZATION_RULE_VERSION` constant.
- `packages/sources/src/redirect-resolver.ts` — `resolveRedirect(url)` one-time HTTP follow + 3-layer SSRF defence: (1) pre-fetch authoritative DNS allowlist via `resolve4`/`resolve6` (bypasses OS getaddrinfo cache so attacker DNS flips can't hide behind cached records); (2) post-fetch DNS-stability re-resolve detecting rebinding (rejects on IP-set drop OR new private IP, including on the `too_many_hops` exit); (3) blind-oracle property — no response body, only status+Location. IPv6 blocklist covers `::1`/`::`, NAT64 well-known `64:ff9b::/96` (kernel translates last 32 bits to embedded IPv4 — added r7), ULA `fc00::/7`, link-local `fe80::/10`, IPv4-mapped (dotted+hex), IPv4-compat (dotted+hex). Exports `ResolvedHostSnapshot` as the seam Phase 4's content fetcher will consume for true connect-time IP pinning.
- `packages/sources/src/index.ts` — re-exports.
- `packages/sources/src/__tests__/canonicalize.test.ts` — 23 cases (scheme, www, trailing slash, utm, sort, fragment, HN/Reddit/X overrides, idempotence).
- `packages/sources/src/__tests__/redirect-resolver.test.ts` — 35 cases (mock fetch, max-hop, timeout, HEAD-405 GET fallback, relative location, plus SSRF defence: loopback, AWS metadata, RFC1918, IPv6 ::1, IPv4-mapped, IPv4-compat, NAT64 `64:ff9b::/96`, multi-record mixed-private, DNS rebinding detection on normal exit and on `too_many_hops` exit, authoritative-resolver dual-stack merge).
- `packages/domain/src/topic.ts` — pure types: `TopicProfile`, `TopicProfileLanguage`, narrowers.
- `packages/domain/src/source.ts` — `Source`, `SourceType`, `SourceStatus`, `WorkspaceSourceSubscription`, narrowers.
- `packages/commands/src/topic-profiles.ts` — consolidated module: `createTopicProfile` (upsert + 23505-retry), `updateTopicProfile`, `deleteTopicProfile` (soft-delete), `listTopicProfiles`. All write `operation_log` (Rule 6) via the shared helper. `validateToneProfileDepth` for JSON-bomb defence (depth 8, nodes 200 counting both object keys AND array elements).
- `packages/commands/src/sources.ts` — consolidated module: `createSource` (resolve + canonicalize + ON CONFLICT global-source upsert + subscription upsert via partial unique index + topic-profile-active check with FOR SHARE), `updateSourceSubscription` (returns joined source for single-row PATCH), `deleteSourceSubscription`, `listSources`. All write `operation_log`. xmax-via-RETURNING for insert-vs-update.
- `packages/commands/src/operation-log.ts` — shared `writeOperationLog` helper (single Rule 6 surface) + `redactUrlForLog` (drops query string before URLs reach error-message logs).
- `packages/commands/src/topic-row-mappers.ts` — Phase 3 row → domain mappers.
- `apps/api/src/routes/topics.ts` — CRUD endpoints.
- `apps/api/src/routes/sources.ts` — CRUD endpoints. PATCH /sources projects from joined return — no second query.
- `apps/api/src/routes/topics-projection.ts` — domain → wire projections.
- `apps/miniapp/src/screens/SettingsScreen.tsx` — topic profile upsert form. MainButton wired (§4), FieldError for validation (§7), closingConfirmation on dirty form (§13). Imports pure helpers from `settingsView.ts`.
- `apps/miniapp/src/screens/SourcesScreen.tsx` — sources list + per-row toggle/delete pending state + DELETE confirmation modal + Skeleton-cell loading. Imports pure helpers from `sourcesView.ts`.
- `apps/miniapp/src/screens/AddSourceScreen.tsx` — URL+type form. MainButton wired (visible: !isSuccess to close double-tap), inputMode=url, FieldError.
- `apps/miniapp/src/screens/settingsView.ts` + `sourcesView.ts` — pure view-model helpers (form dirty-detection, validation, four-state selector, last-fetched formatting, per-row pending). Tested in isolation: 16 + 10 unit tests.
- `apps/miniapp/src/api/topics.ts` + `apps/miniapp/src/api/sources.ts` — clients.
- `packages/shared/src/topic-source-projection.ts` — wire schemas (Zod) shared between API + miniapp.

## Interfaces

### REST

| Method | Path                          | Body / Query                                                   | Returns |
|--------|-------------------------------|----------------------------------------------------------------|---------|
| POST   | `/topics`                     | `{ name, language, main_topics[], keywords[], negative_keywords[], tone_profile? }` | `TopicProfileProjection` |
| GET    | `/topics`                     | —                                                              | `{ items: TopicProfileProjection[] }` |
| PATCH  | `/topics/:id`                 | Partial of POST body                                           | `TopicProfileProjection` |
| DELETE | `/topics/:id`                 | —                                                              | `204` |
| POST   | `/sources`                    | `{ url, type, name?, topic_profile_id? }`                      | `SourceSubscriptionProjection` |
| GET    | `/sources`                    | —                                                              | `{ items: SourceSubscriptionProjection[] }` |
| PATCH  | `/sources/:source_id`         | `{ enabled?, priority?, topic_profile_id? }`                   | `SourceSubscriptionProjection` |
| DELETE | `/sources/:source_id`         | —                                                              | `204` |

All endpoints require Mini App initData (same `extractInitData` guard as Phase 2 routes). Role: `editor` for mutations, `viewer` for reads.

### Projections (wire types in `packages/shared/`)

```ts
type TopicProfileProjection = {
  id: string;
  name: string;
  language: 'ru' | 'en';
  main_topics: string[];
  keywords: string[];
  negative_keywords: string[];
  tone_profile: Record<string, unknown> | null;
  status: 'active' | 'disabled';
  embedding_status: 'pending' | 'ok' | 'failed';
  created_at: string; // ISO
  updated_at: string;
};

type SourceSubscriptionProjection = {
  subscription_id: string;
  source: {
    id: string;
    type: 'rss' | 'website' | 'api' | 'manual';
    url: string;
    canonical_url: string;
    name: string | null;
    fetch_interval_minutes: number;
    last_fetched_at: string | null;
    last_fetch_status: 'ok' | '4xx' | '5xx' | 'parse_error' | 'timeout' | null;
    last_fetch_error: string | null;
    status: 'active' | 'disabled' | 'error';
  };
  enabled: boolean;
  priority: number;
  topic_profile_id: string | null;
  created_at: string;
};
```

## How to extend

- **Multiple topic profiles per workspace (Phase 5+):** drop the upsert in `createTopicProfile`, expose a list/select UI. Schema already supports it.
- **Source health UI (Phase 4+):** `last_fetched_at`/`last_fetch_status`/`last_fetch_error` columns are already on `sources`; the worker writes them. The Mini App "Sources" screen shows placeholders today; Phase 4 fills them.
- **Custom subscription rules (Phase 5+):** `workspace_source_subscriptions.custom_rules jsonb` accepts arbitrary keys today (`{ "min_score": 7, "skip_categories": [...] }`). Used by matching in Phase 5.
- **"Check now" button (Phase 4+):** creates a `fetch_source` task with `priority=80`. The button is hidden in Phase 3 because the task system doesn't exist yet.
- **Canonicalization rule changes:** bump `CANONICALIZATION_RULE_VERSION` in `packages/sources/src/canonicalize.ts`. Phase 4 will introduce a backfill task that re-canonicalizes any row whose `canonicalization_rule_version` is stale.

## Risks

1. **Canonicalization mismatch between subscriptions:** if rules change post-MVP, two workspaces' subscriptions could end up pointing at different `sources` rows for the same logical feed. Mitigation: `canonicalization_rule_version` lets the Phase 4 backfill detect drift and merge.
2. **Redirect resolution fragility:** sources behind aggressive bot-blockers will fail HEAD. Fallback to canonicalizing raw URL avoids breaking source creation, but means the dedupe may miss `bit.ly/x` vs `medium.com/y`. Acceptable for MVP.
3. **~~No DB-level "single topic profile per workspace" constraint~~ — RESOLVED:** migration `0004_phase3_hardening.sql` adds the partial unique index `topic_profiles_one_active_per_workspace_uniq ON topic_profiles (workspace_id) WHERE status = 'active'`. `createTopicProfile` catches the 23505 unique violation on a race and retries (winner's row is then visible and lands on the UPDATE branch).
4. **Subscription with `topic_profile_id` referencing another workspace's profile:** the command must verify `topic_profile.workspace_id == subscription.workspace_id`. Test coverage in Phase 3, hardened in Phase 5 when scoring actually reads the link.

## Edge cases covered

From `tg_mvp_plan/12-EDGE-CASES.md §15` Phase 3:

- **4.6** Different URL forms of the same source → canonicalization → single `sources` row. ✓ (canonicalize.ts)
- **4.7** Redirect chain → resolved once at source creation. ✓ (redirect-resolver.ts)
- **4.11** URL with date query param → override in canonicalize.ts (date kept as stable content key for documented sources). ✓
- **5.4** Many topic_profiles per workspace → UI restricts to one (upsert in command). ✓ (create-topic-profile.ts)

## Status

Active. Validated through six `/step-perfect-loop` invocations (**8 main loops** total, 8 fix-commit rounds + 2 follow-ups + 6 doc commits). Closure tags: `phase-3-perfect` → `r2` → `r3` → `r4` → `r5` → `r6` → `r7` → **`phase-3-perfect-r8`** (current). Final MIN score remains **8 (GOOD)**; r8 closed validation hygiene only (`format:check` and phase diff whitespace), while `pl-breaker` remains at **10** from rounds 4-7 ("surface_still_exhausted: yes" — 4 consecutive). Round 5 added DNS rebinding detection; round 6 upgraded it from cached `dns.lookup` to authoritative `resolve4`/`resolve6`; round 7 added NAT64 `64:ff9b::/96` blocklist + `isFormDirty` language-dirty check + tap-target floor on SourceCell action buttons (defense-in-depth — none moved an individual reviewer's score). Round 7's perf-analyst explicitly classified the MIN cap as `architectural_requirement` after re-reading Rule 6 from `02-ARCHITECTURE.md`; r8 confirmed that cap still applies. Phase 4's content fetcher MUST implement connect-time IP pinning before going live (the TOCTOU residual becomes a hard blocker once response bodies are returned). §15 manual cross-platform QA gap is unreachable from automated review by definition. See `.claude/perfect-loop-runs/2026-05-17-phase-3-step/REPORT.md` and `.codex/perfect-loop-runs/20260517-phase-3-r8/REPORT.md` for close analysis.

## Last touched

2026-05-17
