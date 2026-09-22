# bandlab-mcp

An MCP server that lets a model read and edit **your own** BandLab songs by prompt.

> "Vokali 2 dB kıs, davulu biraz sola al, reverb'ü bypass et" → concrete mix operations → a new BandLab revision.

---

## Read this first: there is no official BandLab API

BandLab publishes **no public API, no developer program, and no OpenAPI spec**. Everything here targets
the private JSON API that bandlab.com's own web app uses (`https://www.bandlab.com/api/v1.3`). That has
two consequences you should decide about before using this:

1. **It can break without notice.** Endpoints, field names and value ranges are undocumented and
   unversioned in practice. This server is written so that unknown fields survive a round-trip, but a
   breaking change on BandLab's side is a matter of when, not if.

2. **It conflicts with BandLab's Terms of Use.** §4.2.7 prohibits using "automated means, bots, …
   automated scripts, or the like" to "register Accounts, log in, add followers …, follow or unfollow
   other Users, send messages, post comments, or otherwise to act on your behalf", and to send "more
   requests … than a human can reasonably produce in the same period of time". Automating your own
   account on your own songs still falls under "act on your behalf". The realistic risk is account
   suspension. That is your call to make, not this README's.

This server is built to sit as close to the defensible side of that line as it can:

- **No social automation.** There is no follow, unfollow, comment, message, or like tool. Those are the
  behaviours the Terms name explicitly, and none of them are needed to edit a mix.
- **Human-pace requests.** Every call is serialized and spaced by `BANDLAB_MIN_INTERVAL_MS` (default
  1200 ms). There are no bursts and no parallel fan-out.
- **Writes are off by default.** `BANDLAB_ALLOW_WRITES` must be explicitly `true`, and even then every
  edit is a dry run unless the caller passes `dryRun: false`.
- **Edits are non-destructive.** BandLab is version-based: saving creates a *new* revision and the
  parent is preserved. Nothing this server does overwrites existing audio.

### How a save becomes audible

BandLab renders mixdowns **server-side**. The web app watches a revision for
`mixdown.status !== 'Ready'` and waits to be told the render finished.

That makes one field decisive: a new revision must **not** carry its parent's `mixdown`. Copy a
finished one over and the server concludes the audio is already current, never queues a render, and
the edit stays inaudible to anyone streaming the post — the project changes, the sound does not.
`prepareNewRevision()` therefore drops `mixdown` along with the other server-owned fields.

Verified end to end on a real song: POST returned a fresh mixdown id with `status: "Empty"`, which
went `Ready` about 18 seconds later, and measuring the new file against the old one showed the EQ
curve exactly as requested — 120/200 Hz down 1.7 dB relative to 800 Hz, 1.6–6.4 kHz up 0.7–1.1 dB.

---

## How it works

BandLab stores a song as a chain of **revisions**. A revision is the full project tree:

```
revision
├── volume (master), key, description, saveType
├── metronome { bpm, signature }
├── mastering { preset }
├── auxChannels[] { id, preset, returnLevel, effects[] }
└── tracks[]
    ├── name, type, volume, pan, fxMix, isMuted, isSolo, colorName
    ├── effects[]     { slug, bypass, params, automation }
    ├── effectsData   { displayName, originalPresetId }   // preset metadata, not the chain
    ├── auxSends[]    { id, sendLevel }
    ├── automation    { volume[], pan[] }
    └── regions[]     { startPosition, endPosition, gain, fadeIn, fadeOut,
                        pitchShift, playbackRate, sampleId }
```

The edit loop is:

1. `bandlab_get_mix` fetches a revision and renders it as compact text, so the model reasons over levels
   and effects rather than a huge JSON blob.
2. The model turns the prompt into typed operations (`set_track_volume`, `add_effect`, `move_region`, …).
3. `bandlab_edit_mix` applies them **purely** — the fetched revision is cloned, never mutated — and
   returns a before/after diff.
4. Only on a second call with `dryRun: false` is a new revision POSTed.

---

## Setup

```bash
npm install
npm run build
```

### Credentials

Three modes. The first two reuse a session **you** created by logging in yourself, which keeps the
server out of §4.2.7's "automated login".

**Mode A — refresh token (recommended, self-renewing).**

1. Log in to bandlab.com in your browser.
2. DevTools → Application → Cookies → `https://www.bandlab.com` → copy the **`refreshToken`** value.
3. Put it in `BANDLAB_REFRESH_TOKEN`.

The server exchanges it at BandLab's identity server
(`https://accounts.bandlab.com/oauth/connect/token`, public client `bandlab_web`) for a 24-hour access
token, caches it in `~/.bandlab-mcp/session.json` (mode `0600`), and renews it automatically. You paste
this once.

Note that the v1.3 `POST /authorizations` route **rejects** these tokens — they are OAuth refresh
tokens and only the identity server accepts them. The server tries OAuth first and falls back to the
legacy route, so either kind of token works.

**Mode B — session bearer token (quick, expires in 24 h).**

DevTools → Network → any `api/v1.3` request → Request Headers → copy the whole
`Authorization: Bearer eyJ…` value into `BANDLAB_SESSION_KEY` (the `Bearer ` prefix is stripped for
you). There is nothing to renew it with, so when it expires the server tells you to paste a fresh one.

**Mode C — email and password.** The server calls `POST /authorizations` itself. The password is never
written to disk, but programmatic login is precisely what §4.2.7 names, so prefer A or B.

```bash
cp .env.example .env   # then fill in whichever mode you chose
```

### Verify against your real account

```bash
npm run verify:live
```

Read-only. It checks every assumption this codebase makes — the shape of `tracks[]`, the real ranges of
`volume` and `pan`, which effect slugs your projects use — and prints which ones do not hold.

