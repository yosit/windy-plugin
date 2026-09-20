import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Import from the built artifact so the prototype we stub is the SAME class
// the plugins receive via `@yosit/windy` (resolved through the Bun workspace
// to ./dist/index.js). Stubbing src/client.ts's WindyClient would have no
// effect on the plugin code.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WindyClient, saveSession } = require('@yosit/windy') as typeof import('@yosit/windy');
type WindyClient = InstanceType<typeof WindyClient>;
import runlinePlugin from '../plugins/runline/src/index';
import driplinePlugin from '../plugins/dripline/src/index';

// ── Helpers to drive the plugins without the real SDKs ────────────────────

interface CapturedAction {
  execute: (input: Record<string, unknown>, ctx: { connection: { config: Record<string, unknown> } }) => Promise<unknown>;
}

function mountRunline(): Map<string, CapturedAction> {
  const actions = new Map<string, CapturedAction>();
  const api = {
    setName: () => {},
    setVersion: () => {},
    setConnectionSchema: () => {},
    registerAction: (name: string, def: CapturedAction) => { actions.set(name, def); },
  };
  runlinePlugin(api as never);
  return actions;
}

interface CapturedTable {
  list?: (ctx: unknown) => AsyncGenerator<Record<string, unknown>>;
}

interface MountedDripline {
  tables: Map<string, CapturedTable>;
  warnings: string[];
}

function mountDripline(): MountedDripline {
  const tables = new Map<string, CapturedTable>();
  const warnings: string[] = [];
  const api = {
    setName: () => {},
    setVersion: () => {},
    setConnectionSchema: () => {},
    onInit: () => {},
    registerTable: (name: string, def: CapturedTable) => { tables.set(name, def); },
    log: {
      info: () => {},
      warn: (msg: string) => { warnings.push(msg); },
      error: () => {},
    },
  };
  driplinePlugin(api as never);
  return { tables, warnings };
}

async function drain(gen: AsyncGenerator<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const r of gen) rows.push(r);
  return rows;
}

/**
 * Replace one method on WindyClient.prototype with a stub for the duration of
 * a test. Returned `instances` collects the `this` of every call, so tests
 * can assert how many distinct clients were created. Restores the original
 * implementation when `restore()` is called.
 */
function stubMethod<K extends keyof WindyClient>(
  method: K,
  impl: (this: WindyClient, ...args: unknown[]) => unknown,
): { instances: WindyClient[]; restore: () => void } {
  const proto = WindyClient.prototype as unknown as Record<string, unknown>;
  const original = proto[method as string];
  const instances: WindyClient[] = [];
  proto[method as string] = function (this: WindyClient, ...args: unknown[]) {
    instances.push(this);
    return impl.apply(this, args);
  };
  return {
    instances,
    restore: () => { proto[method as string] = original; },
  };
}

describe('plugin capability parity (#14)', () => {
  it('registers the extended read-only action and table surfaces', () => {
    const actions = mountRunline();
    const { tables } = mountDripline();
    expect(actions.has('radar.info')).toBe(true);
    expect(actions.has('webcams.archive')).toBe(true);
    expect(actions.has('account.settings')).toBe(true);
    expect(tables.has('windy_radar_info')).toBe(true);
    expect(tables.has('windy_satellite_archive')).toBe(true);
    expect(tables.has('windy_account_settings')).toBe(true);
  });
});

