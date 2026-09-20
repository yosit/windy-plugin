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
