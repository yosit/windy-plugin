---
name: windy
description: Query Windy weather forecasts, observations, tides, alerts, webcams, radar and satellite metadata through Runline actions or Dripline SQL tables. Use for location-specific weather questions, model comparisons, aviation or marine context, and authenticated saved locations. No Windy weather CLI is required.
---

# Windy

Use **Runline** for individual API calls and user-authorized mutations. Use **Dripline** for read-only SQL analysis. Neither adapter requires the other. Both are shipped with this skill in `@yosit/windy`.

## Vex installation

Install the standalone adapters into the current Vex workspace after building or
installing the package:

```sh
node dist/install.mjs
```

Use `--workspace /path/to/workspace` or `VEX_WORKSPACE_PATH` to target another
workspace. Use `--check` in deployment checks; it exits non-zero when either
adapter is missing or stale. The installer places independent bundles at
`.runline/plugins/windy/index.js` and `.dripline/windy.js`.

## Progressive discovery

Start narrow and escalate only when the first layer cannot answer the question:

1. **Resolve** — search a place, or use supplied coordinates.
2. **Snapshot** — use `forecast.now` / `windy_forecast_now` for current conditions.
3. **Forecast** — use `forecast.point` / `windy_forecast_point`; request summary
   or a model manifest only when daily output or an explicit model run is needed.
4. **Specialist data** — use stations, tides, alerts, webcams, air quality, or
   sounding tables/actions for that specific intent.
5. **Raw metadata** — use meteograms, radar/satellite archives, reference
   catalogs, or `*_raw`/JSON fields only when normalized fields are insufficient.

Inspect the host catalog and input schema at each step rather than loading or
calling every capability up front.

## Discovery first

Inspect the host's action/table catalog and schema before calling an unfamiliar capability. Runline exposes the `windy` namespace; Dripline tables start with `windy_`. SQL connection qualification depends on the host.

| Intent | Runline | Dripline |
| --- | --- | --- |
| Find a location | `windy.search.places` | `windy_places` |
| Hourly forecast | `windy.forecast.point` | `windy_forecast_point` |
| Daily forecast | `windy.forecast.point` with `setup: 'summary'` | `windy_forecast_summary` |
| Current conditions | `windy.forecast.now` | `windy_forecast_now` |
| Upper-air profile | `windy.forecast.sounding` / `meteogram` | `windy_forecast_sounding` / `windy_forecast_meteogram` |
| Measured weather | `windy.stations.nearby` / `observations` | `windy_stations_nearby` / `windy_station_observations` |
| Air quality forecast | `windy.forecast.airQuality` | `windy_forecast_air_quality` |
| Public severe-weather alerts | `windy.alerts.cap` | `windy_alerts_cap` |
| Tide heights | `windy.tides.point` / `byPoi` | `windy_tides` |
| Tropical cyclones | `windy.storms.list` | `windy_storms` |
| Nearby webcams | `windy.webcams.near` | `windy_webcams_near` |
| Radar / satellite metadata | `windy.radar.info` / `windy.satellite.info` | `windy_radar_info` / `windy_satellite_info` |
| Saved locations | `windy.account.favourites` | `windy_favourites` |
| Models, levels, overlays | `windy.reference.models` / `levels` / `overlays` | `windy_reference_models` / `windy_reference_levels` / `windy_reference_overlays` |

Resolve ambiguous place names before fetching weather; do not invent coordinates. Coordinate tables require equality filters on `lat` and `lon`.

```javascript
const places = await windy.search.places({ query: 'Tel Aviv', biasLat: 32, biasLon: 35 });
return places;
```

```sql
SELECT ts, temp_k - 273.15 AS temp_c, wind_ms
FROM windy_forecast_point
WHERE lat = 32.0853 AND lon = 34.7818 AND model = 'ecmwf'
ORDER BY ts
LIMIT 12;
```

## Authentication

Most public weather reads support anonymous access. Configure optional connection fields through the host's credential manager:

- `accountSid` / `WINDY_ACCOUNT_SID`: durable `_account_sid` cookie obtained from an authorized logged-in Windy browser. Supports JWT refresh.
- `token` / `WINDY_TOKEN`: pre-issued JWT, roughly 48-hour lifetime; cannot refresh without a cookie.
- `proxy` / `WINDY_PROXY`: optional explicit debugging proxy. Ambient `HTTPS_PROXY` is not used.

Windy uses browser OAuth; this integration does not automate password login or bypass browser challenges. Do not inspect a browser without authorization. Never print cookies, JWTs, or commercial API keys. The commercial forecast API uses its own key, not the web account's subscription.

## Interpretation and safety

- Forecast temperatures are Kelvin; subtract 273.15 for Celsius. Some observation endpoints already return Celsius: inspect column descriptions.
- Wind is m/s; direction is meteorological FROM degrees.
- Precipitation is mm per timestep, not automatically mm/hour.
- Timestamps are generally unix milliseconds UTC; display them in the location's timezone.
- Model run time is not observation time. Forecasts are predictions, not measurements.
- Search, nearby webcams, and CAP alerts are bounded responses, not guaranteed exhaustive global collections. Do not invent pagination parameters.
- Metadata JSON columns preserve nested responses. Inspect their contents rather than assuming undocumented fields.
- Require explicit user confirmation before creating, updating, or deleting favourites, alerts, webcams, settings, or push registrations. Never include mutations in routine smoke checks.
- Do not treat an empty result as proof of good weather when a request failed. Report upstream failures.
- Weather data is advisory; do not represent it as an authoritative aviation, marine, or emergency clearance.