### Register with Claude Code

```bash
claude mcp add bandlab --scope user -- node /absolute/path/to/bandlab-mcp/dist/index.js
```

No `--env` flags are needed: the server loads `.env` from its own package directory, resolved against
the module rather than the working directory, because an MCP client spawns it from wherever it likes.
Variables already present in the environment take precedence, so `claude mcp add --env KEY=value` still
overrides the file when you want it to.

`--scope user` makes it available in every project. Use `--scope project` instead to commit a
`.mcp.json` for a team — but then keep credentials in the environment, not in that file.

Verify with `claude mcp list`; the entry should report `✔ Connected`. Newly added servers are picked up
when Claude Code next starts, so restart it before expecting the `bandlab_*` tools to appear.

---

## Tools

| Tool | Purpose |
|------|---------|
| `bandlab_whoami` | Confirm the session and get your user id |
| `bandlab_list_songs` | Your songs |
| `bandlab_list_revisions` | A song's revision history (its undo stack) |
| `bandlab_get_mix` | Render one revision: tracks, levels, pan, effects, regions |
| `bandlab_edit_mix` | Apply mix operations — dry run by default |
| `bandlab_list_effects` | The harvested effect catalogue: slugs, parameters, observed ranges |
| `bandlab_capabilities` | API base, write state, pacing, inferred value ranges |
| `bandlab_raw_request` | Escape hatch for endpoints not yet wrapped |

### Mix operations

| Group | Operations |
|-------|-----------|
| Levels | `set_track_volume`, `adjust_track_volume_db`, `set_track_pan`, `set_master_volume` |
| Routing | `set_track_mute`, `set_track_solo`, `set_aux_send`, `set_track_fx_mix` |
| Effects | `add_effect`, `remove_effect`, `set_effect_bypass`, `set_effect_params` |
| Arrangement | `move_region`, `remove_region`, `set_region_pitch`, `set_region_playback_rate`, `set_region_gain`, `set_region_fade` |
| Project | `set_bpm`, `set_key`, `set_mastering_preset`, `set_description`, `set_track_color` |

Tracks are addressable by id, by name (case-insensitive, partial allowed), or by 1-based number.
An ambiguous name is refused with the list of matches rather than guessed at.

### Effect slugs

BandLab assembles its effect list inside a WASM audio engine at runtime, so there is no endpoint to
ask and the UI names do not map onto slugs (`pedalThreeBandEq2` is `threeBandEq`,
`pedalMultibandCompressor` is `multibandComp2`). `scripts/harvest-effects.mjs` therefore reads real
published projects and the community preset library and records only what it actually saw:

```bash
node --env-file-if-exists=.env scripts/harvest-effects.mjs 50
```

That writes [docs/effects-catalogue.json](docs/effects-catalogue.json), which `bandlab_list_effects`
serves and `bandlab_edit_mix` validates against — an unlisted slug is refused rather than written,
because BandLab accepts any JSON and a bad slug lands in the project silently instead of erroring.
Pass `allowUnverifiedEffects: true` to override.

---

## What is verified, and what is not

Verified live against `www.bandlab.com/api/v1.3` with a real authenticated session:

- the API version is reachable and current (`/genres` returns real data; v1.5/v1.7/v1.9 are 404)
- `POST /authorizations` accepts `provider: "Password"` and `provider: "Token"` (refresh)
- auth is OpenID Connect from `https://accounts.bandlab.com/oauth` — session JWTs last 24 h
- public reads work unauthenticated; `/revisions/{id}` and `/search/*` require a bearer token
- **`tracks[]` is a real DAW tree**: `volume`, `pan`, `isMuted`, `isSolo`, `name`, `effects[]`,
  `regions[]`, `auxSends[]`, `automation`. The community spec types it as `AudioSample[]`; that is wrong.
- `effects[]` is the signal chain; `effectsData` is only preset provenance (see
  [docs/effects-reference.md](docs/effects-reference.md))
- real effect slugs and param schemas: `compressor`, `expGate`, `deEsser`, `threeBandEq`, `bossGE7`,
  `simpleStudioReverb`, `reverbHybrid`
- `canEdit` correctly reports `false` on revisions you do not own, and the server refuses those writes

Two corrections the live data forced:

- **`auxSends[].sendLevel` is lowercase.** The spec says `SendLevel`; writing that adds a dead field.
- Live revisions carry `volume` (master), `saveType`, `trackGroups`, `samplerKits`, `fxMix`, and region
  `gain`/`fadeIn`/`fadeOut` — none of which appear in the spec. All are modelled now.

**`POST /revisions` is verified.** A full round-trip was run against a real owned song: fetch revision
→ mute a track, −2 dB on another, aux send 0.25, add a `compressor` → POST → read back. Every change
persisted, `isPublic: false` was honoured, and the parent revision was left untouched. The payload that
`prepareNewRevision()` builds — the whole revision minus `id`, `postId`, `createdOn`, `modifiedOn`,
`counters` and `stamp`, with `parentId` pointing at the parent — is accepted as-is.

**Still unverified:**

- the top of the `volume` range: `1.995` was observed, consistent with a `0..2` scale, but unconfirmed.
- audio *upload*: no sample-upload endpoint appears among the 123 known endpoints, so adding new audio
  is out of scope until that path is found. Editing existing audio is unaffected.

`bandlab_capabilities` reports the inferred ranges at runtime so they can be checked rather than trusted.

---

## Development

```bash
npm run typecheck
npm test          # 24 unit tests over the pure edit engine
npm run verify    # build + test
```

The edit engine (`src/mix.ts`) is pure and has no network dependency, which is why it is the part under
test. The HTTP and auth layers are thin by design.

## License

MIT.
