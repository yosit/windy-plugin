/**
 * `@yosit/runline-plugin-windy` — windy.com as typed agent actions.
 *
 * What this is: a runline plugin exposing the windy.com API as typed
 * actions an agent can call directly. Use when the user asks about
 * weather forecasts, marine, air quality, severe-weather alerts,
 * tropical storms, tides, METAR/airports, weather stations, or webcams.
 * For SQL-style aggregation across many points see the sibling
 * `@yosit/dripline-plugin-windy`.
 *
 * Auth (all optional — most actions work anonymously):
 *   - `WINDY_ACCOUNT_SID` (recommended) — `_account_sid` cookie value;
 *     long-lived; auto-refreshes a JWT. Required for `account.*` and
 *     `alerts.live`.
 *   - `WINDY_TOKEN` — pre-issued JWT (~48 h), no refresh.
 *   - `WINDY_PROXY` — HTTPS proxy URL for debugging.
 *
 * Top actions to know:
 *   - `forecast.point` — hourly point forecast (any model).
 *   - `forecast.now` — current-conditions snapshot.
 *   - `forecast.sounding` — pressure-level sounding (aviation / soaring).
 *   - `search.places` — resolve a place name to lat/lon.
 *   - `storms.list` — active tropical cyclones.
 *   - `alerts.cap` — public severe-weather alerts at a location.
 *
 * Vex installation: this adapter is bundled as a standalone file at
 * `.runline/plugins/windy/index.js`; it has no dependency on Dripline or local
 * node_modules.
 *
 * Units stay on the wire: temperature Kelvin, wind m/s, pressure hPa,
 * timestamps unix ms UTC. Consumers convert.
 */
import type { RunlinePluginAPI } from "runline";
import { randomUUID } from "crypto";
import {
  WindyClient,
  WindyAPIError,
  referenceCatalog,
  PACKAGE_VERSION,
  type ClientOptions,
  type PersistedSession,
} from "@yosit/windy";

type Ctx = { connection: { config: Record<string, unknown> } };
type Input = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

// Module-level client cache. Without this, each action call constructs a
// fresh WindyClient with no token, and the first node.windy.com request
// triggers a /api/info bootstrap. A batch of sanity-check calls then burns
// through the persistent 8/24h login-throttle budget. Caching by connection
// config lets the JWT minted on the first call be reused by all later calls
// in the same process.
const clientCache = new Map<string, WindyClient>();
let autoUid: string | undefined;

function getClient(ctx: Ctx): WindyClient {
  const cfg = ctx.connection.config;
  const token = str(cfg.token);
  const accountSid = str(cfg.accountSid);
  const proxy = str(cfg.proxy);

  const uid = str(cfg.uid) ?? (autoUid ??= randomUUID());
  const country = str(cfg.country);
  const lang = str(cfg.lang);
  const key = JSON.stringify({ token, accountSid, uid, country, lang, proxy });

  const cached = clientCache.get(key);
  if (cached) return cached;

  const session: PersistedSession = { uid };
  if (token) session.token = token;
  if (accountSid) session.accountSid = accountSid;

  const opts: ClientOptions = {
    session,
    ephemeral: true,
    proxy,
    country,
    lang,
  };
  const c = new WindyClient(opts);
  clientCache.set(key, c);
  return c;
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WindyAPIError) {
      throw new Error(`windy ${e.status}: ${e.message}`);
    }
    throw e;
  }
}

