# BandLab effects reference

Every value here was read from live revisions on `www.bandlab.com/api/v1.3`, not from documentation —
BandLab publishes none. Treat it as an observed sample, not a complete catalogue.

**The machine-readable version is [effects-catalogue.json](effects-catalogue.json)** — currently
54 slugs harvested from 50 projects and 50 community
presets. Regenerate it with `scripts/harvest-effects.mjs`. This page is the prose companion: it explains
the parts that a parameter dump cannot.

BandLab's UI exposes roughly 90 pedals, so anything absent from the catalogue simply has not been seen
yet, not proven nonexistent.

## Where effects actually live

A track has two effect-shaped fields, and only one of them is the chain:

```jsonc
{
  "effects": [ { "slug": "compressor", "bypass": false, "params": {...}, "automation": {} } ],
  "effectsData": { "displayName": "Studio Vocals", "link": "https://...", "originalPresetId": "aaa4..." }
}
```

- **`effects[]`** is the real signal chain, in order. This is what `add_effect`, `remove_effect`,
  `set_effect_bypass` and `set_effect_params` operate on.
- **`effectsData`** is preset provenance only — which preset the chain came from, for the UI. Writing
  effects here does nothing. It is `null` on tracks that never had a preset applied, and
  `{"displayName": "None", "originalPresetId": null}` on tracks that were reset.

`automation` on an effect maps a param name to a list of automation points. A freshly added effect
carries an empty object.

## Observed effects

### `compressor`

```json
{ "attack": 0.001, "knee": 6, "ratio": 4, "release": 0.068, "threshold": -25.3 }
```

`attack` and `release` are in seconds, `threshold` in dB, `knee` in dB, `ratio` is `n:1`.
Observed ratios ranged from 4 to 12.1.

### `expGate` — expander / noise gate

```json
{ "attack": 0.005, "release": 0.2, "threshold": -19.9 }
```

### `deEsser`

```json
{ "frequency": 13973, "threshold": -20 }
```

`frequency` in Hz — the sibilance band being tamed.

### `threeBandEq`

```json
{ "lowGain": 0, "midGain": 0, "highGain": 19.9, "midFreq": 2000 }
```

Gains in dB, `midFreq` in Hz (sweepable mid band).

### `bossGE7` — 7-band graphic EQ

```json
{
  "gainAt100Hz": -4.6, "gainAt200Hz": -1.9, "gainAt400Hz": 0.6, "gainAt800Hz": -6,
  "gainAt1600Hz": 6.7, "gainAt3200Hz": 2.1, "gainAt6400Hz": -2.2, "level": 0
}
```

All gains in dB. `level` is output trim. Band centres are fixed and encoded in the key names.

### `simpleStudioReverb`

```json
{ "color": 8.5, "mix": 4.7, "size": 2 }
```

Note `mix` here is **not** 0..1 — a value of 4.7 was observed, so this control is on its own scale.
Read the current value before changing it rather than assuming a normalized range.

### `reverbHybrid`

```json
{ "dampening": 7500, "dryWetMix": 0.31, "irType": "chamberShort", "roomSize": 2.1, "spread": 4.4 }
```

`dryWetMix` *is* 0..1 here. `irType` is an enum of impulse-response names; `chamberShort` is the only
one observed so far, so discover others by reading a project that uses them.

## Aux sends

Every inspected project had a single shared reverb bus:

```json
"auxChannels": [ { "id": "aux1", "preset": "sharedReverb", "returnLevel": 1, "effects": null } ]
```

Tracks reference it per-track:

```json
"auxSends": [ { "id": "aux1", "sendLevel": 0, "automation": [] } ]
```

**`sendLevel` is lowercase.** The community OpenAPI spec spells it `SendLevel`; that is wrong, and
writing the capitalised key adds a field BandLab ignores.

## Units: regions and automation disagree

This caught me out, so it is worth stating plainly:

| Field | Unit | How it was verified |
|---|---|---|
| `region.startPosition` / `endPosition` | **seconds** | a region ending at `123.76` renders a 123.9 s song; setting `295.51` on a 203.8 s file produced 295.6 s of audio with 92 s of silence |
| `automation.volume[].position` | **beats** | writing `102.1` at 87 BPM put the change at 70.4 s |

A project carries `metronome.bpm`, which makes the region numbers look like beats. They are not.

## Volume automation

```json
"automation": { "volume": [ {"position": 97.14, "value": 1}, {"position": 97.86, "value": 0} ] }
```

`position` is in **beats** — unlike region positions, which are in seconds. `value` is linear gain on the same 0..2 scale as the fader. Values of exactly
`0` appear in real projects, so a full mute is legitimate. `automate_volume` takes seconds and converts
using `metronome.bpm`, because people describe moments as "the drop at 1:12".

Two behaviours matter when cutting a hole in a mix, both found by measuring a render:

- **The lane sits before the track's effect chain.** Muting the fader stops new signal but a reverb or
  delay keeps ringing, so a hard `value: 0` decays over the tail rather than cutting instantly. With a
  long spring reverb the gap reached only −30 dB before decaying to −52 dB three seconds later.
- **`auxSends` bypass the fader entirely.** The shared reverb bus is fed pre-fader, so its return keeps
  sounding through an automated silence. Set the send to `0` as well when a gap must be clean.

## Observed value ranges

| Field | Observed | Enforced by `mix.ts` |
|---|---|---|
| `track.volume` | 0.248 … 1.995 | clamped 0 … 2 |
| `track.pan` | 0 (no panned tracks in the sample) | clamped −1 … 1 |
| `track.fxMix` | 1 | clamped 0 … 1 |
| `revision.volume` (master) | 1 … 1.459 | clamped 0 … 2 |
| `region.playbackRate` | 1 … 1.567 | must be > 0 |

