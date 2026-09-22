#!/usr/bin/env node
/**
 * Harvests the real effect catalogue from public BandLab projects.
 *
 * BandLab builds its effect list inside a WASM audio engine at runtime, so it
 * cannot be read statically, and the UI directive names do not map cleanly onto
 * slugs (`pedalThreeBandEq2` is `threeBandEq`, `pedalMultibandCompressor` is
 * `multibandComp2`). Guessing a slug would write an effect BandLab does not
 * recognise, so instead this reads published revisions and records only slugs
 * that real projects actually contain, together with the parameter names and
 * observed value ranges that came with them.
 *
 * Strictly read-only, and paced by the shared client throttle.
 *
 *   node --env-file-if-exists=.env scripts/harvest-effects.mjs [revisionCount]
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { SessionManager } from '../dist/auth.js';
import { BandLabClient } from '../dist/client.js';

const TARGET = Number(process.argv[2] ?? 40);
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'effects-catalogue.json');

const config = loadConfig();
const client = new BandLabClient({
  apiBase: config.apiBase,
  session: new SessionManager(config),
  allowWrites: false,
  minIntervalMs: config.minIntervalMs,
  userAgent: config.userAgent,
});

/** slug -> { count, params: { name -> {min,max,samples} }, trackTypes:Set } */
const catalogue = new Map();
const auxPresets = new Map();
const trackTypes = new Map();
const masteringPresets = new Map();

function noteEffect(effect, trackType) {
  if (!effect?.slug) return;
  const entry =
    catalogue.get(effect.slug) ??
    { count: 0, params: new Map(), trackTypes: new Set() };
  entry.count += 1;
  if (trackType) entry.trackTypes.add(trackType);

  for (const [name, value] of Object.entries(effect.params ?? {})) {
    const param = entry.params.get(name) ?? { kind: typeof value, values: [] };
    if (param.values.length < 6 && !param.values.includes(value)) param.values.push(value);
    if (typeof value === 'number') {
      param.min = param.min === undefined ? value : Math.min(param.min, value);
      param.max = param.max === undefined ? value : Math.max(param.max, value);
    }
    entry.params.set(name, param);
  }
  catalogue.set(effect.slug, entry);
}

function bump(map, key) {
  if (key === undefined || key === null) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Community effect presets: a denser source of chains than raw projects. */
let presetsScanned = 0;
try {
  const trending = await client.get('/trending-effect-presets', { limit: 50 });
  for (const preset of trending.data ?? []) {
    presetsScanned += 1;
    for (const effect of preset.effects ?? []) noteEffect(effect, 'preset');
  }
  console.log(`  ${presetsScanned} community presets scanned`);
} catch (error) {
  console.log(`  (skipped presets: ${error.message})`);
}

const seen = new Set();
let after;
let scanned = 0;

console.log(`Harvesting up to ${TARGET} public revisions from ${config.apiBase} ...\n`);

while (scanned < TARGET) {
  const feed = await client.get('/posts', { type: 'Revision', limit: 20, after });
  const posts = feed.data ?? [];
  if (posts.length === 0) break;
  after = feed.paging?.cursors?.after ?? feed.paging?.nextCursor;

  for (const post of posts) {
    const revisionId = post.revision?.id;
    if (!revisionId || seen.has(revisionId) || scanned >= TARGET) continue;
    seen.add(revisionId);

    let revision;
    try {
      revision = await client.get(`/revisions/${revisionId}`);
    } catch {
      continue; // private or deleted between listing and read
    }
    scanned += 1;

    for (const track of revision.tracks ?? []) {
      bump(trackTypes, track.type);
      for (const effect of track.effects ?? []) noteEffect(effect, track.type);
    }
    for (const aux of revision.auxChannels ?? []) {
      bump(auxPresets, aux.preset);
      for (const effect of aux.effects ?? []) noteEffect(effect, 'aux');
    }
    bump(masteringPresets, revision.mastering?.preset);

    process.stdout.write(
      `\r  ${scanned}/${TARGET} revisions · ${catalogue.size} distinct effect slugs`,
    );
  }
  if (!after) break;
}

console.log('\n');

const effects = [...catalogue.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .map(([slug, entry]) => ({
    slug,
    seenInProjects: entry.count,
    trackTypes: [...entry.trackTypes],
    params: Object.fromEntries(
      [...entry.params.entries()].map(([name, param]) => [
        name,
        {
          kind: param.kind,
          ...(param.min === undefined ? {} : { observedMin: param.min, observedMax: param.max }),
          examples: param.values.slice(0, 4),
        },
      ]),
    ),
  }));

const result = {
  harvestedOn: new Date().toISOString().slice(0, 10),
  apiBase: config.apiBase,
  revisionsScanned: scanned,
  presetsScanned,
  note:
    'Slugs observed in real public projects. Absence here does not mean an effect does not ' +
    'exist — BandLab ships roughly 90 pedals and this only sees the ones people used in the ' +
    'sampled projects. Never invent a slug that is not listed.',
  effects,
  auxPresets: Object.fromEntries(auxPresets),
  masteringPresets: Object.fromEntries(masteringPresets),
  trackTypes: Object.fromEntries(trackTypes),
};

await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);

console.log(`${effects.length} distinct effect slugs from ${scanned} revisions:\n`);
for (const effect of effects) {
  console.log(`  ${effect.slug}  (${effect.seenInProjects}x)  params: ${Object.keys(effect.params).join(', ') || '(none)'}`);
}
console.log(`\nmastering presets: ${Object.keys(result.masteringPresets).join(', ') || '(none seen)'}`);
console.log(`aux presets:       ${Object.keys(result.auxPresets).join(', ') || '(none seen)'}`);
console.log(`track types:       ${Object.keys(result.trackTypes).join(', ')}`);
console.log(`\nwritten to ${OUT}`);
