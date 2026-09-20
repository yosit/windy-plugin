---
title: Windy API Architecture
tags: [windy, api, architecture, endpoints, auth]
---

# Windy API Architecture

## API Bases

| Base | URL | Purpose | Auth |
|------|-----|---------|------|
| Account | `https://account.windy.com` | Login, user/account info, JWT exchange | `_account_sid` HttpOnly cookie + Bearer JWT |
| Node services | `https://node.windy.com` | Main REST API: forecasts, alerts, POIs, articles, search, webcams, favourites | JWT in `token2=` query or `Authorization: Bearer` (most endpoints work anonymously too) |
| Node static | `https://node-s.windy.com` | Static map image generator (`/imaker/map`) | None |
| Image service | `https://ims.windy.com` | Weather map tile images (`/im/v3.0/forecast/...`) | None |
| Image proxy | `https://imgproxy.windy.com` | Webcam thumbnails | None |
| Tiles | `https://tiles.windy.com` | Map labels (`/labels/v2.0/`), basemap tiles (`/tiles/v11.2/`) | None |
| Radar | `https://rdr.windy.com` | Radar composite metadata + tiles | None |
| Satellite | `https://sat.windy.com` | Satellite composite metadata | None |
| Webcams admin | `https://admin.windy.com` | Webcam text search (`/webcams/admin/v1.0/views`) | None |
| Static SPA | `https://www.windy.com` | SPA bundle + hot patches | None |

Versioned app bundle path: `https://www.windy.com/v/{version}/...`. Current observed version: `50.0.3.ind.f4a2`.

## Authentication Flow

**Type**: Hybrid — OAuth (Google/Facebook/Apple/email) → server session (`_account_sid` HttpOnly cookie) → JWT issued via `GET account.windy.com/api/info`.

### Step 1 — anonymous bootstrap

```
GET https://account.windy.com/api/info?country=xx&pr=1&sc=0&token2=pending&uid=<random-uuid>&v=50.0.3&poc=1
```

`uid` is a client-generated UUID stored in localStorage; `token2=pending` signals no session yet. Response includes a short-lived anonymous JWT (`magic:560, iat, exp` — ~2 days, no `userID`/`subscriptionTiers`).

### Step 2 — OAuth provider

Browser redirects through `https://accounts.google.com/...` consent → returns to windy → Windy sets the `_account_sid` HttpOnly cookie server-side.

### Step 3 — post-login token exchange

```
GET https://account.windy.com/api/info?country={cc}&pr=1&sc=1&token2=<previous-jwt>&uid=<uuid>&v=50.0.3&poc=1
Cookie: _account_sid=<session>
Authorization: Bearer <previous-jwt>
```

Response (full shape):

```json
{
  "message": "ok",
  "auth": true,
  "token": "<new JWT>",
  "userInfo": {
    "avatar": "https://ims-s.windy.com/account/images/{userId}-profileavatar.png?...",
    "email": "user@example.com",
    "username": "yosit",
    "userslug": "yosit",
    "verifiedEmail": "user@example.com",
    "joindate": 1496761159010,
    "fullname": "",
    "id": 89976,
    "requiresCookieConsent": false,
    "auth": true
  },
  "subscriptionInfo": {
    "tier": "premium",
    "status": "active",
    "state": "ok",
    "platform": "fastspring",
    "expiresAt": 1807228800000,
    "isSubscription": true,
    "isTrial": false
  },
  "subscription": "premium"
}
```

**Token lifetime**: 48 h (172800 s). Refreshed automatically by hitting `/api/info`.

**Refresh strategy for CLI**: persist `_account_sid` cookie + `uid` in `~/.config/windy-cli/session.json`. On each run, GET `account.windy.com/api/info?token2=pending&uid=<uid>&v=50.0.3&poc=1` with the cookie → extract the JWT from `response.token`.

### JWT Claims (HS256)

| Claim | Type | Example | Notes |
|-------|------|---------|-------|
| `magic` | int | `560` | Version-keyed constant |
| `userID` | int | `89976` | Only when authenticated |
| `subscriptionTiers` | string[] | `["premium"]` | Drives `pr=1`/`sc=1` flags |
| `iat` | unix s | `1778693120` | Issued-at |
| `exp` | unix s | `1778865920` | Expires (+48h) |

## Standard Query Parameter Envelope

All `node.windy.com` endpoints accept these (the SPA always sends them; most are advisory):

| Param | Required | Description |
|-------|----------|-------------|
| `token2` | recommended | JWT — required for user-data endpoints, optional for public ones |
| `uid` | yes | Client UUID stored in localStorage |
| `v` | yes | App version, e.g. `50.0.3` |
| `poc` | yes | Per-page-load monotonic counter (request sequence guard) |
| `pr` | yes | `1` if premium tier, `0` otherwise |
| `sc` | yes | `1` if subscription active, `0` otherwise |
| `source` | sometimes | UI origin (`hp` = home page, `detail`, `picker`) |
| `lang` / `userLanguage` | sometimes | ISO 639-1 |
| `country` | sometimes | ISO 3166-1 alpha-2 lowercase |

## Custom Headers

| Header | Set on | Value | Notes |
|--------|--------|-------|-------|
| `accept` | All API requests | `application/json binary/hcacaf$indf4a2` | The `$indf4a2` part matches the app version hash. Set but appears non-load-bearing — JSON content-type returned without it. |
| `windy-csrf` | `account.windy.com/api/info` | Long obfuscated string | Validated only on `account.*` requests. **Not required for `node.windy.com` endpoints.** |
| `authorization` | Some authenticated endpoints | `Bearer <jwt>` | Optional — `token2=` query param works equivalently |

## Path Obfuscation Scheme (Optional)

For some forecast point requests, the SPA serializes path+query into base64-encoded path segments:

```
/Zm9yZWNhc3Q/ZWNtd2Y/cG9pbnQv...
        │       │       │
        ├─ base64('forecast')
        │       ├─ base64('ecmwf')
        │       │       └─ base64('point/ecmwf/v2.9/{lat}/{lon}?{full query string with token2/uid/v/poc}')
```

Response body for these requests is also base64-encoded JSON (content-type `text/plain`).

