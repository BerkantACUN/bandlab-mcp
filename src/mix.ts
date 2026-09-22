/**
 * The mix edit engine.
 *
 * Pure functions only: every operation takes a revision, returns a NEW revision
 * plus a change log, and never touches the input. That property is what makes
 * prompt-driven editing safe to preview before anything is sent to BandLab.
 *
 * Value ranges below are inferred from the BandLab mix editor and the API
 * schema, not from published documentation. `describeRanges()` reports them so
 * a caller can confirm them against a real project before trusting an edit.
 */
import type { ColorName, Effect, Region, Revision, Track } from './types.js';

export const VOLUME_MIN = 0;
/** The editor allows boosting above unity; 2.0 is roughly +6 dB. */
export const VOLUME_MAX = 2;
export const PAN_MIN = -1;
export const PAN_MAX = 1;
export const PITCH_SHIFT_MIN = -12;
export const PITCH_SHIFT_MAX = 12;

export type TrackSelector = string | number;

export type MixOp =
  | { op: 'set_track_volume'; track: TrackSelector; value: number }
  | { op: 'adjust_track_volume_db'; track: TrackSelector; db: number }
  | { op: 'set_track_pan'; track: TrackSelector; value: number }
  | { op: 'set_track_mute'; track: TrackSelector; value: boolean }
  | { op: 'set_track_solo'; track: TrackSelector; value: boolean }
  | { op: 'set_track_color'; track: TrackSelector; color: ColorName }
  | { op: 'add_effect'; track: TrackSelector; slug: string; params?: Record<string, unknown> }
  | { op: 'remove_effect'; track: TrackSelector; slug: string }
  | { op: 'set_effect_bypass'; track: TrackSelector; slug: string; value: boolean }
  | { op: 'set_effect_params'; track: TrackSelector; slug: string; params: Record<string, unknown> }
  | { op: 'set_aux_send'; track: TrackSelector; auxId: string; level: number }
  | { op: 'set_track_fx_mix'; track: TrackSelector; value: number }
  | { op: 'move_region'; track: TrackSelector; region: string; startPosition: number }
  | { op: 'set_region_pitch'; track: TrackSelector; region: string; semitones: number }
  | { op: 'set_region_playback_rate'; track: TrackSelector; region: string; rate: number }
  | { op: 'set_region_gain'; track: TrackSelector; region: string; gain: number }
  | { op: 'set_region_fade'; track: TrackSelector; region: string; fadeIn?: number; fadeOut?: number }
  | { op: 'remove_region'; track: TrackSelector; region: string }
  | { op: 'set_master_volume'; value: number }
  | { op: 'set_mastering_preset'; preset: string }
  | { op: 'set_bpm'; bpm: number }
  | { op: 'set_key'; key: string }
  | { op: 'set_description'; text: string }
  | {
      op: 'automate_volume';
      track: TrackSelector;
      /** Timed in seconds; converted to BandLab's beat positions using the revision tempo. */
      points: Array<{ atSeconds: number; value: number }>;
    };

export interface Change {
  op: MixOp['op'];
  target: string;
  field: string;
  before: unknown;
  after: unknown;
}

export class MixEditError extends Error {}

export interface ApplyResult {
  revision: Revision;
  changes: Change[];
}

/** Applies every operation in order, returning a new revision and a change log. */
export function applyMixOps(revision: Revision, ops: readonly MixOp[]): ApplyResult {
  const next = structuredClone(revision) as Revision;
  const changes: Change[] = [];
  for (const op of ops) changes.push(...applyOne(next, op));
  return { revision: next, changes };
}