The top of the volume range (1.995) sits just under 2.0, which is consistent with a 0..2 linear scale
where 2.0 is roughly +6 dB. It is still an inference, not a documented bound.

## Track types

`voice` (audio), `drum-machine`, `creators-kit` (sampler). A track's `type` decides which fields are
meaningful — `patterns` and `samplerKit` only appear on instrument tracks.

## Region fields

```jsonc
{
  "id": "...", "trackId": "...", "sampleId": "...", "name": "Release_90_SoftKeys_Bm_4bar",
  "startPosition": 0, "endPosition": 76.596,   // SECONDS, not beats
  "sampleOffset": 0, "loopLength": 0,
  "playbackRate": 1.567, "pitchShift": 0, "pitchTimeCorrection": true,
  "gain": 1, "fadeIn": 0, "fadeOut": 0
}
```

`gain`, `fadeIn`, `fadeOut` and `pitchTimeCorrection` are all absent from the community spec and were
found only by reading live data.

## Uploading audio

Not part of v1.3 at all — uploads live on `v2.0`, which is why they are absent from the 123-endpoint
map. Three steps, and the first one **fails with 401 unless the request identifies itself as the web
client**; a valid bearer token alone is refused:

```http
PUT /api/v2.0/uploads/samples/{sampleId}?format=wav
Authorization: Bearer <token>
x-client-id: BandLab-Web
x-client-version: 10.2.77
X-Amz-Meta-User-Id: <your user id>
```

That returns `{ "value": "<presigned S3 URL>" }`. Then `PUT` the raw bytes to that URL with a matching
`Content-Type`, and the sample exists. `GET /api/v2.0/uploads/{sampleId}` returns 404 until a revision
references the sample, so do not poll it as a completion check — post the revision instead.

`sampleId` is a client-generated UUID. The editor decodes every non-MIDI file to WAV before uploading,
so `scripts/upload-audio.mjs` does the same rather than sending an mp3.

### Creating a song around it

`POST /revisions` with `song: { name }` and no song id creates the song, the post and the track in one
call. The region must carry both `sampleId` and `trackId`, and `endPosition` is the audio length **in
seconds** — see the units table above. Verified end to end: a 203.8 s upload became a playable public
song, and the render matched the source at -14.7 LUFS and 7.5 LU.

## Effects that misbehave on a full stereo mix

Measured on a finished 3:24 master by bypassing one effect at a time and re-rendering. Treat these as
warnings, not verdicts — each was tested on one song.

| Effect | What it did | Evidence |
|---|---|---|
| `deEsser` | Acted as a broadband compressor, not a sibilance tool | bypassing it raised loudness ~5 dB and restored LRA from 5.8 to 8.1 LU. Use it on a vocal track only. |
| `stereoSpreader` | The only configuration seen in the wild (`lowerIntensity: 0.71`, `upperIntensity: 1`) **widened** the bass | side/mid energy below 200 Hz went from −12.7 to −11.6 dB; above 4 kHz unchanged |
| `cleanLimiter` | `threshold` behaves as drive, not ceiling | `threshold: -1` produced +1.2 dBTP (clipping). Raising `input` from −8.5 to −7 made the render 3.5 dB *quieter* — its parameters do not map onto the usual meanings |
| `visualEq` | A −2.5 dB peaking cut at 120 Hz barely moved the measured 120 Hz band | the hump stayed at +3.4 dB until `bossGE7`'s broad low cuts went back in |

`cleanLimiter`, `multibandComp2`, `visualEq` and `stereoSpreader` each appeared in only one or two
harvested projects, so their parameter semantics are thin. `bossGE7`, `tapeSimulator` and
`simpleStudioReverb` — seen dozens of times — behaved exactly as expected, and the best-measured master
used only those three.

## Splitter, Mastering and Harmonizer

Three first-party services, mapped from the web app and tested on a real song.

**Splitter** (`scripts/split-stems.mjs`) — free, works. `POST https://source-separation.bandlab.io/v4/separation`
(multipart: `file`, `stems=vocals,drums,bass,other`, `out_format=m4a`, `daily_limits_enabled=true`), poll
`GET /v1/separation/status` until `result === 1`, then `GET /v1/separation` returns a zip of stems. Status
and download take no job id: the service tracks one separation per user. Guitar and piano stems need a
membership; `429` means the daily limit. A 3:24 song separated in about 30 seconds.

**Mastering** — set `revision.mastering = { preset, intensity, bypass: false }` and re-render. Presets:
`cdMaster` (the UI's "Universal"), `tapeMaster`, `naturalMastering`, `punchMastering`, `enhanceClarity`,
`bassBoostMastering`, `spatialMastering`, `cinematicMastering`. It is baked into the mixdown, but on one
song it always pushed to roughly −12 LUFS and cut LRA from 7.0 to 4.5–5.0, and `intensity` 20 and 50
rendered identically — the API appears to ignore it. Since streaming normalises to −14 LUFS anyway,
that extra loudness buys nothing and the lost dynamics stay lost.

**Harmonizer** (`scripts/harmonize.mjs`) — the voice catalogue and presets are free to read, but a full
render (`POST https://harmonizer.bandlab.cloud/v1/task`) returns `402 Join membership to access this
feature.` on a free account.

### Upload race

Creating a revision immediately after uploading a batch of samples left its mixdown `Empty` for over
twelve minutes. Re-posting the identical project rendered in ten seconds. If a render stalls after an
upload, re-post rather than wait.
