/**
 * Renders a revision as compact text.
 *
 * A raw revision is a large JSON tree; dropping it into a model's context is
 * wasteful and hard to reason over. These helpers keep the parts an editing
 * decision actually depends on — levels, panning, effects, region layout — and
 * leave the rest addressable by id.
 */
import type { Change } from './mix.js';
import { trackLabel } from './mix.js';
import type { Revision, Track } from './types.js';

export function summarizeRevision(revision: Revision): string {
  const lines: string[] = [];
  const song = (revision.song ?? {}) as { name?: string };

  lines.push(`Song: ${song.name ?? '(untitled)'}`);
  lines.push(`Revision: ${revision.id ?? '(no id)'}${revision.isPublic ? ' [public]' : ' [private]'}`);
  if (revision.description) lines.push(`Description: ${revision.description}`);

  const bpm = revision.metronome?.bpm;
  const signature = revision.metronome?.signature;
  const tempo = [
    bpm ? `${bpm} BPM` : null,
    signature?.notesCount && signature?.noteValue
      ? `${signature.notesCount}/${signature.noteValue}`
      : null,
    revision.key ? `key ${revision.key}` : null,
  ].filter(Boolean);
  if (tempo.length > 0) lines.push(`Tempo: ${tempo.join(', ')}`);

  if (typeof revision.volume === 'number') lines.push(`Master volume: ${fmt(revision.volume)}`);
  if (revision.mastering?.preset) lines.push(`Mastering preset: ${revision.mastering.preset}`);
  if (revision.canEdit === false) lines.push('NOTE: canEdit is false — writes will be rejected.');

  const tracks = revision.tracks ?? [];
  lines.push('', `Tracks (${tracks.length}):`);
  tracks.forEach((track, index) => lines.push(...describeTrack(track, index)));

  const auxChannels = revision.auxChannels ?? [];
  if (auxChannels.length > 0) {
    lines.push('', `Aux channels (${auxChannels.length}):`);
    for (const aux of auxChannels) {
      const effects = (aux.effects ?? []).map((effect) => effect.slug).filter(Boolean);
      lines.push(
        `  ${aux.id ?? '?'} preset=${aux.preset ?? '-'} return=${fmt(aux.returnLevel)}` +
          (effects.length > 0 ? ` fx=[${effects.join(', ')}]` : ''),
      );
    }
  }
  return lines.join('\n');
}

function describeTrack(track: Track, index: number): string[] {
  const flags = [
    track.isMuted ? 'MUTED' : null,
    track.isSolo ? 'SOLO' : null,
    track.isFrozen ? 'frozen' : null,
  ].filter(Boolean);

  const head =
    `  #${index + 1} ${trackLabel(track)}` +
    `  vol=${fmt(track.volume)} pan=${fmt(track.pan)}` +
    (track.type ? ` type=${track.type}` : '') +
    (typeof track.fxMix === 'number' && track.fxMix !== 1 ? ` fxMix=${fmt(track.fxMix)}` : '') +
    (flags.length > 0 ? `  [${flags.join(', ')}]` : '');
  const lines = [head, `      id=${track.id ?? '(none)'}`];

  const effects = track.effects ?? [];
  if (effects.length > 0) {
    const rendered = effects
      .map((effect) => `${effect.slug}${effect.bypass ? '(bypassed)' : ''}`)
      .join(', ');
    lines.push(`      fx: ${rendered}`);
  }

  const sends = (track.auxSends ?? []).filter((send) => send.id);
  if (sends.length > 0) {
    lines.push(`      sends: ${sends.map((s) => `${s.id}=${fmt(s.sendLevel)}`).join(', ')}`);
  }

  const automation = track.automation ?? {};
  const automated = [
    automation.volume?.length ? `volume(${automation.volume.length}pts)` : null,
    automation.pan?.length ? `pan(${automation.pan.length}pts)` : null,
  ].filter(Boolean);
  if (automated.length > 0) lines.push(`      automation: ${automated.join(', ')}`);

  const regions = track.regions ?? [];
  if (regions.length > 0) {
    lines.push(`      regions (${regions.length}):`);
    for (const region of regions.slice(0, 12)) {
      const pitch = region.pitchShift ? ` pitch=${region.pitchShift}` : '';
      const rate = region.playbackRate && region.playbackRate !== 1 ? ` rate=${region.playbackRate}` : '';
      lines.push(
        `        ${region.name ?? region.id ?? '?'}  ` +
          `[${fmt(region.startPosition)} -> ${fmt(region.endPosition)}]${pitch}${rate}`,
      );
    }
    if (regions.length > 12) lines.push(`        ... and ${regions.length - 12} more`);
  }
  return lines;
}

export function summarizeChanges(changes: readonly Change[]): string {
  if (changes.length === 0) return 'No changes were produced.';
  return changes
    .map((change) => `  ${change.target} :: ${change.field}  ${render(change.before)} -> ${render(change.after)}`)
    .join('\n');
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '(unset)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function fmt(value: number | undefined): string {
  if (typeof value !== 'number') return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