**This obfuscation is OPTIONAL.** The same data is reachable via clean URLs:

```
/forecast/point/{model}/v2.9/{lat}/{lon}?refTime={ISO}&setup=summary&includeNow=true
```

returning standard `application/json`. The CLI uses the clean form.

## Endpoint Catalog

Grouped by resource domain. All paths are relative to `https://node.windy.com` unless noted.

### Forecast — point data

| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `GET /forecast/point/{model}/v2.9/{lat}/{lon}?refTime&setup&includeNow&step&interpolate&extended` | Multi-day forecast at a point | `setup`: `summary` for daily aggregation, omit for full hourly. `step` overrides default (3h for ECMWF). `extended=true` for premium 15-day. |
| `GET /forecast/point/now/{model}/v1.0/{lat}/{lon}?refTime` | "Now" snapshot | Single timestep |
| `GET /forecast/meteogram/{model}/v1.2/{lat}/{lon}?refTime&step` | Meteogram (hourly multi-param) | Used by detail panel hourly table |
| `GET /forecast/airq/{model}/v1.0/{lat}/{lon}?refTime` | Air-quality forecast | `model`: `cams` (global), `camsEu` (Europe high-res) |
| `GET /metadata/v1.0/forecast/{model}/minifest.json?premium` | Model availability + reftime list | `?premium=true` for premium-tier manifest |

### What premium actually unlocks

**All point-forecast models are available to free users.** Premium does not unlock new models — it unlocks better data on the models everyone sees, in four ways:

1. **Hourly temporal step (`step=1`) for the first 90–120 forecast hours**, vs `step=3` (3-hourly) for free. The manifest's `dst` field encodes this: free `[[3,3,90],...]` vs premium `[[1,1,90],...]`.
   - ECMWF: hourly for hours 1–90
   - GFS: hourly for hours 1–120

2. **Most-recent model run**: free gets the previous run, premium gets the new one as soon as it's published. Manifest comparison shows e.g. free `ref:"…T00:00:00Z"` vs premium `ref:"…T06:00:00Z"`.

3. **Extended 15-day window on ECMWF** via `extended=true` query param. Free is capped at 10 days. (`--extended` CLI flag.)

4. **Faster refresh interval** — premium polls the manifest more often:

| Speedup | Models |
|---------|--------|
| 12× (1 h vs 12 h) | HRRR (CONUS) |
| 4× (3 h vs 12 h) | HRRR-AK, ICON-D2, ICON-EU, AROME-HD, AROME-France, UKV, JMA-MSM |
| 2× (6 h vs 12 h) | ECMWF, GFS, ICON, NAM (Conus/HI/AK), AROME (Antilles/Réunion), ACCESS + 7 regional, HRDPS, ALADIN, JMA-CWM, RDWPS, ECMWF Wave, GFS Wave |
| no uplift | METEOBLUE, ICON-EU Waves, CAMS, CAMS-EU |

### Full per-model catalog

Captured 2026-05-13 from `window.W.products` in SPA v50.0.3. Hand-curated as `MODEL_CATALOG` in `src/types.ts`. Run `windy forecast models` for an interactive view filtered by your tier.

| Key | Name | Provider | Res (km) | Forecast (h) | Free refresh (min) | Premium refresh (min) |
|-----|------|----------|---------:|-------------:|-------------------:|----------------------:|
| `ecmwf` | ECMWF | ECMWF | 9 | 240 | 720 | 360 |
| `gfs` | GFS | NOAA | 22 | 360 | 720 | 360 |
| `icon` | ICON | DWD | 13 | 168 | 720 | 360 |
| `mblue` | METEOBLUE | Meteoblue | — | 240 | 720 | — |
| `iconD2` | ICON-D2 | DWD | 2.2 | 48 | 720 | 180 |
| `iconEu` | ICON-EU | DWD | 7 | 120 | 720 | 180 |
| `arome` | AROME-HD | Météo-France | 1.3 | 42 | 720 | 180 |
| `aromeFrance` | AROME (France) | Météo-France | 2.5 | 42 | 720 | 180 |
| `aromeAntilles` | AROME (Antilles) | Météo-France | 2.5 | 42 | 720 | 360 |
| `aromeReunion` | AROME (Réunion) | Météo-France | 2.5 | 42 | 720 | 360 |
| `ukv` | UKV | Met Office | 2 | 120 | 720 | 180 |
| `hrrrConus` | HRRR (CONUS) | NCEP | 3 | 72 | 720 | **60** |
| `hrrrAlaska` | HRRR-AK | NCEP | 3 | 72 | 720 | 180 |
| `namConus` | NAM (CONUS) | NOAA | 5 | 72 | 720 | 360 |
| `namHawaii` | NAM-HI | NOAA | 3 | 72 | 720 | 360 |
| `namAlaska` | NAM-AK | NOAA | 6 | 72 | 720 | 360 |
| `canHrdps` | HRDPS | MSC Canada | 2.5 | 240 | 720 | 360 |
| `czeAladin` | ALADIN | CHMI Czech | 2.3 | 240 | 720 | 360 |
| `jmaMsm` | MSM | JMA Japan | 5 | 240 | 720 | 180 |
| `bomAccess` | ACCESS | BOM | 12 | 240 | 720 | 360 |
| `bomAccessAd/Bn/Dn/Nq/Ph/Sy/Vt` | ACCESS-C regional × 7 | BOM | 1.5 | 36 | 720 | 360 |
| `ecmwfWaves` | ECMWF WAM | ECMWF | 9 | 240 | 720 | 360 |
| `gfsWaves` | GFS Wave | NOAA | 22 | 360 | 720 | 360 |
| `iconEuWaves` | ICON-EU EWAM | DWD | 7 | 240 | 720 | — |
| `jmaCwmWaves` | CWM | JMA Japan | 5 | 240 | 720 | 360 |
| `canRdwpsWaves` | RDWPS | MSC Canada | 2.5 | 240 | 720 | 360 |
| `cams` | CAMS (Global) | Copernicus | 40 | 240 | 720 | — |
| `camsEu` | CAMS (Europe) | Copernicus | 10 | 240 | 1440 | — |

### Forecast — tile data (binary)

