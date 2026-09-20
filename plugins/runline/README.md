# `@yosit/runline-plugin-windy`

A [runline](https://github.com/Michaelliv/runline) plugin that exposes the
[windy.com](https://www.windy.com) API as callable actions for agent code.

Built on top of [`@yosit/windy`](../../) — the plugin instantiates a
`WindyClient` per call using config from `ctx.connection.config`, so it stays
in lock-step with the CLI's auth handling and endpoint coverage.

## Install

Use runline's plugin installer pointed at this repo. The plugin lives in
the `plugins/runline/` subdirectory:

```bash
runline plugin install github:yosit/windy-cli#main:plugins/runline
```

Equivalent forms if your runline version prefers an explicit URL:

```bash
runline plugin install https://github.com/yosit/windy-cli.git#main:plugins/runline
runline plugin install git+https://github.com/yosit/windy-cli.git#path=plugins/runline
```

After install, add a connection (all fields optional — public endpoints
work anonymously):

```bash
runline connection add windy \
  --config token=$WINDY_TOKEN \
  --config accountSid=$WINDY_ACCOUNT_SID
```

## Local build (for development)

```bash
pnpm install
pnpm build    # tsc → dist/
pnpm lint     # tsc --noEmit
```

The `runline` peer dep is satisfied by a local shim
(`src/runline-shim.d.ts`) so the plugin type-checks before runline is
installed; the real types take over once `runline` is on the resolution
path.

## Connection schema

| field | env | required | notes |
|-------|-----|----------|-------|
| `token` | `WINDY_TOKEN` | no | Pre-issued JWT (`token2` value). |
| `accountSid` | `WINDY_ACCOUNT_SID` | no | `_account_sid` cookie value — bootstraps a JWT if `token` is omitted. |
| `uid` | `WINDY_UID` | no | Stable device UUID. Auto-generated per call if omitted. |
| `lang` | `WINDY_LANG` | no | ISO 639-1, default `en`. |
| `country` | `WINDY_COUNTRY` | no | ISO 3166-1 alpha-2 lowercase, default `xx`. |
| `proxy` | `WINDY_PROXY` | no | HTTPS proxy URL (e.g. `http://localhost:8080`) for debugging. |

All credentials are optional — most public endpoints (forecasts, search,
geo, stations, alerts, storms, webcams, tides) work anonymously. The
`account.*`, `alerts.live`, and webcam-archive actions require auth.

## Actions

### Forecast

| action | description |
|--------|-------------|
| `windy.forecast.point` | Multi-day point forecast (model selectable). |
| `windy.forecast.now` | Current-conditions snapshot at a point. |
| `windy.forecast.meteogram` | Hourly multi-parameter meteogram. |
| `windy.forecast.airQuality` | Air-quality forecast (CAMS / CAMS-Europe). |
| `windy.forecast.sounding` | Pressure-level sounding (skew-T). |
| `windy.forecast.modelManifest` | Available reftimes for a model. |

### Search / geo

| action | description |
|--------|-------------|
| `windy.search.places` | Location text search biased to a coord. |
| `windy.geo.reverse` | Reverse geocode. |
| `windy.geo.elevation` | Elevation in meters at a coord. |
| `windy.geo.timezone` | Timezone info for a coord at an instant. |

### Stations

| action | description |
|--------|-------------|
| `windy.stations.nearby` | Nearby weather stations (METAR / WMO / PWS / MADIS). |
| `windy.stations.nearbyAirQuality` | Nearby AQ monitoring stations. |
| `windy.stations.nearbyTides` | Nearby tide stations. |
| `windy.stations.airQualityDetail` | AQ POI detail (latest measurement). |
| `windy.stations.observations` | Historical obs timeseries. |

### Tides

| action | description |
|--------|-------------|
| `windy.tides.point` | Tides for nearest port to a coord. |
| `windy.tides.byPoi` | Tides by tide-POI id. |

### Alerts

| action | description |
|--------|-------------|
| `windy.alerts.cap` | Public CAP severe-weather alerts at a location. |
| `windy.alerts.live` | Live user alerts (requires auth). |

### Storms

| action | description |
|--------|-------------|
| `windy.storms.list` | Active tropical storms worldwide. |
| `windy.storms.count` | Count of active storms. |

### Webcams

| action | description |
|--------|-------------|
| `windy.webcams.near` | Webcams near a coord. |
| `windy.webcams.detail` | Webcam detail by id. |
| `windy.webcams.search` | Text search across webcams. |

### Airports

| action | description |
|--------|-------------|
| `windy.airports.info` | Airport info (runways, METAR, TAF) by ICAO code. |

### Account (require auth)

| action | description |
|--------|-------------|
| `windy.account.whoami` | Current user info / subscription. |
| `windy.account.favourites` | List favourites. |
| `windy.account.addFavourite` | Create a favourite. |
| `windy.account.updateFavourite` | Update favourite by id. |
| `windy.account.deleteFavourite` | Delete favourite by id. |
| `windy.account.userAlerts` | List user alerts. |
| `windy.account.userAlert` | Get a single user alert. |
| `windy.account.deleteUserAlert` | Delete user alert by id. |

## Units (wire format)

Values are returned exactly as the windy API delivers them — consumers
convert:

| field | unit |
|-------|------|
| Temperature | **Kelvin** |
| Wind speed | m/s |
| Wind direction | meteorological deg (FROM direction) |
| Precipitation | mm per timestep |
| Pressure | hPa |
| Distance | km |
| Timestamps | unix ms (UTC) |

## Example agent code

```javascript
// Inside a runline agent script
const here = await windy.geo.reverse({ lat: 32.0853, lon: 34.7818 });
const forecast = await windy.forecast.point({
  lat: 32.0853,
  lon: 34.7818,
  model: "ecmwf",
  setup: "summary",
});
const storms = await windy.storms.list({});
```
