import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuthorizationResult } from './types.js';

const SESSION_FILE = join(homedir(), '.bandlab-mcp', 'session.json');
/** Refresh this long before the server-stated expiry so calls never race it. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * BandLab's identity server. Session JWTs are issued here (the `iss` claim on a
 * live token is `https://accounts.bandlab.com/oauth`), and this is the endpoint
 * that actually renews them — the v1.3 `/authorizations` route rejects these
 * refresh tokens. `bandlab_web` is a public client, so no secret is involved.
 */
const OAUTH_TOKEN_ENDPOINT = 'https://accounts.bandlab.com/oauth/connect/token';
const OAUTH_CLIENT_ID = 'bandlab_web';

interface StoredSession {
  sessionKey: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface AuthConfig {
  apiBase: string;
  /** A bearer token lifted from a browser session; used as-is, cannot be renewed. */
  sessionKey?: string;
  refreshToken?: string;
  username?: string;
  password?: string;
}

export class AuthError extends Error {}

/**
 * Owns the BandLab session key.
 *
 * BandLab issues a short-lived `sessionKey` (JWT) plus a long-lived
 * `refreshToken` from `POST /authorizations`. Only the refresh token is
 * persisted; the password, if supplied, is used once and never written to disk.
 */
export class SessionManager {
  #config: AuthConfig;
  #session: StoredSession | null = null;
  #inflight: Promise<string> | null = null;
  #staticKeyRejected = false;

  constructor(config: AuthConfig) {
    this.#config = config;
  }

  /** Returns a valid bearer token, refreshing or logging in as needed. */
  async getToken(): Promise<string> {
    if (this.#session && Date.now() < this.#session.expiresAt - EXPIRY_SKEW_MS) {
      return this.#session.sessionKey;
    }
    this.#inflight ??= this.#establish().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /** Forces the next call to re-authenticate (used after an unexpected 401). */
  invalidate(): void {
    this.#session = null;
  }

  async #establish(): Promise<string> {
    const stored = this.#session ?? (await this.#load());
    const refreshToken = stored?.refreshToken ?? this.#config.refreshToken;

    if (refreshToken) {
      const attempts: Array<() => Promise<string>> = [
        () => this.#refreshViaOAuth(refreshToken),
        // Legacy path, kept for sessions created by the v1.3 password grant.
        () => this.#authorize({ provider: 'Token', refreshToken }),
      ];
      let lastError: unknown;
      for (const attempt of attempts) {
        try {
          return await attempt();
        } catch (error) {
          lastError = error;
        }
      }
      if (!this.#config.password && !this.#config.sessionKey) throw lastError;
    }

    const { username, password, sessionKey } = this.#config;
    if (username && password) {
      return this.#authorize({ provider: 'Password', username, password });
    }

    if (sessionKey) {
      if (this.#staticKeyRejected) {
        throw new AuthError(
          'The BANDLAB_SESSION_KEY was rejected. Browser tokens are short-lived — copy a fresh ' +
            'Authorization header from DevTools, or switch to BANDLAB_REFRESH_TOKEN for auto-renewal.',
        );
      }
      this.#staticKeyRejected = true;
      // No expiry is knowable for a pasted token; treat it as valid until a 401 says otherwise.
      this.#session = { sessionKey, expiresAt: Number.MAX_SAFE_INTEGER };
      return sessionKey;
    }

    throw new AuthError(
      'No usable credentials. Set BANDLAB_SESSION_KEY or BANDLAB_REFRESH_TOKEN, ' +
        'or BANDLAB_USERNAME + BANDLAB_PASSWORD.',
    );
  }

  /**
   * Renews the session through OpenID Connect.
   *
   * BandLab rotates refresh tokens: each call returns a new one and retires the
   * old. Persisting the replacement is therefore mandatory — dropping it ends
   * the session for good.
   */
  async #refreshViaOAuth(refreshToken: string): Promise<string> {
    const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new AuthError(`OAuth refresh failed (HTTP ${response.status}): ${truncate(text)}`);
    }

    let result: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      result = JSON.parse(text) as typeof result;
    } catch {
      throw new AuthError(`OAuth refresh returned non-JSON: ${truncate(text)}`);
    }
    if (!result.access_token) {
      throw new AuthError('OAuth refresh response contained no access_token.');
    }

    this.#session = {
      sessionKey: result.access_token,
      refreshToken: result.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000,
    };
    await this.#save(this.#session);
    return this.#session.sessionKey;
  }

  async #authorize(body: Record<string, string>): Promise<string> {
    const response = await fetch(`${this.#config.apiBase}/authorizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new AuthError(`Authorization failed (HTTP ${response.status}): ${truncate(text)}`);
    }

    let result: AuthorizationResult;
    try {
      result = JSON.parse(text) as AuthorizationResult;
    } catch {
      throw new AuthError(`Authorization returned non-JSON: ${truncate(text)}`);
    }
    if (!result.sessionKey) {
      throw new AuthError('Authorization response contained no sessionKey.');
    }

    const expiresAt = result.expireDate ? Date.parse(result.expireDate) : Number.NaN;
    this.#session = {
      sessionKey: result.sessionKey,
      refreshToken: result.refreshToken ?? body.refreshToken,
      // Fall back to a conservative 30 minutes when the server omits an expiry.
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 60_000,
    };
    await this.#save(this.#session);
    return this.#session.sessionKey;
  }

  async #load(): Promise<StoredSession | null> {
    try {
      return JSON.parse(await readFile(SESSION_FILE, 'utf8')) as StoredSession;
    } catch {
      return null;
    }
  }

  async #save(session: StoredSession): Promise<void> {
    try {
      await mkdir(dirname(SESSION_FILE), { recursive: true });
      await writeFile(SESSION_FILE, JSON.stringify(session), { mode: 0o600 });
    } catch {
      // A read-only home directory is not fatal: the session stays in memory.
    }
  }
}

function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