| Endpoint | Notes |
|----------|-------|
| `GET https://ims.windy.com/im/v3.0/forecast/{model}/{run}/{forecastHour}/wm_grid_257/{z}/{x}/{y}/{layer}.jpg` | Per-layer pre-rendered weather data tiles. `{run}` = `YYYYMMDDHH`. `{layer}` = `wind-surface`, `temp-surface`, `rain`, `pressure`, `clouds`, `waves`, etc. |
| `GET /citytile/v1.0/{model}/{z}/{x}/{y}?hours&labelsVersion&refTime&step` | City overlay tile (place name + temp pairs) |
| `GET https://tiles.windy.com/labels/v2.0/{lang}/{z}/{x}/{y}.json` | Map label tile (place names) |
| `GET https://tiles.windy.com/tiles/v11.2/{style}/{z}/{x}/{y}.png` | Basemap tile. Styles: `darkmap-retina`, `winter`, `sat`, etc. |
| `GET /maptile/2.1/maptile/newest/satellite.day/{z}/{x}/{y}/256/jpg?token2` | HERE satellite basemap (windy proxies) |

### Search & geocoding

| Endpoint | Notes |
|----------|-------|
| `GET /search/v4.1/{biasLat}/{biasLon}/{query}?lang&size` | Location search biased to a point. Returns mixed types: `city`, `suburb`, `suburb_part`, `state`, `webcam`. Each result has `id`, `lat`, `lon`, `title`, `type`, `cc`, `country`, optional `region`, `state`, `bounds`. |
| `GET /reverse/v3/{lat}/{lon}/{zoom}?lang` | Reverse geocode. Returns `suburb`, `city`, `district`, `state`, `country`, `country_code`, `location: {name, id}`. Zoom level affects detail granularity (14 ≈ neighborhood). |
| `GET /services/elevation/{lat}/{lon}` | Elevation in meters as a bare JSON number. |
| `GET /services/v1/timezone/{lat}/{lon}?ts={unixSec}` | Timezone info for a coordinate at a given timestamp. |

### POIs (stations / air quality / tides)

| Endpoint | Notes |
|----------|-------|
| `GET /pois/v2/{type}/{lat}/{lon}` | Nearby POIs of `type`. Returns array sorted by distance. `type` ∈ {`airq`, `stations`, `tides`, `webcams`}. |
| `GET /pois/v2/{type}/{id}` | POI detail. `id` shape: `{type}-{stationKey}`, e.g. `airq-9weQ_Wbx`, `ad-LLBG`, `wmo-40180`, `pws-17f01bb50e`, `madis-G1000`. |
| `GET /obs/measurement/v3/{type}/{id}/{days}/{step}` | Historical observations timeseries. `days` ∈ {1, 3, 7, 10, 30}; `step` is hours-per-sample (1, 3, 6, 24). |

Station prefixes:
- `ad` — Airport / METAR (e.g., `ad-LLBG` for Ben Gurion)
- `wmo` — WMO synoptic station
- `pws` — Personal Weather Station (private uploaders)
- `madis` — MADIS (NOAA) network
- `airq` — Air-quality monitoring station (OpenAQ-backed)

### Tides

| Endpoint | Notes |
|----------|-------|
| `GET /tides/v1.0/tides/{lat}/{lon}` | Tide forecast for nearest port |
| `GET /tides/v1.0/tides/{poiId}` | Tide forecast by tide-station POI id |

### Alerts

| Endpoint | Notes |
|----------|-------|
| `GET /capalerts/{lat}/{lon}?lang&maxCount&source` | Public CAP (Common Alerting Protocol) gov't-issued alerts (severe weather). `maxCount` default 6. 204 when none. |
| `GET /notif/v1/live-alerts/{lat}/{lon}?distance&userLanguage` | Live alerts feed for user-subscribed locations. `distance` = `km` or `mi`. |

### Hurricanes / tropical cyclones

| Endpoint | Notes |
|----------|-------|
| `GET /tc/v2/storms` | Active storm list with positions + model list + per-hour radius defaults |
| `GET /tc/v2/storms/active/count` | Number of active storms |

### Webcams

| Endpoint | Notes |
|----------|-------|
| `GET /webcams/v2.0/list?nearby={lat,lon}&lang&imageSize&limit` | Nearest webcams. `imageSize` ∈ {`thumbnail`, `preview`, `original`}. Returns `{cams:[{id,title,lastUpdate,lastDaylight,location,images:{current,daylight}}], total}`. |
| `GET /webcams/v2.0/detail/{id}?imageSize&lang` | Webcam detail page |
| `GET /webcams/v3.0/archive/{id}?imageSize&archiveType` | Archive footage browse |
| `GET /webcams/v2.0/archive/hourly/{id}` | Hourly archive image list |
| `GET /webcams/ping/{id}` | Webcam health / metrics |
| `GET https://admin.windy.com/webcams/admin/v1.0/views?textQuery&lat&lon&lang` | Webcam text search |
| `GET /webcams/v1.0/webcams/image-url/{id}?size` | Image URL by webcam id (legacy) |

### Radar / Satellite

| Endpoint | Notes |
|----------|-------|
| `GET https://rdr.windy.com/radar2/composite/minifest2.json` | Radar composite metadata |
| `GET https://rdr.windy.com/radar2/composite/coverage.json` | Radar coverage polygon |
| `GET https://rdr.windy.com/radar2/archive/composite/minifest2.json` | Radar archive index |
| `GET https://sat.windy.com/satellite/composite.json` | Satellite composite metadata |
| `GET https://sat.windy.com/satellite/archive/range.json` | Satellite archive range |
| `GET /widget/{type}/{mode}/image?lat&lon&w&h&format` | Pre-rendered radar/satellite widget image. `type` ∈ {`satellite`, `radar`}, `mode` ∈ {`blue`, `default`}. |

### User data (require auth)