function applyOne(revision: Revision, op: MixOp): Change[] {
  switch (op.op) {
    case 'set_track_volume': {
      const track = resolveTrack(revision, op.track);
      return [set(op, track, 'volume', clamp(op.value, VOLUME_MIN, VOLUME_MAX, 'volume'))];
    }
    case 'adjust_track_volume_db': {
      const track = resolveTrack(revision, op.track);
      const current = typeof track.volume === 'number' ? track.volume : 1;
      const scaled = current * 10 ** (op.db / 20);
      return [set(op, track, 'volume', clamp(round(scaled), VOLUME_MIN, VOLUME_MAX, 'volume'))];
    }
    case 'set_track_pan': {
      const track = resolveTrack(revision, op.track);
      return [set(op, track, 'pan', clamp(op.value, PAN_MIN, PAN_MAX, 'pan'))];
    }
    case 'set_track_mute':
      return [set(op, resolveTrack(revision, op.track), 'isMuted', op.value)];
    case 'set_track_solo':
      return [set(op, resolveTrack(revision, op.track), 'isSolo', op.value)];
    case 'set_track_color':
      return [set(op, resolveTrack(revision, op.track), 'colorName', op.color)];

    case 'add_effect': {
      const track = resolveTrack(revision, op.track);
      const effects = (track.effects ??= []);
      if (effects.some((effect) => effect.slug === op.slug)) {
        throw new MixEditError(
          `Track "${trackLabel(track)}" already has effect "${op.slug}". Use set_effect_params to change it.`,
        );
      }
      // Live effects always carry an `automation` map, empty when unautomated.
      const added: Effect = { slug: op.slug, bypass: false, params: op.params ?? {}, automation: {} };
      effects.push(added);
      return [change(op, trackLabel(track), `effects[${op.slug}]`, null, added)];
    }
    case 'remove_effect': {
      const track = resolveTrack(revision, op.track);
      const effects = track.effects ?? [];
      const index = effects.findIndex((effect) => effect.slug === op.slug);
      if (index === -1) throw new MixEditError(missingEffect(track, op.slug));
      const [removed] = effects.splice(index, 1);
      return [change(op, trackLabel(track), `effects[${op.slug}]`, removed, null)];
    }
    case 'set_effect_bypass': {
      const track = resolveTrack(revision, op.track);
      const effect = resolveEffect(track, op.slug);
      const before = effect.bypass;
      effect.bypass = op.value;
      return [change(op, trackLabel(track), `effects[${op.slug}].bypass`, before, op.value)];
    }
    case 'set_effect_params': {
      const track = resolveTrack(revision, op.track);
      const effect = resolveEffect(track, op.slug);
      const before = { ...(effect.params ?? {}) };
      effect.params = { ...before, ...op.params };
      return [change(op, trackLabel(track), `effects[${op.slug}].params`, before, effect.params)];
    }
    case 'set_aux_send': {
      const track = resolveTrack(revision, op.track);
      const sends = (track.auxSends ??= []);
      const existing = sends.find((send) => send.id === op.auxId);
      const before = existing?.sendLevel ?? null;
      if (existing) existing.sendLevel = op.level;
      else sends.push({ id: op.auxId, sendLevel: op.level, automation: [] });
      return [change(op, trackLabel(track), `auxSends[${op.auxId}].sendLevel`, before, op.level)];
    }
    case 'set_track_fx_mix': {
      const track = resolveTrack(revision, op.track);
      return [set(op, track, 'fxMix', clamp(op.value, 0, 1, 'fxMix'))];
    }

    case 'move_region': {
      const { track, region } = resolveRegion(revision, op.track, op.region);
      const before = region.startPosition;
      const span =
        typeof region.endPosition === 'number' && typeof before === 'number'
          ? region.endPosition - before
          : null;
      region.startPosition = op.startPosition;
      // Preserve length: BandLab stores an absolute end, not a duration.
      if (span !== null) region.endPosition = op.startPosition + span;
      const target = `${trackLabel(track)}/${regionLabel(region)}`;
      return [change(op, target, 'startPosition', before, op.startPosition)];
    }
    case 'set_region_pitch': {
      const { track, region } = resolveRegion(revision, op.track, op.region);
      const before = region.pitchShift;
      region.pitchShift = clamp(op.semitones, PITCH_SHIFT_MIN, PITCH_SHIFT_MAX, 'pitchShift');
      const target = `${trackLabel(track)}/${regionLabel(region)}`;
      return [change(op, target, 'pitchShift', before, region.pitchShift)];
    }
    case 'set_region_playback_rate': {
      const { track, region } = resolveRegion(revision, op.track, op.region);
      if (op.rate <= 0) throw new MixEditError('playbackRate must be greater than 0.');
      const before = region.playbackRate;
      region.playbackRate = op.rate;
      const target = `${trackLabel(track)}/${regionLabel(region)}`;
      return [change(op, target, 'playbackRate', before, op.rate)];
    }
    case 'set_region_gain': {
      const { track, region } = resolveRegion(revision, op.track, op.region);
      const before = region.gain;
      region.gain = clamp(op.gain, VOLUME_MIN, VOLUME_MAX, 'gain');
      const target = `${trackLabel(track)}/${regionLabel(region)}`;
      return [change(op, target, 'gain', before, region.gain)];
    }
    case 'set_region_fade': {
      const { track, region } = resolveRegion(revision, op.track, op.region);
      const target = `${trackLabel(track)}/${regionLabel(region)}`;
      const changes: Change[] = [];
      if (op.fadeIn !== undefined) {
        const before = region.fadeIn;
        region.fadeIn = clampPositive(op.fadeIn, 'fadeIn');
        changes.push(change(op, target, 'fadeIn', before, region.fadeIn));
      }
      if (op.fadeOut !== undefined) {
        const before = region.fadeOut;
        region.fadeOut = clampPositive(op.fadeOut, 'fadeOut');
        changes.push(change(op, target, 'fadeOut', before, region.fadeOut));
      }
      if (changes.length === 0) {
        throw new MixEditError('set_region_fade needs at least one of fadeIn or fadeOut.');
      }
      return changes;
    }
    case 'remove_region': {
      const track = resolveTrack(revision, op.track);
      const regions = track.regions ?? [];
      const index = regions.findIndex((region) => matchesRegion(region, op.region));
      if (index === -1) {
        throw new MixEditError(`No region matching "${op.region}" on track "${trackLabel(track)}".`);
      }
      const [removed] = regions.splice(index, 1);
      return [change(op, trackLabel(track), `regions[${op.region}]`, removed, null)];
    }

    case 'set_master_volume': {
      const before = revision.volume;
      revision.volume = clamp(op.value, VOLUME_MIN, VOLUME_MAX, 'volume');
      return [change(op, 'revision', 'volume', before, revision.volume)];
    }
    case 'set_mastering_preset': {
      const mastering = (revision.mastering ??= {});
      const before = mastering.preset;
      mastering.preset = op.preset;
      return [change(op, 'revision', 'mastering.preset', before, op.preset)];
    }
    case 'set_bpm': {
      if (!Number.isFinite(op.bpm) || op.bpm <= 0) {
        throw new MixEditError('bpm must be a positive number.');
      }
      const metronome = (revision.metronome ??= {});
      const before = metronome.bpm;
      metronome.bpm = op.bpm;
      return [change(op, 'revision', 'metronome.bpm', before, op.bpm)];
    }
    case 'set_key': {
      const before = revision.key;
      revision.key = op.key;
      return [change(op, 'revision', 'key', before, op.key)];
    }
    case 'set_description': {
      const before = revision.description;
      revision.description = op.text;
      return [change(op, 'revision', 'description', before, op.text)];
    }
    case 'automate_volume': {
      const track = resolveTrack(revision, op.track);
      const bpm = revision.metronome?.bpm;
      if (!bpm) {
        throw new MixEditError(
          'Cannot place automation: this revision has no metronome.bpm to convert seconds into beats.',
        );
      }
      // BandLab stores automation positions in beats, but people describe moments
      // in seconds ("the drop at 1:12"), so the op takes seconds and converts.
      const points = op.points
        .map((point) => {
          if (!Number.isFinite(point.atSeconds) || point.atSeconds < 0) {
            throw new MixEditError('automation atSeconds must be zero or greater.');
          }
          return {
            position: round((point.atSeconds * bpm) / 60),
            value: clamp(point.value, VOLUME_MIN, VOLUME_MAX, 'automation value'),
          };
        })
        .sort((a, b) => a.position - b.position);

      const automation = (track.automation ??= {});
      const before = automation.volume;
      automation.volume = points;
      return [change(op, trackLabel(track), 'automation.volume', before, points)];
    }
  }
}

