# Plugin migration record

## Target

One `@yosit/windy` package containing the shared client, Runline adapter, Dripline adapter, and `skills/windy/SKILL.md`. The CLI source is removed and is no longer published as a bin.

## Capability boundary

- **Runline:** individual reads plus authenticated mutations with explicit confirmation.
- **Dripline:** read-only SQL tables; no Runline dependency or initialization.
- **Client:** deterministic HTTP, session refresh, reference catalogs, and complete upstream payloads.
- **Skill:** host-neutral discovery and interpretation guidance; no CLI commands.

## Compatibility

Old package names `@yosit/windy-cli` and `@yosit/windy-skill` are not the migration target. Consumers should change imports to `@yosit/windy` and load the Runline/Dripline adapters through their host. The old CLI command is intentionally unsupported.

## Remaining release work

- Replace TypeScript source builds with standalone Vex bundles and installer.
- Test packed artifacts through the real Runline and Dripline loaders.
- Add the final smoke gate and publish workflow.
- Remove remaining CLI-only source/dependencies and stale docs.
- Validate live API checks with credentials; unit tests are not live verification.

## Epic #23 findings

- Authenticated Runline and Dripline clients load the shared persisted session, so a refreshed JWT is reused across calls and public reads do not trigger account bootstraps or the login throttle.
- Dripline decodes scaled DECIMAL qual objects as `value / 10^scale`. Dripline core 0.9.16 discards DECIMAL scale before plugin dispatch, so quoted coordinate predicates remain the workaround until the core fix ships.
- When Dripline core produces a null qual for `CAST(... AS DOUBLE)` coordinates, the adapter raises a clear unsupported-predicate error instead of silently yielding zero rows.
- `webcams.search` uses public place resolution plus `webcams.near` and client-side filtering; the former `/webcams/admin/v1.0/views` route returns 404.
- `search.places` validates `biasLat`/`biasLon`, accepts `lat`/`lon` aliases, and coordinate formatting rejects non-finite values without leaking `toFixed` errors.