export default function windy(rl: RunlinePluginAPI) {
  rl.setName("windy");
  rl.setVersion(PACKAGE_VERSION);

  rl.setConnectionSchema({
    token: {
      type: "string",
      required: false,
      description:
        "Pre-issued windy JWT (token2). Optional — most public endpoints work anonymously.",
      env: "WINDY_TOKEN",
    },
    accountSid: {
      type: "string",
      required: false,
      description:
        "_account_sid cookie value from a logged-in browser. Used to bootstrap a JWT when `token` is omitted.",
      env: "WINDY_ACCOUNT_SID",
    },
    lang: {
      type: "string",
      required: false,
      description: "ISO 639-1 language code (default `en`).",
      env: "WINDY_LANG",
      default: "en",
    },
    country: {
      type: "string",
      required: false,
      description: "ISO 3166-1 alpha-2 country code, lowercase (default `xx`).",
      env: "WINDY_COUNTRY",
      default: "xx",
    },
    uid: {
      type: "string",
      required: false,
      description: "Stable device UUID for the `uid` query param. Auto-generated per-call if omitted.",
      env: "WINDY_UID",
    },
    proxy: {
      type: "string",
      required: false,
      description: "HTTPS proxy URL for debugging (e.g. `http://localhost:8080`). Routes all outbound traffic through the proxy.",
      env: "WINDY_PROXY",
    },
  });

  for (const [name, value] of Object.entries(referenceCatalog)) {
    rl.registerAction(`reference.${name}`, {
      description: `Discover Windy ${name} before choosing forecast or map parameters. Returns the local reference catalog; no authentication or network required.`,
      inputSchema: {},
      async execute() { return value; },
    });
  }

  rl.registerAction("stations.poiDetail", {
    description: "Read complete POI metadata using a type and id discovered from nearby stations or webcams.",
    inputSchema: {
      type: { type: "string", required: true, description: "POI category, e.g. stations, airq, tides, webcams." },
      id: { type: "string", required: true, description: "Full POI identifier, e.g. ad-LLBG." },
    },
    async execute(input: Input, ctx: Ctx) { return getClient(ctx).poiDetail(String(input.type), String(input.id)); },
  });

  // ── Forecast ────────────────────────────────────────────────────────────

  rl.registerAction("forecast.point", {
    description:
      "Hourly multi-day forecast for one coord — temp/wind/precip series. Returns `{header, data, now?, summary?}`; `data.*` arrays parallel to `data.ts`. Pass `setup:'summary'` for daily aggregates.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853 for Tel Aviv." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818 for Tel Aviv." },
      model: {
        type: "string",
        required: false,
        description: "Forecast model (default `ecmwf`). e.g. ecmwf, gfs, icon, nems, arome.",
        default: "ecmwf",
      },
      refTime: {
        type: "string",
        required: false,
        description: "ISO-8601 model-run timestamp (e.g. `2026-05-13T12:00:00Z`). Omit for the latest run.",
      },
      setup: {
        type: "string",
        required: false,
        description: "Output shape. Only valid value is `summary`, which adds a per-day aggregate block (max/min temp, dominant wind, weather icon). Omit for the full hourly time-series.",
        enum: ["summary"],
      },
      includeNow: { type: "boolean", required: false, description: "If true, the response includes a `now` snapshot alongside the time-series. Default false." },
      step: { type: "number", required: false, description: "Hours per sample. `3` is the free-tier default, `1` is hourly (premium for first 90–120 h on ECMWF/GFS), `6` for sparser series." },
      interpolate: { type: "boolean", required: false, description: "If true, the server spatially interpolates between grid cells instead of returning the nearest gridpoint. Default false." },
      extended: { type: "boolean", required: false, description: "If true, request the extended-horizon output (ECMWF: 15 days for premium vs 10 days free). Default false." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.pointForecast(num(input.lat)!, num(input.lon)!, {
          model: str(input.model),
          refTime: str(input.refTime),
          setup: str(input.setup) === "summary" ? "summary" : undefined,
          includeNow: bool(input.includeNow),
          step: num(input.step),
          interpolate: bool(input.interpolate),
          extended: bool(input.extended),
        }),
      );
    },
  });

  rl.registerAction("forecast.now", {
    description:
      "Current-conditions snapshot at one coord — temp / wind / windDir / weather icon / moon phase. Use for 'what's the weather right now?' without paying for a full hourly series.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      model: { type: "string", required: false, default: "ecmwf", description: "Forecast model id. Common: `ecmwf` (default, global 9 km), `gfs`, `icon`, `iconEu`, `hrrrConus`, `arome`. Full catalog via `forecast.modelManifest`." },
      refTime: { type: "string", required: false, description: "ISO-8601 model-run timestamp (e.g. `2026-05-13T12:00:00Z`). Omit for the latest run." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.pointNow(num(input.lat)!, num(input.lon)!, {
          model: str(input.model),
          refTime: str(input.refTime),
        }),
      );
    },
  });

  rl.registerAction("forecast.meteogram", {
    description:
      "Raw meteogram (surface + 17 pressure levels, hourly). Use only if you need fields beyond `forecast.point` (turbulence, cape, multi-level wind). For a clean per-level pivot use `forecast.sounding`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      model: { type: "string", required: false, description: "Forecast model id. Common: `ecmwf` (default, global 9 km), `gfs`, `icon`, `iconEu`, `hrrrConus`, `arome`. Full catalog via `forecast.modelManifest`." },
      refTime: { type: "string", required: false, description: "ISO-8601 model-run timestamp (e.g. `2026-05-13T12:00:00Z`). Omit for the latest run." },
      step: { type: "number", required: false, description: "Hours per sample. Default 3; pass `1` for hourly (premium models), `6` for sparser series." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.meteogram(num(input.lat)!, num(input.lon)!, {
          model: str(input.model),
          refTime: str(input.refTime),
          step: num(input.step),
        }),
      );
    },
  });

  rl.registerAction("forecast.airQuality", {
    description:
      "Hourly air-quality forecast (CAMS global or camsEu Europe). Use when the user asks about pollutant forecasts (NO2/O3/PM2.5/PM10/SO2/CO/AQI). For measured station data use `stations.airQualityDetail`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      model: {
        type: "string",
        required: false,
        description: "Air-quality model. `cams` (default, 40 km global, CAMS) or `camsEu` (10 km Europe-only, CAMS-EU). Use `camsEu` for finer detail inside Europe.",
        enum: ["cams", "camsEu"],
        default: "cams",
      },
      refTime: { type: "string", required: false, description: "ISO-8601 model-run timestamp (e.g. `2026-05-13T12:00:00Z`). Omit for the latest run." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      const model = str(input.model);
      return run(() =>
        c.airQualityForecast(num(input.lat)!, num(input.lon)!, {
          model: model === "camsEu" ? "camsEu" : "cams",
          refTime: str(input.refTime),
        }),
      );
    },
  });

  rl.registerAction("forecast.sounding", {
    description:
      "Pressure-level sounding (skew-T) — per-timestep × per-level samples with derived wind speed/direction. Use for aviation, glider, paragliding, or any upper-air question.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      model: { type: "string", required: false, description: "Forecast model id. Common: `ecmwf` (default, global 9 km), `gfs`, `icon`, `iconEu`, `hrrrConus`, `arome`. Full catalog via `forecast.modelManifest`." },
      refTime: { type: "string", required: false, description: "ISO-8601 model-run timestamp (e.g. `2026-05-13T12:00:00Z`). Omit for the latest run." },
      step: { type: "number", required: false, description: "Hours per sample. Default 3; pass `1` for hourly (premium models), `6` for sparser series." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.sounding(num(input.lat)!, num(input.lon)!, {
          model: str(input.model),
          refTime: str(input.refTime),
          step: num(input.step),
        }),
      );
    },
  });

  rl.registerAction("forecast.modelManifest", {
    description:
      "Available model reftimes + premium gating. Use to discover the latest `refTime` for a model before calling `forecast.point` / `forecast.meteogram` with an explicit run.",
    inputSchema: {
      model: {
        type: "string",
        required: false,
        description: "Model identifier (manifest run id). Defaults to `ecmwf-hres`. Accepts the user-facing alias `ecmwf` and maps it to `ecmwf-hres`. Other examples: `gfs`, `icon-global`, `hrrr-conus`, `arome-france`. See MODEL_CATALOG in @yosit/windy types for the full list.",
        default: "ecmwf-hres",
      },
      premium: { type: "boolean", required: false, description: "If true, request premium-tier reftimes (faster refresh cadence). Default true. Pass false to see only free-tier runs.", default: true },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.modelManifest(str(input.model), bool(input.premium) ?? true));
    },
  });

  // ── Search / geocoding ──────────────────────────────────────────────────

  rl.registerAction("search.places", {
    description:
      "Resolve a place name to (lat, lon). Use as the first step when the user names a place (\"Reykjavik\", \"Big Sur\") instead of coords. Results biased toward (`biasLat`, `biasLon`) for disambiguation.",
    inputSchema: {
      query: { type: "string", required: true, description: "Free-text place name. Examples: `\"Tel Aviv\"`, `\"Eiffel Tower\"`, `\"LLBG\"` (matches airport codes too)." },
      biasLat: { type: "number", required: true, description: "Bias-point latitude, decimal degrees. Results closer to (biasLat, biasLon) rank higher. Pass `0` if you have no preference." },
      biasLon: { type: "number", required: true, description: "Bias-point longitude, decimal degrees. Pass `0` if you have no preference." },
      size: { type: "number", required: false, description: "Max results to return. Default 13. API range: min 10, max ~25 — values < 10 are clamped up.", default: 13 },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.search(
          String(input.query),
          num(input.biasLat)!,
          num(input.biasLon)!,
          num(input.size) ?? 13,
        ),
      );
    },
  });

  rl.registerAction("geo.reverse", {
    description:
      "Reverse-geocode a coord to suburb / city / district / state / country. Use when you have lat/lon and need a human-readable label. `zoom` 14 ≈ neighborhood, 10 ≈ city.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      zoom: { type: "number", required: false, description: "Detail level (web-map zoom). `10` ≈ city, `14` ≈ neighborhood (default), `18` ≈ street. Lower zoom = broader admin area.", default: 14 },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.reverseGeocode(num(input.lat)!, num(input.lon)!, num(input.zoom) ?? 14));
    },
  });

  rl.registerAction("geo.elevation", {
    description:
      "Elevation in meters at a coord (returns a bare number). Use for altitude / terrain questions or pressure-altitude conversions.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.elevation(num(input.lat)!, num(input.lon)!));
    },
  });

  rl.registerAction("geo.timezone", {
    description:
      "Timezone metadata at a coord and instant (default: now). Use to convert UTC forecast timestamps to local time, or to detect DST transitions.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      ts: {
        type: "number",
        required: false,
        description: "Unix milliseconds UTC at which to resolve the timezone (needed for DST handling). Default: server `Date.now()`. Example: `1778705511377`.",
      },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.timezone(num(input.lat)!, num(input.lon)!, num(input.ts) ?? Date.now()));
    },
  });

  // ── Stations / POIs ─────────────────────────────────────────────────────

  rl.registerAction("stations.nearby", {
    description:
      "Nearby ground weather stations (METAR + WMO + PWS + MADIS) with latest obs. Use when the user wants OBSERVED weather (vs forecast). Feed `id` into `stations.observations` for history.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.nearbyStations(num(input.lat)!, num(input.lon)!));
    },
  });

  rl.registerAction("stations.nearbyAirQuality", {
    description:
      "Nearby measured AQ stations with current AQI snapshot. Feed `id` into `stations.airQualityDetail` for the full pollutant breakdown. For forecast AQ use `forecast.airQuality`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.nearbyAirQuality(num(input.lat)!, num(input.lon)!));
    },
  });

  rl.registerAction("stations.nearbyTides", {
    description:
      "Nearby tide POIs (port list). Use to discover a `poiId` to pass to `tides.byPoi`. If you just want tides at a coord, `tides.point` is enough.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.nearbyTides(num(input.lat)!, num(input.lon)!));
    },
  });

  rl.registerAction("stations.airQualityDetail", {
    description:
      "Full latest measurement at one AQ station — every pollutant + its per-pollutant AQI. Use after `stations.nearbyAirQuality` once you've picked an `id`.",
    inputSchema: {
      id: { type: "string", required: true, description: "Air-quality station id (with or without the `airq-` prefix — the client strips it). Get one from `stations.nearbyAirQuality`. Example: `airq-1029` or `1029`." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.airQualityStation(String(input.id)));
    },
  });

  rl.registerAction("stations.observations", {
    description:
      "Historical observation time-series for one station — temp / wind / gust / pressure / RH / precip. Use to backtest a forecast or build a microclimate baseline. `type` ∈ {airq, ad, wmo, pws, madis}.",
    inputSchema: {
      type: {
        type: "string",
        required: true,
        description: "Station network. `ad` = airport METAR, `wmo` = WMO, `pws` = personal weather stations, `madis` = MADIS, `airq` = air-quality. The `id` returned by `stations.nearby` includes the matching type.",
        enum: ["airq", "ad", "wmo", "pws", "madis"],
      },
      id: { type: "string", required: true, description: "Station id (with or without the type prefix — the client strips `airq-`/`ad-`/`wmo-`/`pws-`/`madis-`). Get one from `stations.nearby` or `stations.nearbyAirQuality`." },
      days: {
        type: "number",
        required: false,
        description: "Look-back window in days. Server accepts {1, 3, 7, 10, 30}. Default 10.",
        default: 10,
      },
      step: {
        type: "number",
        required: false,
        description: "Hours per sample. `1` = hourly (default), `3` = 3-hourly, `24` = daily summaries.",
        default: 1,
      },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.observations(
          str(input.type) as "airq" | "ad" | "wmo" | "pws" | "madis",
          String(input.id),
          num(input.days) ?? 10,
          num(input.step) ?? 1,
        ),
      );
    },
  });

  // ── Tides ───────────────────────────────────────────────────────────────

  rl.registerAction("tides.point", {
    description:
      "Tide-height forecast at port nearest a coord. Use for sailing/fishing/coastal access. For a specific port use `tides.byPoi`. Returns `{header, data, extremes}`; `data.height` parallels `data.ts`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.tides(num(input.lat)!, num(input.lon)!));
    },
  });

  rl.registerAction("tides.byPoi", {
    description:
      "Tide-height forecast for a specific tide-POI. Use after `stations.nearbyTides` returns a `poiId` you want to pin to.",
    inputSchema: {
      poiId: { type: "string", required: true, description: "Tide-POI id (e.g. `tide-1234`). Get one from `stations.nearbyTides`." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.tidesByPoi(String(input.poiId)));
    },
  });

  // ── Alerts ──────────────────────────────────────────────────────────────

  rl.registerAction("alerts.cap", {
    description:
      "Government-issued severe-weather alerts at a location. Public, no auth. Returns a FLAT shape with single-letter `type` (`F`/`T`/`W`/…) and `severity` (`M`/`S`/…) codes plus `event` label, `headline` sentence, and `start`/`end` unix-ms windows — NOT the wrapped CAP envelope. For PERSONAL threshold alarms see `alerts.live`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      maxCount: { type: "number", required: false, description: "Maximum alerts to return. Default 6. Server caps at 10 — higher values are transparently clamped by the client (no 400 error).", default: 6 },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.capAlerts(num(input.lat)!, num(input.lon)!, { maxCount: num(input.maxCount) }),
      );
    },
  });

  rl.registerAction("alerts.live", {
    description:
      "Live alerts the SIGNED-IN user subscribed to (push-style threshold alarms). Requires auth. For public severe-weather at a location use `alerts.cap`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      distance: {
        type: "string",
        required: false,
        description: "Unit for any distance fields the server returns. `km` (default) or `mi`.",
        enum: ["km", "mi"],
        default: "km",
      },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      const d = str(input.distance) === "mi" ? "mi" : "km";
      return run(() => c.liveAlerts(num(input.lat)!, num(input.lon)!, d));
    },
  });

  // ── Storms ──────────────────────────────────────────────────────────────

  rl.registerAction("storms.list", {
    description:
      "Active tropical cyclones worldwide. Use for hurricane/typhoon/cyclone questions. Returns `{storms, models, defaultCircles}`; `strength` = Saffir-Simpson 0..5 (0 = tropical depression).",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.storms());
    },
  });

  rl.registerAction("storms.count", {
    description:
      "Cheap probe — count of active tropical cyclones. Use before fetching the full `storms.list` if you only need a number.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.stormsCount());
    },
  });

  // ── Webcams ─────────────────────────────────────────────────────────────

  rl.registerAction("webcams.near", {
    description:
      "Webcams near a coord with current image URLs. Use for visual ground truth (\"what does it actually look like there?\"). For full detail use `webcams.detail`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      limit: { type: "number", required: false, description: "Max webcams to return. Default 10–20 (server-controlled). Pass a smaller value for a brief survey." },
      imageSize: {
        type: "string",
        required: false,
        description: "Image variant URL to populate. `thumbnail` (default, smallest), `preview` (medium), `original` (full-res).",
        enum: ["thumbnail", "preview", "original"],
        default: "thumbnail",
      },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      const sz = str(input.imageSize);
      return run(() =>
        c.webcamsNear(num(input.lat)!, num(input.lon)!, {
          limit: num(input.limit),
          imageSize:
            sz === "preview" || sz === "original" || sz === "thumbnail" ? sz : "thumbnail",
        }),
      );
    },
  });

  rl.registerAction("webcams.detail", {
    description:
      "Full detail for one webcam by id (location, freshest image URLs). Use after `webcams.near` or `webcams.search` to grab a high-res frame.",
    inputSchema: {
      id: { type: "string", required: true, description: "Webcam numeric id (string-form). Get one from `webcams.near` or `webcams.search`." },
      imageSize: {
        type: "string",
        required: false,
        description: "Image variant URL to populate. `thumbnail`, `preview` (default), `original` (full-res).",
        enum: ["thumbnail", "preview", "original"],
        default: "preview",
      },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      const sz = str(input.imageSize);
      return run(() =>
        c.webcamDetail(
          String(input.id),
          sz === "thumbnail" || sz === "original" || sz === "preview" ? sz : "preview",
        ),
      );
    },
  });

  rl.registerAction("webcams.search", {
    description:
      "Webcam text search by name / location. Use when the user names a place (\"Eiffel Tower\", \"Big Sur\") instead of giving coords.",
    inputSchema: {
      query: { type: "string", required: true, description: "Free-text query matching webcam title / city / country. Example: `\"Big Sur\"`, `\"Eiffel\"`." },
      lat: { type: "number", required: false, description: "Optional bias-point latitude (decimal degrees) — closer webcams rank higher." },
      lon: { type: "number", required: false, description: "Optional bias-point longitude (decimal degrees)." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() =>
        c.webcamSearch(String(input.query), { lat: num(input.lat), lon: num(input.lon) }),
      );
    },
  });

  // ── Airports ────────────────────────────────────────────────────────────

  rl.registerAction("airports.info", {
    description:
      "Airport info by ICAO — name, elevation, runways (heading + surface), latest METAR/TAF, frequencies. Use for aviation context: alternate planning, METAR/TAF, runway/wind alignment.",
    inputSchema: {
      icao: { type: "string", required: true, description: "ICAO 4-letter airport code, case-insensitive. Examples: `KJFK` (JFK), `EGLL` (Heathrow), `LLBG` (Ben Gurion). Use IATA→ICAO lookups if you only have a 3-letter code." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.airport(String(input.icao)));
    },
  });

  // ── Account ─────────────────────────────────────────────────────────────

  rl.registerAction("account.whoami", {
    description:
      "Signed-in user profile + subscription state. Use to verify auth is wired up, check premium tier, or grab the user id.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.whoami());
    },
  });

  rl.registerAction("account.favourites", {
    description:
      "Coordinates the user has bookmarked in the windy app. Requires auth. Use to drive batch forecasts for places the user cares about.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.favourites());
    },
  });

  rl.registerAction("account.addFavourite", {
    description: "Bookmark a coordinate in the user's windy account. Requires auth. Returns the created favourite (server assigns id + timestamps). To find created entries later use `account.favourites`.",
    inputSchema: {
      lat: { type: "number", required: true, description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N). Example: 32.0853." },
      lon: { type: "number", required: true, description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E). Example: 34.7818." },
      title: { type: "string", required: false, description: "Human-readable label shown in the windy app sidebar. Example: `\"Home\"`, `\"Cabin\"`." },
      name: { type: "string", required: false, description: "Internal name used in URL slugs. Lowercase / hyphenated. Example: `\"home\"`." },
      type: { type: "string", required: false, description: "Favourite kind. Default `fav` (the only value windy currently accepts here)." },
      cc: { type: "string", required: false, description: "ISO 3166-1 alpha-2 country code, lowercase. Example: `\"il\"`, `\"us\"`." },
      note: { type: "string", required: false, description: "Free-form user note attached to the favourite. Visible in the app." },
      pin: { type: "boolean", required: false, description: "If true, pin to the top of the favourites list (sticky in UI). Default false." },
      pinOrder: { type: "number", required: false, description: "Sort order among pinned favourites — lower value appears higher. Only meaningful when `pin: true`. Example: `0` for first." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      const value: Record<string, unknown> = {
        lat: num(input.lat)!,
        lon: num(input.lon)!,
      };
      if (str(input.title)) value.title = str(input.title);
      if (str(input.name)) value.name = str(input.name);
      if (str(input.type)) value.type = str(input.type);
      if (str(input.cc)) value.cc = str(input.cc);
      if (str(input.note)) value.note = str(input.note);
      if (bool(input.pin) !== undefined) value.pin = bool(input.pin);
      if (num(input.pinOrder) !== undefined) value.pinOrder = num(input.pinOrder);
      return run(() => c.addFavourite(value as Parameters<WindyClient["addFavourite"]>[0]));
    },
  });

  rl.registerAction("account.updateFavourite", {
    description: "Modify an existing favourite. Requires auth. Pass `patch` as a partial FavouriteValue; only the keys you include are changed. Use after `account.favourites` to grab the `id`.",
    inputSchema: {
      id: { type: "string", required: true, description: "Favourite id (server-assigned, returned by `account.addFavourite` or `account.favourites`). Example: `abc123def`." },
      patch: {
        type: "object",
        required: true,
        description: "Partial FavouriteValue to merge. Any subset of `lat`, `lon`, `title`, `name`, `type`, `cc`, `note`, `pin`, `pinOrder`. Example: `{ title: \"New name\", pin: true }`.",
      },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      const patch = (input.patch ?? {}) as Record<string, unknown>;
      return run(() => c.updateFavourite(String(input.id), patch));
    },
  });

  rl.registerAction("account.deleteFavourite", {
    description: "Permanently delete a favourite. Requires auth. Use after `account.favourites` to find the `id`. No-op if id is unknown.",
    inputSchema: {
      id: { type: "string", required: true, description: "Favourite id (from `account.favourites`). The deletion is permanent." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.deleteFavourite(String(input.id)));
    },
  });

  rl.registerAction("account.userAlerts", {
    description: "List threshold-style weather alarms the user has configured (e.g. \"wind > 10 m/s at home\"). Requires auth. Returns `UserAlertItem[]` with `value.conditions` describing each trigger.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.userAlerts());
    },
  });

  rl.registerAction("account.userAlert", {
    description: "Fetch one user alert with its full condition tree. Requires auth. Use after `account.userAlerts` once you have an `id`.",
    inputSchema: {
      id: { type: "string", required: true, description: "User-alert id (from `account.userAlerts`). Example: `alert-1234`." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.getUserAlert(String(input.id)));
    },
  });

  rl.registerAction("account.deleteUserAlert", {
    description: "Permanently delete a user alert. Requires auth. Use after `account.userAlerts` to find the `id`.",
    inputSchema: {
      id: { type: "string", required: true, description: "User-alert id (from `account.userAlerts`). Example: `alert-1234`." },
    },
    async execute(input: Input, ctx: Ctx) {
      const c = getClient(ctx);
      return run(() => c.deleteUserAlert(String(input.id)));
    },
  });

  // Read-only client capabilities that do not map to the core weather tables.
  // They remain actions so callers receive the complete upstream response.
  rl.registerAction("webcams.archive", {
    description: "List archived frames for one webcam. Use after `webcams.near` or `webcams.detail` when historical imagery is needed; returns the complete archive response.",
    inputSchema: {
      id: { type: "string", required: true, description: "Windy webcam id from `webcams.near` or `webcams.search`." },
      imageSize: { type: "string", required: false, description: "Optional image variant requested by the archive endpoint." },
      archiveType: { type: "string", required: false, description: "Optional archive category accepted by Windy." },
    },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).webcamArchive(String(input.id), { imageSize: str(input.imageSize), archiveType: str(input.archiveType) })); },
  });
  rl.registerAction("webcams.hourlyArchive", {
    description: "Retrieve hourly archived imagery metadata for one webcam when a time-series archive is needed.",
    inputSchema: { id: { type: "string", required: true, description: "Windy webcam id." } },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).webcamHourlyArchive(String(input.id))); },
  });
  rl.registerAction("webcams.ping", {
    description: "Check the health and freshness of one webcam owned or monitored by Windy.",
    inputSchema: { id: { type: "string", required: true, description: "Windy webcam id." } },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).webcamPing(String(input.id))); },
  });
  rl.registerAction("radar.info", {
    description: "Get current radar composite metadata, including available frames and render configuration.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).radarInfo()); },
  });
  rl.registerAction("radar.coverage", {
    description: "Get the geographic coverage of Windy's radar composite for deciding whether radar data exists at a location.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).radarCoverage()); },
  });
  rl.registerAction("radar.archive", {
    description: "Get the available historical radar composite frame range for replay or time-window analysis.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).radarArchive()); },
  });
  rl.registerAction("satellite.info", {
    description: "Get current satellite composite metadata and available imagery frames.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).satelliteInfo()); },
  });
  rl.registerAction("satellite.archive", {
    description: "Get the available historical satellite composite frame range for replay or comparison.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).satelliteArchive()); },
  });
  rl.registerAction("geo.citytile", {
    description: "Fetch forecast city-overlay data for a map tile when a map viewport needs named-city weather values.",
    inputSchema: {
      model: { type: "string", required: true, description: "Windy forecast model identifier, such as `ecmwf-hres` or `gfs`." },
      z: { type: "number", required: true, description: "Map tile zoom." },
      x: { type: "number", required: true, description: "Map tile X coordinate." },
      y: { type: "number", required: true, description: "Map tile Y coordinate." },
      refTime: { type: "string", required: false, description: "Optional ISO-8601 model run timestamp." },
      step: { type: "number", required: false, description: "Optional forecast sample interval in hours." },
      hours: { type: "number", required: false, description: "Optional forecast horizon in hours." },
      labelsVersion: { type: "string", required: false, description: "Optional Windy labels version." },
    },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).citytile(String(input.model), num(input.z)!, num(input.x)!, num(input.y)!, { refTime: str(input.refTime), step: num(input.step), hours: num(input.hours), labelsVersion: str(input.labelsVersion) })); },
  });
  rl.registerAction("account.settings", {
    description: "Read the signed-in user's Windy display and location settings; requires authentication and returns the complete settings object.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).userSettings()); },
  });
  rl.registerAction("account.colors", {
    description: "Read the signed-in user's custom color palettes; requires authentication.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).userColors()); },
  });
  rl.registerAction("account.plugins", {
    description: "Read the signed-in user's installed Windy plugins; requires authentication.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).userPlugins()); },
  });
  rl.registerAction("account.device", {
    description: "Read the signed-in user's registered device state; requires authentication.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).userDevice()); },
  });
  rl.registerAction("account.myWebcams", {
    description: "List webcams owned by the signed-in user; requires authentication and webcam-owner access.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).myWebcams()); },
  });
  rl.registerAction("webcams.add", {
    description: "Register a webcam owned by the signed-in user. Requires authentication; use only after explicit user confirmation.",
    inputSchema: { payload: { type: "object", required: true, description: "Complete webcam payload including title, lat, lon, and imageUrl." } },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).addWebcam(input.payload as Parameters<WindyClient["addWebcam"]>[0])); },
  });
  rl.registerAction("webcams.update", {
    description: "Update an owned webcam. Requires authentication; use only after explicit user confirmation.",
    inputSchema: { id: { type: "string", required: true, description: "Owned webcam id." }, patch: { type: "object", required: true, description: "Fields to update." } },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).updateWebcam(String(input.id), input.patch as Record<string, unknown>)); },
  });
  rl.registerAction("webcams.remove", {
    description: "Delete an owned webcam permanently. Requires authentication and explicit confirmation.",
    inputSchema: { id: { type: "string", required: true, description: "Owned webcam id to delete." }, confirm: { type: "boolean", required: true, description: "Must be true after the user confirms permanent deletion." } },
    async execute(input: Input, ctx: Ctx) { if (input.confirm !== true) throw new Error("windy: webcam deletion requires confirm=true"); return run(() => getClient(ctx).removeWebcam(String(input.id))); },
  });
  rl.registerAction("push.register", {
    description: "Register or refresh a push-notification device for the signed-in user; requires authentication.",
    inputSchema: { token: { type: "string", required: true, description: "FCM or APNs device token." }, platform: { type: "string", required: false, description: "Push platform: web, ios, or android. Defaults to web." } },
    async execute(input: Input, ctx: Ctx) { const p = str(input.platform); return run(() => getClient(ctx).registerPushDevice(String(input.token), p === "ios" || p === "android" ? p : "web")); },
  });
  rl.registerAction("push.unregister", {
    description: "Unregister the current push-notification device for the signed-in user; requires authentication.",
    inputSchema: {},
    async execute(_input: Input, ctx: Ctx) { return run(() => getClient(ctx).unregisterPushDevice()); },
  });
  rl.registerAction("maps.widgetImageUrl", {
    description: "Build a deterministic radar or satellite widget image URL without making an API request.",
    inputSchema: { type: { type: "string", required: true, description: "Image type: radar or satellite." }, lat: { type: "number", required: true, description: "Latitude." }, lon: { type: "number", required: true, description: "Longitude." }, width: { type: "number", required: false, description: "Image width in pixels." }, height: { type: "number", required: false, description: "Image height in pixels." } },
    async execute(input: Input, ctx: Ctx) { const t = str(input.type) === "satellite" ? "satellite" : "radar"; return getClient(ctx).widgetImageUrl(t, num(input.lat)!, num(input.lon)!, { w: num(input.width), h: num(input.height) }); },
  });
  rl.registerAction("maps.staticUrl", {
    description: "Build a deterministic Windy static-map image URL without making an API request.",
    inputSchema: { lat: { type: "number", required: true, description: "Latitude." }, lon: { type: "number", required: true, description: "Longitude." }, zoom: { type: "number", required: false, description: "Map zoom." }, size: { type: "number", required: false, description: "Image size in pixels." } },
    async execute(input: Input, ctx: Ctx) { return getClient(ctx).staticMapUrl({ lat: num(input.lat)!, lon: num(input.lon)!, zoom: num(input.zoom), size: num(input.size) }); },
  });
  rl.registerAction("maps.dataTileUrl", {
    description: "Build a deterministic forecast data-tile URL from a model run, forecast hour, overlay, and tile coordinates.",
    inputSchema: { model: { type: "string", required: true, description: "Forecast model id." }, run: { type: "string", required: true, description: "Model run timestamp YYYYMMDDHH." }, forecastHour: { type: "string", required: true, description: "Forecast timestamp YYYYMMDDHH." }, overlay: { type: "string", required: true, description: "Windy overlay name." }, z: { type: "number", required: true, description: "Tile zoom." }, x: { type: "number", required: true, description: "Tile X." }, y: { type: "number", required: true, description: "Tile Y." }, ext: { type: "string", required: false, description: "jpg or png." } },
    async execute(input: Input, ctx: Ctx) { return getClient(ctx).dataTileUrl(String(input.model), String(input.run), String(input.forecastHour), String(input.overlay), num(input.z)!, num(input.x)!, num(input.y)!, str(input.ext) === "png" ? "png" : "jpg"); },
  });
  rl.registerAction("maps.basemapTileUrl", {
    description: "Build a deterministic Windy basemap tile URL.",
    inputSchema: { style: { type: "string", required: true, description: "Windy basemap style." }, z: { type: "number", required: true, description: "Tile zoom." }, x: { type: "number", required: true, description: "Tile X." }, y: { type: "number", required: true, description: "Tile Y." } },
    async execute(input: Input, ctx: Ctx) { return getClient(ctx).basemapTileUrl(String(input.style) as Parameters<WindyClient["basemapTileUrl"]>[0], num(input.z)!, num(input.x)!, num(input.y)!); },
  });
  rl.registerAction("maps.labelTileUrl", {
    description: "Build a deterministic Windy place-label tile URL.",
    inputSchema: { z: { type: "number", required: true, description: "Tile zoom." }, x: { type: "number", required: true, description: "Tile X." }, y: { type: "number", required: true, description: "Tile Y." }, lang: { type: "string", required: false, description: "Optional label language." } },
    async execute(input: Input, ctx: Ctx) { return getClient(ctx).labelTileUrl(num(input.z)!, num(input.x)!, num(input.y)!, str(input.lang)); },
  });
  rl.registerAction("commercial.pointForecast", {
    description: "Call Windy's separate commercial point-forecast API with an API key; use only when the user provides that credential.",
    inputSchema: { apiKey: { type: "string", required: true, description: "Commercial Windy API key; do not log or persist it." }, options: { type: "object", required: true, description: "Complete point-forecast options including lat, lon, model, and parameters." } },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).apiPointForecast(String(input.apiKey), input.options as Parameters<WindyClient["apiPointForecast"]>[1])); },
  });
  rl.registerAction("startup.article", {
    description: "Read Windy's startup article content for an optional location.",
    inputSchema: { lat: { type: "number", required: false, description: "Optional latitude." }, lon: { type: "number", required: false, description: "Optional longitude." } },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).startupArticle({ lat: num(input.lat), lon: num(input.lon) })); },
  });
  rl.registerAction("startup.promo", {
    description: "Read Windy's startup promotion content for an optional location or forced promotion id.",
    inputSchema: { lat: { type: "number", required: false, description: "Optional latitude." }, lon: { type: "number", required: false, description: "Optional longitude." }, forceId: { type: "string", required: false, description: "Optional promotion id." } },
    async execute(input: Input, ctx: Ctx) { return run(() => getClient(ctx).startupPromo({ lat: num(input.lat), lon: num(input.lon), forceId: str(input.forceId) })); },
  });
}
