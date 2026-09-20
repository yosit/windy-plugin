import https from 'https';
import type { Agent } from 'https';
import { URL } from 'url';
import { createGunzip, createBrotliDecompress, createInflate } from 'zlib';

// Lazily instantiate an HTTPS proxy agent when WINDY_PROXY is set. The env
// var is opt-in by exact name — we don't honor the ambient HTTPS_PROXY,
// since users frequently have one set for unrelated tools.
const proxyAgents = new Map<string, Agent | null>();
function getProxyAgent(proxy?: string): Agent | undefined {
  const url = (proxy ?? process.env.WINDY_PROXY)?.trim() ?? '';
  if (!proxyAgents.has(url)) {
    if (url) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { HttpsProxyAgent } = require('https-proxy-agent') as {
          HttpsProxyAgent: new (u: string, o?: { keepAlive?: boolean }) => Agent;
        };
        proxyAgents.set(url, new HttpsProxyAgent(url, { keepAlive: true }));
      } catch {
        // https-proxy-agent isn't installed — proxy support disabled.
        proxyAgents.set(url, null);
      }
    } else {
      proxyAgents.set(url, null);
    }
  }
  return proxyAgents.get(url) ?? undefined;
}
import type {
  AccountInfo,
  AirportResponse,
  AirQualityPOI,
  CapAlert,
  Favourite,
  FavouriteValue,
  Level,
  LiveAlertsResponse,
  NearbyAirQualityStation,
  NearbyWeatherStation,
  ObservationTimeseries,
  Overlay,
  PointForecast,
  PressureLevelSample,
  ReverseGeocode,
  SearchResponse,
  Sounding,
  SoundingTimestep,
  StormsResponse,
  TideForecast,
  UserAlertItem,
  Webcam,
  WebcamList,
  PointModel,
  AirQualityModel,
  StationType,
  BasemapStyle,
} from './types';
import { LEVELS, LEVEL_ALTITUDE } from './types';
import {
  decodeJWT,
  loadSession,
  recordLoginAttempt,
  saveSession,
  isSessionReusable,
  tokenIsStale,
  type PersistedSession,
} from './session';

const APP_VERSION = '50.0.3';

/**
 * Maps user-facing model names (used by `/forecast/point/...`) to the
 * lower-level run ids the manifest endpoint expects.
 */
const MANIFEST_MODEL_ALIASES: Record<string, string> = {
  ecmwf: 'ecmwf-hres',
};
const APP_ACCEPT_HEADER = 'application/json binary/hcacaf$indf4a2';

const NODE_HOST = 'node.windy.com';
const ACCOUNT_HOST = 'account.windy.com';
const NODE_S_HOST = 'node-s.windy.com';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Set to `false` to skip auth params and the bootstrap. */
  auth?: boolean;
  /** Override host (default `node.windy.com`). */
  host?: string;
  /** Extra query params (appended after the auth envelope). */
  qs?: Record<string, string | number | boolean | undefined>;
  /** Send Authorization: Bearer header (auth must be enabled). */
  bearer?: boolean;
  /** Raw response (don't JSON.parse). Returns text body. */
  raw?: boolean;
  /** Skip the auth envelope (`token2`, `uid`, `v`, `poc`, `pr`, `sc`) but still send `_account_sid` cookie if available. */
  skipEnvelope?: boolean;
}

export interface ClientOptions {
  /** Override the session file. If not provided, persists to ~/.config/windy-cli/session.json. */
  session?: PersistedSession;
  /** Country code (ISO 3166-1 alpha-2 lowercase). Default `xx`. */
  country?: string;
  /** Language (ISO 639-1). Default `en`. */
  lang?: string;
  /** Don't persist updates to disk. */
  ephemeral?: boolean;
  /** HTTPS proxy for this client only; avoids connection-wide env cross-talk. */
  proxy?: string;
}

export class WindyClient {
  private session: PersistedSession;
  private country: string;
  private lang: string;
  private ephemeral: boolean;
  private proxy?: string;
  private pocCounter = 1;
  private refreshPromise: Promise<void> | null = null;

  constructor(opts: ClientOptions = {}) {
    this.session = opts.session ?? loadSession();
    this.country = opts.country ?? 'xx';
    this.lang = opts.lang ?? 'en';
    this.ephemeral = opts.ephemeral ?? false;
    this.proxy = opts.proxy;
  }

  /** Build a client from environment variables and/or the on-disk session. */
  static fromEnv(opts: Omit<ClientOptions, 'session'> = {}): WindyClient {
    const session = loadSession();
    if (process.env.WINDY_ACCOUNT_SID) session.accountSid = process.env.WINDY_ACCOUNT_SID;
    if (process.env.WINDY_TOKEN) {
      session.token = process.env.WINDY_TOKEN;
      try {
        const claims = decodeJWT(process.env.WINDY_TOKEN);
        session.tokenExp = claims.exp;
        if (claims.userID) session.userId = claims.userID;
      } catch {
        /* ignore */
      }
    }
    if (process.env.WINDY_UID) session.uid = process.env.WINDY_UID;
    return new WindyClient({ ...opts, session });
  }

  get persistedSession(): PersistedSession {
    return { ...this.session };
  }

  // ── Authentication ────────────────────────────────────────────────────

