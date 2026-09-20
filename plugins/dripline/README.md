# `@yosit/dripline-plugin-windy`

A [dripline](https://github.com/Michaelliv/dripline) plugin that exposes the
[windy.com](https://www.windy.com) API as SQL-queryable tables backed by
DuckDB.

Built on top of [`@yosit/windy`](../../) — every table instantiates a
`WindyClient` per call using config from `ctx.connection.config`, so it
stays in lock-step with the CLI's auth handling and endpoint coverage.

## Install

```bash
dripline plugin install git:github.com/yosit/windy-cli#packages/plugins/dripline
# or, since this plugin lives in a subdirectory:
dripline plugin install git+https://github.com/yosit/windy-cli.git#path=plugins/dripline
```

Then add a connection (all fields optional — public endpoints work
anonymously):

```bash
dripline connection add windy \
  --config token=$WINDY_TOKEN \
  --config accountSid=$WINDY_ACCOUNT_SID
```

## Local build (for development)

```bash
pnpm install
pnpm build    # tsc → dist/
pnpm lint     # tsc --noEmit
```

`dripline` is a peer dep. A local shim (`src/dripline-shim.d.ts`)
provides minimal types so this package type-checks before dripline is on
the resolution path; the real types take over once it is.

The TypeScript path mapping for `@yosit/windy` points at
`../../dist/index.d.ts`, so build the parent (`pnpm build` at the repo
root) before building the plugin.

## Connection schema

| field        | env                  | required | notes |
|--------------|----------------------|----------|-------|
| `token`      | `WINDY_TOKEN`        | no       | Pre-issued JWT (`token2` value). |
| `accountSid` | `WINDY_ACCOUNT_SID`  | no       | `_account_sid` cookie value — bootstraps a JWT when `token` is absent. |
| `uid`        | `WINDY_UID`          | no       | Stable device UUID. Auto-generated per call if omitted. |
| `lang`       | `WINDY_LANG`         | no       | ISO 639-1, default `en`. |
| `country`    | `WINDY_COUNTRY`      | no       | ISO 3166-1 alpha-2 lowercase, default `xx`. |
| `proxy`      | `WINDY_PROXY`        | no       | HTTPS proxy URL (e.g. `http://localhost:8080`) for debugging via mitmproxy / Charles / Burp. |

All credentials are optional — most public endpoints (forecasts, search,
geo, stations, alerts, storms, webcams, tides) work anonymously. The
`windy_account*`, `windy_favourites`, `windy_user_alerts*`, and
`windy_alerts_live` tables require auth.

## Tables

### Forecast

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_forecast_point`        | `lat`, `lon` | Multi-day forecast as long-format hourly rows (surface only). |
| `windy_forecast_summary`      | `lat`, `lon` | Daily aggregates (max/min temp, dominant wind, weather icon). One row per date. |
| `windy_forecast_now`          | `lat`, `lon` | Current-conditions snapshot (1 row). |
| `windy_forecast_sounding`     | `lat`, `lon` | Pressure-level (skew-T) — one row per (timestep, level). 6 standard upper-air params. |
| `windy_forecast_meteogram`    | `lat`, `lon` | Full meteogram fidelity — surface + 17 pressure levels with every parameter the endpoint exposes (one row per (timestep, level), including surface-only cape/ptype/gust/precip/snow/pressure/clouds). |
| `windy_forecast_air_quality`  | `lat`, `lon` | CAMS / CAMS-Europe AQ forecast (hourly long-format). |
| `windy_forecast_models`       | —            | Model manifest (reftimes + premium gating) as raw JSON. |

Optional key columns on forecast tables: `model`, `ref_time`, `step`.

### Geo & search

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_places`        | `query`        | Location text search; biased by `bias_lat` / `bias_lon`. |
| `windy_geo_reverse`   | `lat`, `lon`   | Reverse geocode (1 row). |
| `windy_geo_elevation` | `lat`, `lon`   | Elevation in m (1 row). |
| `windy_geo_timezone`  | `lat`, `lon`   | Timezone info for a coordinate at an instant. |

### Stations

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_stations_nearby`               | `query_lat`, `query_lon` | METAR / WMO / PWS / MADIS nearby weather stations. |
| `windy_stations_nearby_air_quality`   | `query_lat`, `query_lon` | Nearby AQ monitoring stations. |
| `windy_stations_nearby_tides`         | `query_lat`, `query_lon` | Nearby tide stations (raw JSON in `raw`). |
| `windy_station_air_quality`           | `id`                     | AQ POI detail — latest measurement. |
| `windy_station_observations`          | `station_type`, `station_id` | Historical observation timeseries. `station_type` ∈ {airq, ad, wmo, pws, madis}. |

### Tides

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_tides`          | (`query_lat`, `query_lon`) OR `poi_id` | Tide-height timeseries. |
| `windy_tide_extremes`  | (`query_lat`, `query_lon`) OR `poi_id` | High/low extremes. |

### Alerts / storms

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_alerts_cap`   | `query_lat`, `query_lon` | Public CAP severe-weather alerts. |
| `windy_alerts_live`  | `query_lat`, `query_lon` | Live user alerts (requires auth). |
| `windy_storms`       | —                        | Active tropical storms worldwide. |
| `windy_storms_count` | —                        | Active-storm count (1 row). |

### Webcams

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_webcams_near`    | `query_lat`, `query_lon` | Webcams near a coordinate. |
| `windy_webcam`          | `id`                     | Webcam detail. |
| `windy_webcams_search`  | `query`                  | Webcam text search. |

### Airports

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_airport`         | `icao` | Airport info (metadata + latest METAR/TAF JSON). |
| `windy_airport_runways` | `icao` | One row per runway. |

### Account (auth required)

| table | required key columns | description |
|-------|----------------------|-------------|
| `windy_account`      | —    | Current user / subscription (1 row). |
| `windy_favourites`   | —    | Saved favourites. |
| `windy_user_alerts`  | —    | User's saved alerts. |
| `windy_user_alert`   | `id` | One user alert by id. |

## Units (wire format)

Values are returned exactly as the windy API delivers them — consumers
convert as needed:

| field         | unit |
|---------------|------|
| Temperature   | **Kelvin** (`*_k`) |
| Wind speed    | m/s (`*_ms`) |
| Wind dir      | meteorological FROM direction, degrees (`*_dir_deg`) |
| Precipitation | mm per timestep (`*_mm`) |
| Pressure      | hPa (`*_hpa`) |
| Distance      | km (`*_km`) |
| Timestamps    | unix ms UTC (`*_ms`) plus an ISO datetime `ts` column on time-series tables |

## Example SQL

```sql
-- 5-day forecast for Tel Aviv at 6-hourly cadence
SELECT ts, temp_k - 273.15 AS temp_c, wind_ms, wind_dir_deg
FROM windy.windy_forecast_point
WHERE lat = 32.0853 AND lon = 34.7818
  AND model = 'ecmwf'
  AND step = 6
ORDER BY ts;

-- Pressure-level wind at 850 hPa over the next 48 h
SELECT ts, wind_ms, wind_dir_deg
FROM windy.windy_forecast_sounding
WHERE lat = 32.0853 AND lon = 34.7818
  AND level = '850h'
ORDER BY ts
LIMIT 16;

-- Currently active tropical storms ranked by intensity
SELECT name, lat, lon, strength, wind_speed_ms
FROM windy.windy_storms
ORDER BY wind_speed_ms DESC;

-- All severe-weather alerts in effect near a coordinate
SELECT event, severity, headline, expires
FROM windy.windy_alerts_cap
WHERE query_lat = 48.85 AND query_lon = 2.35
  AND severity IN ('Severe', 'Extreme');

-- Reverse geocode joined onto an elevation lookup
SELECT g.country, g.city, e.elevation_m
FROM windy.windy_geo_reverse g
JOIN windy.windy_geo_elevation e USING (lat, lon)
WHERE g.lat = 46.5475 AND g.lon = 7.9852;
```

## Notes

- Failed API calls log a warning via `dl.log.warn(...)` and yield zero
  rows, so a partial query (e.g. one bad coordinate) won't crash a join.
- Three forecast tables target different ergonomics over the same data:
  `windy_forecast_point` (surface time-series only), `windy_forecast_sounding`
  (pressure levels, 6 standard params), and `windy_forecast_meteogram` (full
  surface + pressure-level fidelity in one long-format table — pick this
  when you need cape / ptype / gust at surface AND upper-air winds in the
  same query).
- For mutating operations (create/update/delete favourites or alerts),
  use the CLI directly — dripline plugins expose read-only tables.