describe('runline plugin client cache (#7)', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  it('reuses one WindyClient across calls with the same connection config', async () => {
    const s = stubMethod('pointForecast', async () =>
      ({ header: { model: 'ecmwf', refTime: 't' }, data: { ts: [] } }) as never,
    );
    restores.push(s.restore);

    const actions = mountRunline();
    const ctx = { connection: { config: { uid: 'cache-test-uid-1', accountSid: 'sid-1' } } };
    const fc = actions.get('forecast.point')!;
    await fc.execute({ lat: 1, lon: 2 }, ctx);
    await fc.execute({ lat: 3, lon: 4 }, ctx);

    expect(s.instances.length).toBe(2);
    expect(s.instances[0]).toBe(s.instances[1]);
  });

  it('loads the persisted session instead of starting empty', async () => {
    const originalConfig = process.env.XDG_CONFIG_HOME;
    const configHome = mkdtempSync(join(tmpdir(), 'windy-plugin-session-'));
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      saveSession({ uid: 'persisted-uid', accountSid: 'sid-1', token: 'cached-token', tokenExp: 2_000_000_000 });
      const s = stubMethod('pointForecast', async function (this: WindyClient) {
        expect(this.persistedSession.token).toBe('cached-token');
        return { header: { model: 'ecmwf', refTime: 't' }, data: { ts: [] } } as never;
      });
      restores.push(s.restore);
      const actions = mountRunline();
      await actions.get('forecast.point')!.execute(
        { lat: 1, lon: 2 },
        { connection: { config: { uid: 'persisted-uid', accountSid: 'sid-1' } } },
      );
    } finally {
      if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalConfig;
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it('search.places reports missing bias coordinates clearly', async () => {
    const actions = mountRunline();
    const action = actions.get('search.places')!;
    await expect(action.execute({ query: 'Fort William' }, { connection: { config: {} } }))
      .rejects.toThrow('search.places: biasLat is required');
    await expect(action.execute({ query: 'Fort William', latitude: 56.82, longitude: -5.11 }, { connection: { config: {} } }))
      .rejects.toThrow('search.places: biasLat is required');
  });

  it('search.places accepts lat/lon as coordinate aliases', async () => {
    const s = stubMethod('search', async (...args: unknown[]) => ({ data: [{ lat: args[1], lon: args[2] }] }) as never);
    restores.push(s.restore);
    const actions = mountRunline();
    await actions.get('search.places')!.execute(
      { query: 'Fort William', lat: 56.82, lon: -5.11 },
      { connection: { config: { uid: 'search-aliases' } } },
    );
    expect(s.instances).toHaveLength(1);
  });

  it('creates a separate client when the connection config differs', async () => {
    const s = stubMethod('pointForecast', async () =>
      ({ header: { model: 'ecmwf', refTime: 't' }, data: { ts: [] } }) as never,
    );
    restores.push(s.restore);

    const actions = mountRunline();
    const fc = actions.get('forecast.point')!;
    await fc.execute({ lat: 1, lon: 2 }, { connection: { config: { uid: 'cache-test-a' } } });
    await fc.execute({ lat: 1, lon: 2 }, { connection: { config: { uid: 'cache-test-b' } } });

    expect(s.instances[0]).not.toBe(s.instances[1]);
  });
});

describe('dripline forecast tables surface errors (#4, #8)', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  it('windy_forecast_now rethrows upstream errors instead of returning 0 rows', async () => {
    const s = stubMethod('pointForecast', async () => { throw new Error('boom: upstream failed'); });
    restores.push(s.restore);

    const { tables, warnings } = mountDripline();
    const t = tables.get('windy_forecast_now')!;
    const gen = t.list!({
      connection: { config: { uid: 'drip-err-now' } },
      quals: [
        { column: 'lat', operator: '=', value: 37.7442 },
        { column: 'lon', operator: '=', value: 23.4283 },
      ],
    });

    await expect(drain(gen)).rejects.toThrow(/boom/);
    expect(warnings.some((w) => w.includes('windy_forecast_now'))).toBe(true);
  });

  it('windy_forecast_point rethrows upstream errors', async () => {
    const s = stubMethod('pointForecast', async () => { throw new Error('explode'); });
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_point')!;
    const gen = t.list!({
      connection: { config: { uid: 'drip-err-point' } },
      quals: [
        { column: 'lat', operator: '=', value: 1 },
        { column: 'lon', operator: '=', value: 2 },
      ],
    });
    await expect(drain(gen)).rejects.toThrow(/explode/);
  });

  it('windy_forecast_now yields a row populated from the now snapshot on success', async () => {
    const s = stubMethod('pointForecast', async () => ({
      header: { model: 'ecmwf', refTime: '2026-05-22T12:00:00Z', tzName: 'Europe/Athens' },
      data: { ts: [] },
      now: { temp: 292.36, wind: 4.7, windDir: 338, icon: 1, moonPhase: 2 },
    }) as never);
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_now')!;
    const rows = await drain(t.list!({
      connection: { config: { uid: 'drip-ok' } },
      quals: [
        { column: 'lat', operator: '=', value: 37.7442 },
        { column: 'lon', operator: '=', value: 23.4283 },
      ],
    }));

    expect(rows.length).toBe(1);
    expect(rows[0].temp_k).toBe(292.36);
    expect(rows[0].wind_ms).toBe(4.7);
    expect(rows[0].wind_dir_deg).toBe(338);
    expect(rows[0].model).toBe('ecmwf');
  });

  it('windy_forecast_now passes includeNow=true so the snapshot populates', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const s = stubMethod('pointForecast', async function (
      this: WindyClient,
      ..._args: unknown[]
    ) {
      receivedOpts = _args[2] as Record<string, unknown>;
      return { header: { model: 'ecmwf', refTime: 't' }, data: { ts: [] }, now: { temp: 1 } } as never;
    });
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_now')!;
    await drain(t.list!({
      connection: { config: { uid: 'drip-includeNow' } },
      quals: [
        { column: 'lat', operator: '=', value: 1 },
        { column: 'lon', operator: '=', value: 2 },
      ],
    }));
    expect(receivedOpts?.includeNow).toBe(true);
  });
});

