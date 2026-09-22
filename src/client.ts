import { SessionManager } from './auth.js';
import type { Paged } from './types.js';

export class BandLabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export class WriteBlockedError extends Error {}

export interface ClientOptions {
  apiBase: string;
  session: SessionManager;
  /** Writes are refused unless this is true (BANDLAB_ALLOW_WRITES). */
  allowWrites: boolean;
  /** Floor on the gap between requests, to stay at human pace. */
  minIntervalMs: number;
  userAgent: string;
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Thin HTTP client for the BandLab API.
 *
 * Three behaviours matter beyond plain fetch:
 *  - every request is spaced by `minIntervalMs` so the server never sees a burst;
 *  - a single 401 triggers one re-authentication and one retry;
 *  - write verbs are refused unless writes were explicitly enabled.
 */
export class BandLabClient {
  #options: ClientOptions;
  #queue: Promise<unknown> = Promise.resolve();
  #lastCallAt = 0;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  get allowWrites(): boolean {
    return this.#options.allowWrites;
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  /** Walks a cursor-paginated collection up to `limit` items. */
  async listAll<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    limit = 50,
  ): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;

    while (items.length < limit) {
      const page = await this.get<Paged<T>>(path, {
        ...query,
        limit: Math.min(20, limit - items.length),
        after,
      });
      const batch = page.data ?? [];
      items.push(...batch);
      after = page.paging?.cursors?.after ?? page.paging?.nextCursor;
      if (!after || batch.length === 0) break;
    }
    return items.slice(0, limit);
  }

  async request<T>(
    method: string,
    path: string,
    init: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    if (WRITE_METHODS.has(method) && !this.#options.allowWrites) {
      throw new WriteBlockedError(
        `Refusing ${method} ${path}: writes are disabled. Set BANDLAB_ALLOW_WRITES=true to enable them.`,
      );
    }
    return this.#enqueue(() => this.#send<T>(method, path, init, true));
  }

  /** Serializes all calls and enforces the minimum spacing between them. */
  async #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const wait = this.#lastCallAt + this.#options.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.#lastCallAt = Date.now();
      return task();
    });
    // Keep the chain alive even when a task rejects.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #send<T>(
    method: string,
    path: string,
    init: { query?: Record<string, string | number | undefined>; body?: unknown },
    mayRetry: boolean,
  ): Promise<T> {
    const url = new URL(`${this.#options.apiBase}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const token = await this.#options.session.getToken();
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'user-agent': this.#options.userAgent,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (response.status === 401 && mayRetry) {
      this.#options.session.invalidate();
      return this.#send<T>(method, path, init, false);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new BandLabApiError(
        `BandLab ${method} ${path} failed with HTTP ${response.status}`,
        response.status,
        text.slice(0, 600),
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