  /**
   * Fetch a fresh JWT and user info from /api/info.
   *
   * If `_account_sid` cookie is set, the server returns a logged-in JWT.
   * Otherwise an anonymous JWT (still usable for most public endpoints).
   */
  async refreshAuth(): Promise<AccountInfo> {
    if (!this.session.accountSid) {
      throw new Error(
        'refresh requires the `_account_sid` cookie. Set WINDY_ACCOUNT_SID, ' +
          'or configure accountSid on the Windy connection. A bare JWT (WINDY_TOKEN) cannot be ' +
          'refreshed — it expires in ~48 h and must be replaced.',
      );
    }
    // Guard against tight-loop re-auth (stuck plugin, retry storm). Persistent
    // 24h history; throws if the budget is exhausted.
    recordLoginAttempt();
    // Bypass ensureAuth() to avoid recursion — the /api/info call IS the refresh.
    const info = await this.requestNoEnsure<AccountInfo>('/api/info', {
      host: ACCOUNT_HOST,
      skipEnvelope: false,
      bearer: !!this.session.token,
    });
    // Only persist the new token when the response is for an authenticated session.
    // (Without _account_sid the server returns an anonymous JWT — saving it would
    // clobber a user-supplied authenticated token.)
    const isAuthedResponse = info?.auth === true && !!info?.userInfo;
    if (info?.token && isAuthedResponse) {
      this.session.token = info.token;
      try {
        const claims = decodeJWT(info.token);
        this.session.tokenExp = claims.exp;
        if (claims.userID) this.session.userId = claims.userID;
      } catch {
        /* ignore */
      }
    }
    if (info?.userInfo) {
      this.session.username = info.userInfo.username;
    }
    if (info?.subscription) {
      this.session.subscription = info.subscription;
    }
    this.session.lastKeepaliveMs = Date.now();
    if (isAuthedResponse) this.persist();
    return info;
  }

  /** Returns current user info / subscription, reusing a valid persisted session. */
  async whoami(): Promise<AccountInfo> {
    if (isSessionReusable(this.session) && this.session.userId !== undefined && this.session.username && this.session.subscription) {
      return {
        message: 'cached session',
        auth: true,
        token: this.session.token!,
        userInfo: {
          avatar: '',
          email: '',
          username: this.session.username,
          userslug: this.session.username,
          verifiedEmail: '',
          joindate: 0,
          fullname: '',
          id: this.session.userId,
          requiresCookieConsent: false,
          auth: true,
        },
        subscription: this.session.subscription,
        subscriptionInfo: {
          tier: this.session.subscription,
          status: 'active',
          state: 'cached',
          platform: 'unknown',
          expiresAt: this.session.tokenExp! * 1000,
          isSubscription: this.session.subscription !== 'free',
          isTrial: false,
        },
      };
    }
    return this.refreshAuth();
  }

  /** Decode the active JWT (does not refresh). */
  decodeToken() {
    if (!this.session.token) return null;
    try {
      return decodeJWT(this.session.token);
    } catch {
      return null;
    }
  }

  // ── Forecast ───────────────────────────────────────────────────────────

  /**
   * Multi-day point forecast.
   * @param model One of POINT_MODELS, e.g. `ecmwf`, `gfs`, `icon`.
   * @param refTime Optional ISO model-run timestamp. Omit to use latest.
   * @param setup `summary` returns daily aggregates; omit for full hourly.
   */
  async pointForecast(
    lat: number,
    lon: number,
    opts: {
      model?: PointModel | string;
      refTime?: string;
      setup?: 'summary' | undefined;
      includeNow?: boolean;
      step?: number;
      interpolate?: boolean;
      extended?: boolean;
      source?: string;
    } = {},
  ): Promise<PointForecast> {
    const model = opts.model ?? 'ecmwf';
    return this.request<PointForecast>(
      `/forecast/point/${model}/v2.9/${fmt(lat)}/${fmt(lon)}`,
      {
        qs: {
          refTime: opts.refTime,
          setup: opts.setup,
          includeNow: opts.includeNow,
          step: opts.step,
          interpolate: opts.interpolate ? 'true' : undefined,
          extended: opts.extended ? 'true' : undefined,
          source: opts.source ?? 'hp',
        },
      },
    );
  }

  /** Current-conditions snapshot at a point (single timestep). */
  async pointNow(
    lat: number,
    lon: number,
    opts: { model?: PointModel | string; refTime?: string } = {},
  ): Promise<unknown> {
    const model = opts.model ?? 'ecmwf';
    return this.request(`/forecast/point/now/${model}/v1.0/${fmt(lat)}/${fmt(lon)}`, {
      qs: { refTime: opts.refTime },
    });
  }

  /** Meteogram (hourly multi-param) for a point. */
  async meteogram(
    lat: number,
    lon: number,
    opts: { model?: PointModel | string; refTime?: string; step?: number } = {},
  ): Promise<unknown> {
    const model = opts.model ?? 'ecmwf';
    return this.request(`/forecast/meteogram/${model}/v1.2/${fmt(lat)}/${fmt(lon)}`, {
      qs: { refTime: opts.refTime, step: opts.step },
    });
  }

