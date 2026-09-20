# CLAUDE.md

This repository ships a shared Windy API client, Runline actions, a Dripline SQL adapter, and an agent skill. It does **not** ship a Windy weather CLI.

## Stack

- Bun, Node.js >=16-compatible output, TypeScript
- `https` for API transport
- Vitest for tests
- Runline and Dripline are optional host SDK peers of their adapters

## Commands

```bash
bun install
bun run build
bun run lint
bun test
```

Build the root client before adapter packages because their TypeScript path maps target the root declarations:

```bash
bun run build
bun run --filter @yosit/runline-plugin-windy build
bun run --filter @yosit/dripline-plugin-windy build
```

## Package layout

- `src/client.ts` — full Windy HTTP client
- `src/session.ts` — credential-grade session persistence and refresh helpers
- `src/catalog.ts` — local model/overlay/level/language reference data
- `src/types.ts` — API entities and reference catalogs
- `src/index.ts` — shared package exports
- `plugins/runline/src/index.ts` — typed actions; can run without Dripline
- `plugins/dripline/src/index.ts` — read-only SQL tables; can run without Runline
- `skills/windy/SKILL.md` — authoritative agent skill
- `kb/` — API evidence, intent, data strategy, and migration status

## Authentication

Windy uses OAuth in the browser, followed by an `_account_sid` cookie exchanged for an approximately 48-hour JWT at `account.windy.com/api/info`. The integration does not automate password login.

Connection fields exposed by both adapters:

- `accountSid` / `WINDY_ACCOUNT_SID` — durable browser cookie, supports JWT refresh
- `token` / `WINDY_TOKEN` — pre-issued JWT, cannot be refreshed without the cookie
- `proxy` / `WINDY_PROXY` — explicit debugging proxy; ambient `HTTPS_PROXY` is ignored

Most public forecasts, search, geo, station, alert, storm, webcam, and tide reads work anonymously. Account reads and mutations require authentication. Never log or commit cookies, JWTs, or API keys.

Sessions use `~/.config/windy-cli/session.json` for legacy library compatibility. Writes are atomic and credential-grade. `WINDY_SESSION_FILE` and `WINDY_LOGIN_HISTORY_FILE` are internal test escape hatches.

## Client behavior

`WindyClient` returns complete API payloads. It preserves Windy wire units: Kelvin temperature, m/s wind, meteorological FROM-direction degrees, mm per timestep, hPa pressure, and unix-ms UTC timestamps.

`ensureAuth()` only refreshes when a cookie-backed session is stale. Anonymous and token-only clients do not attempt an impossible cookie refresh. Each client may carry its own proxy; adapters include proxy in their connection cache key and never mutate global proxy environment state.

## Plugin rules

- Dripline is independently installable and read-only.
- Runline may expose mutations, but destructive or consequential actions require explicit confirmation.
- Runline actions return complete client responses.
- Dripline tables preserve complete nested/undocumented payloads in JSON columns where a normalized schema is not yet verified.
- Do not claim a server-sized response is exhaustive without pagination evidence.
- Live checks must be read-only and must not persist or print credentials.

## Knowledge base

Update `kb/windy-api-architecture.md`, `kb/windy-api-intent.md`, `kb/windy-data-strategy.md`, and `kb/migration.md` when behavior or packaging changes. `skills/windy/SKILL.md` is the user-facing discovery contract.

## Verification gate

Before closing an issue, run root and adapter builds/lints plus `bun test`. Before release, also run packed-artifact and real-host smoke checks. A passing unit suite is not evidence of live API success.
