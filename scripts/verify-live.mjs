#!/usr/bin/env node
/**
 * One-shot live verification against a real BandLab account.
 *
 * The BandLab API is undocumented, so several things in this codebase are
 * informed guesses. This script checks each of them against a real session and
 * prints what actually came back. It is strictly read-only: it never writes.
 *
 *   BANDLAB_SESSION_KEY="Bearer eyJ..." node scripts/verify-live.mjs
 */
import { loadConfig } from '../dist/config.js';
import { SessionManager } from '../dist/auth.js';
import { BandLabClient } from '../dist/client.js';
import { summarizeRevision } from '../dist/format.js';

const config = loadConfig();
const client = new BandLabClient({
  apiBase: config.apiBase,
  session: new SessionManager(config),
  allowWrites: false, // read-only by construction
  minIntervalMs: config.minIntervalMs,
  userAgent: config.userAgent,
});

const results = [];
function record(claim, ok, detail) {
  results.push({ claim, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `\n      ${detail}` : ''}`);
}

console.log(`Verifying against ${config.apiBase}\n`);

// 1. Session works.
let me;
try {
  me = await client.get('/me');
  record('session authenticates (GET /me)', true, `${me.username} (${me.id})`);
} catch (error) {
  record('session authenticates (GET /me)', false, error.message);
  console.error('\nCannot continue without a session.');
  process.exit(1);
}

// 2. Catalogue is reachable.
let songs = [];
try {
  songs = await client.listAll(`/users/${me.id}/songs`, {}, 10);
  record('own songs are listable', songs.length > 0, `${songs.length} song(s)`);
} catch (error) {
  record('own songs are listable', false, error.message);
}

if (songs.length === 0) {
  console.log('\nNo songs on this account — nothing further to verify.');
  process.exit(0);
}

// 3. Revision history.
const song = songs[0];
let revisions = [];
try {
  revisions = await client.listAll(`/songs/${song.id}/revisions`, {}, 5);
  record('revision history is readable', revisions.length > 0, `${revisions.length} revision(s) of "${song.name}"`);
} catch (error) {
  record('revision history is readable', false, error.message);
  process.exit(1);
}

// 4. The big one: does a revision really carry the DAW tree?
const revision = await client.get(`/revisions/${revisions[0].id}`);
const tracks = Array.isArray(revision.tracks) ? revision.tracks : [];
record('revision contains tracks[]', tracks.length > 0, `${tracks.length} track(s)`);

const first = tracks[0] ?? {};
record(
  'tracks carry mix fields (volume/pan)',
  typeof first.volume === 'number' || typeof first.pan === 'number',
  `keys: ${Object.keys(first).join(', ')}`,
);
record('tracks expose a name', typeof first.name === 'string', `name=${JSON.stringify(first.name)}`);

// 5. Observed value ranges vs. the ones mix.ts enforces.
const volumes = tracks.map((t) => t.volume).filter((v) => typeof v === 'number');
const pans = tracks.map((t) => t.pan).filter((v) => typeof v === 'number');
if (volumes.length > 0) {
  const lo = Math.min(...volumes);
  const hi = Math.max(...volumes);
  record('volume sits inside the assumed 0..2', lo >= 0 && hi <= 2, `observed ${lo} .. ${hi}`);
}
if (pans.length > 0) {
  const lo = Math.min(...pans);
  const hi = Math.max(...pans);
  record('pan sits inside the assumed -1..1', lo >= -1 && hi <= 1, `observed ${lo} .. ${hi}`);
}

// 6. Effect slugs actually in use — these are undocumented.
// Informational: a project with no effects is normal, not a failure.
const slugs = [...new Set(tracks.flatMap((t) => (t.effects ?? []).map((e) => e.slug)))].filter(Boolean);
console.log(`INFO  effect slugs in use: ${slugs.join(', ') || '(none on this revision)'}`);

const sample = tracks.flatMap((t) => t.effects ?? []).find((e) => e.params && Object.keys(e.params).length > 0);
if (sample) {
  console.log(`\n      example effect params — ${sample.slug}: ${JSON.stringify(sample.params)}`);
}

// 7. Regions and tempo.
const regions = tracks.flatMap((t) => t.regions ?? []);
record('regions carry positions', regions.some((r) => typeof r.startPosition === 'number'), `${regions.length} region(s)`);
record('tempo is present', typeof revision.metronome?.bpm === 'number', `bpm=${revision.metronome?.bpm}`);

// 8. Write permission (checked, never exercised).
record('revision reports canEdit', revision.canEdit === true, `canEdit=${revision.canEdit}`);

console.log('\n--- rendered mix ---');
console.log(summarizeRevision(revision));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log('Assumptions needing a fix:');
  for (const f of failed) console.log(`  - ${f.claim}`);
}
