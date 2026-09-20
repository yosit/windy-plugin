import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isSessionReusable, loadSession, recordLoginAttempt, saveSession } from '../src/session';

describe('session lifecycle helpers', () => {
  let tmp: string;
  let original: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'windy-session-'));
    original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.WINDY_DISABLE_LOGIN_THROTTLE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('isSessionReusable: true only with non-stale token', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(isSessionReusable({ uid: 'u' })).toBe(false);
    expect(isSessionReusable({ uid: 'u', token: 't', tokenExp: future })).toBe(true);
    expect(isSessionReusable({ uid: 'u', token: 't', tokenExp: past })).toBe(false);
  });

  it('saves and reloads a private session atomically', () => {
    const session = { uid: 'private-uid', token: 'token', tokenExp: 2_000_000_000 };
    saveSession(session);
    expect(loadSession()).toEqual(session);
    expect(lstatSync(join(tmp, 'windy-cli', 'session.json')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(tmp, 'windy-cli')).mode & 0o777).toBe(0o700);
  });

  it('rejects a symlinked session file', () => {
    const dir = join(tmp, 'windy-cli');
    saveSession({ uid: 'safe' });
    const sessionPath = join(dir, 'session.json');
    rmSync(sessionPath);
    // A symlink must never be followed for credential material.
    const target = join(tmp, 'target.json');
    writeFileSync(target, JSON.stringify({ uid: 'target' }));
    const fs = require('fs') as typeof import('fs');
    fs.symlinkSync(target, sessionPath);
    expect(() => loadSession()).toThrow(/unsafe session file/);
  });

  it('recordLoginAttempt is bypassable for tests', () => {
    process.env.WINDY_DISABLE_LOGIN_THROTTLE = '1';
    for (let i = 0; i < 20; i++) recordLoginAttempt();
  });

  it('recordLoginAttempt throws after exceeding the 24h window', () => {
    for (let i = 0; i < 8; i++) recordLoginAttempt();
    expect(() => recordLoginAttempt()).toThrow(/login throttle/);
  });
});