  /** Air-quality forecast at a point (CAMS or CAMS-Europe). */
  async airQualityForecast(
    lat: number,
    lon: number,
    opts: { model?: AirQualityModel; refTime?: string } = {},
  ): Promise<unknown> {
    const model = opts.model ?? 'cams';
    return this.request(`/forecast/airq/${model}/v1.0/${fmt(lat)}/${fmt(lon)}`, {
      qs: { refTime: opts.refTime },
    });
  }

  /**
   * Pressure-level sounding (skew-T) — reformats the meteogram response into a
   * clean per-timestep × per-level structure.
   *
   * The meteogram endpoint returns flat keys like `temp-850h`, `wind_u-500h`,
   * etc. for 17 atmospheric levels (`surface`, `100m`, `975h`…`10h`). This
   * method pivots them into `SoundingTimestep[]` for easy consumption.
   */
  async sounding(
    lat: number,
    lon: number,
    opts: { model?: PointModel | string; refTime?: string; step?: number } = {},
  ): Promise<Sounding> {
    const model = opts.model ?? 'ecmwf';
    const raw = (await this.meteogram(lat, lon, opts)) as {
      header: { model: string; refTime: string; step: number; tzName?: string };
      data: Record<string, number[] | undefined> & { hours: number[] };
    };
    const tsList = raw.data.hours ?? [];
    const refMs = Date.parse(raw.header.refTime);
    const params = ['temp', 'dewpoint', 'rh', 'gh', 'wind_u', 'wind_v'] as const;

    const timesteps: SoundingTimestep[] = tsList.map((ts, i) => {
      const levels: PressureLevelSample[] = (LEVELS as readonly Level[]).map((level) => {
        const sample: PressureLevelSample = {
          level,
          altM: LEVEL_ALTITUDE[level].altM,
          altFt: LEVEL_ALTITUDE[level].altFt,
        };
        for (const p of params) {
          const arr = raw.data[`${p}-${level}`];
          if (arr && arr[i] !== undefined) (sample as unknown as Record<string, unknown>)[p] = arr[i];
        }
        if (sample.wind_u !== undefined && sample.wind_v !== undefined) {
          sample.wind = Math.hypot(sample.wind_u, sample.wind_v);
          // meteorological FROM direction
          sample.windDir = (Math.atan2(-sample.wind_u, -sample.wind_v) * 180) / Math.PI;
          if (sample.windDir < 0) sample.windDir += 360;
        }
        return sample;
      });
      return {
        ts,
        hoursOffset: Math.round((ts - refMs) / 3_600_000),
        levels,
      };
    });

    return {
      header: {
        model: raw.header.model ?? model,
        refTime: raw.header.refTime,
        lat,
        lon,
        tzName: raw.header.tzName,
        step: raw.header.step ?? 3,
      },
      timesteps,
    };
  }

  /** Forecast model manifest (available reftimes, premium gating). */
  async modelManifest(
    model: string = 'ecmwf-hres',
    premium = true,
  ): Promise<unknown> {
    // The forecast point endpoint accepts user-facing model names like `ecmwf`
    // and `gfs`, but the manifest endpoint requires the lower-level run id
    // (e.g. `ecmwf-hres`). Map the common aliases so callers can use the same
    // model name everywhere.
    const resolved = MANIFEST_MODEL_ALIASES[model] ?? model;
    return this.request(`/metadata/v1.0/forecast/${resolved}/minifest.json`, {
      qs: { premium: premium ? 'true' : undefined },
    });
  }

  // ── Search / geocoding ─────────────────────────────────────────────────

  /**
   * Location search biased to a coordinate.
   * @param query Free-text query
   * @param biasLat,biasLon Bias point (results closer ranked higher)
   * @param size Max results (default 13). API minimum is 10 — smaller values are clamped up.
   */
  async search(
    query: string,
    biasLat: number,
    biasLon: number,
    size = 13,
  ): Promise<SearchResponse> {
    return this.request<SearchResponse>(
      `/search/v4.1/${fmt(biasLat)}/${fmt(biasLon)}/${encodeURIComponent(query)}`,
      { qs: { lang: this.lang, size: Math.max(10, size) } },
    );
  }

  /** Reverse geocode a coordinate. Zoom 14 ≈ neighborhood, 10 ≈ city. */
  async reverseGeocode(lat: number, lon: number, zoom = 14): Promise<ReverseGeocode> {
    return this.request<ReverseGeocode>(
      `/reverse/v3/${fmt(lat)}/${fmt(lon)}/${zoom}`,
      { qs: { lang: this.lang } },
    );
  }

  /** Elevation in meters at a coordinate (returns bare number from server). */
  async elevation(lat: number, lon: number): Promise<number> {
    return this.request<number>(`/services/elevation/${fmt(lat)}/${fmt(lon)}`);
  }

  /**
   * Timezone info for a coordinate at an instant.
   * @param ts Unix milliseconds UTC (default: now). Converted to ISO-8601 on the wire — the API rejects numeric epochs.
   */
  async timezone(lat: number, lon: number, ts: number = Date.now()): Promise<unknown> {
    return this.request(`/services/v1/timezone/${fmt(lat)}/${fmt(lon)}`, {
      qs: { ts: new Date(ts).toISOString() },
    });
  }

  // ── POIs ───────────────────────────────────────────────────────────────