| Endpoint | Method | Notes |
|----------|--------|-------|
| `/users/settings?storeTs` | GET / POST | User UI/locale/units settings. `storeTs` query is a sync token. |
| `/users/v1/data/favs?storeTs` | GET / POST | Favourites list. Each item is wrapped: `{id, updated, value: {type:'fav', version, lat, lon, title, ...}}`. POST creates; server assigns the id. |
| `/users/v1/data/favs/{id}` | PUT / DELETE | Update / delete one favourite |
| `/users/v1/data/alerts?storeTs` | GET / POST | User-defined alerts. Each item wraps an alert with conditions, status (`triggered`/`normal`/`suspended`), and condition types (`cloudiness`, `freshSnow`, `rainfall`, `swell`, `temperature`, `time`, `wind`). |
| `/users/v1/data/alerts/{id}` | GET / PUT / DELETE | Single alert ops |
| `/users/v1/data/colors?storeTs` | GET / POST | Custom layer color palettes |
| `/users/v1/data/plugins?storeTs` | GET / POST | Installed plugin list |
| `/users/v3/devices/{uid}` | GET / POST | Device registration (push notifications). Returns 404 until first POST. |

### Airports

| Endpoint | Notes |
|----------|-------|
| `GET /airports/adinfo/{icao}` | Airport info: runways (with heading/elevation/lat/lon), METAR, TAF, IATA, elevation, wikipedia link. Source: `adds` (NOAA Aviation Weather). |

### Map overlay data

| Endpoint | Notes |
|----------|-------|
| `GET /citytile/v1.0/{model}/{z}/{x}/{y}?labelsVersion&step&refTime&hours` | City overlay data — list of named cities in tile, each with a per-step forecast curve for temperature pills. |

### Webcams (extra)

| Endpoint | Notes |
|----------|-------|
| `GET /webcams/ping/{id}` | Webcam health / metrics ping |
| `GET https://admin.windy.com/webcams/admin/v1.0/views?textQuery&lang&lat&lon` | Webcam text search across all webcams |

### Misc

| Endpoint | Notes |
|----------|-------|
| `GET /articles/startup/article?country,device,language,lat,loginStatus,lon,platform,target,userStatus,version` | Startup banner article |
| `GET /articles/startup/promotion?{same}&forceId` | Marketing promotion banner |
| `GET /services/umisteni?v&t&d` | Ad/feature placement config (Czech "placement") |
| `HEAD /sedlina/ga/1?{many}` | Google-Analytics-shaped event ping (skip) |
| `GET https://node-s.windy.com/imaker/map?c={lat,lon}&z={z}&size={w}` OR `?bbox={s,w,n,e}` | Pre-rendered static map image (PNG) |

## Entity Shapes

### PointForecast (setup=summary)

```ts
interface PointForecast {
  header: ForecastHeader;
  celestial: Celestial;
  summary: Record<DateString, DaySummary>; // YYYY-MM-DD → DaySummary
  data: TimeseriesData;
  now: NowSnapshot;
}

interface ForecastHeader {
  model: string;          // "ECMWF" — uppercase on the wire. The dripline plugin lowercases this on emit (and lowercases incoming model quals) so SQL predicates like `WHERE model = 'ecmwf'` match without `lower()`. See #9.
  refTime: string;        // ISO "YYYY-MM-DDTHH:00:00Z"
  update: string;         // ISO model run time
  updateTs: number;       // unix ms
  elevation: number;      // m, terrain at point
  step: number;           // hours between samples
  utcOffset: number;      // hours, point's TZ offset
  tzName: string;         // IANA timezone
  sunset: number;         // unix ms today's sunset
  sunrise: number;        // unix ms today's sunrise
  hasWaves: boolean;
  daysAvail: number;      // 15 for premium ECMWF, 10 for free
  modelElevation: number; // m, model grid cell elevation
}

interface Celestial {
  night: string;          // ISO Z
  sunsetTs: number;
  sunriseTs: number;
  duskTs: number;
  isDay: boolean;
  atSea: number;          // 0..1, fraction of sky above sea
  TZname: string;         // IANA
  TZoffset: number;       // hours
  TZoffsetMin: number;    // minutes
  TZoffsetFormatted: string; // "+03:00"
  TZabbrev: string;       // "GMT+3"
  TZtype: 't';
  nowObserved: string;    // ISO with offset
  sunset: string;         // "HH:mm" local
  sunrise: string;        // "HH:mm" local
  dusk: string;
}

interface DaySummary {
  icon: number;           // WMO-style icon id
  date: string;
  index: number;          // index into data.ts where this day starts
  timestamp: number;      // unix ms midnight local
  weekday: 'MON'|'TUE'|'WED'|'THU'|'FRI'|'SAT'|'SUN';
  day: number;            // day of month
  tempMax: number;        // Kelvin
  tempMin: number;        // Kelvin
  wind: number;           // m/s
  windDir: number;        // degrees (meteorological, from-direction)
  segments: number;       // count of timesteps in this day
}

interface TimeseriesData {
  ts: number[];           // unix ms
  temp: number[];         // Kelvin
  snow: number[];         // mm
  wind: number[];         // m/s
  mm: number[];           // precipitation mm per step
  // detailed setup adds: dewpoint, wind_u, wind_v, gust, rh, pressure, clouds_low/mid/high, hClouds, cape, ptype...
}

interface NowSnapshot {
  temp: number;           // Kelvin
  wind: number;           // m/s
  icon: number;
  windDir: number;        // degrees
  moonPhase: number;      // 0..7
}
```

### SearchResult

```ts
interface SearchResult {
  id: string;             // OSM-style or "webcam-{id}"
  lat: number;
  lon: number;
  title: string;
  type: 'city'|'suburb'|'suburb_part'|'state'|'country'|'webcam';
  cc?: string;            // ISO country code
  country?: string;
  region?: string;
  state?: string;
  bounds?: string;        // "minLat,minLon,maxLat,maxLon"
  webcamId?: string;      // if type=webcam
}
```

### ReverseGeocode

```ts
interface ReverseGeocode {
  suburb?: string;
  city?: string;
  district?: string;
  state?: string;
  country: string;
  country_code: string;   // lowercase ISO
  location: { name: string; id: string; };
}
```

### AirQualityPOI