describe('dripline forecast tables normalize model casing (#9)', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  it('windy_forecast_point yields lowercase `model` even when header is uppercase', async () => {
    const s = stubMethod('pointForecast', async () => ({
      header: { model: 'ECMWF', refTime: '2026-05-22T12:00:00Z' },
      data: { ts: [1_700_000_000_000], temp: [290] },
    }) as never);
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_point')!;
    const rows = await drain(t.list!({
      connection: { config: { uid: 'drip-case' } },
      quals: [
        { column: 'lat', operator: '=', value: 37.7442 },
        { column: 'lon', operator: '=', value: 23.4283 },
        { column: 'model', operator: '=', value: 'ecmwf' },
      ],
    }));
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe('ecmwf');
  });

  it('windy_forecast_point restores DuckDB DECIMAL quals before calling the client', async () => {
    let received: { lat?: number; lon?: number } = {};
    const s = stubMethod('pointForecast', async function (this: WindyClient, ...args: unknown[]) {
      received = { lat: args[0] as number, lon: args[1] as number };
      return { header: { model: 'ecmwf', refTime: 't' }, data: { ts: [] } } as never;
    });
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_point')!;
    await drain(t.list!({
      connection: { config: { uid: 'drip-decimal' } },
      quals: [
        { column: 'lat', operator: '=', value: { value: 566420n, scale: 4 } },
        { column: 'lon', operator: '=', value: { value: -48800n, scale: 4 } },
      ],
    }));
    expect(received).toEqual({ lat: 56.642, lon: -4.88 });
  });

  it('windy_forecast_point rejects null quals produced by unsupported CAST expressions', async () => {
    const s = stubMethod('pointForecast', async () => ({
      header: { model: 'ecmwf', refTime: 't' },
      data: { ts: [1_700_000_000_000], temp: [290] },
    }) as never);
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_point')!;
    await expect(drain(t.list!({
      connection: { config: { uid: 'drip-cast-double' } },
      quals: [
        { column: 'lat', operator: '=', value: null },
        { column: 'lon', operator: '=', value: null },
        { column: 'model', operator: '=', value: 'ecmwf' },
      ],
    }))).rejects.toThrow(/lat.*CAST/);
    expect(s.instances).toHaveLength(0);
  });

  it('windy_forecast_point lowercases the model qual before calling the client', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const s = stubMethod('pointForecast', async function (this: WindyClient, ..._args: unknown[]) {
      receivedOpts = _args[2] as Record<string, unknown>;
      return { header: { model: 'ECMWF', refTime: 't' }, data: { ts: [] } } as never;
    });
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_point')!;
    await drain(t.list!({
      connection: { config: { uid: 'drip-case-in' } },
      quals: [
        { column: 'lat', operator: '=', value: 1 },
        { column: 'lon', operator: '=', value: 2 },
        { column: 'model', operator: '=', value: 'ECMWF' },
      ],
    }));
    expect(receivedOpts?.model).toBe('ecmwf');
  });

  it('windy_forecast_air_quality accepts lowercase `camseu` alias', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const s = stubMethod('airQualityForecast', async function (this: WindyClient, ..._args: unknown[]) {
      receivedOpts = _args[2] as Record<string, unknown>;
      return { header: { model: 'camsEu', refTime: 't' }, data: { ts: [] } } as never;
    });
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_air_quality')!;
    const rows = await drain(t.list!({
      connection: { config: { uid: 'drip-aq' } },
      quals: [
        { column: 'lat', operator: '=', value: 1 },
        { column: 'lon', operator: '=', value: 2 },
        { column: 'model', operator: '=', value: 'camseu' },
      ],
    }));
    expect(receivedOpts?.model).toBe('camsEu');
    // emitted rows are still lowercased for predicate matching
    for (const r of rows) expect(r.model).toBe('camseu');
  });

  it('windy_forecast_sounding maps ECMWF-HRES header back to user-facing `ecmwf` (#10)', async () => {
    const s = stubMethod('sounding', async () => ({
      header: {
        model: 'ECMWF-HRES',
        refTime: '2026-05-22T12:00:00Z',
        lat: 1,
        lon: 2,
        step: 3,
      },
      timesteps: [{ ts: 1_700_000_000_000, hoursOffset: 0, levels: [{ level: 'surface', altM: 0, altFt: 0 }] }],
    }) as never);
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_sounding')!;
    const rows = await drain(t.list!({
      connection: { config: { uid: 'drip-sound-emit' } },
      quals: [
        { column: 'lat', operator: '=', value: 37.7442 },
        { column: 'lon', operator: '=', value: 23.4283 },
        { column: 'model', operator: '=', value: 'ecmwf' },
      ],
    }));
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe('ecmwf');
  });

  it('windy_forecast_sounding accepts `ecmwf-hres` qual and sends `ecmwf` upstream (#10)', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const s = stubMethod('sounding', async function (this: WindyClient, ..._args: unknown[]) {
      receivedOpts = _args[2] as Record<string, unknown>;
      return { header: { model: 'ECMWF-HRES', refTime: 't', lat: 0, lon: 0, step: 3 }, timesteps: [] } as never;
    });
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_sounding')!;
    await drain(t.list!({
      connection: { config: { uid: 'drip-sound-in' } },
      quals: [
        { column: 'lat', operator: '=', value: 1 },
        { column: 'lon', operator: '=', value: 2 },
        { column: 'model', operator: '=', value: 'ecmwf-hres' },
      ],
    }));
    expect(receivedOpts?.model).toBe('ecmwf');
  });

  it('windy_forecast_meteogram normalizes ECMWF-HRES → ecmwf both directions (#10)', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const s = stubMethod('meteogram', async function (this: WindyClient, ..._args: unknown[]) {
      receivedOpts = _args[2] as Record<string, unknown>;
      return {
        header: { model: 'ECMWF-HRES', refTime: '2026-05-22T12:00:00Z', step: 3 },
        data: { hours: [1_700_000_000_000] },
      } as never;
    });
    restores.push(s.restore);

    const { tables } = mountDripline();
    const t = tables.get('windy_forecast_meteogram')!;
    const rows = await drain(t.list!({
      connection: { config: { uid: 'drip-mg' } },
      quals: [
        { column: 'lat', operator: '=', value: 1 },
        { column: 'lon', operator: '=', value: 2 },
        { column: 'model', operator: '=', value: 'ecmwf-hres' },
        { column: 'level', operator: '=', value: 'surface' },
      ],
    }));
    expect(receivedOpts?.model).toBe('ecmwf');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.model).toBe('ecmwf');
  });
});

describe('runline plugin tolerates nearbyTides 404 via client (#6)', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  it('returns [] from stations.nearbyTides action when upstream 404s', async () => {
    // nearbyTides catches 404 inside the client (verified separately) — make
    // sure the runline action returns the same empty list without throwing.
    const s = stubMethod('nearbyTides', async () => [] as never);
    restores.push(s.restore);

    const actions = mountRunline();
    const action = actions.get('stations.nearbyTides')!;
    const result = await action.execute(
      { lat: 37.7442, lon: 23.4283 },
      { connection: { config: { uid: 'tides-test' } } },
    );
    expect(result).toEqual([]);
  });
});
