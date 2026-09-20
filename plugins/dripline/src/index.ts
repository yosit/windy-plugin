/**
 * `@yosit/dripline-plugin-windy` — windy.com as SQL tables (DuckDB).
 *
 * What this is: a Dripline plugin that exposes the windy.com API as 47
 * read-only SQL tables, including normalized weather tables and complete JSON
 * metadata/reference tables. Use when the user asks about weather forecasts,
 * marine conditions, air quality, severe-weather alerts, tropical storms,
 * tides, METAR/airport info, weather stations, or webcams — anywhere SQL
 * is more ergonomic than a sequence of host queries.
 *
 * Auth (all optional — most tables work anonymously):
 *   - `WINDY_ACCOUNT_SID` (recommended) — `_account_sid` cookie value;
 *     long-lived; auto-refreshes a JWT on demand. Required for
 *     `windy_account*`, `windy_favourites`, `windy_user_alerts*`,
 *     `windy_alerts_live`.
 *   - `WINDY_TOKEN` — pre-issued JWT (`token2`), ~48 h, no refresh.
 *   - `WINDY_PROXY` — HTTPS proxy URL for debugging.
 *
 * Top tables to know:
 *   - `windy_forecast_point` — hourly forecast time-series (long format).
 *   - `windy_forecast_summary` — daily aggregates (max/min temp, dominant wind).
 *   - `windy_storms` — currently-active tropical cyclones.
 *   - `windy_alerts_cap` — government-issued severe-weather alerts.
 *   - `windy_stations_nearby` — METAR / WMO / PWS / MADIS stations near a point.
 *   - `windy_tides` — tide heights for the nearest port (or by tide-POI id).
 *
 * Vex installation: this adapter is bundled as a standalone file at
 * `.dripline/windy.js`; it has no dependency on Runline or local node_modules.
 *
 * Units stay on the wire — temperature in Kelvin (`*_k`), wind in m/s (`*_ms`),
 * pressure in hPa (`*_hpa`), distance in km (`*_km`), timestamps in unix ms
 * (`*_ms`). Time-series tables also expose an ISO `ts` column for joins.
 */
import type { DriplinePluginAPI, QueryContext, Qual } from "dripline";
import { randomUUID } from "crypto";
import {
  WindyClient,
  WindyAPIError,
  referenceCatalog,
  PACKAGE_VERSION,
  LEVELS,
  LEVEL_ALTITUDE,
  type Level,
  type ClientOptions,
  type PersistedSession,
  loadSession,
  type PointForecast,
  type SearchResponse,
  type ReverseGeocode,
  type NearbyWeatherStation,
  type NearbyAirQualityStation,
  type AirQualityPOI,
  type ObservationTimeseries,
  type TideForecast,
  type CapAlert,
  type StormsResponse,
  type WebcamList,
  type Webcam,
  type AirportResponse,
  type AccountInfo,
  type Favourite,
  type FavouriteValue,
  type UserAlertItem,
  type Sounding,
} from "@yosit/windy";

// ── Qual helpers ──────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  // DuckDB may pass DECIMAL quals as an unscaled value plus its scale. Do not
  // coerce the object directly: Number({ value: 566420n, scale: 4 }) is NaN,
  // while Number(566420n) silently produces the wrong coordinate.
  if (v !== null && typeof v === "object") {
    const d = v as { value?: unknown; scale?: unknown };
    const raw = d.value;
    const scale = typeof d.scale === "number" ? d.scale : Number(d.scale);
    if ((typeof raw === "bigint" || typeof raw === "number" || typeof raw === "string") &&
        Number.isInteger(scale) && scale >= 0) {
      const n = Number(raw) / 10 ** scale;
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}
function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  if (typeof v === "number") return v !== 0;
  return undefined;
}

function qVal(quals: Qual[], col: string): unknown {
  return quals.find((q) => q.column === col && q.operator === "=")?.value;
}
function qStr(q: Qual[], c: string): string | undefined { return str(qVal(q, c)); }
function qNum(q: Qual[], c: string): number | undefined {
  const value = num(qVal(q, c));
  if (/(^|_)(lat|lon)$/.test(c) && q.some((qual) => qual.column === c && qual.operator === "=") && value === undefined) {
    throw new Error(`windy: ${c} equality predicate has no valid numeric value; this host may not support CAST predicates. Use quoted numeric coordinates.`);
  }
  return value;
}
function qBool(q: Qual[], c: string): boolean | undefined { return bool(qVal(q, c)); }

// Lowercase model identifiers on the wire. The forecast `header.model` field
// is uppercase in some responses (e.g. `ECMWF`) while users naturally write
// `WHERE model = 'ecmwf'`. DuckDB applies post-filters after we yield rows,
// so an emitted `ECMWF` would be filtered out. Normalize on both ingress and
// egress so case-insensitive predicates Just Work. See #9.
function lc(s: string | undefined): string | undefined {
  return typeof s === "string" ? s.toLowerCase() : s;
}
function qModel(q: Qual[], c = "model"): string | undefined { return lc(qStr(q, c)); }

// Meteogram-endpoint model normalization (#10). The meteogram endpoint
// (`/forecast/meteogram/<model>/v1.2/...`) accepts user-facing ids like
// `ecmwf` but returns `header.model = "ECMWF-HRES"` — the lower-level run id.
// Without normalization, `windy_forecast_sounding` / `_meteogram` emitted
// `ecmwf-hres`, while passing `model = 'ecmwf-hres'` upstream got HTTP 400 —
// so there was no working predicate value. Map the wire run-id back to the
// user-facing id on egress, and accept the wire id as an alias on ingress.
const METEOGRAM_WIRE_TO_USER: Record<string, string> = {
  "ecmwf-hres": "ecmwf",
};
function meteogramEmittedModel(s: string | undefined): string | undefined {
  const v = lc(s);
  return v != null ? (METEOGRAM_WIRE_TO_USER[v] ?? v) : v;
}
function qMeteogramModel(q: Qual[]): string | undefined {
  const v = qModel(q);
  return v != null ? (METEOGRAM_WIRE_TO_USER[v] ?? v) : v;
}

// ── Client construction ───────────────────────────────────────────────────

// Module-level client cache. Without this, each table query constructs a
// fresh WindyClient with no token, and the first node.windy.com request
// triggers a /api/info bootstrap — quickly exhausting the persistent 8/24h
// login-throttle budget across a batch of sanity-check queries. Caching by
// connection config lets the JWT from the first call be reused by all later
// calls in the same process.
const clientCache = new Map<string, WindyClient>();
let autoUid: string | undefined;

function getClient(ctx: QueryContext): WindyClient {
  const cfg = ctx.connection?.config ?? {};
  const token = str(cfg.token);
  const accountSid = str(cfg.accountSid);
  const proxy = str(cfg.proxy);
  const uid = str(cfg.uid) ?? (autoUid ??= randomUUID());
  const country = str(cfg.country);
  const lang = str(cfg.lang);
  const key = JSON.stringify({ token, accountSid, uid, country, lang, proxy });

  const cached = clientCache.get(key);
  if (cached) return cached;

  const session: PersistedSession = accountSid || token ? loadSession() : { uid };
  if (session.accountSid && accountSid && session.accountSid !== accountSid) {
    delete session.token;
    delete session.tokenExp;
    delete session.userId;
    delete session.username;
    delete session.subscription;
  }
  session.uid = uid;
  if (accountSid) session.accountSid = accountSid;
  else delete session.accountSid;
  if (token) session.token = token;
  const opts: ClientOptions = {
    session,
    proxy,
    country,
    lang,
  };
  const c = new WindyClient(opts);
  clientCache.set(key, c);
  return c;
}

// ── Misc helpers ──────────────────────────────────────────────────────────

function isoFromMs(ts: number | undefined | null): string | undefined {
  if (ts == null || !Number.isFinite(ts)) return undefined;
  try { return new Date(ts).toISOString(); } catch { return undefined; }
}

function jsonOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined;
  try { return JSON.stringify(v); } catch { return undefined; }
}

function logErr(dl: DriplinePluginAPI, table: string, e: unknown): void {
  if (e instanceof WindyAPIError) {
    dl.log.warn(`${table}: windy ${e.status}: ${e.message}`);
  } else {
    dl.log.warn(`${table}: ${(e as Error)?.message ?? String(e)}`);
  }
}

/**
 * Used by tables where an empty result is dangerous to confuse with a real
 * upstream failure (e.g. forecast tables). Logs the error so it shows up in
 * plugin logs AND rethrows it so the SQL caller sees a query error rather
 * than silent 0 rows.
 */
function failTable(dl: DriplinePluginAPI, table: string, e: unknown): never {
  logErr(dl, table, e);
  if (e instanceof Error) throw e;
  throw new Error(`${table}: ${String(e)}`);
}

// Wind u/v → meteorological FROM-direction degrees (0..360)
function windDirFromUV(u: number | undefined, v: number | undefined): number | undefined {
  if (u == null || v == null || !Number.isFinite(u) || !Number.isFinite(v)) return undefined;
  let d = (Math.atan2(-u, -v) * 180) / Math.PI;
  if (d < 0) d += 360;
  return d;
}

// ─────────────────────────────────────────────────────────────────────────
// Plugin entry
// ─────────────────────────────────────────────────────────────────────────