```ts
interface AirQualityPOI {
  id: string;             // "airq-{key}"
  lat: number;
  lon: number;
  name: string;
  time: string;           // ISO Z
  mx: number; my: number; // projected map coords
  dataSource: string;     // "openaq.org"
  source: string;
  stationID: string;
  datastreams: null | any;
  rank: number;
  type: 'airq';
  quality: number;
  size: number;
  diff: number;           // minutes since measurement
  aqi: number | null;
  co: number | null; co_aqi: number | null;
  no2: number | null; no2_aqi: number | null;
  o3: number | null; o3_aqi: number | null;
  pm10: number | null; pm10_aqi: number | null;
  pm25: number | null; pm25_aqi: number | null;
  so2: number | null; so2_aqi: number | null;
}
```

### NearbyAirQualityStation

```ts
interface NearbyAirQualityStation {
  id: string;             // "airq-..."
  name: string;
  dataSource: string;
  dist: number;           // km
  lon: number; lat: number;
  aqi: number | null;
  diff: number;           // minutes since last measurement
  hAgo: number;
  minAgo: number;
}
```

### NearbyWeatherStation

```ts
interface NearbyWeatherStation {
  id: string;             // "ad-LLBG" | "wmo-40180" | "pws-..." | "madis-..."
  name: string;
  type: 'ad'|'wmo'|'pws'|'madis';
  lat: number; lon: number;
  dist: number;           // km
  diff: number;           // minutes since report
  hAgo: number; minAgo: number;
  // observations:
  temp: number | null;    // °C
  wind: number | null;    // m/s
  gust: number | null;    // m/s
  dir: number | null;     // degrees
  precip: number | null;  // mm
  precip_time: number | null; // hours
  qnh: number | null;     // hPa
  rh: number | null;      // % humidity
  dew_point: number | null; // °C
  wx_icon: number | null;
  is_airport?: 0|1;
}
```

### Webcam

```ts
interface Webcam {
  id: number;             // numeric id
  title: string;
  lastUpdate: number;     // unix ms
  lastDaylight: number;   // unix ms
  location: {
    lat: number; lon: number;
    title: string;
    city: string;
    country: string;
  };
  images: {
    current: string;      // URL to current snapshot
    daylight: string;     // URL to last daylight snapshot
  };
}

interface WebcamList { cams: Webcam[]; total: number; }
```

### CapAlert (CAP — Common Alerting Protocol)

204 No Content when no alerts at location. When present, returns array of `{id, sender, sent, status, msgType, scope, info: {category, event, urgency, severity, certainty, effective, expires, headline, description, instruction, area}}`.

### Hurricane / Storm

```ts
interface StormList {
  storms: Array<{ id: string; name: string; lat: number; lon: number; strength: number; windSpeed: number; }>;
  models: Record<string, { name: string; shortName: string; is_operated_by_windy: boolean; }>;
  defaultCircles: Record<string, number>; // hour → radius (m)
}
```

### MeasurementTimeseries (`/obs/measurement/v3/...`)

```ts
interface MeasurementTimeseries<TParam extends string = string> {
  header: {
    lat: number; lon: number; name: string;
    updated: string;        // ISO Z
    id: string;
    is_airport: 0|1; size: number;
    declination: number;
    dataSource: string;
    duplicates: string[];
    step: number;           // hours per sample
    start: number;          // unix ms
    type: 'airq'|'ad'|'wmo'|'pws'|'madis';
  };
  segments: Array<{ start: number; end: number; }>;
  data: { ts: number[]; } & Record<TParam, (number|null)[]>;
  calData?: { day: string[]; hour: number[]; ts: number[]; isDay: number[]; };
  summary?: Record<string, { date: string; index: number; timestamp: number; end: number; weekday: string; day: number; segments: number; }>;
  celestial?: Celestial;
}
```

For air quality: params include `pm25`, `pm25_aqi`, `pm10`, `pm10_aqi`, `co`, `no2`, `o3`, `so2`, plus `*_aqi` companions.

For weather stations: `temp`, `wind`, `gust`, `dir`, `precip`, `qnh`, `rh`, `dew_point`.

### Tropical Cyclone tracks

`/tc/v2/storms` → returns list above. Each storm also has detailed forecasts at deeper endpoint TBD (likely `/tc/v2/storms/{id}`).

### UserInfo / Subscription — see Authentication Flow.

### Favourite (user data)

```ts
interface Favourite {
  key: string;            // ObjectId-shaped (e.g. "618be2628c0abf90be6fcd5d")
  lat: number;
  lon: number;
  title: string;
  countryCode?: string;
  note?: string;
  pin?: boolean;
  pinOrder?: number;
  type?: 'location'|'webcam'|'station';
  createdTs?: number;
  // Server adds: storeTs (unix ms last modified, used for sync)
}
```

## Datetimes & Timezones

- **Timestamps in responses are unix milliseconds (UTC)** unless suffixed with non-numeric characters.
- **ISO strings** (e.g., `refTime`, `update`, `celestial.night`) end with `Z` → UTC.
- **`celestial.nowObserved` and short strings (`sunset`, `sunrise`, `dusk`)** are pre-formatted in the LOCATION's local timezone (offset stamped in or `HH:mm` short).
- **Temperatures**: Kelvin (subtract 273.15 for °C).
- **Wind speed**: m/s (× 3.6 → km/h, × 1.94384 → kt).
- **Precipitation**: mm per timestep (3 h for ECMWF).
- **Wind direction**: meteorological degrees (FROM direction; 0 = wind from N, 90 = from E).
- **Pressure (`qnh`)**: hPa.
- **Distance (`dist`)**: km (station results).
- Server returns `null` for missing scalar measurements; for arrays in `/obs/measurement` results, entries can be `null` for missing samples.

The user's preferred display units come from `node.windy.com/users/settings` — but the wire format above is always SI/Kelvin/meteorological.

## Error Reference

> Phase 6 TODO: trigger errors deliberately. Observed so far:
- **204 No Content** — empty result (e.g., `/capalerts/...` with no alerts, promo with no current promo).
- **200 with empty array** — many list endpoints (`{alerts:[]}`).
- **404** — _to verify_ for invalid IDs/coords
- **401** — _to verify_ for expired/missing JWT on user-data endpoints
- **403** — _to verify_ for premium gating

## Client-only features (no dedicated endpoint)

These plugins exist in `window.W.plugins` but don't hit a new endpoint — they consume `/forecast/point/...` or `/forecast/meteogram/...` for one or more coordinates and render client-side:

