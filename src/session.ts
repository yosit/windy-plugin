import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { WindyJWT } from './types';

function configDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'windy-cli')
    : join(homedir(), '.config', 'windy-cli');
}

function sessionFile(): string {
  return process.env.WINDY_SESSION_FILE ?? join(configDir(), 'session.json');
}

function loginHistoryFile(): string {
  return process.env.WINDY_LOGIN_HISTORY_FILE ?? join(configDir(), 'login-history.json');
}

const LOGIN_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LOGIN_HISTORY_MAX_PER_WINDOW = 8;

export interface PersistedSession {
  /** `_account_sid` HttpOnly cookie value */
  accountSid?: string;
  /** Stable device UUID for the `uid` query param */
  uid: string;
  /** Cached JWT (refreshed when expired) */
  token?: string;
  /** Decoded `exp` claim, unix s */
  tokenExp?: number;
  /** User id from the last successful /api/info call */
  userId?: number;
  /** Username from the last successful /api/info call */
  username?: string;
  /** Subscription tier */
  subscription?: string;
  /** Unix ms of the last successful keepalive/refresh, for jittered keepalive scheduling. */
  lastKeepaliveMs?: number;
}

export function decodeJWT(token: string): WindyJWT {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const payload = Buffer.from(parts[1], 'base64url').toString();
  return JSON.parse(payload) as WindyJWT;
}

function assertPrivateRegularFile(path: string): void {
  const st = lstatSync(path);
  const uid = process.getuid?.();
  if (!st.isFile() || st.nlink !== 1 || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`windy: refusing unsafe session file ${path}`);
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicWrite(path: string, value: string): void {
  const dir = join(path, '..');
  ensurePrivateDir(dir);
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, value, { encoding: 'utf8' });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    try { unlinkSync(temp); } catch { /* already renamed */ }
  }
}

export function loadSession(): PersistedSession {
  if (existsSync(sessionFile())) {
    assertPrivateRegularFile(sessionFile());
    const raw = readFileSync(sessionFile(), 'utf8');
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed || typeof parsed.uid !== 'string' || parsed.uid.length === 0) {
      throw new Error(`windy: invalid session file ${sessionFile()}`);
    }
    return parsed;
  }
  return { uid: randomUUID() };
}

export function saveSession(s: PersistedSession): void {
  atomicWrite(sessionFile(), JSON.stringify(s, null, 2));
}

export function sessionPath(): string {
  return sessionFile();
}

export function loginHistoryPath(): string {
  return loginHistoryFile();
}

/** Returns true if token is missing or expires within `marginSec` seconds. */
export function tokenIsStale(s: PersistedSession, marginSec = 60): boolean {
  if (!s.token || !s.tokenExp) return true;
  return Date.now() / 1000 > s.tokenExp - marginSec;
}

/**
 * True when the session still has a JWT we can use without bootstrapping
 * from the cookie. Callers should prefer this over kicking a re-auth: most
 * windy endpoints accept a slightly-stale token, and re-auth costs an
 * `/api/info` round-trip on the auth host.
 */
export function isSessionReusable(s: PersistedSession, marginSec = 60): boolean {
  return !!s.token && !tokenIsStale(s, marginSec);
}

// ── Login throttle ────────────────────────────────────────────────────────
// Persistent record of `/api/info` bootstrap calls within the last 24h.
// Guards against accidental tight-loop re-auth from a stuck plugin or a
// pathological retry, which on cookie-gated APIs is a fast path to a
// challenge / IP block.

interface LoginHistory {
  /** Unix ms timestamps of bootstrap attempts, newest last. */
  events: number[];
}

function loadLoginHistory(): LoginHistory {
  if (!existsSync(loginHistoryFile())) return { events: [] };
  assertPrivateRegularFile(loginHistoryFile());
  try {
    const raw = readFileSync(loginHistoryFile(), 'utf8');
    const parsed = JSON.parse(raw) as LoginHistory;
    return { events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch (error) {
    if (error instanceof SyntaxError) return { events: [] };
    throw error;
  }
}

function saveLoginHistory(h: LoginHistory): void {
  atomicWrite(loginHistoryFile(), JSON.stringify(h, null, 2));
}

/**
 * Throws if more than `LOGIN_HISTORY_MAX_PER_WINDOW` bootstraps have
 * happened in the last 24h. Otherwise records this attempt and returns.
 * Disabled by setting `WINDY_DISABLE_LOGIN_THROTTLE=1` (tests).
 */
export function recordLoginAttempt(now: number = Date.now()): void {
  if (process.env.WINDY_DISABLE_LOGIN_THROTTLE === '1') return;
  const h = loadLoginHistory();
  const cutoff = now - LOGIN_HISTORY_WINDOW_MS;
  const recent = h.events.filter((t) => t >= cutoff);
  if (recent.length >= LOGIN_HISTORY_MAX_PER_WINDOW) {
    const oldest = new Date(recent[0]).toISOString();
    throw new Error(
      `windy: login throttle — ${recent.length} bootstraps in the last 24h ` +
        `(oldest ${oldest}). Set WINDY_DISABLE_LOGIN_THROTTLE=1 to override.`,
    );
  }
  recent.push(now);
  saveLoginHistory({ events: recent });
}

// ── Jittered keepalive ────────────────────────────────────────────────────
// Many real-time-data SPAs ping a lightweight endpoint at a wall-clock
// interval to keep the session warm. Doing it on a fixed cadence is itself
// a fingerprint, so we jitter ±20% around `baseMs`.

export interface KeepaliveOptions {
  /** Median interval in ms (default 9 min — under windy's typical 10-min idle). */
  baseMs?: number;
  /** Fractional jitter applied symmetrically (default 0.2 = ±20%). */
  jitter?: number;
  /** Async ping; rejection is swallowed (we'll retry next tick). */
  ping: () => Promise<void>;
}

/**
 * Schedules `ping()` on a jittered cadence. Returns a stop function. Does
 * not run immediately — first ping fires after one jittered interval.
 */
export function startKeepalive(opts: KeepaliveOptions): () => void {
  const base = Math.max(30_000, opts.baseMs ?? 9 * 60 * 1000);
  const jitter = Math.min(0.5, Math.max(0, opts.jitter ?? 0.2));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const delta = base * jitter;
    const next = base + (Math.random() * 2 - 1) * delta;
    timer = setTimeout(async () => {
      try {
        await opts.ping();
      } catch {
        /* swallow — next tick will retry */
      }
      schedule();
    }, next);
    // Don't keep the event loop alive just for keepalive in CLI use.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