  /** Nearby air-quality stations. */
  async nearbyAirQuality(lat: number, lon: number): Promise<NearbyAirQualityStation[]> {
    return this.request<NearbyAirQualityStation[]>(
      `/pois/v2/airq/${fmt(lat)}/${fmt(lon)}`,
    );
  }

  /** Nearby weather stations (airport METAR + WMO + PWS + MADIS). */
  async nearbyStations(lat: number, lon: number): Promise<NearbyWeatherStation[]> {
    return this.request<NearbyWeatherStation[]>(
      `/pois/v2/stations/${fmt(lat)}/${fmt(lon)}`,
    );
  }

  /**
   * Nearby tide stations. Returns `[]` when the upstream endpoint has no
   * stations near the coord (it answers with a 404 instead of an empty list).
   * For an actual tide-height forecast at any coordinate use `tides()`.
   */
  async nearbyTides(lat: number, lon: number): Promise<unknown[]> {
    try {
      const r = await this.request<unknown>(`/pois/v2/tides/${fmt(lat)}/${fmt(lon)}`);
      if (Array.isArray(r)) return r;
      const pois = (r as { pois?: unknown[] } | null)?.pois;
      return Array.isArray(pois) ? pois : [];
    } catch (e) {
      if (e instanceof WindyAPIError && e.status === 404) return [];
      throw e;
    }
  }

  /** Air-quality POI detail (latest measurement). */
  async airQualityStation(id: string): Promise<AirQualityPOI> {
    const fullId = id.startsWith('airq-') ? id : `airq-${id}`;
    return this.request<AirQualityPOI>(`/pois/v2/airq/${fullId}`);
  }

  /** Generic POI detail by `{type}-{id}`. */
  async poiDetail<T = unknown>(type: string, id: string): Promise<T> {
    return this.request<T>(`/pois/v2/${type}/${id}`);
  }

  /**
   * Historical observation timeseries for a station.
   * @param type `airq` | `ad` | `wmo` | `pws` | `madis`
   * @param id Station id (without the `{type}-` prefix)
   * @param days Look-back window (1, 3, 7, 10, 30)
   * @param step Hours per sample (1 = hourly, 3 = 3-hourly, 24 = daily)
   */
  async observations(
    type: StationType | 'airq',
    id: string,
    days = 10,
    step = 1,
  ): Promise<ObservationTimeseries> {
    const bareId = id.replace(/^(airq|ad|wmo|pws|madis)-/, '');
    return this.request<ObservationTimeseries>(
      `/obs/measurement/v3/${type}/${bareId}/${days}/${step}`,
    );
  }

  // ── Tides ──────────────────────────────────────────────────────────────

  /** Tide forecast for nearest port to a coordinate. */
  async tides(lat: number, lon: number): Promise<TideForecast> {
    return this.request<TideForecast>(`/tides/v1.0/tides/${fmt(lat)}/${fmt(lon)}`);
  }

  /** Tide forecast by tide-POI id. */
  async tidesByPoi(poiId: string): Promise<TideForecast> {
    return this.request<TideForecast>(`/tides/v1.0/tides/${poiId}`);
  }

  // ── Alerts ─────────────────────────────────────────────────────────────

  /**
   * Public CAP (government-issued severe weather) alerts at a location.
   *
   * @param opts.maxCount Maximum alerts to return. Default 6. **Server caps at
   * 10** — values >10 return HTTP 400 (`maxCount must not be greater than 10`).
   * The client transparently clamps to 10 to avoid the error.
   */
  async capAlerts(
    lat: number,
    lon: number,
    opts: { maxCount?: number; source?: string } = {},
  ): Promise<CapAlert[] | null> {
    // Server enforces maxCount <= 10. Clamp here so all surfaces (CLI, runline,
    // dripline) benefit without duplicating the constraint.
    const maxCount = Math.min(Math.max(1, opts.maxCount ?? 6), 10);
    return this.request<CapAlert[] | null>(`/capalerts/${fmt(lat)}/${fmt(lon)}`, {
      qs: {
        source: opts.source ?? 'hp',
        lang: this.lang,
        maxCount,
      },
    });
  }

  /** Live alerts subscribed by the current user. */
  async liveAlerts(
    lat: number,
    lon: number,
    distance: 'km' | 'mi' = 'km',
  ): Promise<LiveAlertsResponse> {
    return this.request<LiveAlertsResponse>(`/notif/v1/live-alerts/${fmt(lat)}/${fmt(lon)}`, {
      qs: { distance, userLanguage: this.lang },
    });
  }

  // ── Tropical cyclones ──────────────────────────────────────────────────

  /** Active tropical storms worldwide. */
  async storms(): Promise<StormsResponse> {
    return this.request<StormsResponse>('/tc/v2/storms');
  }

  /** Number of active storms. */
  async stormsCount(): Promise<unknown> {
    return this.request('/tc/v2/storms/active/count');
  }

  // ── Webcams ────────────────────────────────────────────────────────────

  /** Webcams near a coordinate. */
  async webcamsNear(
    lat: number,
    lon: number,
    opts: { limit?: number; imageSize?: 'thumbnail' | 'preview' | 'original' } = {},
  ): Promise<WebcamList> {
    return this.request<WebcamList>('/webcams/v2.0/list', {
      qs: {
        nearby: `${fmt(lat)},${fmt(lon)}`,
        lang: this.lang,
        limit: opts.limit,
        imageSize: opts.imageSize ?? 'thumbnail',
      },
    });
  }

