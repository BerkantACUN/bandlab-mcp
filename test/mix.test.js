import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyMixOps, MixEditError, resolveTrack, VOLUME_MAX } from '../dist/mix.js';
import { assertKnownEffects, prepareNewRevision } from '../dist/server.js';
import { findEffect, loadCatalogue } from '../dist/catalogue.js';

/** A small but realistic two-track project. */
function fixture() {
  return {
    id: 'rev-1',
    postId: 'post-1',
    createdOn: '2026-01-01T00:00:00Z',
    counters: { plays: 5 },
    mixdown: { id: 'mix-1', status: 'Ready' },
    key: 'C',
    metronome: { bpm: 120, signature: { notesCount: 4, noteValue: 4 } },
    tracks: [
      {
        id: 'track-vocal',
        name: 'Lead Vocal',
        volume: 0.8,
        pan: 0,
        isMuted: false,
        effects: [{ slug: 'reverb', bypass: false, params: { mix: 0.2 } }],
        regions: [{ id: 'r1', name: 'verse', startPosition: 0, endPosition: 16 }],
      },
      {
        id: 'track-drums',
        name: 'Drums',
        volume: 1,
        pan: -0.2,
        isMuted: false,
        effects: [],
        regions: [],
      },
    ],
  };
}

describe('applyMixOps', () => {
  it('leaves the input revision untouched', () => {
    const original = fixture();
    const snapshot = structuredClone(original);

    applyMixOps(original, [{ op: 'set_track_volume', track: 'Lead Vocal', value: 0.1 }]);

    assert.deepEqual(original, snapshot);
  });

  it('sets a track volume and records the before/after values', () => {
    const { revision, changes } = applyMixOps(fixture(), [
      { op: 'set_track_volume', track: 'Lead Vocal', value: 0.5 },
    ]);

    assert.equal(revision.tracks[0].volume, 0.5);
    assert.deepEqual(changes, [
      { op: 'set_track_volume', target: 'Lead Vocal', field: 'volume', before: 0.8, after: 0.5 },
    ]);
  });

  it('clamps volume to the maximum instead of throwing', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_track_volume', track: 'Drums', value: 99 },
    ]);

    assert.equal(revision.tracks[1].volume, VOLUME_MAX);
  });

  it('converts a decibel adjustment into a linear gain', () => {
    // +6 dB doubles linear gain: 0.8 * 10^(6/20) ~= 1.596
    const { revision } = applyMixOps(fixture(), [
      { op: 'adjust_track_volume_db', track: 'Lead Vocal', db: 6 },
    ]);

    assert.ok(Math.abs(revision.tracks[0].volume - 1.596) < 0.005);
  });

  it('clamps pan to the stereo range', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_track_pan', track: 'Drums', value: -5 },
    ]);

    assert.equal(revision.tracks[1].pan, -1);
  });

  it('mutes a track selected by 1-based number', () => {
    const { revision } = applyMixOps(fixture(), [{ op: 'set_track_mute', track: 2, value: true }]);

    assert.equal(revision.tracks[1].isMuted, true);
    assert.equal(revision.tracks[0].isMuted, false);
  });

  it('applies operations in order', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_track_volume', track: 'Drums', value: 0.5 },
      { op: 'adjust_track_volume_db', track: 'Drums', db: 6 },
    ]);

    assert.ok(Math.abs(revision.tracks[1].volume - 0.998) < 0.01);
  });

  it('adds an effect with the supplied params', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'add_effect', track: 'Drums', slug: 'compressor', params: { ratio: 4 } },
    ]);

    assert.deepEqual(revision.tracks[1].effects, [
      { slug: 'compressor', bypass: false, params: { ratio: 4 }, automation: {} },
    ]);
  });

  it('refuses to add an effect the track already has', () => {
    assert.throws(
      () => applyMixOps(fixture(), [{ op: 'add_effect', track: 'Lead Vocal', slug: 'reverb' }]),
      (error) => error instanceof MixEditError && /already has effect/.test(error.message),
    );
  });

  it('merges effect params rather than replacing them', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_effect_params', track: 'Lead Vocal', slug: 'reverb', params: { decay: 2 } },
    ]);

    assert.deepEqual(revision.tracks[0].effects[0].params, { mix: 0.2, decay: 2 });
  });

  it('names the available effects when one is missing', () => {
    assert.throws(
      () =>
        applyMixOps(fixture(), [
          { op: 'set_effect_bypass', track: 'Lead Vocal', slug: 'delay', value: true },
        ]),
      (error) => /Present: reverb/.test(error.message),
    );
  });

  it('preserves region length when moving it', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'move_region', track: 'Lead Vocal', region: 'verse', startPosition: 32 },
    ]);

    const region = revision.tracks[0].regions[0];
    assert.equal(region.startPosition, 32);
    assert.equal(region.endPosition, 48);
  });

  it('clamps pitch shift to one octave', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_region_pitch', track: 'Lead Vocal', region: 'verse', semitones: 50 },
    ]);

    assert.equal(revision.tracks[0].regions[0].pitchShift, 12);
  });

  it('rejects a non-positive playback rate', () => {
    assert.throws(
      () =>
        applyMixOps(fixture(), [
          { op: 'set_region_playback_rate', track: 'Lead Vocal', region: 'verse', rate: 0 },
        ]),
      MixEditError,
    );
  });

  it('updates tempo and key on the revision itself', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_bpm', bpm: 90 },
      { op: 'set_key', key: 'Am' },
    ]);

    assert.equal(revision.metronome.bpm, 90);
    assert.equal(revision.key, 'Am');
  });

  it('rejects a non-positive bpm', () => {
    assert.throws(() => applyMixOps(fixture(), [{ op: 'set_bpm', bpm: 0 }]), MixEditError);
  });
});