/** Resolves a track by id, by name (case-insensitive), or by 1-based position. */
export function resolveTrack(revision: Revision, selector: TrackSelector): Track {
  const tracks = revision.tracks ?? [];
  if (tracks.length === 0) throw new MixEditError('This revision has no tracks.');

  if (typeof selector === 'number') {
    const track = tracks[selector - 1];
    if (!track) {
      throw new MixEditError(
        `Track #${selector} is out of range (this revision has ${tracks.length}).`,
      );
    }
    return track;
  }

  const wanted = selector.trim().toLowerCase();
  const byId = tracks.find((track) => track.id?.toLowerCase() === wanted);
  if (byId) return byId;

  const named = tracks.filter((track) => track.name?.toLowerCase() === wanted);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new MixEditError(ambiguous(selector, named));

  const partial = tracks.filter((track) => track.name?.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new MixEditError(ambiguous(selector, partial));

  const listing = tracks.map((track, index) => `#${index + 1} ${trackLabel(track)}`).join(', ');
  throw new MixEditError(`No track matches "${selector}". Available: ${listing}`);
}

function resolveEffect(track: Track, slug: string): Effect {
  const effect = (track.effects ?? []).find((candidate) => candidate.slug === slug);
  if (!effect) throw new MixEditError(missingEffect(track, slug));
  return effect;
}

function resolveRegion(
  revision: Revision,
  trackSelector: TrackSelector,
  regionSelector: string,
): { track: Track; region: Region } {
  const track = resolveTrack(revision, trackSelector);
  const region = (track.regions ?? []).find((candidate) =>
    matchesRegion(candidate, regionSelector),
  );
  if (!region) {
    throw new MixEditError(
      `No region matching "${regionSelector}" on track "${trackLabel(track)}".`,
    );
  }
  return { track, region };
}

function matchesRegion(region: Region, selector: string): boolean {
  const wanted = selector.trim().toLowerCase();
  return region.id?.toLowerCase() === wanted || region.name?.toLowerCase() === wanted;
}

export function trackLabel(track: Track): string {
  return track.name ?? track.preset ?? track.type ?? track.id ?? 'untitled track';
}

function regionLabel(region: Region): string {
  return region.name ?? region.id ?? 'region';
}

function ambiguous(selector: TrackSelector, matches: readonly Track[]): string {
  const names = matches.map(trackLabel).join(', ');
  return `"${selector}" matches ${matches.length} tracks (${names}). Use the track id or its number.`;
}

function missingEffect(track: Track, slug: string): string {
  const present = (track.effects ?? []).map((effect) => effect.slug).filter(Boolean);
  const suffix = present.length > 0 ? ` Present: ${present.join(', ')}.` : ' It has no effects.';
  return `Track "${trackLabel(track)}" has no effect "${slug}".${suffix}`;
}

function set<K extends keyof Track>(op: MixOp, track: Track, field: K, value: Track[K]): Change {
  const before = track[field];
  track[field] = value;
  return change(op, trackLabel(track), String(field), before, value);
}

function change(op: MixOp, target: string, field: string, before: unknown, after: unknown): Change {
  return { op: op.op, target, field, before: before ?? null, after };
}

function clamp(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value)) throw new MixEditError(`${field} must be a finite number.`);
  return Math.min(max, Math.max(min, value));
}

function clampPositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new MixEditError(`${field} must be zero or greater.`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The inferred ranges this engine enforces, for disclosure to the caller. */
export function describeRanges(): Record<string, string> {
  return {
    volume: `${VOLUME_MIN}..${VOLUME_MAX} (linear gain, 1.0 = unity; inferred, not documented by BandLab)`,
    pan: `${PAN_MIN}..${PAN_MAX} (-1 hard left, +1 hard right; inferred)`,
    pitchShift: `${PITCH_SHIFT_MIN}..${PITCH_SHIFT_MAX} semitones (inferred)`,
    regionPositions:
      'startPosition/endPosition are in SECONDS (verified: a region ending at 123.76 renders a ' +
      '123.9 s song), despite the project also carrying a tempo',
    automationPositions:
      'automation lane positions are in BEATS, unlike regions — verified by writing 102.1 at ' +
      '87 BPM and measuring the change land at 70.4 s',
  };
}
