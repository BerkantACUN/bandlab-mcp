#!/usr/bin/env node
/** Entry point: wires config -> session -> client -> MCP server over stdio. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionManager } from './auth.js';
import { BandLabClient } from './client.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

/**
 * Loads `.env` from the package root.
 *
 * An MCP client spawns this process from an arbitrary working directory, so the
 * file is resolved against this module rather than `cwd`. Variables already set
 * by the client win, which keeps `claude mcp add --env` working as an override.
 */
function loadDotEnv(): void {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    process.loadEnvFile(join(packageRoot, '.env'));
  } catch {
    // No .env, or unreadable: credentials are expected from the environment.
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const session = new SessionManager({
    apiBase: config.apiBase,
    sessionKey: config.sessionKey,
    refreshToken: config.refreshToken,
    username: config.username,
    password: config.password,
  });

  const client = new BandLabClient({
    apiBase: config.apiBase,
    session,
    allowWrites: config.allowWrites,
    minIntervalMs: config.minIntervalMs,
    userAgent: config.userAgent,
  });

  await buildServer(client, config).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error('[bandlab-mcp] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