- **Sounding / Skew-T** (`sounding`, `radiosonde` plugins) — uses the **meteogram** endpoint, which returns 17 atmospheric levels × 6 parameters (`temp-{level}`, `dewpoint-{level}`, `rh-{level}`, `gh-{level}`, `wind_u-{level}`, `wind_v-{level}`). The CLI exposes a `windy forecast sounding` command that pivots the flat keys into a clean per-timestep × per-level structure.
- **Route planner** (`rplanner` plugin) — calls `/forecast/point/...` once per waypoint.
- **Distance tool** (`distance` plugin) — pure client measurement.
- **Wind trajectories** (`wind-trajectories` plugin) — client-side integration of the wind field tiles.
- **Multi-model comparison** (`multimodel` plugin) — calls point forecast for each model in parallel.
- **Share / embed link** (`share` plugin) — just builds a URL string from current map state.

## Overlay-only products (consumed as IMS image tiles, no point endpoint)

These products show as map layers via `https://ims.windy.com/im/v3.0/forecast/{model}/{run}/{forecastHour}/wm_grid_257/{z}/{x}/{y}/{overlay}.jpg`. They do NOT have a corresponding `/forecast/point/...` endpoint:

- **EFI** (ECMWF Extreme Forecast Index): `efiWind`, `efiTemp`, `efiRain`
- **Drought** (CzechGlobe): `drought40`, `drought100`, `moistureAnom40`, `moistureAnom100`, `soilMoisture40`, `soilMoisture100`
- **Fire weather**: `fwi` (Fire Weather Index), `dfm10h` (Dead Fuel Moisture)
- **Avalanche danger**: `avalancheDanger` — overlay tile aggregating regional avalanche bulletins
- **CAP alerts overlay**: `capAlerts` — global view of all government weather alerts
- **CMEMS marine**: `cmems` — Copernicus Marine Service (currents, SST)
- **Active fires**: NASA FIRMS — `activeFires` product
- **Pollen**: `pollenAlder`, `pollenBirch`, `pollenGrass`, `pollenMugwort`, `pollenOlive`, `pollenRagweed` — these are localization strings, NOT separate products. Pollen data is delivered via the `cams`/`camsEu` air-quality forecast.
- **Heatmaps**: `heatmaps` — aggregate user activity overlays
- **Topographic basemap**: `topoMap`

Use `windy tile data {model} {run} {hour} {overlay} {z} {x} {y}` to build the URL for any of these.

## Atmospheric levels

17 levels available in the meteogram response. From the surface up:

| Key | Pressure | Altitude (m) | Altitude (ft) | Flight level |
|-----|----------|-------------:|--------------:|--------------|
| `surface` | — | 0 | 0 | — |
| `100m` | — | 100 | 330 | — |
| `975h` | 975 hPa | 300 | 1000 | — |
| `950h` | 950 hPa | 600 | 2000 | — |
| `925h` | 925 hPa | 750 | 2500 | — |
| `900h` | 900 hPa | 900 | 3000 | — |
| `850h` | 850 hPa | 1500 | 5000 | — |
| `800h` | 800 hPa | 2000 | 6400 | — |
| `700h` | 700 hPa | 3000 | 10000 | FL100 |
| `600h` | 600 hPa | 4200 | 14000 | FL140 |
| `500h` | 500 hPa | 5500 | 18000 | FL180 |
| `400h` | 400 hPa | 7000 | 24000 | FL240 |
| `300h` | 300 hPa | 9000 | 30000 | FL300 |
| `250h` | 250 hPa | 10000 | 34000 | FL340 |
| `200h` | 200 hPa | 11700 | 39000 | FL390 |
| `150h` | 150 hPa | 13500 | 45000 | FL450 |
| `10h` | 10 hPa | 30000 | 98000 | FL980 |

(Surface and `100m` are returned only at points where the model surface is at or below sea level — at elevated terrain those levels return undefined.)

## Overlays catalog (66)

All renderable weather/composite overlays — used as the layer in IMS tile URLs and as the active product on the home map.

Wind/temp/humidity: `wind`, `temp`, `wetbulbtemp`, `dewpoint`, `gust`, `gustAccu`, `rh`. Precipitation/cloud: `rain`, `rainAccu`, `snowAccu`, `snowcover`, `ptype`, `clouds`, `lclouds`, `mclouds`, `hclouds`, `cloudtop`, `ccl`, `cbase`. Stability: `cape`, `thunder`, `deg0`, `turbulence`, `icing`. Other: `pressure`, `solarpower`, `uvindex`. Waves/ocean: `waves`, `wwaves`, `wavePower`, `swell`, `swell1-3`, `currents`, `currentsTide`, `sst`, `visibility`, `fog`. Air quality: `gtco3`, `pm2p5`, `no2`, `aod550`, `tcso2`, `go3`, `cosc`, `dustsm`, `aqi`. Imagery: `radar`, `satellite`, `topoMap`, `heatmaps`. Alerts: `capAlerts`, `avalancheDanger`, `hurricanes`. ECMWF EFI: `efiWind`, `efiTemp`, `efiRain`. Drought/fire: `moistureAnom40/100`, `drought40/100`, `soilMoisture40/100`, `fwi`, `dfm10h`.

## Public alternative — api.windy.com

Windy also operates **`https://api.windy.com/api/point-forecast/v2`** — a separate, documented Point Forecast API requiring its own API key (obtain at api.windy.com). Different auth (API key in POST body), simpler endpoint shape, lower throughput than the web app. Exposed by the CLI as `windy api point ...` with `WINDY_API_KEY` env var or `--key` flag.

Request shape (POST JSON):
```json
{
  "lat": 32.080, "lon": 34.781,
  "model": "gfs",
  "parameters": ["wind", "temp", "rh", "pressure"],
  "levels": ["surface", "850h", "500h"],
  "key": "<API_KEY>"
}
```

Response: `{ts: number[], "wind_u-surface": number[], "temp-850h": number[], ...}` — pre-flattened columnar arrays keyed by `{param}-{level}`. Available models on the public API: `gfs`, `gfsWaves`, `ecmwf`, `iconEu` (subset of the web-app models).