  /** Webcam detail. */
  async webcamDetail(
    id: number | string,
    imageSize: 'thumbnail' | 'preview' | 'original' = 'preview',
  ): Promise<Webcam> {
    return this.request<Webcam>(`/webcams/v2.0/detail/${id}`, {
      qs: { imageSize, lang: this.lang },
    });
  }

  /** Webcam archive frame list. */
  async webcamArchive(
    id: number | string,
    opts: { imageSize?: string; archiveType?: string } = {},
  ): Promise<unknown> {
    return this.request(`/webcams/v3.0/archive/${id}`, {
      qs: { imageSize: opts.imageSize, archiveType: opts.archiveType },
    });
  }

  /** Webcam hourly archive. */
  async webcamHourlyArchive(id: number | string): Promise<unknown> {
    return this.request(`/webcams/v2.0/archive/hourly/${id}`);
  }

  // ── Radar / satellite ──────────────────────────────────────────────────

  async radarInfo(): Promise<unknown> {
    return this.request('https://rdr.windy.com/radar2/composite/minifest2.json', {
      auth: false,
      skipEnvelope: true,
    });
  }

  async radarCoverage(): Promise<unknown> {
    return this.request('https://rdr.windy.com/radar2/composite/coverage.json', {
      auth: false,
      skipEnvelope: true,
    });
  }

  async satelliteInfo(): Promise<unknown> {
    return this.request('https://sat.windy.com/satellite/composite.json', {
      auth: false,
      skipEnvelope: true,
    });
  }

  /** Radar archive frame index. */
  async radarArchive(): Promise<unknown> {
    return this.request('https://rdr.windy.com/radar2/archive/composite/minifest2.json', {
      auth: false,
      skipEnvelope: true,
    });
  }

  /** Satellite archive frame range. */
  async satelliteArchive(): Promise<unknown> {
    return this.request('https://sat.windy.com/satellite/archive/range.json', {
      auth: false,
      skipEnvelope: true,
    });
  }

  /** URL of a pre-rendered radar/satellite widget image. */
  widgetImageUrl(
    type: 'radar' | 'satellite',
    lat: number,
    lon: number,
    opts: { w?: number; h?: number; format?: string; mode?: string } = {},
  ): string {
    const mode = opts.mode ?? (type === 'satellite' ? 'blue' : 'default');
    const params = new URLSearchParams({
      lat: fmt(lat),
      lon: fmt(lon),
      w: String(opts.w ?? 640),
      h: String(opts.h ?? 360),
      format: opts.format ?? 'jpeg',
    });
    return `https://${NODE_HOST}/widget/${type}/${mode}/image?${params}`;
  }

  /** URL of a static map image (used in share previews). */
  staticMapUrl(opts: {
    lat: number;
    lon: number;
    zoom?: number;
    size?: number;
  }): string {
    const params = new URLSearchParams({
      c: `${fmt(opts.lat)},${fmt(opts.lon)}`,
      z: String(opts.zoom ?? 10),
      size: String(opts.size ?? 640),
    });
    return `https://${NODE_S_HOST}/imaker/map?${params}`;
  }

  /**
   * Direct URL to a pre-rendered weather data tile on the IMS image server.
   * Use the radar `minifest2.json` (or the model's `minifest.json`) to find
   * valid `run` (YYYYMMDDHH) and `forecastHour` (YYYYMMDDHH) timestamps.
   *
   * @param model Model identifier (e.g. `ecmwf-hres`, `gfs`)
   * @param run Model run timestamp `YYYYMMDDHH`
   * @param forecastHour Forecast timestamp `YYYYMMDDHH`
   * @param overlay Overlay/layer (e.g. `wind-surface`, `temp-850h`, `rain`, `radar`)
   * @param z,x,y Tile coordinates
   * @param ext File extension (`jpg`, `png`)
   */
  dataTileUrl(
    model: string,
    run: string,
    forecastHour: string,
    overlay: Overlay | string,
    z: number,
    x: number,
    y: number,
    ext: 'jpg' | 'png' = 'jpg',
  ): string {
    return `https://ims.windy.com/im/v3.0/forecast/${model}/${run}/${forecastHour}/wm_grid_257/${z}/${x}/${y}/${overlay}.${ext}`;
  }

  /** Basemap tile URL. */
  basemapTileUrl(style: BasemapStyle, z: number, x: number, y: number): string {
    return `https://tiles.windy.com/tiles/v11.2/${style}/${z}/${x}/${y}.png`;
  }

  /** Place-label tile URL (vector labels). */
  labelTileUrl(z: number, x: number, y: number, lang?: string): string {
    return `https://tiles.windy.com/labels/v2.0/${lang ?? this.lang}/${z}/${x}/${y}.json`;
  }

  // ── Airports ───────────────────────────────────────────────────────────

  /**
   * Airport info by ICAO code (e.g. `LLBG`, `KJFK`, `EGLL`).
   * Returns runways, METAR, TAF, and metadata.
   */
  async airport(icao: string): Promise<AirportResponse> {
    return this.request<AirportResponse>(`/airports/adinfo/${icao.toUpperCase()}`);
  }

  // ── Citytile (city pill data) ──────────────────────────────────────────

