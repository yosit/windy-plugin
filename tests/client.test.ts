import { describe, it, expect, vi } from 'vitest';
import { WindyClient, WindyAPIError } from '../src/client';
import { decodeJWT } from '../src/session';

describe('WindyClient', () => {
  it('builds a client without requiring credentials (anonymous mode)', () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    expect(c).toBeDefined();
    expect(c.persistedSession.uid).toBe('test-uid');
    expect(c.persistedSession.token).toBeUndefined();
  });

  it('public reads do not try to refresh an anonymous session', async () => {
    const c = new WindyClient({ session: { uid: 'anonymous-test' }, ephemeral: true });
    const refresh = vi.spyOn(c, 'refreshAuth');
    const transport = vi.spyOn(c as unknown as { rawRequest: () => Promise<unknown> }, 'rawRequest').mockResolvedValue(42);
    await expect(c.elevation(1, 2)).resolves.toBe(42);
    expect(refresh).not.toHaveBeenCalled();
    transport.mockRestore();
    refresh.mockRestore();
  });

  it('decodeToken returns null when no token is stored', () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    expect(c.decodeToken()).toBeNull();
  });

  it('requireAuthed throws on user-data endpoints when not logged in', async () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    await expect(c.favourites()).rejects.toThrow(/authenticated session/);
    await expect(c.userAlerts()).rejects.toThrow(/authenticated session/);
    await expect(c.userSettings()).rejects.toThrow(/authenticated session/);
  });

  it('staticMapUrl produces a node-s.windy.com URL', () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    const url = c.staticMapUrl({ lat: 32.08, lon: 34.78, zoom: 10, size: 640 });
    expect(url).toMatch(/node-s\.windy\.com/);
    expect(url).toMatch(/c=32\.080%2C34\.780/);
    expect(url).toMatch(/z=10/);
    expect(url).toMatch(/size=640/);
  });

  it('modelManifest aliases user-facing `ecmwf` to `ecmwf-hres`', async () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    const spy = vi
      .spyOn(c as unknown as { request: (p: string, o?: unknown) => Promise<unknown> }, 'request')
      .mockResolvedValue({} as never);
    await c.modelManifest('ecmwf');
    expect(spy).toHaveBeenCalledWith(
      '/metadata/v1.0/forecast/ecmwf-hres/minifest.json',
      expect.anything(),
    );
    spy.mockRestore();
  });

  it('modelManifest leaves non-aliased model names alone', async () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    const spy = vi
      .spyOn(c as unknown as { request: (p: string, o?: unknown) => Promise<unknown> }, 'request')
      .mockResolvedValue({} as never);
    await c.modelManifest('gfs');
    expect(spy).toHaveBeenCalledWith(
      '/metadata/v1.0/forecast/gfs/minifest.json',
      expect.anything(),
    );
    spy.mockRestore();
  });

  it('nearbyTides returns [] on upstream 404 instead of throwing', async () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    vi.spyOn(c as unknown as { request: (p: string) => Promise<unknown> }, 'request')
      .mockRejectedValue(new WindyAPIError(404, 'HTTP 404', '{}'));
    await expect(c.nearbyTides(37.7442, 23.4283)).resolves.toEqual([]);
  });

  it('nearbyTides rethrows non-404 errors', async () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    vi.spyOn(c as unknown as { request: (p: string) => Promise<unknown> }, 'request')
      .mockRejectedValue(new WindyAPIError(500, 'HTTP 500', '{}'));
    await expect(c.nearbyTides(37.7442, 23.4283)).rejects.toThrow(/500/);
  });

  it('widgetImageUrl encodes radar/satellite params', () => {
    const c = new WindyClient({ session: { uid: 'test-uid' }, ephemeral: true });
    const url = c.widgetImageUrl('satellite', 32.08, 34.78, { w: 1200, h: 600 });
    expect(url).toMatch(/node\.windy\.com\/widget\/satellite\/blue\/image/);
    expect(url).toMatch(/lat=32\.080/);
    expect(url).toMatch(/lon=34\.780/);
    expect(url).toMatch(/w=1200/);
  });
});

describe('decodeJWT', () => {
  it('decodes a Windy-shaped JWT', () => {
    // header: {"alg":"HS256","typ":"JWT"}
    // payload: {"magic":560,"userID":89976,"subscriptionTiers":["premium"],"iat":1778693120,"exp":1778865920}
    const sample =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJtYWdpYyI6NTYwLCJzdWJzY3JpcHRpb25UaWVycyI6WyJwcmVtaXVtIl0sInVzZXJJRCI6ODk5NzYsImlhdCI6MTc3ODY5MzEyMCwiZXhwIjoxNzc4ODY1OTIwfQ.signature';
    const claims = decodeJWT(sample);
    expect(claims.magic).toBe(560);
    expect(claims.userID).toBe(89976);
    expect(claims.subscriptionTiers).toEqual(['premium']);
    expect(claims.iat).toBe(1778693120);
    expect(claims.exp).toBe(1778865920);
  });

  it('throws on a malformed JWT', () => {
    expect(() => decodeJWT('not-a-jwt')).toThrow(/Malformed/);
  });
});