## Open Questions

1. Exact rate limits per endpoint.
2. Sub-endpoint of `/tc/v2/storms/{id}` for full track + forecast cone.
3. Exact body shape POST `/users/settings` accepts (whole object vs. patch).

## Real-time (WebSocket / SSE)

`W.http.createEventSource` exists, but no WebSocket / EventSource connections were observed during home page + detail panel browsing. Likely used for radar archive playback / live lightning.

## Field Value Vocabularies (Phase 4b sample, 2026-05-22)

The vocabularies below come from a 50-coord global sweep — anything not in this table is *unverified*. Where the vocabulary is open or sample-thin, the note says so explicitly so plugin descriptions don't lie.

### CAP alerts — the most consequential surprise

windy's `/capalerts/{lat}/{lon}` returns a **flat** object, **not** the wrapped CAP-standard envelope. The legacy `CapAlert { sender, sent, status, msgType, scope, info: { … } }` type in `types.ts` was wrong end-to-end and the dripline table was yielding undefined for every alert field. Real shape:

```json
{
  "id": "23320519",
  "start": 1779464040000,
  "end":   1779511500000,
  "type": "F",
  "severity": "S",
  "event": "Flood Watch",
  "headline": "Flood Watch issued May 22 at 10:34AM CDT until May 25 at 7:00PM CDT by NWS Houston/Galveston TX",
  "startLocal": { "weekday": "FRI", "day": "22", "month": "May", "year": "2026", "hour": "10" },
  "endLocal":   { "weekday": "FRI", "day": "22", "month": "May", "year": "2026", "hour": "23" }
}
```

Observed value vocabularies (1 alert per category in the sample — likely incomplete):

| Field | Observed | Notes |
|-------|----------|-------|
| `type` | `F` (Flood), `T` (Thunderstorms), `W` (Wind) | Single-letter code, NOT a CAP category string. More letters certainly exist; cross-reference with `event` for the human label. |
| `severity` | `M` (likely Minor/Moderate), `S` (likely Severe) | Single-letter code, NOT a CAP severity string. Mapping is approximate until more alerts sampled. |
| `event` | `Flood Watch`, `Thunderstorms`, `Wind` | Short human label. Localized to `WINDY_LANG`. |
| `startLocal.weekday` | `FRI` (the only one in-sample) | 3-letter uppercase, follows `Weekday` enum. |

**Server constraint:** `maxCount > 10` returns HTTP 400 (`maxCount must not be greater than 10`). Both runline + dripline clamp to 10.

### Search / `windy_places` — type vocabulary is open

I previously described `type` as ∈ {city, suburb, suburb_part, state, country, webcam}. Phase 4b across 6 queries × 4 bias coords returned **26 distinct categories**, all OpenStreetMap-style:

`aeroway`, `bus_stop`, `city`, `city_district`, `country`, `fuel`, `hamlet`, `historic`, `hostel`, `hotel`, `landuse`, `leisure`, `parking`, `pg` (paragliding), `place`, `railway`, `state`, `state_district`, `station`, `suburb`, `suburb_part`, `surf`, `town`, `village`, `webcam`, `wood`.

Treat as open vocabulary — windy proxies OSM data.

### Country code (`cc`, `country_code`)

100% of sampled rows are **lowercase 2-letter ISO 3166-1 alpha-2** (580 search results, 12 reverse-geocodes, 2 favourites). `Antarctica` → `aq`. Open ocean / north pole → empty `{}` (no country fields at all).

### Stations (`windy_stations_nearby`)

| Field | Observed (88 rows, 6 cities) |
|-------|------------------------------|
| `type` | `madis` (35), `wmo` (22), `pws` (19), `ad` (10), `ship` (2). My docs were missing `ship`. |
| `is_airport` | Always `undefined`. Filter on `type='ad'` instead. The flag appears only in observation-endpoint headers, not the nearby list. |

### Station observations (`windy_station_observations`)

Real `obs.data` keys (from `c.observations('ad','LLBG',3,1)`):
`temp`, `wind`, `windDir`, `dewPoint`, `pressure`, `weathercode`, `visibility`, `category`.

Critical mismatch I fixed: I had a column `dir` mapped to `rowJson.dir` — but the wire key is `windDir` (camelCase). Renamed column to `wind_dir`, added a fallback alias chain `windDir ?? wind_dir ?? dir` for safety. Also added `dew_point`, `visibility`, `weathercode`, `category` columns that were previously buried in `raw`.

Header has ~21 keys (not just the 8 in the legacy `ObservationHeader` interface). Phase 4b across 3 AD airports + 1 PWS confirmed all are consistently present on AD rows:

```json
{
  "lat": 40.6392, "lon": -73.7639,
  "source_name": "adds",
  "name": "John F. Kennedy International Airport",
  "updated": "2026-05-22T19:32:45.748Z",
  "id": "KJFK",
  "subtype": "large_airport",
  "is_airport": 1,
  "avg_delay_min": 8,
  "obs_count": 187,
  "latest_obs": "2026-05-22T18:51:00.000Z",
  "desc": "large_airport",
  "size": 187,
  "declination": -12.574288637914059,
  "start": 1779336000000,
  "observation": {
    "records": 187,
    "avgDelayMin": 8,
    "avgFreqMin": 53.903743315508024,
    "latestObs": "2026-05-22T18:51:00.000Z"
  },
  "duplicityId": "74486",
  "duplicityType": "wmo",
  "duplicates": ["74486"],
  "step": 3,
  "type": "ad"
}
```

Resolution (2026-05-22):