describe('resolveTrack', () => {
  it('matches by id, exact name, partial name and position', () => {
    const revision = fixture();

    assert.equal(resolveTrack(revision, 'track-drums').name, 'Drums');
    assert.equal(resolveTrack(revision, 'Lead Vocal').id, 'track-vocal');
    assert.equal(resolveTrack(revision, 'vocal').id, 'track-vocal');
    assert.equal(resolveTrack(revision, 1).id, 'track-vocal');
  });

  it('is case-insensitive on names', () => {
    assert.equal(resolveTrack(fixture(), 'DRUMS').id, 'track-drums');
  });

  it('lists the available tracks when nothing matches', () => {
    assert.throws(
      () => resolveTrack(fixture(), 'bass'),
      (error) => /Available: #1 Lead Vocal, #2 Drums/.test(error.message),
    );
  });

  it('refuses an ambiguous partial name', () => {
    const revision = fixture();
    revision.tracks.push({ id: 'track-vocal-2', name: 'Backing Vocal' });

    assert.throws(
      () => resolveTrack(revision, 'vocal'),
      (error) => /matches 2 tracks/.test(error.message),
    );
  });

  it('reports an out-of-range track number', () => {
    assert.throws(
      () => resolveTrack(fixture(), 9),
      (error) => /out of range \(this revision has 2\)/.test(error.message),
    );
  });

  it('rejects editing a revision with no tracks', () => {
    assert.throws(() => resolveTrack({ tracks: [] }, 1), MixEditError);
  });
});

