/**
 * The verified effect catalogue.
 *
 * BandLab assembles its effect list inside a WASM audio engine at runtime, so
 * there is no endpoint to ask. `scripts/harvest-effects.mjs` instead reads real
 * published projects and records the slugs and parameters they actually use.
 * Everything here therefore came off a working project — which matters, because
 * an invented slug would be written into a revision BandLab cannot interpret.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CatalogueParam {
  kind: string;
  observedMin?: number;
  observedMax?: number;
  examples: unknown[];
}

export interface CatalogueEffect {
  slug: string;
  seenInProjects: number;
  trackTypes: string[];
  params: Record<string, CatalogueParam>;
}

export interface EffectCatalogue {
  harvestedOn: string;
  revisionsScanned: number;
  note: string;
  effects: CatalogueEffect[];
  auxPresets: Record<string, number>;
  masteringPresets: Record<string, number>;
  trackTypes: Record<string, number>;
}

const EMPTY: EffectCatalogue = {
  harvestedOn: 'never',
  revisionsScanned: 0,
  note: 'No catalogue file found. Run: node scripts/harvest-effects.mjs',
  effects: [],
  auxPresets: {},
  masteringPresets: {},
  trackTypes: {},
};

let cached: EffectCatalogue | null = null;

export function loadCatalogue(): EffectCatalogue {
  if (cached) return cached;
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'effects-catalogue.json');
  try {
    cached = JSON.parse(readFileSync(path, 'utf8')) as EffectCatalogue;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

export function findEffect(slug: string): CatalogueEffect | undefined {
  const wanted = slug.toLowerCase();
  return loadCatalogue().effects.find((effect) => effect.slug.toLowerCase() === wanted);
}

/** Renders the catalogue as text, optionally filtered by a search term. */
export function describeCatalogue(query?: string): string {
  const catalogue = loadCatalogue();
  if (catalogue.effects.length === 0) return catalogue.note;

  const term = query?.trim().toLowerCase();
  const matches = term
    ? catalogue.effects.filter(
        (effect) =>
          effect.slug.toLowerCase().includes(term) ||
          Object.keys(effect.params).some((name) => name.toLowerCase().includes(term)),
      )
    : catalogue.effects;

  const lines = [
    `Verified effect catalogue — ${catalogue.effects.length} slugs from ` +
      `${catalogue.revisionsScanned} real projects (harvested ${catalogue.harvestedOn}).`,
    catalogue.note,
    '',
  ];

  if (matches.length === 0) {
    const all = catalogue.effects.map((effect) => effect.slug).join(', ');
    return `${lines.join('\n')}No slug or parameter matches "${query}".\n\nAll slugs: ${all}`;
  }

  if (term) lines.push(`Matching "${query}" (${matches.length}):`, '');

  for (const effect of matches) {
    lines.push(`${effect.slug}  (seen ${effect.seenInProjects}x)`);
    for (const [name, param] of Object.entries(effect.params)) {
      const range =
        param.observedMin === undefined
          ? param.kind
          : `${param.kind}, observed ${param.observedMin} .. ${param.observedMax}`;
      const examples = param.examples.slice(0, 3).map((value) => JSON.stringify(value)).join(', ');
      lines.push(`    ${name}: ${range}${examples ? ` — e.g. ${examples}` : ''}`);
    }
    lines.push('');
  }

  lines.push(
    `Aux presets: ${Object.keys(catalogue.auxPresets).join(', ') || '(none observed)'}`,
    `Track types: ${Object.keys(catalogue.trackTypes).join(', ')}`,
  );
  return lines.join('\n');
}