1. **TypeScript:** Expanded `ObservationHeader` in `src/types.ts` with `source_name`, `subtype`, `avg_delay_min`, `obs_count`, `latest_obs`, `desc`, `duplicityId`, `duplicityType`, and a new nested `ObservationMetrics` type for the `observation` block. `dataSource` kept as optional alias for back-compat (modern responses send `source_name`).
2. **Dripline table:** `windy_station_observations` now surfaces 15 `station_*` columns derived from the header (source_name, subtype, is_airport boolean, avg_delay_min, obs_count, latest_obs_ms, avg_freq_min, declination_deg, step_h, updated_ms, duplicity_id, duplicity_type, duplicates JSON) plus a `station_header_raw` JSON column. Same on every row of a single series (long-format consistency with forecast tables).
3. **Verified** by live-smoking KJFK obs — every new column populated with sensible values (e.g. `station_avg_freq_min: 53.9` for KJFK's ~hourly METAR cadence).

### Airports / runways

| Field | Observed | Notes |
|-------|----------|-------|
| `subtype` | `large_airport`, `medium_airport`, `small_airport` (8/3/2 across 15 ICAOs) | Heliport / seaplane_base documented but not in sample. |
| `scheduled_service` | `yes`, `no` (string, not boolean) | Plugin converts to boolean. |
| `runway.surface` | `ASP`, `ASPH`, `ASPH-G`, `PEM`, `CON`, `Grass`, `WATER` | Mix of 3-letter, 4-letter, and full words. NOT well-normalized — match with `LIKE` or normalize before filtering. |
| `runway.closed` | `0` (23/23) | Sample skewed toward operational airports. |
| `runway.lighted` | `1` (23/23) | Sample skewed toward modern airports. |

### Storms

Phase 4b caught only 1 active storm globally (a `strength: 0` tropical depression with `windSpeed: 9.8` m/s). Saffir-Simpson 0..5 is the doc-stated scale; can't verify higher categories without an active hurricane. Description retains "0 = tropical depression, 1..5 hurricane category" but the upper end is **unverified** from sampling.

`stormsCount` response shape: `{activeStormCount: <n>}` (NOT `{count: <n>}` as the type hinted). Plugin handles both.

### Forecast model manifest

I previously described `manifest->'refTimes'` as the run list — wrong. Real top-level keys: `dst` (active run id), `info`, `ref` (canonical ref-time), `update` (ISO), `v` (version), `end` (final timestep), `urls` (tile URL templates).

### Subscription (`/api/info` for premium accounts)

| Field | Observed |
|-------|----------|
| `subscription` | `premium`. `free` is the implicit complement (null/missing). |
| `subscriptionInfo.tier` | `premium`. |
| `subscriptionInfo.status` | `active`. Other states (`inactive`, `cancelled`, `trialing`) likely exist on lapsed accounts. |
| `subscriptionInfo.platform` | `fastspring`. App-store subscribers likely report `apple` / `google` — not in sample. |
| `subscriptionInfo.state` | `ok`. Not currently surfaced as a column. |

### Favourites

| Field | Observed (2 rows) |
|-------|-------------------|
| `value.type` | `fav` |
| `value.version` | `50.0.3` (matches `APP_VERSION` constant — windy stamps the client version on save) |
| `value.cc` | `il` (lowercase 2-letter; same as search/reverse) |

### Reproducing the sample

```bash
WINDY_DISABLE_LOGIN_THROTTLE=1 node -e "
const {WindyClient} = require('./dist/index.js');
const c = WindyClient.fromEnv();
c.capAlerts(29.7604, -95.3698, { maxCount: 10 }).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

The full sampler used to generate the table above lives in `/tmp/windy-sampler.mjs` during the sampling session; re-run when adding endpoints or after major windy feature releases.

## Methodology — digest-system v0.4 applied (2026-05-22)

The repo follows the digest-system skill methodology. Phases applied:

- **Phase 7c (field-completeness)** — every API field round-trips through either a runline action return or a dripline table column. Time-series tables expose a `header_raw` JSON column so the full server header survives; new surface-only scalar columns (`elevation_m`, `tz_name`, `utc_offset_h`, `sunrise_ms`, `sunset_ms`, `days_avail`, `step_h`, `has_waves`, `hClouds`) were added; runline `geo.elevation` returns the bare number (no `{elevationM:...}` wrap); runline `account.addFavourite` accepts every `FavouriteValue` field (`cc`, `note`, `pin`, `pinOrder`).
- **Phase 7d (progressive disclosure)** — top-of-file docstrings on both plugins (what + when + auth + top tables); every action/table description rewritten to name a user intent and cross-link related actions/tables.
- **Cross-cutting (v0.2.0 session lifecycle)** — `WINDY_PROXY` env support via lazy `https-proxy-agent` on every `https.request` (opt-in by exact name; deliberately does NOT honor ambient `HTTPS_PROXY`); public env-var surface capped at `WINDY_ACCOUNT_SID` + `WINDY_TOKEN` + `WINDY_PROXY`; `WINDY_UID` / `WINDY_LANG` / `WINDY_COUNTRY` / `WINDY_HTTP_TIMEOUT` are internal escape hatches (read by code, not advertised).

### Plugin layout

Plugins live under `plugins/` (per the v0.3.0 scaffold convention):

- `plugins/runline/` → `@yosit/runline-plugin-windy` — typed actions.
- `plugins/dripline/` → `@yosit/dripline-plugin-windy` — SQL tables (31 of them).

Both type-map `@yosit/windy` to the parent's built `../../dist/index.d.ts`. Build the parent first (`bun run build` at the repo root), then each plugin (`cd plugins/<name> && bun run build`).

### Forecast tables — division of labor

Three forecast tables target different ergonomics over the same underlying endpoints; pick by which fields you need:

| table | endpoint | row grain | params |
|-------|----------|-----------|--------|
| `windy_forecast_point` | `/forecast/point` | per timestep, surface only | temp, dewpoint, wind (u/v/mag/dir), gust, rh, pressure, precip, snow, clouds {low,mid,high,h}, cape, ptype |
| `windy_forecast_sounding` | `/forecast/meteogram` (pivoted) | per (timestep, level) — 17 levels | temp, dewpoint, rh, gh, wind u/v/mag/dir |
| `windy_forecast_meteogram` | `/forecast/meteogram` (raw) | per (timestep, level) — 17 levels | sounding params + surface-only extras (cape, ptype, gust, pressure, precip, snow, clouds) at `level='surface'` |

### Skipped phases

- **Phase 2b** (Vendor auth SDK replay) — N/A. Windy uses OAuth + a single bootstrap call (`account.windy.com/api/info`), not Transmit XM / ForgeRock / Ping / F5.
- **Phase 6 WAF diagnostics** — N/A so far. No CloudFront/Akamai/F5 rejections observed in practice.