  /**
   * City-overlay tile data — list of named cities visible in the tile, each
   * with a forecast curve. Used by the home map "city temperature pills".
   * @param model Forecast model identifier (e.g. `ecmwf-hres`, `gfs`)
   * @param z Tile zoom
   * @param x Tile X
   * @param y Tile Y
   */
  async citytile(
    model: string,
    z: number,
    x: number,
    y: number,
    opts: { refTime?: string; step?: number; hours?: number; labelsVersion?: string } = {},
  ): Promise<unknown> {
    return this.request(`/citytile/v1.0/${model}/${z}/${x}/${y}`, {
      qs: {
        labelsVersion: opts.labelsVersion ?? 'v2.0',
        step: opts.step ?? 3,
        refTime: opts.refTime,
        hours: opts.hours,
      },
    });
  }

  // ── Webcam search & metrics ────────────────────────────────────────────

  /**
   * Search webcams by resolving the query to a place, then filtering the
   * public nearby-webcam response. The former admin endpoint is not a public
   * route and returns 404.
   */
  async webcamSearch(
    query: string,
    opts: { lat?: number; lon?: number } = {},
  ): Promise<WebcamList> {
    let lat = opts.lat;
    let lon = opts.lon;
    if (lat === undefined || lon === undefined) {
      const places = await this.search(query, 0, 0, 10);
      const place = places.data?.find((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      lat = place?.lat;
      lon = place?.lon;
    }
    if (lat === undefined || lon === undefined) return { cams: [], total: 0 };

    const nearby = await this.webcamsNear(lat, lon, { limit: 25, imageSize: 'preview' });
    const needle = query.trim().toLowerCase();
    const cams = nearby.cams.filter((cam) => {
      const haystack = [
        cam.title,
        cam.location?.title,
        cam.location?.city,
        cam.location?.country,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(needle);
    });
    return { cams, total: cams.length };
  }

  /** Webcam health / ping metrics. */
  async webcamPing(id: number | string): Promise<unknown> {
    return this.request(`/webcams/ping/${id}`);
  }

  // ── User data (require login) ──────────────────────────────────────────

  /** List user favourites. */
  async favourites(): Promise<Favourite[]> {
    this.requireAuthed('favourites');
    return this.request<Favourite[]>('/users/v1/data/favs');
  }

  /** Create a new favourite (server assigns the id). */
  async addFavourite(
    fav: Omit<
      FavouriteValue,
      'id' | 'userId' | 'userID' | 'counter' | 'deleted' | 'updated' | 'type' | 'version'
    >,
  ): Promise<unknown> {
    this.requireAuthed('addFavourite');
    const body = { ...fav, type: 'fav' as const, version: APP_VERSION, updated: Date.now() };
    return this.request('/users/v1/data/favs', { method: 'POST', body });
  }

  /** Update an existing favourite by id. */
  async updateFavourite(id: string, value: Partial<FavouriteValue>): Promise<unknown> {
    this.requireAuthed('updateFavourite');
    return this.request(`/users/v1/data/favs/${id}`, {
      method: 'PUT',
      body: { ...value, updated: Date.now() },
    });
  }

  /** Delete a favourite by id. */
  async deleteFavourite(id: string): Promise<unknown> {
    this.requireAuthed('deleteFavourite');
    return this.request(`/users/v1/data/favs/${id}`, { method: 'DELETE' });
  }

  /** List user alerts. */
  async userAlerts(): Promise<UserAlertItem[] | null> {
    this.requireAuthed('userAlerts');
    return this.request<UserAlertItem[] | null>('/users/v1/data/alerts');
  }

  /** Get a single user alert by id. */
  async getUserAlert(id: string): Promise<UserAlertItem> {
    this.requireAuthed('getUserAlert');
    return this.request<UserAlertItem>(`/users/v1/data/alerts/${id}`);
  }

  /** Create a user alert. */
  async addUserAlert(alert: NonNullable<UserAlertItem['value']>): Promise<unknown> {
    this.requireAuthed('addUserAlert');
    const body = { ...alert, type: 'alert' as const, version: APP_VERSION, updated: Date.now() };
    return this.request('/users/v1/data/alerts', { method: 'POST', body });
  }

  /** Update a user alert. */
  async updateUserAlert(id: string, value: Partial<NonNullable<UserAlertItem['value']>>): Promise<unknown> {
    this.requireAuthed('updateUserAlert');
    return this.request(`/users/v1/data/alerts/${id}`, {
      method: 'PUT',
      body: { ...value, updated: Date.now() },
    });
  }

  /** Delete a user alert. */
  async deleteUserAlert(id: string): Promise<unknown> {
    this.requireAuthed('deleteUserAlert');
    return this.request(`/users/v1/data/alerts/${id}`, { method: 'DELETE' });
  }

  /** Get user settings. */
  async userSettings(): Promise<unknown> {
    this.requireAuthed('userSettings');
    return this.request('/users/settings');
  }

  /** Update user settings. */
  async updateUserSettings(patch: Record<string, unknown>): Promise<unknown> {
    this.requireAuthed('updateUserSettings');
    return this.request('/users/settings', { method: 'POST', body: patch });
  }

  /** List custom color palettes. */
  async userColors(): Promise<unknown> {
    this.requireAuthed('userColors');
    return this.request('/users/v1/data/colors');
  }

  /** List installed plugins. */
  async userPlugins(): Promise<unknown> {
    this.requireAuthed('userPlugins');
    return this.request('/users/v1/data/plugins');
  }

  /** Get device registration. */
  async userDevice(): Promise<unknown> {
    this.requireAuthed('userDevice');
    return this.request(`/users/v3/devices/${this.session.uid}`);
  }

  /**
   * Register / refresh this device for push notifications.
   * @param token FCM (Android/web) or APNs (iOS) push token
   * @param platform `web` | `ios` | `android`
   */
  async registerPushDevice(
    token: string,
    platform: 'web' | 'ios' | 'android' = 'web',
  ): Promise<unknown> {
    this.requireAuthed('registerPushDevice');
    return this.request(`/users/v3/devices/${this.session.uid}`, {
      method: 'POST',
      body: {
        token,
        platform,
        lang: this.lang,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  /** Unregister a push notification device. */
  async unregisterPushDevice(): Promise<unknown> {
    this.requireAuthed('unregisterPushDevice');
    return this.request(`/users/v3/devices/${this.session.uid}`, {
      method: 'DELETE',
    });
  }

  // ── Webcam owner CRUD ─────────────────────────────────────────────────

  /**
   * List webcams owned by the current user.
   * Uses the admin endpoint — requires the user to have webcams registered.
   */
  async myWebcams(): Promise<unknown> {
    this.requireAuthed('myWebcams');
    return this.request('https://admin.windy.com/webcams/admin/v1.0/my-webcams', {
      skipEnvelope: true,
      bearer: true,
    });
  }

  /** Register a new webcam (owner flow). */
  async addWebcam(payload: {
    title: string;
    lat: number;
    lon: number;
    imageUrl: string;
    sourceUrl?: string;
    description?: string;
    [k: string]: unknown;
  }): Promise<unknown> {
    this.requireAuthed('addWebcam');
    return this.request('https://admin.windy.com/webcams/admin/v1.0/webcams', {
      method: 'POST',
      body: payload,
      skipEnvelope: true,
      bearer: true,
    });
  }

  /** Update a webcam. */
  async updateWebcam(id: number | string, patch: Record<string, unknown>): Promise<unknown> {
    this.requireAuthed('updateWebcam');
    return this.request(`https://admin.windy.com/webcams/admin/v1.0/webcams/${id}`, {
      method: 'PUT',
      body: patch,
      skipEnvelope: true,
      bearer: true,
    });
  }

  /** Remove a webcam. */
  async removeWebcam(id: number | string): Promise<unknown> {
    this.requireAuthed('removeWebcam');
    return this.request(`https://admin.windy.com/webcams/admin/v1.0/webcams/${id}`, {
      method: 'DELETE',
      skipEnvelope: true,
      bearer: true,
    });
  }

  // ── api.windy.com Point Forecast API ──────────────────────────────────

  /**
   * Call the official commercial Point Forecast API at api.windy.com.
   * Requires a separate API key from https://api.windy.com/ (free tier ~500 calls/day).
   *
   * Different auth model from the web-app endpoints — uses an API key in the body.
   * @param apiKey Windy API key (separate from your web subscription)
   * @param opts Point + model + parameters
   */
  async apiPointForecast(
    apiKey: string,
    opts: {
      lat: number;
      lon: number;
      model: PointModel | string;
      /** Parameters to return — e.g. `['wind', 'temp', 'rh']`. */
      parameters: string[];
      /** Pressure-level filter — e.g. `['surface', '850h']`. */
      levels?: Level[];
      /** Pre-canned key list bundle ID. */
      key?: string;
    },
  ): Promise<unknown> {
    return this.request('https://api.windy.com/api/point-forecast/v2', {
      method: 'POST',
      body: {
        lat: opts.lat,
        lon: opts.lon,
        model: opts.model,
        parameters: opts.parameters,
        levels: opts.levels,
        key: apiKey,
      },
      auth: false,
      skipEnvelope: true,
    });
  }

  // ── Misc ───────────────────────────────────────────────────────────────

  /** Startup banner article. */
  async startupArticle(opts: { lat?: number; lon?: number } = {}): Promise<unknown> {
    return this.startupContent('article', opts);
  }

  /** Startup marketing promo. */
  async startupPromo(opts: { lat?: number; lon?: number; forceId?: string } = {}): Promise<unknown> {
    return this.startupContent('promotion', opts);
  }

  private startupContent(
    kind: 'article' | 'promotion',
    opts: { lat?: number; lon?: number; forceId?: string },
  ): Promise<unknown> {
    return this.request(`/articles/startup/${kind}`, {
      qs: {
        country: this.country,
        device: 'desktop',
        language: this.lang,
        platform: 'desktop',
        target: 'index',
        userStatus: this.session.subscription === 'premium' ? 'premium' : 'free',
        loginStatus: this.session.userId ? 'signed-in' : 'signed-out',
        version: APP_VERSION,
        lat: opts.lat,
        lon: opts.lon,
        forceId: opts.forceId,
      },
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private requireAuthed(op: string): void {
    if (!this.session.accountSid && !this.session.token) {
      throw new Error(
        `${op} requires an authenticated session. Configure accountSid or token on the Windy connection.`,
      );
    }
  }

  private persist(): void {
    if (!this.ephemeral) saveSession(this.session);
  }

  private async ensureAuth(): Promise<void> {
    // Only refresh when we have a means to refresh (account cookie) and the token is stale
    if (!tokenIsStale(this.session, 60)) return;
    // Anonymous and token-only clients have no cookie from which to mint a JWT.
    if (!this.session.accountSid) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        await this.refreshAuth();
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private async request<T = unknown>(
    pathOrUrl: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const auth = options.auth ?? requiresAuthentication(pathOrUrl);
    if (auth) await this.ensureAuth();
    return this.requestNoEnsure<T>(pathOrUrl, options);
  }

  private async requestNoEnsure<T = unknown>(
    pathOrUrl: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const skipEnvelope = options.skipEnvelope ?? false;

    const isAbsolute = pathOrUrl.startsWith('http');
    const base = isAbsolute ? pathOrUrl : `https://${options.host ?? NODE_HOST}${pathOrUrl}`;
    const url = new URL(base);

    // Merge user qs first, then auth envelope (envelope overrides if collision)
    if (options.qs) {
      for (const [k, v] of Object.entries(options.qs)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    if (!skipEnvelope) {
      const tiers = this.decodeToken()?.subscriptionTiers ?? [];
      const isPremium = tiers.includes('premium') || this.session.subscription === 'premium';
      url.searchParams.set('pr', isPremium ? '1' : '0');
      url.searchParams.set('sc', isPremium ? '1' : '0');
      if (this.session.token) url.searchParams.set('token2', this.session.token);
      url.searchParams.set('uid', this.session.uid);
      url.searchParams.set('v', APP_VERSION);
      url.searchParams.set('poc', String(this.pocCounter++));
    }

    return this.rawRequest<T>(url, options);
  }

  private rawRequest<T>(url: URL, options: RequestOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      const method = options.method ?? 'GET';
      const data =
        options.body !== undefined ? JSON.stringify(options.body) : undefined;
      const headers: Record<string, string> = {
        accept: APP_ACCEPT_HEADER,
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': `${this.lang}-US,${this.lang};q=0.9`,
        'user-agent': USER_AGENT,
        origin: 'https://www.windy.com',
        referer: 'https://www.windy.com/',
      };
      if (this.session.accountSid && url.hostname.endsWith('windy.com')) {
        headers['cookie'] = `_account_sid=${this.session.accountSid}`;
      }
      if (options.bearer && this.session.token) {
        headers['authorization'] = `Bearer ${this.session.token}`;
      }
      if (data !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(data));
      }

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method,
          headers,
          timeout: Number(process.env.WINDY_HTTP_TIMEOUT ?? 30000),
          agent: getProxyAgent(this.proxy),
        },
        (res) => {
          // Capture rotated _account_sid if present
          const setCookies = res.headers['set-cookie'];
          if (setCookies && Array.isArray(setCookies)) {
            for (const c of setCookies) {
              const m = /^_account_sid=([^;]+)/.exec(c);
              if (m && m[1] !== this.session.accountSid) {
                this.session.accountSid = m[1];
                if (!this.ephemeral) this.persist();
              }
            }
          }
          let stream: NodeJS.ReadableStream = res;
          const encoding = res.headers['content-encoding'];
          if (encoding === 'gzip') stream = res.pipe(createGunzip());
          else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
          else if (encoding === 'deflate') stream = res.pipe(createInflate());
          else if (encoding === 'zstd') {
            try {
              // zstd was added to zlib in Node 22.15+. Older versions will fall through.
              const zlib = require('zlib') as typeof import('zlib');
              const decoder = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
                .createZstdDecompress?.();
              if (decoder) stream = res.pipe(decoder);
            } catch {
              /* fall through to raw — likely garbage */
            }
          }

          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            const text = buf.toString();
            const status = res.statusCode ?? 0;

            if (status === 204 || buf.length === 0) {
              resolve(null as T);
              return;
            }
            if (status >= 400) {
              reject(
                new WindyAPIError(
                  status,
                  `HTTP ${status} on ${url.pathname}: ${text.slice(0, 400)}`,
                  text,
                ),
              );
              return;
            }
            if (options.raw) {
              resolve(text as unknown as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              // Some endpoints return text/plain numbers (e.g. /services/elevation)
              const asNum = Number(text);
              if (!Number.isNaN(asNum) && text.trim() !== '') {
                resolve(asNum as unknown as T);
                return;
              }
              reject(new Error(`Non-JSON response from ${url.pathname}: ${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out: ${url.pathname}`));
      });
      if (data !== undefined) req.write(data);
      req.end();
    });
  }
}

export class WindyAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'WindyAPIError';
  }
}

function requiresAuthentication(pathOrUrl: string): boolean {
  return pathOrUrl.startsWith('/users/') ||
    pathOrUrl === '/users/settings' ||
    pathOrUrl.startsWith('/notif/v1/live-alerts/') ||
    (pathOrUrl.startsWith('https://admin.windy.com/') &&
      !pathOrUrl.endsWith('/webcams/admin/v1.0/views'));
}

function fmt(coord: number): string {
  if (!Number.isFinite(coord)) throw new Error(`invalid coordinate: ${coord}`);
  // Windy expects 3 decimal places for the lat/lon path segments
  return coord.toFixed(3);
}