export default function windyPlugin(dl: DriplinePluginAPI): void {
  dl.setName("windy");
  dl.setVersion(PACKAGE_VERSION);

  dl.setConnectionSchema({
    token: {
      type: "string",
      required: false,
      env: "WINDY_TOKEN",
      description:
        "Pre-issued windy JWT (token2 value). Optional — most public endpoints work anonymously.",
    },
    accountSid: {
      type: "string",
      required: false,
      env: "WINDY_ACCOUNT_SID",
      description:
        "_account_sid cookie value from a logged-in browser. Used to bootstrap a JWT when `token` is absent.",
    },
    uid: {
      type: "string",
      required: false,
      env: "WINDY_UID",
      description: "Stable device UUID. Auto-generated per call if omitted.",
    },
    lang: {
      type: "string",
      required: false,
      env: "WINDY_LANG",
      default: "en",
      description: "ISO 639-1 language code.",
    },
    country: {
      type: "string",
      required: false,
      env: "WINDY_COUNTRY",
      default: "xx",
      description: "ISO 3166-1 alpha-2 country code, lowercase.",
    },
    proxy: {
      type: "string",
      required: false,
      env: "WINDY_PROXY",
      description:
        "HTTPS proxy URL for debugging (e.g. http://localhost:8080). Routes all outbound traffic through the proxy.",
    },
  });

  for (const [name, value] of Object.entries(referenceCatalog)) {
    dl.registerTable(`windy_reference_${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`, {
      description: `Discover Windy ${name} before choosing forecast or map parameters; no network or credentials required.`,
      columns: [{ name: "data", type: "json", description: `Complete ${name} reference entry. No fields are projected away.` }],
      async *list(ctx) {
        let count = 0;
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (ctx.signal?.aborted || (ctx.limit != null && count >= ctx.limit)) return;
          yield { data: JSON.stringify(entry) };
          count++;
        }
      },
    });
  }

  // Singleton read surfaces retain the complete upstream payload in JSON. This
  // avoids silently projecting undocumented metadata while keeping them
  // queryable alongside the normalized weather tables.
  const registerJsonTable = (
    name: string,
    description: string,
    read: (c: WindyClient) => Promise<unknown>,
  ): void => {
    dl.registerTable(name, {
      description,
      columns: [{ name: "data", type: "json", description: "Complete upstream response. Nested fields are preserved as JSON." }],
      async *list(ctx) {
        try {
          yield { data: jsonOrUndef(await read(getClient(ctx))) };
        } catch (e) {
          failTable(dl, name, e);
        }
      },
    });
  };

  registerJsonTable("windy_radar_info", "Current radar composite metadata and available frames.", (c) => c.radarInfo());
  registerJsonTable("windy_radar_coverage", "Geographic coverage metadata for the radar composite.", (c) => c.radarCoverage());
  registerJsonTable("windy_radar_archive", "Historical radar composite frame metadata.", (c) => c.radarArchive());
  registerJsonTable("windy_satellite_info", "Current satellite composite metadata and available frames.", (c) => c.satelliteInfo());
  registerJsonTable("windy_satellite_archive", "Historical satellite composite frame metadata.", (c) => c.satelliteArchive());
  registerJsonTable("windy_account_settings", "Authenticated user's complete Windy settings.", (c) => c.userSettings());
  registerJsonTable("windy_account_colors", "Authenticated user's complete custom color palettes.", (c) => c.userColors());
  registerJsonTable("windy_account_plugins", "Authenticated user's complete installed-plugin list.", (c) => c.userPlugins());
  registerJsonTable("windy_account_device", "Authenticated user's complete registered-device state.", (c) => c.userDevice());
  registerJsonTable("windy_account_my_webcams", "Authenticated user's complete owned-webcam list.", (c) => c.myWebcams());

  // ── windy_forecast_point ────────────────────────────────────────────────
  dl.registerTable("windy_forecast_point", {
    description:
      "Multi-day hourly point forecast — one row per timestep (temp/wind/precip/pressure). Filter `lat`,`lon`,`model`,`step`,`ref_time`. Daily: `windy_forecast_summary`; upper-air: `windy_forecast_sounding`.",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "model", type: "string", description: "Forecast model id (e.g. `ecmwf`, `gfs`, `icon`)." },
      { name: "ref_time", type: "string", description: "Model reference time as ISO-8601 (the model run this row was sampled from)." },
      { name: "ts_ms", type: "number", description: "Sample timestamp, unix milliseconds UTC." },
      { name: "ts", type: "datetime", description: "Sample timestamp as ISO-8601 (parallel column to `ts_ms`)." },
      { name: "temp_k", type: "number", description: "Temperature in Kelvin. Convert: °C = temp_k − 273.15." },
      { name: "dewpoint_k", type: "number", description: "Dewpoint in Kelvin. Convert: °C = dewpoint_k − 273.15." },
      { name: "wind_ms", type: "number", description: "Wind-speed magnitude, m/s. Convert: kt = wind_ms × 1.944, km/h = wind_ms × 3.6." },
      { name: "wind_u_ms", type: "number", description: "Zonal (east+) wind component, m/s." },
      { name: "wind_v_ms", type: "number", description: "Meridional (north+) wind component, m/s." },
      { name: "wind_dir_deg", type: "number", description: "Wind FROM direction, meteorological degrees. 0/360 = from N, 90 = from E, 180 = from S, 270 = from W." },
      { name: "gust_ms", type: "number", description: "Peak gust speed in the timestep, m/s." },
      { name: "rh_pct", type: "number", description: "Relative humidity, percent (0–100)." },
      { name: "pressure_hpa", type: "number", description: "Surface (or level) pressure, hectopascals (= millibars). Sea-level ≈ 1013 hPa." },
      { name: "precip_mm", type: "number", description: "Total precipitation in this timestep, millimeters (liquid-equivalent)." },
      { name: "snow_mm", type: "number", description: "Snowfall in this timestep, millimeters (liquid-equivalent — divide by ~0.1 for snow depth)." },
      { name: "clouds_low", type: "number", description: "Low-cloud cover fraction (0–100 percent), surface to ~2 km AGL." },
      { name: "clouds_mid", type: "number", description: "Mid-cloud cover fraction (0–100 percent), ~2–6 km AGL." },
      { name: "clouds_high", type: "number", description: "High-cloud cover fraction (0–100 percent), ~6 km+ AGL." },
      { name: "h_clouds", type: "number", description: "Composite/high cloud fraction (server-defined alias for `clouds_high` on some models)." },
      { name: "cape", type: "number", description: "Convective Available Potential Energy, J/kg. >1000 = thunderstorm potential; >2500 = severe; >4000 = extreme." },
      { name: "ptype", type: "number", description: "Precipitation type code (server-defined integer; commonly: 0 = none, 1 = rain, 3 = sleet/mixed, 5 = snow, 7 = freezing rain — exact mapping varies by model)." },
      { name: "elevation_m", type: "number", description: "Terrain elevation at the requested coord, meters above MSL." },
      { name: "model_elevation_m", type: "number", description: "Elevation the forecast model assumes for this gridpoint, meters MSL. May differ from real `elevation_m` due to model resolution." },
      { name: "tz_name", type: "string", description: "IANA timezone of the location (e.g. `Asia/Jerusalem`). All `ts_ms` values are still UTC — use this for local-time display only." },
      { name: "utc_offset_h", type: "number", description: "Local-time offset from UTC, hours (positive = east). Includes DST when applicable for this `ref_time`." },
      { name: "sunrise_ms", type: "number", description: "Today's sunrise at the location, unix milliseconds UTC." },
      { name: "sunset_ms", type: "number", description: "Today's sunset at the location, unix milliseconds UTC." },
      { name: "days_avail", type: "number", description: "Forecast horizon available from this `ref_time`, days. Premium accounts usually see more days for ECMWF (15 vs 10)." },
      { name: "step_h", type: "number", description: "Hours per sample in the time-series (1 = hourly, 3 = 3-hourly, 24 = daily)." },
      { name: "has_waves", type: "boolean", description: "True if the underlying model produced wave fields (ECMWF / GFS waves). Use to know whether wave-specific overlays would be available." },
      { name: "header_raw", type: "json", description: "Full response header as JSON — useful when you need fields not surfaced as columns (e.g. `celestial`, model metadata). Top-level keys: see ForecastHeader / TideForecast['header'] in @yosit/windy." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "model", required: "optional" },
      { name: "ref_time", required: "optional" },
      { name: "step", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        const r: PointForecast = await c.pointForecast(lat, lon, {
          model: qModel(ctx.quals),
          refTime: qStr(ctx.quals, "ref_time"),
          step: qNum(ctx.quals, "step"),
        });
        const h = r.header;
        const model = lc(h.model);
        const refTime = h.refTime;
        const d = r.data;
        const tsArr = d.ts ?? [];
        const headerRaw = jsonOrUndef(h);
        for (let i = 0; i < tsArr.length; i++) {
          const u = d.wind_u?.[i];
          const v = d.wind_v?.[i];
          yield {
            lat, lon, model, ref_time: refTime,
            ts_ms: tsArr[i],
            ts: isoFromMs(tsArr[i]),
            temp_k: d.temp?.[i],
            dewpoint_k: d.dewpoint?.[i],
            wind_ms: d.wind?.[i],
            wind_u_ms: u,
            wind_v_ms: v,
            wind_dir_deg: windDirFromUV(u, v),
            gust_ms: d.gust?.[i],
            rh_pct: d.rh?.[i],
            pressure_hpa: d.pressure?.[i],
            precip_mm: d.mm?.[i],
            snow_mm: d.snow?.[i],
            clouds_low: d.clouds_low?.[i],
            clouds_mid: d.clouds_mid?.[i],
            clouds_high: d.clouds_high?.[i],
            h_clouds: d.hClouds?.[i],
            cape: d.cape?.[i],
            ptype: d.ptype?.[i],
            elevation_m: h.elevation,
            model_elevation_m: h.modelElevation,
            tz_name: h.tzName,
            utc_offset_h: h.utcOffset,
            sunrise_ms: h.sunrise,
            sunset_ms: h.sunset,
            days_avail: h.daysAvail,
            step_h: h.step,
            has_waves: h.hasWaves,
            header_raw: headerRaw,
          };
        }
      } catch (e) {
        failTable(dl, "windy_forecast_point", e);
      }
    },
  });

  // ── windy_forecast_summary ────────────────────────────────────────────
  // Daily aggregates from setup=summary calls — one row per date.
  dl.registerTable("windy_forecast_summary", {
    description:
      "Daily forecast summary — one row per date with max/min temp, dominant wind, weather icon. Only populated when the underlying call uses setup=summary (which this table always passes).",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "model", type: "string", description: "Forecast model id (e.g. `ecmwf`, `gfs`, `icon`)." },
      { name: "ref_time", type: "string", description: "Model reference time as ISO-8601 (the model run this row was sampled from)." },
      { name: "date", type: "string", description: "Local date the summary covers, `YYYY-MM-DD`." },
      { name: "weekday", type: "string", description: "Weekday code. One of: `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN`." },
      { name: "ts_ms", type: "number", description: "Timestamp, unix milliseconds UTC." },
      { name: "day_index", type: "number", description: "Day offset from today (0 = today, 1 = tomorrow, ...)." },
      { name: "day_of_month", type: "number", description: "Day-of-month (1..31), in the location's local time." },
      { name: "icon", type: "number", description: "Windy weather-icon code (1..). Maps to a glyph in the windy app; meaning varies by code (sun/cloud/rain/snow/etc.)." },
      { name: "temp_max_k", type: "number", description: "Daily maximum temperature, Kelvin. Convert: °C = temp_max_k − 273.15." },
      { name: "temp_min_k", type: "number", description: "Daily minimum temperature, Kelvin. Convert: °C = temp_min_k − 273.15." },
      { name: "wind_ms", type: "number", description: "Wind-speed magnitude, m/s. Convert: kt = wind_ms × 1.944, km/h = wind_ms × 3.6." },
      { name: "wind_dir_deg", type: "number", description: "Wind FROM direction, meteorological degrees. 0/360 = from N, 90 = from E, 180 = from S, 270 = from W." },
      { name: "segments", type: "number", description: "Number of intra-day timesteps contributing to this daily aggregate (e.g. 8 for 3-hourly, 24 for hourly)." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "model", required: "optional" },
      { name: "ref_time", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        const r: PointForecast = await c.pointForecast(lat, lon, {
          model: qModel(ctx.quals),
          refTime: qStr(ctx.quals, "ref_time"),
          setup: "summary",
        });
        const model = lc(r.header.model);
        const refTime = r.header.refTime;
        for (const [date, s] of Object.entries(r.summary ?? {})) {
          yield {
            lat, lon, model, ref_time: refTime,
            date,
            weekday: s.weekday,
            ts_ms: s.timestamp,
            day_index: s.index,
            day_of_month: s.day,
            icon: s.icon,
            temp_max_k: s.tempMax,
            temp_min_k: s.tempMin,
            wind_ms: s.wind,
            wind_dir_deg: s.windDir,
            segments: s.segments,
          };
        }
      } catch (e) {
        failTable(dl, "windy_forecast_summary", e);
      }
    },
  });

  // ── windy_forecast_now ──────────────────────────────────────────────────
  dl.registerTable("windy_forecast_now", {
    description:
      "Current-conditions snapshot at a point. Single row. Use when the user wants \"right now\" weather without the full forecast time-series — temp / wind / windDir / weather icon / moon phase.",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "model", type: "string", description: "Forecast model id (e.g. `ecmwf`, `gfs`, `icon`)." },
      { name: "ref_time", type: "string", description: "Model reference time as ISO-8601 (the model run this row was sampled from)." },
      { name: "temp_k", type: "number", description: "Temperature in Kelvin. Convert: °C = temp_k − 273.15." },
      { name: "wind_ms", type: "number", description: "Wind-speed magnitude, m/s. Convert: kt = wind_ms × 1.944, km/h = wind_ms × 3.6." },
      { name: "wind_dir_deg", type: "number", description: "Wind FROM direction, meteorological degrees. 0/360 = from N, 90 = from E, 180 = from S, 270 = from W." },
      { name: "icon", type: "number", description: "Windy weather-icon code (1..). Maps to a glyph in the windy app; meaning varies by code (sun/cloud/rain/snow/etc.)." },
      { name: "moon_phase", type: "number", description: "Moon-phase index, 0–7. 0 = new moon, 2 = first quarter, 4 = full, 6 = last quarter." },
      { name: "tz_name", type: "string", description: "IANA timezone of the location (e.g. `Asia/Jerusalem`). All `ts_ms` values are still UTC — use this for local-time display only." },
      { name: "utc_offset_h", type: "number", description: "Local-time offset from UTC, hours (positive = east). Includes DST when applicable for this `ref_time`." },
      { name: "elevation_m", type: "number", description: "Terrain elevation at the requested coord, meters above MSL." },
      { name: "sunrise_ms", type: "number", description: "Today's sunrise at the location, unix milliseconds UTC." },
      { name: "sunset_ms", type: "number", description: "Today's sunset at the location, unix milliseconds UTC." },
      { name: "header_raw", type: "json", description: "Full response header as JSON — useful when you need fields not surfaced as columns (e.g. `celestial`, model metadata). Top-level keys: see ForecastHeader / TideForecast['header'] in @yosit/windy." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "model", required: "optional" },
      { name: "ref_time", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        // `c.pointNow` returns a bare NowSnapshot+extras (no header). Use
        // `pointForecast` so we can populate both header (model / ref_time /
        // tz / elevation / sun) and the `now` snapshot in one call.
        const r = await c.pointForecast(lat, lon, {
          model: qModel(ctx.quals),
          refTime: qStr(ctx.quals, "ref_time"),
          includeNow: true,
        });
        const h = r.header;
        yield {
          lat, lon,
          model: lc(h?.model),
          ref_time: h?.refTime,
          temp_k: r.now?.temp,
          wind_ms: r.now?.wind,
          wind_dir_deg: r.now?.windDir,
          icon: r.now?.icon,
          moon_phase: r.now?.moonPhase,
          tz_name: h?.tzName,
          utc_offset_h: h?.utcOffset,
          elevation_m: h?.elevation,
          sunrise_ms: h?.sunrise,
          sunset_ms: h?.sunset,
          header_raw: jsonOrUndef(h),
        };
      } catch (e) {
        failTable(dl, "windy_forecast_now", e);
      }
    },
  });

  // ── windy_forecast_sounding ────────────────────────────────────────────
  // Pressure-level sounding (skew-T) — meteogram pivoted into per-(ts, level).
  dl.registerTable("windy_forecast_sounding", {
    description:
      "Pressure-level sounding (skew-T) — one row per (timestep, level). Use for aviation/glider/paragliding or upper-air questions. 17 levels surface→10 hPa with wind/temp/dewpoint/RH/height.",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "model", type: "string", description: "Forecast model id (e.g. `ecmwf`, `gfs`, `icon`)." },
      { name: "ref_time", type: "string", description: "Model reference time as ISO-8601 (the model run this row was sampled from)." },
      { name: "ts_ms", type: "number", description: "Sample timestamp, unix milliseconds UTC." },
      { name: "ts", type: "datetime", description: "Sample timestamp as ISO-8601 (parallel column to `ts_ms`)." },
      { name: "hours_offset", type: "number", description: "Hours from ref_time." },
      { name: "level", type: "string", description: "Level key (surface, 100m, 850h, …)." },
      { name: "alt_m", type: "number", description: "Approximate altitude of the pressure level, meters AGL (LEVEL_ALTITUDE lookup, not model-derived)." },
      { name: "alt_ft", type: "number", description: "Approximate altitude of the pressure level, feet AGL." },
      { name: "temp_k", type: "number", description: "Temperature in Kelvin. Convert: °C = temp_k − 273.15." },
      { name: "dewpoint_k", type: "number", description: "Dewpoint in Kelvin. Convert: °C = dewpoint_k − 273.15." },
      { name: "rh_pct", type: "number", description: "Relative humidity, percent (0–100)." },
      { name: "gh_m", type: "number", description: "Geopotential height, m." },
      { name: "wind_u_ms", type: "number", description: "Zonal (east+) wind component, m/s." },
      { name: "wind_v_ms", type: "number", description: "Meridional (north+) wind component, m/s." },
      { name: "wind_ms", type: "number", description: "Wind-speed magnitude, m/s. Convert: kt = wind_ms × 1.944, km/h = wind_ms × 3.6." },
      { name: "wind_dir_deg", type: "number", description: "Wind FROM direction, meteorological degrees. 0/360 = from N, 90 = from E, 180 = from S, 270 = from W." },
      { name: "tz_name", type: "string", description: "IANA timezone of the location (e.g. `Asia/Jerusalem`). All `ts_ms` values are still UTC — use this for local-time display only." },
      { name: "step_h", type: "number", description: "Hours per sample in the time-series (1 = hourly, 3 = 3-hourly, 24 = daily)." },
      { name: "header_raw", type: "json", description: "Full response header as JSON — useful when you need fields not surfaced as columns (e.g. `celestial`, model metadata). Top-level keys: see ForecastHeader / TideForecast['header'] in @yosit/windy." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "model", required: "optional" },
      { name: "ref_time", required: "optional" },
      { name: "step", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        const s: Sounding = await c.sounding(lat, lon, {
          model: qMeteogramModel(ctx.quals),
          refTime: qStr(ctx.quals, "ref_time"),
          step: qNum(ctx.quals, "step"),
        });
        const h = s.header;
        const model = meteogramEmittedModel(h.model);
        const refTime = h.refTime;
        const headerRaw = jsonOrUndef(h);
        for (const t of s.timesteps) {
          for (const lv of t.levels) {
            yield {
              lat, lon, model, ref_time: refTime,
              ts_ms: t.ts,
              ts: isoFromMs(t.ts),
              hours_offset: t.hoursOffset,
              level: lv.level,
              alt_m: lv.altM,
              alt_ft: lv.altFt,
              temp_k: lv.temp,
              dewpoint_k: lv.dewpoint,
              rh_pct: lv.rh,
              gh_m: lv.gh,
              wind_u_ms: lv.wind_u,
              wind_v_ms: lv.wind_v,
              wind_ms: lv.wind,
              wind_dir_deg: lv.windDir,
              tz_name: h.tzName,
              step_h: h.step,
              header_raw: headerRaw,
            };
          }
        }
      } catch (e) {
        failTable(dl, "windy_forecast_sounding", e);
      }
    },
  });

  // ── windy_forecast_meteogram ───────────────────────────────────────────
  // Full meteogram fidelity — surface + 17 pressure levels with every
  // parameter the meteogram endpoint exposes (vs sounding which keeps the
  // standard 6 per-level params, vs forecast_point which is surface-only).
  // One row per (timestep, level).
  dl.registerTable("windy_forecast_meteogram", {
    description:
      "Full meteogram — one row per (timestep, level). Per-level temp/dewpoint/RH/gh/wind + surface cape/ptype/gust/precip/snow/pressure/clouds. Lighter: `windy_forecast_sounding` or `windy_forecast_point`.",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "model", type: "string", description: "Forecast model id (e.g. `ecmwf`, `gfs`, `icon`)." },
      { name: "ref_time", type: "string", description: "Model reference time as ISO-8601 (the model run this row was sampled from)." },
      { name: "ts_ms", type: "number", description: "Sample timestamp, unix milliseconds UTC." },
      { name: "ts", type: "datetime", description: "Sample timestamp as ISO-8601 (parallel column to `ts_ms`)." },
      { name: "hours_offset", type: "number", description: "Hours from `ref_time` to this sample's `ts_ms` (forecast hour)." },
      { name: "level", type: "string", description: "Pressure-level key. One of: `surface`, `100m`, `975h`, `950h`, `925h`, `900h`, `850h`, `800h`, `700h`, `600h`, `500h`, `400h`, `300h`, `250h`, `200h`, `150h`, `10h`. `surface` is the only level that populates the surface-only columns." },
      { name: "alt_m", type: "number", description: "Approximate altitude of the pressure level, meters AGL (LEVEL_ALTITUDE lookup, not model-derived)." },
      { name: "alt_ft", type: "number", description: "Approximate altitude of the pressure level, feet AGL." },
      { name: "temp_k", type: "number", description: "Temperature in Kelvin. Convert: °C = temp_k − 273.15." },
      { name: "dewpoint_k", type: "number", description: "Dewpoint in Kelvin. Convert: °C = dewpoint_k − 273.15." },
      { name: "rh_pct", type: "number", description: "Relative humidity, percent (0–100)." },
      { name: "gh_m", type: "number", description: "Geopotential height at this level, meters. The actual altitude of the pressure surface in the model (more accurate than `alt_m` for soundings)." },
      { name: "wind_u_ms", type: "number", description: "Zonal (east+) wind component, m/s." },
      { name: "wind_v_ms", type: "number", description: "Meridional (north+) wind component, m/s." },
      { name: "wind_ms", type: "number", description: "Wind-speed magnitude, m/s. Convert: kt = wind_ms × 1.944, km/h = wind_ms × 3.6." },
      { name: "wind_dir_deg", type: "number", description: "Wind FROM direction, meteorological degrees. 0/360 = from N, 90 = from E, 180 = from S, 270 = from W." },
      // surface-only — null at pressure levels
      { name: "gust_ms", type: "number", description: "Peak gust speed in the timestep, m/s." },
      { name: "pressure_hpa", type: "number", description: "Surface (or level) pressure, hectopascals (= millibars). Sea-level ≈ 1013 hPa." },
      { name: "precip_mm", type: "number", description: "Total precipitation in this timestep, millimeters (liquid-equivalent)." },
      { name: "snow_mm", type: "number", description: "Snowfall in this timestep, millimeters (liquid-equivalent — divide by ~0.1 for snow depth)." },
      { name: "clouds_low", type: "number", description: "Low-cloud cover fraction (0–100 percent), surface to ~2 km AGL." },
      { name: "clouds_mid", type: "number", description: "Mid-cloud cover fraction (0–100 percent), ~2–6 km AGL." },
      { name: "clouds_high", type: "number", description: "High-cloud cover fraction (0–100 percent), ~6 km+ AGL." },
      { name: "h_clouds", type: "number", description: "Composite/high cloud fraction (server-defined alias for `clouds_high` on some models)." },
      { name: "cape", type: "number", description: "Convective Available Potential Energy, J/kg. >1000 = thunderstorm potential; >2500 = severe; >4000 = extreme." },
      { name: "ptype", type: "number", description: "Precipitation type code (server-defined integer; commonly: 0 = none, 1 = rain, 3 = sleet/mixed, 5 = snow, 7 = freezing rain — exact mapping varies by model)." },
      // metadata
      { name: "tz_name", type: "string", description: "IANA timezone of the location (e.g. `Asia/Jerusalem`). All `ts_ms` values are still UTC — use this for local-time display only." },
      { name: "step_h", type: "number", description: "Hours per sample in the time-series (1 = hourly, 3 = 3-hourly, 24 = daily)." },
      { name: "header_raw", type: "json", description: "Full response header as JSON — useful when you need fields not surfaced as columns (e.g. `celestial`, model metadata). Top-level keys: see ForecastHeader / TideForecast['header'] in @yosit/windy." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "model", required: "optional" },
      { name: "ref_time", required: "optional" },
      { name: "step", required: "optional" },
      { name: "level", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      const levelFilter = qStr(ctx.quals, "level");
      try {
        const c = getClient(ctx);
        const raw = (await c.meteogram(lat, lon, {
          model: qMeteogramModel(ctx.quals),
          refTime: qStr(ctx.quals, "ref_time"),
          step: qNum(ctx.quals, "step"),
        })) as {
          header: { model: string; refTime: string; step?: number; tzName?: string };
          data: Record<string, number[] | undefined> & { hours: number[] };
        };
        const h = raw.header;
        const model = meteogramEmittedModel(h.model);
        const refTime = h.refTime;
        const headerRaw = jsonOrUndef(h);
        const tsArr = raw.data.hours ?? [];
        const refMs = Date.parse(refTime);
        const levels: readonly Level[] = levelFilter
          ? ((LEVELS as readonly Level[]).filter((l) => l === levelFilter))
          : (LEVELS as readonly Level[]);
        for (let i = 0; i < tsArr.length; i++) {
          const ts = tsArr[i];
          const hoursOffset = Number.isFinite(refMs)
            ? Math.round((ts - refMs) / 3_600_000)
            : undefined;
          for (const level of levels) {
            const u = raw.data[`wind_u-${level}`]?.[i];
            const v = raw.data[`wind_v-${level}`]?.[i];
            const explicitWind = raw.data[`wind-${level}`]?.[i];
            const row: Record<string, unknown> = {
              lat, lon, model, ref_time: refTime,
              ts_ms: ts,
              ts: isoFromMs(ts),
              hours_offset: hoursOffset,
              level,
              alt_m: LEVEL_ALTITUDE[level]?.altM,
              alt_ft: LEVEL_ALTITUDE[level]?.altFt,
              temp_k: raw.data[`temp-${level}`]?.[i],
              dewpoint_k: raw.data[`dewpoint-${level}`]?.[i],
              rh_pct: raw.data[`rh-${level}`]?.[i],
              gh_m: raw.data[`gh-${level}`]?.[i],
              wind_u_ms: u,
              wind_v_ms: v,
              wind_ms:
                u != null && v != null ? Math.hypot(u, v) : explicitWind,
              wind_dir_deg: windDirFromUV(u, v),
              tz_name: h.tzName,
              step_h: h.step,
              header_raw: headerRaw,
            };
            if (level === "surface") {
              row.gust_ms = raw.data["gust-surface"]?.[i];
              row.pressure_hpa = raw.data["pressure-surface"]?.[i];
              row.precip_mm = raw.data["mm-surface"]?.[i];
              row.snow_mm = raw.data["snow-surface"]?.[i];
              row.clouds_low = raw.data["clouds_low-surface"]?.[i];
              row.clouds_mid = raw.data["clouds_mid-surface"]?.[i];
              row.clouds_high = raw.data["clouds_high-surface"]?.[i];
              row.h_clouds = raw.data["hClouds-surface"]?.[i];
              row.cape = raw.data["cape-surface"]?.[i];
              row.ptype = raw.data["ptype-surface"]?.[i];
            }
            yield row;
          }
        }
      } catch (e) {
        failTable(dl, "windy_forecast_meteogram", e);
      }
    },
  });

  // ── windy_forecast_air_quality ─────────────────────────────────────────
  dl.registerTable("windy_forecast_air_quality", {
    description:
      "Air-quality forecast — one row per timestep with NO2/O3/PM2.5/PM10/SO2/CO/AQI. `model` ∈ {`cams` (default), `camsEu`}. For OBSERVED AQ see `windy_stations_nearby_air_quality`.",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "model", type: "string", description: "Forecast model id (e.g. `ecmwf`, `gfs`, `icon`)." },
      { name: "ref_time", type: "string", description: "Model reference time as ISO-8601 (the model run this row was sampled from)." },
      { name: "ts_ms", type: "number", description: "Sample timestamp, unix milliseconds UTC." },
      { name: "ts", type: "datetime", description: "Sample timestamp as ISO-8601 (parallel column to `ts_ms`)." },
      { name: "no2", type: "number", description: "Nitrogen dioxide concentration, µg/m³." },
      { name: "o3", type: "number", description: "Ozone concentration, µg/m³. Surface (tropospheric) O₃ is the pollutant; column total (`go3`) is folded in here when surface isn't reported." },
      { name: "pm25", type: "number", description: "PM2.5 particulate matter concentration, µg/m³." },
      { name: "pm10", type: "number", description: "PM10 particulate matter concentration, µg/m³." },
      { name: "so2", type: "number", description: "Sulfur dioxide concentration, µg/m³." },
      { name: "co", type: "number", description: "Carbon monoxide concentration, mg/m³ (note: CO units differ from other pollutants)." },
      { name: "aqi", type: "number", description: "Air Quality Index (US EPA scale typically). 0–50 good, 51–100 moderate, 101–150 unhealthy for sensitive, 151–200 unhealthy, 201–300 very unhealthy, 301+ hazardous." },
      { name: "aod550", type: "number", description: "Aerosol optical depth at 550 nm — proxy for haze / aerosol load. Dimensionless." },
      { name: "header_raw", type: "json", description: "Full response header as JSON — useful when you need fields not surfaced as columns (e.g. `celestial`, model metadata). Top-level keys: see ForecastHeader / TideForecast['header'] in @yosit/windy." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "model", required: "optional" },
      { name: "ref_time", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      const m = qModel(ctx.quals);
      try {
        const c = getClient(ctx);
        const raw = (await c.airQualityForecast(lat, lon, {
          model: m === "camseu" ? "camsEu" : "cams",
          refTime: qStr(ctx.quals, "ref_time"),
        })) as {
          header: { model: string; refTime: string };
          data: { ts: number[] } & Record<string, number[] | undefined>;
        };
        const model = lc(raw.header.model);
        const refTime = raw.header.refTime;
        const d = raw.data;
        const tsArr = d.ts ?? [];
        const headerRaw = jsonOrUndef(raw.header);
        for (let i = 0; i < tsArr.length; i++) {
          yield {
            lat, lon, model, ref_time: refTime,
            ts_ms: tsArr[i],
            ts: isoFromMs(tsArr[i]),
            no2: d.no2?.[i],
            o3: d.o3?.[i] ?? d.go3?.[i],
            pm25: d.pm25?.[i] ?? d.pm2p5?.[i],
            pm10: d.pm10?.[i],
            so2: d.so2?.[i] ?? d.tcso2?.[i],
            co: d.co?.[i] ?? d.cosc?.[i],
            aqi: d.aqi?.[i],
            aod550: d.aod550?.[i],
            header_raw: headerRaw,
          };
        }
      } catch (e) {
        failTable(dl, "windy_forecast_air_quality", e);
      }
    },
  });

  // ── windy_forecast_models ──────────────────────────────────────────────
  dl.registerTable("windy_forecast_models", {
    description:
      "Forecast model manifest — available runs, refresh times, premium gating. Use to discover a `ref_time` to pass to other forecast tables. Filter by `model` (default `ecmwf-hres`) and `premium`.",
    columns: [
      { name: "model", type: "string", description: "Forecast model id (e.g. `ecmwf`, `gfs`, `icon`)." },
      { name: "premium", type: "boolean", description: "Whether the manifest reflects premium-tier reftimes (faster refresh) or free-tier only." },
      { name: "manifest", type: "json", description: "Full model-manifest payload. Phase 4b observed top-level keys: `dst` (active model-run id), `info`, `ref` (canonical ref-time), `update` (ISO), `v` (version), `end` (final timestep), `urls` (tile URL templates). Use `manifest->'dst'` for the latest run; `manifest->'ref'` for its ISO timestamp." },
    ],
    keyColumns: [
      { name: "model", required: "optional" },
      { name: "premium", required: "optional" },
    ],
    async *list(ctx) {
      try {
        const c = getClient(ctx);
        const model = qModel(ctx.quals) ?? "ecmwf-hres";
        const premium = qBool(ctx.quals, "premium") ?? true;
        const m = await c.modelManifest(model, premium);
        yield { model, premium, manifest: jsonOrUndef(m) };
      } catch (e) {
        logErr(dl, "windy_forecast_models", e);
      }
    },
  });

  // ── windy_places (location search) ─────────────────────────────────────
  dl.registerTable("windy_places", {
    description:
      "Location text search. Use to resolve a place name to (lat, lon) before calling any other windy table. Results biased toward `bias_lat`/`bias_lon` when supplied (defaults to (0,0)).",
    columns: [
      { name: "query", type: "string", description: "Free-text query passed in WHERE — echoed. The full needle that produced this match." },
      { name: "bias_lat", type: "number", description: "Bias-point latitude passed in WHERE — echoed. Results closer to (bias_lat, bias_lon) ranked higher." },
      { name: "bias_lon", type: "number", description: "Bias-point longitude passed in WHERE — echoed." },
      { name: "id", type: "string", description: "Windy place id. Use as a stable key across queries; not the same as `webcam_id`." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "title", type: "string", description: "Display name of the matched place (e.g. \"Tel Aviv, Israel\")." },
      { name: "type", type: "string", description: "Match category — OpenStreetMap-style category names (windy proxies OSM data here). Phase 4b observed (~25): `aeroway`, `bus_stop`, `city`, `city_district`, `country`, `fuel`, `hamlet`, `historic`, `hostel`, `hotel`, `landuse`, `leisure`, `parking`, `pg`, `place`, `railway`, `state`, `state_district`, `station`, `suburb`, `suburb_part`, `surf`, `town`, `village`, `webcam`, `wood`. More likely exist; treat as open vocabulary." },
      { name: "cc", type: "string", description: "ISO 3166-1 alpha-2 country code, lowercase (e.g. `il`, `us`, `de`)." },
      { name: "country", type: "string", description: "Country display name in the user's `lang` (e.g. \"Israel\")." },
      { name: "region", type: "string", description: "Region within the country (geographic / administrative subdivision)." },
      { name: "state", type: "string", description: "State / province name. Most relevant for federations (US, India, etc.)." },
      { name: "bounds", type: "string", description: "Bounding box, comma-separated: `minLat,minLon,maxLat,maxLon`. Useful for map framing." },
      { name: "webcam_id", type: "string", description: "Populated only when `type='webcam'` — the matching webcam's numeric id." },
    ],
    keyColumns: [
      { name: "query", required: "required" },
      { name: "bias_lat", required: "optional" },
      { name: "bias_lon", required: "optional" },
      { name: "size", required: "optional" },
    ],
    async *list(ctx) {
      const q = qStr(ctx.quals, "query");
      if (!q) return;
      const biasLat = qNum(ctx.quals, "bias_lat") ?? 0;
      const biasLon = qNum(ctx.quals, "bias_lon") ?? 0;
      const size = qNum(ctx.quals, "size") ?? 13;
      try {
        const c = getClient(ctx);
        const r: SearchResponse = await c.search(q, biasLat, biasLon, size);
        for (const x of r.data ?? []) {
          yield {
            query: q,
            bias_lat: biasLat,
            bias_lon: biasLon,
            id: x.id,
            lat: x.lat,
            lon: x.lon,
            title: x.title,
            type: x.type,
            cc: x.cc,
            country: x.country,
            region: x.region,
            state: x.state,
            bounds: x.bounds,
            webcam_id: x.webcamId,
          };
        }
      } catch (e) {
        logErr(dl, "windy_places", e);
      }
    },
  });

  // ── windy_geo_reverse ──────────────────────────────────────────────────
  dl.registerTable("windy_geo_reverse", {
    description:
      "Reverse-geocode a coordinate to suburb / city / district / state / country. Single row. Use when the user has lat/lon and needs a human-readable place name. `zoom` 14 ≈ neighborhood, 10 ≈ city. NOTE: open-ocean and polar coords return an empty row (every field null) — verified at 0,-150 and 89,0 in Phase 4b. Antarctica resolves cleanly (`country='Antarctica', country_code='aq'`).",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "zoom", type: "number", description: "Web-map zoom level passed in WHERE. 10 ≈ city, 14 ≈ neighborhood, 18 ≈ street." },
      { name: "suburb", type: "string", description: "Suburb / neighborhood. Null for rural / open-water coords." },
      { name: "city", type: "string", description: "City / town containing the coord. Null for remote areas." },
      { name: "district", type: "string", description: "District within the city, where applicable." },
      { name: "state", type: "string", description: "State / province / region (administrative level 1)." },
      { name: "country", type: "string", description: "Country display name in the user's `lang`." },
      { name: "country_code", type: "string", description: "ISO 3166-1 alpha-2 country code, lowercase." },
      { name: "location_name", type: "string", description: "Most-specific place name windy assigns to the coord (often equals city + state, varies by zoom)." },
      { name: "location_id", type: "string", description: "Stable windy id for the geocoded location. Joins with `windy_places.id`." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "zoom", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      const zoom = qNum(ctx.quals, "zoom") ?? 14;
      try {
        const c = getClient(ctx);
        const r: ReverseGeocode = await c.reverseGeocode(lat, lon, zoom);
        yield {
          lat, lon, zoom,
          suburb: r.suburb,
          city: r.city,
          district: r.district,
          state: r.state,
          country: r.country,
          country_code: r.country_code,
          location_name: r.location?.name,
          location_id: r.location?.id,
        };
      } catch (e) {
        logErr(dl, "windy_geo_reverse", e);
      }
    },
  });

  // ── windy_geo_elevation ────────────────────────────────────────────────
  dl.registerTable("windy_geo_elevation", {
    description:
      "Elevation in meters at a coordinate. Single row. Use for questions about altitude, hiking, terrain, or to convert pressure-altitude between AGL/MSL.",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "elevation_m", type: "number", description: "Terrain elevation at the requested coord, meters above MSL." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        const m = await c.elevation(lat, lon);
        yield { lat, lon, elevation_m: m };
      } catch (e) {
        logErr(dl, "windy_geo_elevation", e);
      }
    },
  });

  // ── windy_geo_timezone ─────────────────────────────────────────────────
  dl.registerTable("windy_geo_timezone", {
    description:
      "Timezone info for a coordinate at an instant (default: now). Use to convert UTC timestamps from forecast tables to local time, or to detect DST transitions at the location.",
    columns: [
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "ts_ms", type: "number", description: "Timestamp, unix milliseconds UTC." },
      { name: "tz_name", type: "string", description: "IANA timezone of the location (e.g. `Asia/Jerusalem`). All `ts_ms` values are still UTC — use this for local-time display only." },
      { name: "tz_offset_min", type: "number", description: "Local-time offset from UTC, MINUTES (positive = east). E.g. 180 for Israel summer time, −300 for US Eastern." },
      { name: "tz_abbrev", type: "string", description: "Short timezone abbreviation (e.g. `IDT`, `PST`, `EDT`). DST-aware." },
      { name: "raw", type: "json", description: "Complete raw row from the upstream API — preserves any field not surfaced as a column. Use `raw->'fieldname'` to extract specific values." },
    ],
    keyColumns: [
      { name: "lat", required: "required" },
      { name: "lon", required: "required" },
      { name: "ts_ms", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      if (lat == null || lon == null) return;
      const ts = qNum(ctx.quals, "ts_ms") ?? Date.now();
      try {
        const c = getClient(ctx);
        const r = (await c.timezone(lat, lon, ts)) as Record<string, unknown>;
        yield {
          lat, lon, ts_ms: ts,
          tz_name: str(r?.TZname) ?? str(r?.tzName),
          tz_offset_min: num(r?.TZoffsetMin) ?? num(r?.TZoffset),
          tz_abbrev: str(r?.TZabbrev),
          raw: jsonOrUndef(r),
        };
      } catch (e) {
        logErr(dl, "windy_geo_timezone", e);
      }
    },
  });

  // ── windy_stations_nearby ──────────────────────────────────────────────
  dl.registerTable("windy_stations_nearby", {
    description:
      "Nearby ground stations (METAR/WMO/PWS/MADIS) with latest obs — OBSERVED weather vs forecast. Distance in km. Join `id` into `windy_station_observations` for history.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "id", type: "string", description: "Station identifier in `<type>-<bare-id>` form (e.g. `airq-1029`)." },
      { name: "name", type: "string", description: "Display name of the station." },
      { name: "type", type: "string", description: "Station network. Phase 4b observed: `madis`, `wmo`, `pws`, `ad` (airport METAR), `ship` (ship-borne reports). `airq` is documented but not returned by this endpoint (use `windy_stations_nearby_air_quality` for those)." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "dist_km", type: "number", description: "Great-circle distance from the query point to this station/POI, kilometers." },
      { name: "diff_min", type: "number", description: "Age of the latest observation, minutes (now − observation time)." },
      { name: "h_ago", type: "number", description: "Whole-hours portion of observation age (e.g. 2 for \"2h 15min ago\")." },
      { name: "min_ago", type: "number", description: "Remainder-minutes portion of observation age (e.g. 15 for \"2h 15min ago\")." },
      { name: "temp_c", type: "number", description: "Latest observed temperature, Celsius (note: stations report °C, unlike forecast tables which use Kelvin)." },
      { name: "wind_ms", type: "number", description: "Wind-speed magnitude, m/s. Convert: kt = wind_ms × 1.944, km/h = wind_ms × 3.6." },
      { name: "gust_ms", type: "number", description: "Peak gust speed in the timestep, m/s." },
      { name: "dir_deg", type: "number", description: "Wind FROM direction at the station, meteorological degrees (0/360 = N, 90 = E, 180 = S, 270 = W)." },
      { name: "precip", type: "number", description: "Observed precipitation in the reporting interval, mm." },
      { name: "qnh_hpa", type: "number", description: "QNH (sea-level-corrected pressure), hPa. Used by pilots for altimeter setting." },
      { name: "rh_pct", type: "number", description: "Relative humidity, percent (0–100)." },
      { name: "dew_point_c", type: "number", description: "Dewpoint at the station, Celsius." },
      { name: "wx_icon", type: "number", description: "Windy weather-icon code for this station's current conditions (same vocabulary as `icon`)." },
      { name: "is_airport", type: "boolean", description: "Filterable hint that the station is an airport METAR reporter. Phase 4b observed: always null in nearby-station rows — use `type = 'ad'` instead. The flag appears in observation-endpoint headers, not the nearby list." },
    ],
    keyColumns: [
      { name: "query_lat", required: "required" },
      { name: "query_lon", required: "required" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        const rows: NearbyWeatherStation[] = await c.nearbyStations(lat, lon);
        for (const r of rows ?? []) {
          yield {
            query_lat: lat, query_lon: lon,
            id: r.id, name: r.name, type: r.type,
            lat: r.lat, lon: r.lon, dist_km: r.dist,
            diff_min: r.diff, h_ago: r.hAgo, min_ago: r.minAgo,
            temp_c: r.temp, wind_ms: r.wind, gust_ms: r.gust,
            dir_deg: r.dir, precip: r.precip, qnh_hpa: r.qnh,
            rh_pct: r.rh, dew_point_c: r.dew_point,
            wx_icon: r.wx_icon, is_airport: r.is_airport === 1,
          };
        }
      } catch (e) {
        logErr(dl, "windy_stations_nearby", e);
      }
    },
  });

  // ── windy_stations_nearby_air_quality ──────────────────────────────────
  dl.registerTable("windy_stations_nearby_air_quality", {
    description:
      "Nearby measured AQ stations with current AQI snapshot. Join `id` into `windy_station_air_quality` for full pollutant breakdown. For forecast AQ use `windy_forecast_air_quality`.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "id", type: "string", description: "AQ-station id with `airq-` prefix (e.g. `airq-1029`). Pass to `windy_station_air_quality.id`." },
      { name: "name", type: "string", description: "Display name of the AQ station (e.g. \"Holon\", \"Tel Aviv University\")." },
      { name: "data_source", type: "string", description: "Upstream provider name. Phase 4b observed: `openaq.org` (aggregator), `PurpleAir` (PWS PM2.5 network). Free-form string — treat as open vocabulary." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "dist_km", type: "number", description: "Great-circle distance from the query point to this station/POI, kilometers." },
      { name: "aqi", type: "number", description: "Air Quality Index (US EPA scale typically). 0–50 good, 51–100 moderate, 101–150 unhealthy for sensitive, 151–200 unhealthy, 201–300 very unhealthy, 301+ hazardous." },
      { name: "diff_min", type: "number", description: "Age of the latest observation, minutes (now − observation time)." },
      { name: "h_ago", type: "number", description: "Whole-hours portion of observation age (e.g. 2 for \"2h 15min ago\")." },
      { name: "min_ago", type: "number", description: "Remainder-minutes portion of observation age (e.g. 15 for \"2h 15min ago\")." },
    ],
    keyColumns: [
      { name: "query_lat", required: "required" },
      { name: "query_lon", required: "required" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        const rows: NearbyAirQualityStation[] = await c.nearbyAirQuality(lat, lon);
        for (const r of rows ?? []) {
          yield {
            query_lat: lat, query_lon: lon,
            id: r.id, name: r.name, data_source: r.dataSource,
            lat: r.lat, lon: r.lon, dist_km: r.dist,
            aqi: r.aqi, diff_min: r.diff,
            h_ago: r.hAgo, min_ago: r.minAgo,
          };
        }
      } catch (e) {
        logErr(dl, "windy_stations_nearby_air_quality", e);
      }
    },
  });

  // ── windy_stations_nearby_tides ────────────────────────────────────────
  dl.registerTable("windy_stations_nearby_tides", {
    description:
      "Nearby tide stations (POI list). Use to discover a `poi_id` to pass to `windy_tides` / `windy_tide_extremes`. The raw JSON of each row is preserved in `raw`.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "id", type: "string", description: "Tide-POI id (e.g. `tide-1234`). Pass to `windy_tides.poi_id` / `windy_tide_extremes.poi_id`." },
      { name: "name", type: "string", description: "Tide-port display name (e.g. \"Haifa\", \"Aberdeen\")." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "dist_km", type: "number", description: "Great-circle distance from the query point to this station/POI, kilometers." },
      { name: "raw", type: "json", description: "Complete raw row from the upstream API — preserves any field not surfaced as a column. Use `raw->'fieldname'` to extract specific values." },
    ],
    keyColumns: [
      { name: "query_lat", required: "required" },
      { name: "query_lon", required: "required" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      if (lat == null || lon == null) return;
      try {
        const c = getClient(ctx);
        const raw = await c.nearbyTides(lat, lon);
        const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { pois?: unknown[] })?.pois) ? (raw as { pois: unknown[] }).pois : [];
        for (const r of rows as Array<Record<string, unknown>>) {
          yield {
            query_lat: lat, query_lon: lon,
            id: str(r.id),
            name: str(r.name),
            lat: num(r.lat),
            lon: num(r.lon),
            dist_km: num(r.dist),
            raw: jsonOrUndef(r),
          };
        }
      } catch (e) {
        logErr(dl, "windy_stations_nearby_tides", e);
      }
    },
  });

  // ── windy_station_air_quality (POI detail) ─────────────────────────────
  dl.registerTable("windy_station_air_quality", {
    description:
      "Detailed latest measurement from one AQ station — full pollutant breakdown (CO/NO2/O3/PM2.5/PM10/SO2 with per-pollutant AQI). Single row. Get the `id` from `windy_stations_nearby_air_quality`.",
    columns: [
      { name: "id", type: "string", description: "AQ-POI id (with `airq-` prefix). Echoed from the WHERE filter." },
      { name: "type", type: "string", description: "POI kind. Always `airq` for this table." },
      { name: "lat", type: "number", description: "POI latitude, decimal degrees." },
      { name: "lon", type: "number", description: "POI longitude, decimal degrees." },
      { name: "name", type: "string", description: "Display name of the AQ station." },
      { name: "time", type: "string", description: "Timestamp of the latest measurement, ISO-8601 UTC (e.g. `2026-05-13T20:00:00Z`)." },
      { name: "data_source", type: "string", description: "Upstream provider name. Phase 4b observed: `openaq.org` (aggregator), `PurpleAir` (PWS PM2.5 network). Free-form string — treat as open vocabulary." },
      { name: "source", type: "string", description: "Original publisher/aggregator of the measurement (server-defined; e.g. `openaq`, `eea`, `airnow`)." },
      { name: "station_id", type: "string", description: "Source station id as the upstream provider issued it (may include prefixes the windy `id` lacks)." },
      { name: "rank", type: "number", description: "Server-assigned priority for the station in nearby/list queries — lower is ranked higher." },
      { name: "quality", type: "number", description: "Server-assigned reliability score for the station's measurements (higher = more trusted)." },
      { name: "size", type: "number", description: "Station-network size category (server-defined; higher = larger / more-trusted)." },
      { name: "diff_min", type: "number", description: "Age of the latest observation, minutes (now − observation time)." },
      { name: "aqi", type: "number", description: "Air Quality Index (US EPA scale typically). 0–50 good, 51–100 moderate, 101–150 unhealthy for sensitive, 151–200 unhealthy, 201–300 very unhealthy, 301+ hazardous." },
      { name: "co", type: "number", description: "Carbon monoxide concentration, mg/m³ (note: CO units differ from other pollutants)." },
      { name: "co_aqi", type: "number", description: "Per-pollutant AQI sub-index for CO." },
      { name: "no2", type: "number", description: "Nitrogen dioxide concentration, µg/m³." },
      { name: "no2_aqi", type: "number", description: "Per-pollutant AQI sub-index for NO₂." },
      { name: "o3", type: "number", description: "Ozone concentration, µg/m³." },
      { name: "o3_aqi", type: "number", description: "Per-pollutant AQI sub-index for O₃." },
      { name: "pm10", type: "number", description: "PM10 particulate matter concentration, µg/m³." },
      { name: "pm10_aqi", type: "number", description: "Per-pollutant AQI sub-index for PM10." },
      { name: "pm25", type: "number", description: "PM2.5 particulate matter concentration, µg/m³." },
      { name: "pm25_aqi", type: "number", description: "Per-pollutant AQI sub-index for PM2.5." },
      { name: "so2", type: "number", description: "Sulfur dioxide concentration, µg/m³." },
      { name: "so2_aqi", type: "number", description: "Per-pollutant AQI sub-index for SO₂." },
    ],
    keyColumns: [{ name: "id", required: "required" }],
    async *list(ctx) {
      const id = qStr(ctx.quals, "id");
      if (!id) return;
      try {
        const c = getClient(ctx);
        const r: AirQualityPOI = await c.airQualityStation(id);
        yield {
          id: r.id, type: r.type, lat: r.lat, lon: r.lon, name: r.name, time: r.time,
          data_source: r.dataSource, source: r.source,
          station_id: r.stationID, rank: r.rank, quality: r.quality,
          size: r.size, diff_min: r.diff,
          aqi: r.aqi,
          co: r.co, co_aqi: r.co_aqi,
          no2: r.no2, no2_aqi: r.no2_aqi,
          o3: r.o3, o3_aqi: r.o3_aqi,
          pm10: r.pm10, pm10_aqi: r.pm10_aqi,
          pm25: r.pm25, pm25_aqi: r.pm25_aqi,
          so2: r.so2, so2_aqi: r.so2_aqi,
        };
      } catch (e) {
        logErr(dl, "windy_station_air_quality", e);
      }
    },
  });

  // ── windy_station_observations ─────────────────────────────────────────
  dl.registerTable("windy_station_observations", {
    description:
      "Historical obs time-series for one station — temp / wind / windDir / dewPoint / pressure / visibility / weathercode / category. Use to backtest a forecast or grab METAR history. `station_type` ∈ {airq, ad, wmo, pws, madis}. Server data-keys are camelCase; the table mirrors them.",
    columns: [
      { name: "station_type", type: "string", description: "Station network. One of: `airq`, `ad`, `wmo`, `pws`, `madis`. Echoed from the WHERE filter." },
      { name: "station_id", type: "string", description: "Station id (without type prefix). Echoed from the WHERE filter." },
      { name: "station_name", type: "string", description: "Display name of the station (e.g. \"Ben Gurion International Airport\")." },
      { name: "lat", type: "number", description: "Station latitude, decimal degrees, WGS-84." },
      { name: "lon", type: "number", description: "Station longitude, decimal degrees, WGS-84." },
      { name: "station_source_name", type: "string", description: "Upstream feed identifier. Phase 4b observed: `adds` (NOAA ADDS METAR), `noaa` (NWS), `openaq.org`, `PurpleAir`. Same on every row of a single series." },
      { name: "station_subtype", type: "string", description: "Station-subtype classification. For airports: `large_airport` / `medium_airport` / `small_airport` / `heliport` / `seaplane_base`. Empty for non-airport networks." },
      { name: "station_is_airport", type: "boolean", description: "True if this is an airport METAR reporter (server returns `1`/`0`; plugin converts). Reliable here in the obs header (unlike `windy_stations_nearby.is_airport` which is always null)." },
      { name: "station_avg_delay_min", type: "number", description: "Average publish-delay between observation time and when it appears in the feed, minutes. Higher = staler data." },
      { name: "station_obs_count", type: "number", description: "Total observation records returned in this window. Same on every row of a single series." },
      { name: "station_latest_obs_ms", type: "number", description: "Most recent observation timestamp the station has reported, unix milliseconds UTC. Compare to `NOW()` to detect offline stations." },
      { name: "station_avg_freq_min", type: "number", description: "Average gap between consecutive observations, minutes. METAR airports ≈ 30; high-freq PWS can be <10." },
      { name: "station_declination_deg", type: "number", description: "Magnetic declination at the station, decimal degrees (signed; positive = E, negative = W). Add to magnetic headings to get true headings." },
      { name: "station_step_h", type: "number", description: "Server's sampling step for this series, hours. Echoes the `step` WHERE filter (typically 1, 3, or 24)." },
      { name: "station_updated_ms", type: "number", description: "When windy last refreshed this series, unix milliseconds UTC. Distinct from `station_latest_obs_ms` (the underlying obs time)." },
      { name: "station_duplicity_id", type: "string", description: "Id of a related station record (e.g. the WMO synoptic that mirrors this airport's METAR). Join in `windy_station_observations` to compare paired feeds." },
      { name: "station_duplicity_type", type: "string", description: "Network of the related station. Phase 4b observed: `wmo` on AD airport rows (a paired synoptic report)." },
      { name: "station_duplicates", type: "json", description: "JSON array of related-station IDs (excludes the row's own id; intersects with `station_duplicity_id`). Empty array when no duplicates." },
      { name: "station_header_raw", type: "json", description: "Full header object as JSON — preserves any field not surfaced as a column (`desc`, `start`, `observation` block, vendor extensions). Same on every row of a single series." },
      { name: "ts_ms", type: "number", description: "Observation timestamp, unix milliseconds UTC." },
      { name: "ts", type: "datetime", description: "Observation timestamp as ISO-8601." },
      { name: "temp", type: "number", description: "Observed temperature. Units depend on `station_type`: METAR (`ad`) typically °C; PWS may report °C or °F — check `raw` if unsure." },
      { name: "wind", type: "number", description: "Observed wind speed, m/s." },
      { name: "wind_dir", type: "number", description: "Observed wind FROM direction, meteorological degrees (0/360 = N). Server key is `windDir`." },
      { name: "gust", type: "number", description: "Observed gust speed, m/s. May be null when the network doesn't report gusts." },
      { name: "dew_point", type: "number", description: "Observed dewpoint temperature, same units as `temp`. Server key is `dewPoint`." },
      { name: "pressure", type: "number", description: "Observed pressure, hPa (=mbar). METAR/WMO usually report QNH (sea-level adjusted); PWS may report station pressure." },
      { name: "rh", type: "number", description: "Observed relative humidity, percent (0–100). Often null on METAR feeds (computed from temp/dewpoint instead — derive when needed)." },
      { name: "precip", type: "number", description: "Observed precipitation in the sampling interval, mm." },
      { name: "visibility", type: "number", description: "Horizontal visibility, meters. METAR-derived; expect 10000 (= clear / max) on most clear-air observations." },
      { name: "weathercode", type: "number", description: "WMO present-weather code (server-defined integer). METAR/WMO synoptic value; see WMO Table 4677 for canonical mapping." },
      { name: "category", type: "string", description: "Flight-rules category for the observation. METAR convention: `VFR`, `MVFR`, `IFR`, `LIFR`. Populated for `station_type='ad'` (airport) rows; null for PWS." },
      { name: "aqi", type: "number", description: "Air Quality Index (only populated for `station_type='airq'`). EPA scale: 0–50 good ... 301+ hazardous." },
      { name: "raw", type: "json", description: "Complete raw row from the obs endpoint — preserves any parameter not surfaced as a column. Top-level keys are the server's parameter names (camelCase, e.g. `dewPoint`, `windDir`)." },
    ],
    keyColumns: [
      { name: "station_type", required: "required" },
      { name: "station_id", required: "required" },
      { name: "days", required: "optional" },
      { name: "step", required: "optional" },
    ],
    async *list(ctx) {
      const type = qStr(ctx.quals, "station_type");
      const id = qStr(ctx.quals, "station_id");
      if (!type || !id) return;
      const allowed = ["airq", "ad", "wmo", "pws", "madis"] as const;
      if (!(allowed as readonly string[]).includes(type)) return;
      const days = qNum(ctx.quals, "days") ?? 10;
      const step = qNum(ctx.quals, "step") ?? 1;
      try {
        const c = getClient(ctx);
        const obs: ObservationTimeseries = await c.observations(
          type as (typeof allowed)[number],
          id,
          days,
          step,
        );
        const d = obs.data;
        const tsArr = d.ts ?? [];
        const h = obs.header ?? ({} as Record<string, unknown>);
        // Precompute header-derived columns (same on every row of this series).
        const name = h.name as string | undefined;
        const lat = h.lat as number | undefined;
        const lon = h.lon as number | undefined;
        const sourceName = (h.source_name as string | undefined) ?? (h.dataSource as string | undefined);
        const subtype = h.subtype as string | undefined;
        const isAirport = h.is_airport === 1 ? true : h.is_airport === 0 ? false : undefined;
        const observation = (h.observation as { records?: number; avgDelayMin?: number; avgFreqMin?: number; latestObs?: string } | undefined) ?? undefined;
        const avgDelayMin = num(h.avg_delay_min ?? observation?.avgDelayMin);
        const obsCount = num(h.obs_count ?? observation?.records ?? h.size);
        const latestObsMs = (() => {
          const v = (h.latest_obs as string | undefined) ?? observation?.latestObs;
          return v ? Date.parse(v) : undefined;
        })();
        const avgFreqMin = num(observation?.avgFreqMin);
        const declinationDeg = num(h.declination);
        const stepH = num(h.step);
        const updatedMs = (() => {
          const v = h.updated as string | undefined;
          return v ? Date.parse(v) : undefined;
        })();
        const duplicityId = h.duplicityId as string | undefined;
        const duplicityType = h.duplicityType as string | undefined;
        const duplicates = Array.isArray(h.duplicates) ? jsonOrUndef(h.duplicates) : undefined;
        const headerRaw = jsonOrUndef(h);

        for (let i = 0; i < tsArr.length; i++) {
          const rowJson: Record<string, unknown> = { ts_ms: tsArr[i] };
          for (const [k, arr] of Object.entries(d)) {
            if (k === "ts") continue;
            if (Array.isArray(arr)) rowJson[k] = arr[i];
          }
          yield {
            station_type: type,
            station_id: id,
            station_name: name,
            lat, lon,
            station_source_name: sourceName,
            station_subtype: subtype,
            station_is_airport: isAirport,
            station_avg_delay_min: avgDelayMin,
            station_obs_count: obsCount,
            station_latest_obs_ms: latestObsMs,
            station_avg_freq_min: avgFreqMin,
            station_declination_deg: declinationDeg,
            station_step_h: stepH,
            station_updated_ms: updatedMs,
            station_duplicity_id: duplicityId,
            station_duplicity_type: duplicityType,
            station_duplicates: duplicates,
            station_header_raw: headerRaw,
            ts_ms: tsArr[i],
            ts: isoFromMs(tsArr[i]),
            temp: num(rowJson.temp),
            wind: num(rowJson.wind),
            wind_dir: num(rowJson.windDir ?? rowJson.wind_dir ?? rowJson.dir),
            gust: num(rowJson.gust),
            dew_point: num(rowJson.dewPoint ?? rowJson.dew_point),
            pressure: num(rowJson.pressure),
            rh: num(rowJson.rh),
            precip: num(rowJson.precip),
            visibility: num(rowJson.visibility),
            weathercode: num(rowJson.weathercode),
            category: typeof rowJson.category === "string" ? rowJson.category : undefined,
            aqi: num(rowJson.aqi),
            raw: jsonOrUndef(rowJson),
          };
        }
      } catch (e) {
        logErr(dl, "windy_station_observations", e);
      }
    },
  });

  // ── windy_tides ────────────────────────────────────────────────────────
  // Long-format heights. Use either (lat,lon) or poi_id to identify the port.
  dl.registerTable("windy_tides", {
    description:
      "Tide-height forecast time-series. Use for sailing/fishing/coastal access. Pass (`query_lat`,`query_lon`) for nearest port OR `poi_id` (from `windy_stations_nearby_tides`). Heights in m above datum.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "poi_id", type: "string", description: "Tide-POI id (e.g. `tide-1234`). Echoed when the WHERE filter pinned the table to a specific port; null when nearest-port lookup was used." },
      { name: "port_name", type: "string", description: "Display name of the resolved tide port (e.g. \"Haifa\", \"Aberdeen\")." },
      { name: "port_lat", type: "number", description: "Tide port latitude, decimal degrees. May differ from `query_lat` since the server snaps to the nearest registered port." },
      { name: "port_lon", type: "number", description: "Tide port longitude, decimal degrees." },
      { name: "tz_name", type: "string", description: "IANA timezone of the location (e.g. `Asia/Jerusalem`). All `ts_ms` values are still UTC — use this for local-time display only." },
      { name: "ts_ms", type: "number", description: "Sample timestamp, unix milliseconds UTC." },
      { name: "ts", type: "datetime", description: "Sample timestamp as ISO-8601 (parallel column to `ts_ms`)." },
      { name: "height_m", type: "number", description: "Tide height above chart datum, meters. Chart datum is typically the lowest astronomical tide (LAT)." },
      { name: "header_raw", type: "json", description: "Full response header as JSON — useful when you need fields not surfaced as columns (e.g. `celestial`, model metadata). Top-level keys: see ForecastHeader / TideForecast['header'] in @yosit/windy." },
    ],
    keyColumns: [
      { name: "query_lat", required: "optional" },
      { name: "query_lon", required: "optional" },
      { name: "poi_id", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      const poi = qStr(ctx.quals, "poi_id");
      if (poi == null && (lat == null || lon == null)) return;
      try {
        const c = getClient(ctx);
        const r: TideForecast = poi
          ? await c.tidesByPoi(poi)
          : await c.tides(lat as number, lon as number);
        const portName = str(r.header?.name);
        const portLat = num(r.header?.lat);
        const portLon = num(r.header?.lon);
        const tzName = str(r.header?.tzName);
        const headerRaw = jsonOrUndef(r.header);
        const tsArr = r.data?.ts ?? [];
        const hArr = r.data?.height ?? [];
        for (let i = 0; i < tsArr.length; i++) {
          yield {
            query_lat: lat,
            query_lon: lon,
            poi_id: poi,
            port_name: portName,
            port_lat: portLat,
            port_lon: portLon,
            tz_name: tzName,
            ts_ms: tsArr[i],
            ts: isoFromMs(tsArr[i]),
            height_m: hArr[i],
            header_raw: headerRaw,
          };
        }
      } catch (e) {
        logErr(dl, "windy_tides", e);
      }
    },
  });

  // ── windy_tide_extremes ────────────────────────────────────────────────
  dl.registerTable("windy_tide_extremes", {
    description:
      "Tide high/low turning points (companion to `windy_tides`). Use when the user wants \"next high tide\" or to enumerate daily extremes — no need to scan the full timeseries. `kind` ∈ {`high`, `low`}.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "poi_id", type: "string", description: "Tide-POI id (e.g. `tide-1234`). Echoed when the WHERE filter pinned the table to a specific port; null when nearest-port lookup was used." },
      { name: "port_name", type: "string", description: "Display name of the resolved tide port (e.g. \"Haifa\", \"Aberdeen\")." },
      { name: "ts_ms", type: "number", description: "Sample timestamp, unix milliseconds UTC." },
      { name: "ts", type: "datetime", description: "Sample timestamp as ISO-8601 (parallel column to `ts_ms`)." },
      { name: "height_m", type: "number", description: "Tide height above chart datum, meters. Chart datum is typically the lowest astronomical tide (LAT)." },
      { name: "kind", type: "string", description: "Extreme type. One of: `high`, `low`." },
    ],
    keyColumns: [
      { name: "query_lat", required: "optional" },
      { name: "query_lon", required: "optional" },
      { name: "poi_id", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      const poi = qStr(ctx.quals, "poi_id");
      if (poi == null && (lat == null || lon == null)) return;
      try {
        const c = getClient(ctx);
        const r: TideForecast = poi
          ? await c.tidesByPoi(poi)
          : await c.tides(lat as number, lon as number);
        const portName = str(r.header?.name);
        for (const e of r.extremes ?? []) {
          yield {
            query_lat: lat,
            query_lon: lon,
            poi_id: poi,
            port_name: portName,
            ts_ms: e.ts,
            ts: isoFromMs(e.ts),
            height_m: e.height,
            kind: e.type,
          };
        }
      } catch (e) {
        logErr(dl, "windy_tide_extremes", e);
      }
    },
  });

  // ── windy_storms ───────────────────────────────────────────────────────
  dl.registerTable("windy_storms", {
    description:
      "Active tropical cyclones worldwide — one row per named storm. Use for hurricane/typhoon/cyclone questions. `wind_speed_ms` = sustained wind; `strength` = Saffir-Simpson 0..5 (0 = tropical depression).",
    columns: [
      { name: "id", type: "string", description: "Storm id assigned by windy/JTWC/NHC (stable for the storm's lifetime)." },
      { name: "name", type: "string", description: "Storm name as issued by the warning center (e.g. `IRMA`, `HAIKUI`)." },
      { name: "lat", type: "number", description: "Current storm-center latitude, decimal degrees, WGS-84." },
      { name: "lon", type: "number", description: "Current storm-center longitude, decimal degrees, WGS-84." },
      { name: "strength", type: "number", description: "Saffir-Simpson category. 0 = tropical depression, 1..5 = hurricane category. Higher = stronger." },
      { name: "wind_speed_ms", type: "number", description: "Sustained wind speed, m/s. Knots = wind_speed_ms × 1.944." },
    ],
    async *list(ctx) {
      try {
        const c = getClient(ctx);
        const r: StormsResponse = await c.storms();
        for (const s of r.storms ?? []) {
          yield {
            id: s.id, name: s.name, lat: s.lat, lon: s.lon,
            strength: s.strength, wind_speed_ms: s.windSpeed,
          };
        }
      } catch (e) {
        logErr(dl, "windy_storms", e);
      }
    },
  });

  // ── windy_storms_count ─────────────────────────────────────────────────
  dl.registerTable("windy_storms_count", {
    description:
      "Count of active tropical cyclones (single row). Use as a cheap probe before fetching the full `windy_storms` list.",
    columns: [
      { name: "count", type: "number", description: "Number of currently-active tropical cyclones worldwide. Server returns `{activeStormCount: <n>}` (Phase 4b verified); this column extracts the integer." },
      { name: "raw", type: "json", description: "Full raw server response — `{activeStormCount: <n>}`." },
    ],
    async *list(ctx) {
      try {
        const c = getClient(ctx);
        const r = await c.stormsCount();
        const obj = r as { activeStormCount?: unknown; count?: unknown } | null;
        const count =
          typeof r === "number" ? r :
          obj && "activeStormCount" in obj ? num(obj.activeStormCount) :
          obj && "count" in obj ? num(obj.count) :
          undefined;
        yield { count, raw: jsonOrUndef(r) };
      } catch (e) {
        logErr(dl, "windy_storms_count", e);
      }
    },
  });

  // ── windy_alerts_cap ───────────────────────────────────────────────────
  dl.registerTable("windy_alerts_cap", {
    description:
      "Government-issued severe-weather alerts at a location. Public, no auth needed. NOTE: windy delivers a flat shape with single-letter `type`/`severity` codes (Phase 4b verified) — NOT the wrapped CAP-standard envelope. For PERSONAL threshold alarms see `windy_alerts_live`.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "id", type: "string", description: "Alert id from the issuing authority (numeric string)." },
      { name: "start_ms", type: "number", description: "Start of the alert window, unix milliseconds UTC." },
      { name: "start", type: "datetime", description: "Start of the alert window, ISO-8601 (parallel to `start_ms`)." },
      { name: "end_ms", type: "number", description: "End of the alert window, unix milliseconds UTC. Filter `end_ms > NOW()` (or `end_ms > epoch_ms(NOW())`) for active alerts only." },
      { name: "end", type: "datetime", description: "End of the alert window, ISO-8601 (parallel to `end_ms`)." },
      { name: "type", type: "string", description: "Single-letter category code (NOT a standard CAP category string). Phase 4b observed: `F` (Flood), `T` (Thunderstorms), `W` (Wind). More letters likely exist — cross-reference with `event` for the human-readable label." },
      { name: "severity", type: "string", description: "Single-letter severity code (NOT a CAP severity string). Phase 4b observed: `M` (likely Minor/Moderate), `S` (likely Severe). Treat the mapping as approximate until you sample more alerts." },
      { name: "event", type: "string", description: "Short human-readable label (e.g. `\"Flood Watch\"`, `\"Thunderstorms\"`, `\"Wind\"`). Localized to `WINDY_LANG`." },
      { name: "headline", type: "string", description: "Full sentence as published by the issuing authority (e.g. \"Flood Watch issued May 22 at 10:34AM CDT until May 25 at 7:00PM CDT by NWS Houston/Galveston TX\"). Use this for display; parse `event` for filtering." },
      { name: "start_local_weekday", type: "string", description: "Local-time weekday at alert start. 3-letter code: `MON`, `TUE`, ..., `SUN`." },
      { name: "start_local_day", type: "string", description: "Local-time day-of-month at alert start, 2-digit string (e.g. `\"22\"`)." },
      { name: "start_local_month", type: "string", description: "Local-time month name at alert start, localized (e.g. `\"May\"`)." },
      { name: "start_local_year", type: "string", description: "Local-time year at alert start, 4-digit string." },
      { name: "start_local_hour", type: "string", description: "Local-time hour at alert start, 24h 2-digit string (`\"00\"`..`\"23\"`)." },
      { name: "end_local_weekday", type: "string", description: "Local-time weekday at alert end. 3-letter code." },
      { name: "end_local_day", type: "string", description: "Local-time day-of-month at alert end." },
      { name: "end_local_month", type: "string", description: "Local-time month name at alert end." },
      { name: "end_local_year", type: "string", description: "Local-time year at alert end." },
      { name: "end_local_hour", type: "string", description: "Local-time hour at alert end." },
      { name: "raw", type: "json", description: "Full raw alert row (in case windy adds new fields). Use `raw->'fieldname'` to access them." },
    ],
    keyColumns: [
      { name: "query_lat", required: "required" },
      { name: "query_lon", required: "required" },
      { name: "max_count", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      if (lat == null || lon == null) return;
      // Server caps maxCount at 10; the client transparently clamps so all
      // surfaces (CLI / runline / dripline) get the same treatment.
      try {
        const c = getClient(ctx);
        const rows: CapAlert[] | null = await c.capAlerts(lat, lon, {
          maxCount: qNum(ctx.quals, "max_count"),
        });
        for (const a of rows ?? []) {
          yield {
            query_lat: lat, query_lon: lon,
            id: a.id,
            start_ms: a.start,
            start: isoFromMs(a.start),
            end_ms: a.end,
            end: isoFromMs(a.end),
            type: a.type,
            severity: a.severity,
            event: a.event,
            headline: a.headline,
            start_local_weekday: a.startLocal?.weekday,
            start_local_day: a.startLocal?.day,
            start_local_month: a.startLocal?.month,
            start_local_year: a.startLocal?.year,
            start_local_hour: a.startLocal?.hour,
            end_local_weekday: a.endLocal?.weekday,
            end_local_day: a.endLocal?.day,
            end_local_month: a.endLocal?.month,
            end_local_year: a.endLocal?.year,
            end_local_hour: a.endLocal?.hour,
            raw: jsonOrUndef(a),
          };
        }
      } catch (e) {
        logErr(dl, "windy_alerts_cap", e);
      }
    },
  });

  // ── windy_alerts_live (auth) ──────────────────────────────────────────
  dl.registerTable("windy_alerts_live", {
    description:
      "Live alerts the SIGNED-IN user has subscribed to (push-style threshold alarms). Requires auth. For public severe-weather alerts at a location use `windy_alerts_cap`.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "distance", type: "string", description: "Unit used in any distance fields in `raw`. One of: `km` (default), `mi`." },
      { name: "raw", type: "json", description: "Complete raw row from the upstream API — preserves any field not surfaced as a column. Use `raw->'fieldname'` to extract specific values." },
    ],
    keyColumns: [
      { name: "query_lat", required: "required" },
      { name: "query_lon", required: "required" },
      { name: "distance", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      if (lat == null || lon == null) return;
      const distance = qStr(ctx.quals, "distance") === "mi" ? "mi" : "km";
      try {
        const c = getClient(ctx);
        const r = await c.liveAlerts(lat, lon, distance);
        for (const a of r.alerts ?? []) {
          yield { query_lat: lat, query_lon: lon, distance, raw: jsonOrUndef(a) };
        }
      } catch (e) {
        logErr(dl, "windy_alerts_live", e);
      }
    },
  });

  // ── windy_webcams_near ─────────────────────────────────────────────────
  dl.registerTable("windy_webcams_near", {
    description:
      "Webcams near a coord — one row per cam, with current + last-daylight image URLs. Use for visual ground truth. Join `id` into `windy_webcam` for full detail.",
    columns: [
      { name: "query_lat", type: "number", description: "Latitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "query_lon", type: "number", description: "Longitude passed in WHERE — echoed for joins. Decimal degrees." },
      { name: "id", type: "number", description: "Webcam numeric id. Stable identifier; join into `windy_webcam` for full detail." },
      { name: "title", type: "string", description: "Display title — human-readable label." },
      { name: "last_update_ms", type: "number", description: "When the camera last produced a frame, unix milliseconds UTC. Stale cams (> 24 h) may be dark/offline." },
      { name: "last_daylight_ms", type: "number", description: "When the cam last produced a DAYLIGHT frame, unix milliseconds UTC. Use this for the freshest visible-light image." },
      { name: "cam_lat", type: "number", description: "Camera position latitude, decimal degrees." },
      { name: "cam_lon", type: "number", description: "Camera position longitude, decimal degrees." },
      { name: "location_title", type: "string", description: "Human-readable location label as shown on the windy app (e.g. \"Eiffel Tower, Paris\")." },
      { name: "city", type: "string", description: "City of the camera location." },
      { name: "country", type: "string", description: "Country name of the camera location." },
      { name: "image_current", type: "string", description: "URL of the most recent frame (may be dark at night). Image variant per `image_size`." },
      { name: "image_daylight", type: "string", description: "URL of the most recent DAYLIGHT frame. Use this if `image_current` would be dark." },
    ],
    keyColumns: [
      { name: "query_lat", required: "required" },
      { name: "query_lon", required: "required" },
      { name: "limit", required: "optional" },
      { name: "image_size", required: "optional" },
    ],
    async *list(ctx) {
      const lat = qNum(ctx.quals, "query_lat");
      const lon = qNum(ctx.quals, "query_lon");
      if (lat == null || lon == null) return;
      const limit = qNum(ctx.quals, "limit");
      const sz = qStr(ctx.quals, "image_size");
      const imageSize: "thumbnail" | "preview" | "original" =
        sz === "preview" || sz === "original" || sz === "thumbnail" ? sz : "thumbnail";
      try {
        const c = getClient(ctx);
        const r: WebcamList = await c.webcamsNear(lat, lon, { limit, imageSize });
        for (const cam of r.cams ?? []) {
          yield {
            query_lat: lat, query_lon: lon,
            id: cam.id, title: cam.title,
            last_update_ms: cam.lastUpdate,
            last_daylight_ms: cam.lastDaylight,
            cam_lat: cam.location?.lat,
            cam_lon: cam.location?.lon,
            location_title: cam.location?.title,
            city: cam.location?.city,
            country: cam.location?.country,
            image_current: cam.images?.current,
            image_daylight: cam.images?.daylight,
          };
        }
      } catch (e) {
        logErr(dl, "windy_webcams_near", e);
      }
    },
  });

  // ── windy_webcam (detail) ──────────────────────────────────────────────
  dl.registerTable("windy_webcam", {
    description:
      "One webcam by id (single row). Use after `windy_webcams_near` or `windy_webcams_search` to load full detail / fresh image URLs.",
    columns: [
      { name: "id", type: "number", description: "Webcam numeric id. Stable identifier; join into `windy_webcam` for full detail." },
      { name: "title", type: "string", description: "Display title — human-readable label." },
      { name: "last_update_ms", type: "number", description: "When the camera last produced a frame, unix milliseconds UTC. Stale cams (> 24 h) may be dark/offline." },
      { name: "last_daylight_ms", type: "number", description: "When the cam last produced a DAYLIGHT frame, unix milliseconds UTC. Use this for the freshest visible-light image." },
      { name: "cam_lat", type: "number", description: "Camera position latitude, decimal degrees." },
      { name: "cam_lon", type: "number", description: "Camera position longitude, decimal degrees." },
      { name: "location_title", type: "string", description: "Human-readable location label as shown on the windy app (e.g. \"Eiffel Tower, Paris\")." },
      { name: "city", type: "string", description: "City of the camera location." },
      { name: "country", type: "string", description: "Country name of the camera location." },
      { name: "image_current", type: "string", description: "URL of the most recent frame (may be dark at night). Image variant per `image_size`." },
      { name: "image_daylight", type: "string", description: "URL of the most recent DAYLIGHT frame. Use this if `image_current` would be dark." },
      { name: "image_size", type: "string", description: "Image variant used to populate the URLs. One of: `thumbnail`, `preview`, `original`." },
    ],
    keyColumns: [
      { name: "id", required: "required" },
      { name: "image_size", required: "optional" },
    ],
    async *list(ctx) {
      const idStr = qStr(ctx.quals, "id");
      const idNum = qNum(ctx.quals, "id");
      const id = idNum ?? (idStr ? Number(idStr) : undefined);
      if (id == null || !Number.isFinite(id)) return;
      const sz = qStr(ctx.quals, "image_size");
      const imageSize: "thumbnail" | "preview" | "original" =
        sz === "thumbnail" || sz === "original" || sz === "preview" ? sz : "preview";
      try {
        const c = getClient(ctx);
        const cam: Webcam = await c.webcamDetail(id, imageSize);
        yield {
          id: cam.id, title: cam.title,
          last_update_ms: cam.lastUpdate,
          last_daylight_ms: cam.lastDaylight,
          cam_lat: cam.location?.lat,
          cam_lon: cam.location?.lon,
          location_title: cam.location?.title,
          city: cam.location?.city,
          country: cam.location?.country,
          image_current: cam.images?.current,
          image_daylight: cam.images?.daylight,
          image_size: imageSize,
        };
      } catch (e) {
        logErr(dl, "windy_webcam", e);
      }
    },
  });

  // ── windy_webcams_search ───────────────────────────────────────────────
  dl.registerTable("windy_webcams_search", {
    description:
      "Webcam text search by name / location. Use when the user names a place (\"Eiffel Tower\", \"Big Sur\") rather than a coord. Optionally bias by `lat`/`lon`.",
    columns: [
      { name: "query", type: "string", description: "Free-text query passed in WHERE — echoed." },
      { name: "id", type: "string", description: "Result id (windy place id when type=`city`/`country`; webcam numeric id when type=`webcam`)." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "title", type: "string", description: "Display title — human-readable label." },
      { name: "type", type: "string", description: "Match category. For webcam search typically `webcam` (also `city` when the search resolves to a place containing webcams)." },
      { name: "cc", type: "string", description: "ISO 3166-1 alpha-2 country code, lowercase (e.g. `il`, `us`, `de`)." },
      { name: "country", type: "string", description: "Country display name in the user's `lang`." },
      { name: "webcam_id", type: "string", description: "Webcam numeric id (as string); populated when the match is a webcam." },
    ],
    keyColumns: [
      { name: "query", required: "required" },
      { name: "lat", required: "optional" },
      { name: "lon", required: "optional" },
    ],
    async *list(ctx) {
      const q = qStr(ctx.quals, "query");
      if (!q) return;
      const lat = qNum(ctx.quals, "lat");
      const lon = qNum(ctx.quals, "lon");
      try {
        const c = getClient(ctx);
        const r: WebcamList = await c.webcamSearch(q, { lat, lon });
        for (const x of r.cams ?? []) {
          yield {
            query: q,
            id: String(x.id),
            lat: x.location?.lat,
            lon: x.location?.lon,
            title: x.title,
            type: "webcam",
            cc: undefined,
            country: x.location?.country,
            webcam_id: String(x.id),
          };
        }
      } catch (e) {
        logErr(dl, "windy_webcams_search", e);
      }
    },
  });

  // ── windy_airport ──────────────────────────────────────────────────────
  dl.registerTable("windy_airport", {
    description:
      "Airport info by ICAO code — name, elevation, latest METAR + TAF, frequencies. Single row. Use for aviation context or to fetch METAR/TAF. Runways live in `windy_airport_runways`.",
    columns: [
      { name: "icao", type: "string", description: "ICAO 4-letter airport code (e.g. `KJFK`, `EGLL`, `LLBG`). Echoed from the WHERE filter." },
      { name: "id", type: "string", description: "Windy-internal airport id (different from the ICAO/IATA codes)." },
      { name: "iata", type: "string", description: "IATA 3-letter airport code (e.g. `TLV`). Null for airports without commercial service." },
      { name: "subtype", type: "string", description: "Airport classification. One of: `large_airport`, `medium_airport`, `small_airport`, `heliport`, `seaplane_base`." },
      { name: "name", type: "string", description: "Airport name (e.g. \"Ben Gurion International Airport\")." },
      { name: "source", type: "string", description: "Upstream airport-database source (server-defined; typically `our_airports`)." },
      { name: "home_link", type: "string", description: "Airport's official website URL, if known. Null otherwise." },
      { name: "wikipedia_link", type: "string", description: "Wikipedia article URL for the airport, if known. Null otherwise." },
      { name: "keywords", type: "string", description: "Search-keyword aliases (former names, abbreviations). Comma-separated." },
      { name: "elev_ft", type: "number", description: "Airport elevation above MSL, feet." },
      { name: "elev_m", type: "number", description: "Airport elevation above MSL, meters." },
      { name: "scheduled_service", type: "boolean", description: "True if the airport hosts scheduled passenger service (commercial flights), vs GA-only / heliport." },
      { name: "metar", type: "json", description: "Latest METAR observation as JSON. Shape varies by source; common keys: `raw`, `temp`, `wind`, `visibility`, `time`." },
      { name: "taf", type: "json", description: "Latest TAF (terminal aerodrome forecast) as JSON. Shape varies; typically a `periods` array." },
      { name: "frequencies", type: "json", description: "Radio frequencies array. Each entry typically has `type` (TWR/GND/ATIS/etc.), `freq`." },
    ],
    keyColumns: [{ name: "icao", required: "required" }],
    async *list(ctx) {
      const icao = qStr(ctx.quals, "icao");
      if (!icao) return;
      try {
        const c = getClient(ctx);
        const r: AirportResponse = await c.airport(icao);
        const i = r.info;
        yield {
          icao,
          id: i.id, iata: i.iata, subtype: i.subtype, name: i.name,
          source: i.source,
          home_link: i.home_link,
          wikipedia_link: i.wikipedia_link,
          keywords: i.keywords ?? undefined,
          elev_ft: num(i.elev_ft),
          elev_m: num(i.elev_m),
          scheduled_service: i.scheduled_service === "yes",
          metar: jsonOrUndef(i.metar),
          taf: jsonOrUndef(i.taf),
          frequencies: jsonOrUndef(i.frequencies),
        };
      } catch (e) {
        logErr(dl, "windy_airport", e);
      }
    },
  });

  // ── windy_airport_runways ──────────────────────────────────────────────
  dl.registerTable("windy_airport_runways", {
    description:
      "Runways at an airport — one row per runway. Use for aviation route planning (`he_heading_deg`/`le_heading_deg` for wind alignment, `length_ft`/`width_ft`/`surface` for suitability).",
    columns: [
      { name: "icao", type: "string", description: "ICAO 4-letter airport code (e.g. `KJFK`, `EGLL`, `LLBG`). Echoed from the WHERE filter." },
      { name: "runway_id", type: "number", description: "OurAirports numeric runway id (unique across the global runway database)." },
      { name: "closed", type: "boolean", description: "True if the runway is permanently closed/decommissioned." },
      { name: "lighted", type: "boolean", description: "True if the runway has edge / approach lighting (night-capable)." },
      { name: "surface", type: "string", description: "Runway surface — values are NOT well-normalized (mix of 3-letter, 4-letter, and full-word codes; capitalization varies). Phase 4b observed: `ASP` / `ASPH` (asphalt), `PEM` (permeable asphalt), `ASPH-G` (asphalt with grass overrun), `CON` (concrete), `Grass`, `WATER`. Match with `LIKE` or normalize before filtering." },
      { name: "he_ident", type: "string", description: "High-end runway identifier (e.g. `09L`, `27R`)." },
      { name: "le_ident", type: "string", description: "Low-end runway identifier (e.g. `27R`, the opposite end of `09L`)." },
      { name: "length_ft", type: "number", description: "Runway length, feet. Meters ≈ length_ft × 0.3048." },
      { name: "width_ft", type: "number", description: "Runway width, feet." },
      { name: "he_elev_ft", type: "number", description: "Elevation of the high-end threshold above MSL, feet." },
      { name: "le_elev_ft", type: "number", description: "Elevation of the low-end threshold above MSL, feet." },
      { name: "he_heading_deg", type: "number", description: "Magnetic heading TO from the high end, degrees (0..360). Compare to wind_dir_deg + 180 (wind TO direction) to assess crosswind." },
      { name: "le_heading_deg", type: "number", description: "Magnetic heading TO from the low end, degrees (0..360)." },
      { name: "he_lat", type: "number", description: "Latitude of the high-end runway threshold, decimal degrees." },
      { name: "he_lon", type: "number", description: "Longitude of the high-end runway threshold, decimal degrees." },
      { name: "le_lat", type: "number", description: "Latitude of the low-end runway threshold, decimal degrees." },
      { name: "le_lon", type: "number", description: "Longitude of the low-end runway threshold, decimal degrees." },
    ],
    keyColumns: [{ name: "icao", required: "required" }],
    async *list(ctx) {
      const icao = qStr(ctx.quals, "icao");
      if (!icao) return;
      try {
        const c = getClient(ctx);
        const r: AirportResponse = await c.airport(icao);
        for (const rw of r.info?.runways ?? []) {
          yield {
            icao,
            runway_id: rw.id,
            closed: rw.closed === 1,
            lighted: rw.lighted === 1,
            surface: rw.surface,
            he_ident: rw.he_ident,
            le_ident: rw.le_ident,
            length_ft: rw.length_ft,
            width_ft: rw.width_ft,
            he_elev_ft: rw.he_elevation_ft,
            le_elev_ft: rw.le_elevation_ft,
            he_heading_deg: rw.he_heading_degT,
            le_heading_deg: rw.le_heading_degT,
            he_lat: rw.he_latitude_deg,
            he_lon: rw.he_longitude_deg,
            le_lat: rw.le_latitude_deg,
            le_lon: rw.le_longitude_deg,
          };
        }
      } catch (e) {
        logErr(dl, "windy_airport_runways", e);
      }
    },
  });

  // ── windy_account (auth) ──────────────────────────────────────────────
  dl.registerTable("windy_account", {
    description:
      "Signed-in user profile + subscription state (single row). Requires auth. Use to verify auth is working, check premium tier, or fetch the user's id for joins.",
    columns: [
      { name: "auth", type: "boolean", description: "True if the request was authenticated (token / cookie validated). False rows mean the call ran anonymously despite credentials being set." },
      { name: "username", type: "string", description: "Windy username (URL-safe lowercase slug). Stable across the account's lifetime." },
      { name: "fullname", type: "string", description: "User's full display name as set on the account. May be empty." },
      { name: "email", type: "string", description: "Verified email address on the windy account." },
      { name: "user_id", type: "number", description: "Numeric windy user id. Stable across logins. Available in JWT claims as `userID`." },
      { name: "subscription", type: "string", description: "Top-level subscription label. Phase 4b observed: `premium`. `free` is the implicit complement when null/missing." },
      { name: "subscription_tier", type: "string", description: "Subscription tier — same vocabulary as `subscription`. Phase 4b observed: `premium`." },
      { name: "subscription_status", type: "string", description: "Subscription state. Phase 4b observed: `active`. Other values likely (e.g. `inactive`, `cancelled`, `trialing`) — sample lapsed accounts to verify." },
      { name: "subscription_platform", type: "string", description: "Billing platform. Phase 4b observed: `fastspring`. App-store subscribers likely report `apple` / `google` — sample to verify." },
      { name: "subscription_expires_ms", type: "number", description: "Subscription expiry, unix milliseconds UTC." },
    ],
    async *list(ctx) {
      try {
        const c = getClient(ctx);
        const r: AccountInfo = await c.whoami();
        yield {
          auth: r.auth,
          username: r.userInfo?.username,
          fullname: r.userInfo?.fullname,
          email: r.userInfo?.email,
          user_id: r.userInfo?.id,
          subscription: r.subscription,
          subscription_tier: r.subscriptionInfo?.tier,
          subscription_status: r.subscriptionInfo?.status,
          subscription_platform: r.subscriptionInfo?.platform,
          subscription_expires_ms: r.subscriptionInfo?.expiresAt,
        };
      } catch (e) {
        logErr(dl, "windy_account", e);
      }
    },
  });

  // ── windy_favourites (auth) ───────────────────────────────────────────
  dl.registerTable("windy_favourites", {
    description:
      "Coordinates the user has bookmarked in the windy app. Requires auth. Use to drive batch forecasts for places the user cares about (join lat/lon into `windy_forecast_point` or `windy_forecast_now`).",
    columns: [
      { name: "id", type: "string", description: "Server-assigned favourite id (opaque string; stable for the bookmark's lifetime). Pass to runline `account.updateFavourite` / `account.deleteFavourite`." },
      { name: "updated_ms", type: "number", description: "Server-side last-modified, unix milliseconds UTC." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "title", type: "string", description: "Display title — human-readable label." },
      { name: "type", type: "string", description: "Favourite kind. Typically `fav` (the only value the windy client currently writes)." },
      { name: "version", type: "string", description: "Schema version of the favourite/alert payload as published by the windy client. Used by sync clients to detect format changes." },
      { name: "key", type: "string", description: "Composite `lat/lon` key the windy SDK uses for client-side deduplication." },
      { name: "user_id", type: "string", description: "Owning user id (string form; same value as `windy_account.user_id` cast to text)." },
      { name: "counter", type: "number", description: "Server-side optimistic-concurrency counter — increments on each update. Used by the windy SDK for conflict resolution." },
      { name: "cc", type: "string", description: "ISO 3166-1 alpha-2 country code, lowercase (e.g. `il`, `us`, `de`)." },
      { name: "note", type: "string", description: "Free-form user note attached to the favourite." },
      { name: "pin", type: "boolean", description: "True if the favourite is pinned to the top of the user's list." },
      { name: "pin_order", type: "number", description: "Sort order among pinned favourites — lower value appears higher. Only meaningful when `pin = true`." },
      { name: "deleted_ms", type: "number", description: "Tombstone timestamp, unix milliseconds UTC, or null if the favourite is live. Soft-delete is recorded here so other devices can sync the removal." },
    ],
    async *list(ctx) {
      try {
        const c = getClient(ctx);
        const rows: Favourite[] = await c.favourites();
        for (const f of rows ?? []) {
          const v: FavouriteValue | undefined = f.value;
          yield {
            id: f.id,
            updated_ms: f.updated,
            lat: v?.lat,
            lon: v?.lon,
            title: v?.title,
            type: v?.type,
            version: v?.version,
            key: v?.key,
            user_id: v?.userID,
            counter: v?.counter,
            cc: v?.cc,
            note: v?.note,
            pin: v?.pin,
            pin_order: v?.pinOrder,
            deleted_ms: v?.deleted ?? undefined,
          };
        }
      } catch (e) {
        logErr(dl, "windy_favourites", e);
      }
    },
  });

  // ── windy_user_alerts (auth) ──────────────────────────────────────────
  dl.registerTable("windy_user_alerts", {
    description:
      "Threshold weather alarms the user has configured (e.g. wind > 10 m/s at home). Requires auth. For one by id use `windy_user_alert`; for currently-firing alerts use `windy_alerts_live`.",
    columns: [
      { name: "id", type: "string", description: "User-alert id (opaque server-assigned string). Pass to runline `account.userAlert` / `account.deleteUserAlert`." },
      { name: "updated_ms", type: "number", description: "Server-side last-modified, unix milliseconds UTC." },
      { name: "store_ts_ms", type: "number", description: "When the alert was last persisted to storage, unix milliseconds UTC. Differs from `updated_ms` after offline edits sync up." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "title", type: "string", description: "Display title — human-readable label." },
      { name: "enabled", type: "boolean", description: "True if the alert actively monitors and fires push notifications. Disabled alerts persist but don't trigger." },
      { name: "status", type: "string", description: "Current alert state. One of: `triggered`, `normal`, `suspended`." },
      { name: "user_id", type: "string", description: "Owning user id (string form; same value as `windy_account.user_id` cast to text)." },
      { name: "counter", type: "number", description: "Server-side optimistic-concurrency counter — increments on each update. Used by the windy SDK for conflict resolution." },
      { name: "conditions", type: "json", description: "Array of trigger conditions. Each item has a `type` ∈ {`cloudiness`, `freshSnow`, `rainfall`, `swell`, `temperature`, `time`, `wind`} plus type-specific threshold fields (e.g. `min`, `max`)." },
      { name: "raw", type: "json", description: "Full unaltered UserAlertItem (for fields not surfaced as columns)." },
    ],
    async *list(ctx) {
      try {
        const c = getClient(ctx);
        const rows: UserAlertItem[] | null = await c.userAlerts();
        for (const a of rows ?? []) {
          const v = a.value;
          yield {
            id: a.id,
            updated_ms: a.updated,
            store_ts_ms: a.storeTs,
            lat: v?.lat,
            lon: v?.lon,
            title: v?.title,
            enabled: v?.enabled,
            status: v?.status,
            user_id: v?.userID,
            counter: v?.counter,
            conditions: jsonOrUndef(v?.conditions),
            raw: jsonOrUndef(a),
          };
        }
      } catch (e) {
        logErr(dl, "windy_user_alerts", e);
      }
    },
  });

  // ── windy_user_alert (auth, by id) ────────────────────────────────────
  dl.registerTable("windy_user_alert", {
    description:
      "One user alert by id (single row). Requires auth. Use after `windy_user_alerts` to inspect the full condition tree.",
    columns: [
      { name: "id", type: "string", description: "User-alert id (opaque server-assigned string). Pass to runline `account.userAlert` / `account.deleteUserAlert`." },
      { name: "updated_ms", type: "number", description: "Server-side last-modified, unix milliseconds UTC." },
      { name: "store_ts_ms", type: "number", description: "When the alert was last persisted to storage, unix milliseconds UTC. Differs from `updated_ms` after offline edits sync up." },
      { name: "lat", type: "number", description: "Latitude, decimal degrees, WGS-84. Range −90..90 (positive = N)." },
      { name: "lon", type: "number", description: "Longitude, decimal degrees, WGS-84. Range −180..180 (positive = E)." },
      { name: "title", type: "string", description: "Display title — human-readable label." },
      { name: "enabled", type: "boolean", description: "True if the alert actively monitors and fires push notifications. Disabled alerts persist but don't trigger." },
      { name: "status", type: "string", description: "Current alert state. One of: `triggered`, `normal`, `suspended`." },
      { name: "user_id", type: "string", description: "Owning user id (string form; same value as `windy_account.user_id` cast to text)." },
      { name: "counter", type: "number", description: "Server-side optimistic-concurrency counter — increments on each update. Used by the windy SDK for conflict resolution." },
      { name: "conditions", type: "json", description: "Array of trigger conditions. Each item has a `type` ∈ {`cloudiness`, `freshSnow`, `rainfall`, `swell`, `temperature`, `time`, `wind`} plus type-specific threshold fields." },
      { name: "raw", type: "json", description: "Complete raw row from the upstream API — preserves any field not surfaced as a column. Use `raw->'fieldname'` to extract specific values." },
    ],
    keyColumns: [{ name: "id", required: "required" }],
    async *list(ctx) {
      const id = qStr(ctx.quals, "id");
      if (!id) return;
      try {
        const c = getClient(ctx);
        const a: UserAlertItem = await c.getUserAlert(id);
        const v = a.value;
        yield {
          id: a.id ?? id,
          updated_ms: a.updated,
          store_ts_ms: a.storeTs,
          lat: v?.lat,
          lon: v?.lon,
          title: v?.title,
          enabled: v?.enabled,
          status: v?.status,
          user_id: v?.userID,
          counter: v?.counter,
          conditions: jsonOrUndef(v?.conditions),
          raw: jsonOrUndef(a),
        };
      } catch (e) {
        logErr(dl, "windy_user_alert", e);
      }
    },
  });
}
