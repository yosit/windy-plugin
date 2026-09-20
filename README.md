# Windy

Runline actions, Dripline SQL tables, and an agent skill for [windy.com](https://www.windy.com), backed by one shared TypeScript client. **No Windy weather CLI.**

## Package and migration

The migration target is one package, `@yosit/windy`, with client, `runline`, and `dripline` entry points and `skills/windy/SKILL.md`. New package publishing is a separate release step.

Replace old `@yosit/windy-skill` or `@yosit/windy-cli` imports with `@yosit/windy`. The former `windy` and `windy-skill` commands are removed. Existing login/refresh cron jobs must be replaced with host connection credentials and automatic session refresh. Do not copy JWTs into shell history.

See [migration status and capability boundaries](kb/migration.md). Historical changelog entries describe earlier releases, not the current API.

## Use through Runline

After loading the Runline adapter and configuring a Windy connection:

```javascript
const forecast = await windy.forecast.point({
  lat: 32.0853, lon: 34.7818, model: 'ecmwf', setup: 'summary'
});
return forecast;
```

Discover actions and input schemas through the host before selecting parameters. Runline returns client responses, including nested data. Mutations require user authorization and must never be included in automated live checks.

## Use through Dripline

After loading the Dripline adapter:

```sql
SELECT ts, temp_k - 273.15 AS temp_c, wind_ms
FROM windy_forecast_point
WHERE lat = 32.0853 AND lon = 34.7818 AND model = 'ecmwf'
ORDER BY ts
LIMIT 12;
```

Some hosts qualify tables with a connection name. Dripline is read-only and does not depend on Runline. Forecasts, soundings, observations and tides offer time-series rows; reference catalogs and metadata are also available.

## Credentials

Windy uses browser OAuth. Configure credentials through the host connection manager:

| Connection field | Optional environment mapping | Purpose |
| --- | --- | --- |
| `accountSid` | `WINDY_ACCOUNT_SID` | Authorized browser's `_account_sid` cookie; durable JWT refresh credential |
| `token` | `WINDY_TOKEN` | Pre-issued JWT; approximately 48 hours, cannot refresh without cookie |
| `proxy` | `WINDY_PROXY` | Explicit debugging proxy; ambient `HTTPS_PROXY` is ignored |

Public weather endpoints can be called anonymously; account operations require credentials. The separate commercial forecast API requires its own API key. Never log secrets. The legacy library session path remains `~/.config/windy-cli/session.json` for compatibility; do not confuse that with plugin connection storage.

## Library

```typescript
import { WindyClient } from '@yosit/windy';

const client = new WindyClient({ session: { uid: 'my-device-id' }, ephemeral: true });
const forecast = await client.pointForecast(32.0853, 34.7818);
```

`WindyClient.fromEnv()` supports the legacy library session plus explicit credential environment overrides. The adapters configure clients independently of the old CLI.

## Units and completeness

Forecast temperature: Kelvin. Wind: m/s, meteorological FROM degrees. Precipitation: mm per timestep. Timestamps: generally unix milliseconds UTC. Observation units can differ; inspect field documentation.

Search and nearby APIs are bounded responses, not bulk exports. Do not assume a server-sized response is exhaustive. Known gaps and unverified endpoint behavior are tracked in [the migration record](kb/migration.md).

## Development

```bash
pnpm install
pnpm build
pnpm lint
pnpm test
```

During migration the source adapters remain in `plugins/`. Build the root client before their individual TypeScript builds. Tests currently import the built client deliberately so prototype stubs target the same class as the adapters.

- `src/`: client, session storage, types, reference catalogs
- `plugins/`: independent adapter sources
- `skills/windy/SKILL.md`: authoritative shipped skill
- `kb/`: API evidence and migration status
- `tests/`: isolated deterministic tests

## License

MIT
