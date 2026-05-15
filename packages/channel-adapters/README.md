# @postdash/channel-adapters

Channel adapters package — Phase 2+.

Houses platform-specific transport for: Telegram (Phase 2), VK (Phase 13), Discord (future).

## Architecture rule

`packages/ai`, `packages/commands`, `packages/domain` MUST stay channel-agnostic. Platform-specific limits (e.g. Telegram's 4096-char post cap), platform entities, and platform verification calls live ONLY in `packages/channel-adapters/<platform>/`.

The Phase 0 MVP currently uses `TELEGRAM_POST_MAX_LENGTH` (from `@postdash/shared/telegram-format`) inside `packages/ai/src/providers/template.ts` — the concrete MVP fallback provider — because the only target channel is Telegram. The generic interface (`DraftOutputSchema` in `packages/ai/src/provider.ts`) is channel-agnostic and carries no length cap. The Telegram-specific cap is applied by (a) `TemplateProvider` for fallback drafts today, (b) the future `channel-adapters/telegram` package at publish-time validation. When the second adapter lands (Phase 9 / 13), per-channel validation moves here and `TemplateProvider`'s direct dependency on `TELEGRAM_POST_MAX_LENGTH` is replaced by a channel-aware truncation strategy.

See also: root `CLAUDE.md` and `tg_mvp_plan/02-ARCHITECTURE.md` ("Telegram is an adapter, not core").

First implementation lands in Phase 2 (`@postdash/channel-adapters/telegram`).