describe('prepareNewRevision', () => {
  it('drops server-owned fields and links to the parent', () => {
    const parent = fixture();
    const { revision: edited } = applyMixOps(parent, [
      { op: 'set_track_volume', track: 'Drums', value: 0.4 },
    ]);

    const payload = prepareNewRevision(edited, parent, 'louder drums');

    assert.equal(payload.id, undefined);
    assert.equal(payload.postId, undefined);
    assert.equal(payload.createdOn, undefined);
    assert.equal(payload.counters, undefined);
    assert.equal(payload.parentId, 'rev-1');
    // Dropped on purpose: a carried-over Ready mixdown suppresses the re-render.
    assert.equal(payload.mixdown, undefined);
    assert.equal(payload.description, 'louder drums');
    assert.equal(payload.tracks[1].volume, 0.4);
  });

  it('forces visibility when isPublic is supplied', () => {
    const parent = { ...fixture(), isPublic: true };
    const payload = prepareNewRevision(structuredClone(parent), parent, undefined, false);

    assert.equal(payload.isPublic, false);
  });

  it('inherits parent visibility when isPublic is omitted', () => {
    const parent = { ...fixture(), isPublic: true };
    const payload = prepareNewRevision(structuredClone(parent), parent);

    assert.equal(payload.isPublic, true);
  });

  it('leaves the description alone when none is supplied', () => {
    const parent = { ...fixture(), description: 'original note' };
    const payload = prepareNewRevision(structuredClone(parent), parent);

    assert.equal(payload.description, 'original note');
  });
});

describe('fields verified against the live API', () => {
  it('writes aux send level as lowercase sendLevel', () => {
    // The community OpenAPI spec says `SendLevel`; live responses use `sendLevel`.
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_aux_send', track: 'Drums', auxId: 'aux1', level: 0.4 },
    ]);

    assert.deepEqual(revision.tracks[1].auxSends, [
      { id: 'aux1', sendLevel: 0.4, automation: [] },
    ]);
  });

  it('updates an existing aux send in place', () => {
    const base = fixture();
    base.tracks[1].auxSends = [{ id: 'aux1', sendLevel: 0, automation: [] }];

    const { revision, changes } = applyMixOps(base, [
      { op: 'set_aux_send', track: 'Drums', auxId: 'aux1', level: 0.75 },
    ]);

    assert.equal(revision.tracks[1].auxSends.length, 1);
    assert.equal(revision.tracks[1].auxSends[0].sendLevel, 0.75);
    assert.equal(changes[0].before, 0);
  });

  it('sets the master volume on the revision', () => {
    const { revision } = applyMixOps(fixture(), [{ op: 'set_master_volume', value: 1.4 }]);

    assert.equal(revision.volume, 1.4);
  });

  it('clamps fxMix to 0..1', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_track_fx_mix', track: 'Drums', value: 5 },
    ]);

    assert.equal(revision.tracks[1].fxMix, 1);
  });

  it('sets region gain', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'set_region_gain', track: 'Lead Vocal', region: 'verse', gain: 0.6 },
    ]);

    assert.equal(revision.tracks[0].regions[0].gain, 0.6);
  });

  it('sets only the fade side that was supplied', () => {
    const { revision, changes } = applyMixOps(fixture(), [
      { op: 'set_region_fade', track: 'Lead Vocal', region: 'verse', fadeOut: 2 },
    ]);

    assert.equal(revision.tracks[0].regions[0].fadeOut, 2);
    assert.equal(revision.tracks[0].regions[0].fadeIn, undefined);
    assert.equal(changes.length, 1);
  });

  it('rejects a fade op with neither side supplied', () => {
    assert.throws(
      () => applyMixOps(fixture(), [{ op: 'set_region_fade', track: 1, region: 'verse' }]),
      MixEditError,
    );
  });

  it('rejects a negative fade', () => {
    assert.throws(
      () =>
        applyMixOps(fixture(), [
          { op: 'set_region_fade', track: 1, region: 'verse', fadeIn: -1 },
        ]),
      MixEditError,
    );
  });

  it('gives a new effect an empty automation map, as live effects have', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'add_effect', track: 'Drums', slug: 'deEsser' },
    ]);

    assert.deepEqual(revision.tracks[1].effects[0].automation, {});
  });
});

