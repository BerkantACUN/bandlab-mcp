/** Environment-driven configuration, validated once at startup. */

export interface Config {
  apiBase: string;
  /** A bearer token copied straight from a browser session. Cannot be refreshed. */
  sessionKey?: string;
  refreshToken?: string;
  username?: string;
  password?: string;
  allowWrites: boolean;
  minIntervalMs: number;
  userAgent: string;
}

const DEFAULT_API_BASE = 'https://www.bandlab.com/api/v1.3';
const DEFAULT_MIN_INTERVAL_MS = 1200;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionKey = stripBearer(trimmed(env.BANDLAB_SESSION_KEY));
  const refreshToken = trimmed(env.BANDLAB_REFRESH_TOKEN);
  const username = trimmed(env.BANDLAB_USERNAME);
  const password = trimmed(env.BANDLAB_PASSWORD);

  if (!sessionKey && !refreshToken && !(username && password)) {
    throw new Error(
      'BandLab credentials missing. Set BANDLAB_SESSION_KEY or BANDLAB_REFRESH_TOKEN, ' +
        'or both BANDLAB_USERNAME and BANDLAB_PASSWORD.',
    );
  }

  const interval = Number(env.BANDLAB_MIN_INTERVAL_MS ?? DEFAULT_MIN_INTERVAL_MS);

  return {
    apiBase: (trimmed(env.BANDLAB_API_BASE) ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    sessionKey,
    refreshToken,
    username,
    password,
    allowWrites: env.BANDLAB_ALLOW_WRITES === 'true',
    minIntervalMs: Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_MIN_INTERVAL_MS,
    userAgent: trimmed(env.BANDLAB_USER_AGENT) ?? 'bandlab-mcp/0.1.0',
  };
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

/** Accepts either a bare token or a whole `Bearer x` header, since both get pasted. */
function stripBearer(value: string | undefined): string | undefined {
  return value?.replace(/^Bearer\s+/i, '').trim() || undefined;
}