describe('effect slug guard', () => {
  it('accepts a slug harvested from real projects', () => {
    assert.doesNotThrow(() =>
      assertKnownEffects([{ op: 'add_effect', track: 1, slug: 'compressor' }]),
    );
  });

  it('rejects an invented slug and names the verified ones', () => {
    assert.throws(
      () => assertKnownEffects([{ op: 'add_effect', track: 1, slug: 'superReverb9000' }]),
      (error) =>
        /Unknown effect slug\(s\): superReverb9000/.test(error.message) &&
        /Verified slugs:/.test(error.message),
    );
  });

  it('checks set_effect_params too', () => {
    assert.throws(
      () => assertKnownEffects([{ op: 'set_effect_params', track: 1, slug: 'nope', params: {} }]),
      MixEditError,
    );
  });

  it('ignores ops that carry no slug', () => {
    assert.doesNotThrow(() =>
      assertKnownEffects([{ op: 'set_track_volume', track: 1, value: 0.5 }]),
    );
  });

  it('matches slugs case-insensitively', () => {
    assert.ok(findEffect('COMPRESSOR'));
    assert.equal(findEffect('COMPRESSOR').slug, 'compressor');
  });
});

describe('effect catalogue', () => {
  it('was harvested and contains the guitar tools', () => {
    const catalogue = loadCatalogue();

    assert.ok(catalogue.effects.length > 20, 'expected a populated catalogue');
    for (const slug of ['guitarAmp', 'tubeScreamer', 'overdrive', 'tapeSimulator']) {
      assert.ok(findEffect(slug), `expected ${slug} in the catalogue`);
    }
  });

  it('records parameter names for each effect', () => {
    const compressor = findEffect('compressor');
    const params = Object.keys(compressor.params);

    // Asserted as a superset: harvesting more projects legitimately discovers
    // optional params (makeupGain turned up only in community presets).
    for (const name of ['attack', 'knee', 'ratio', 'release', 'threshold']) {
      assert.ok(params.includes(name), `expected compressor param ${name}`);
    }
  });

  it('captures enum-valued params as examples', () => {
    const cab = findEffect('guitarCab');

    assert.ok(cab.params.cabModel.examples.length > 0);
    assert.equal(cab.params.cabModel.kind, 'string');
  });
});

describe('automate_volume', () => {
  it('converts seconds into beat positions using the revision tempo', () => {
    // 120 BPM => 2 beats per second.
    const { revision } = applyMixOps(fixture(), [
      {
        op: 'automate_volume',
        track: 1,
        points: [
          { atSeconds: 0, value: 1 },
          { atSeconds: 10, value: 0 },
        ],
      },
    ]);

    assert.deepEqual(revision.tracks[0].automation.volume, [
      { position: 0, value: 1 },
      { position: 20, value: 0 },
    ]);
  });

  it('sorts points by time regardless of input order', () => {
    const { revision } = applyMixOps(fixture(), [
      {
        op: 'automate_volume',
        track: 1,
        points: [
          { atSeconds: 8, value: 1 },
          { atSeconds: 2, value: 0 },
        ],
      },
    ]);

    const lane = revision.tracks[0].automation.volume;
    assert.ok(lane[0].position < lane[1].position);
  });

  it('clamps automation values to the volume range', () => {
    const { revision } = applyMixOps(fixture(), [
      { op: 'automate_volume', track: 1, points: [{ atSeconds: 1, value: 99 }] },
    ]);

    assert.equal(revision.tracks[0].automation.volume[0].value, VOLUME_MAX);
  });

  it('clears the lane when given no points', () => {
    const base = fixture();
    base.tracks[0].automation = { volume: [{ position: 4, value: 0.5 }] };

    const { revision } = applyMixOps(base, [
      { op: 'automate_volume', track: 1, points: [] },
    ]);

    assert.deepEqual(revision.tracks[0].automation.volume, []);
  });

  it('rejects a negative time', () => {
    assert.throws(
      () =>
        applyMixOps(fixture(), [
          { op: 'automate_volume', track: 1, points: [{ atSeconds: -1, value: 1 }] },
        ]),
      MixEditError,
    );
  });

  it('refuses when the revision has no tempo to convert against', () => {
    const base = fixture();
    delete base.metronome;

    assert.throws(
      () =>
        applyMixOps(base, [
          { op: 'automate_volume', track: 1, points: [{ atSeconds: 1, value: 1 }] },
        ]),
      (error) => /no metronome.bpm/.test(error.message),
    );
  });
});
