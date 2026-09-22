/**
 * MCP tool surface for BandLab.
 *
 * Scope is deliberately narrow: reading your own catalogue and editing your own
 * mixes. Follow/unfollow, commenting, messaging and other social actions are
 * intentionally absent — those are the behaviours BandLab's Terms of Use single
 * out as prohibited automation, and none of them are needed to edit a song.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BandLabApiError, BandLabClient, WriteBlockedError } from './client.js';
import { summarizeChanges, summarizeRevision } from './format.js';
import { applyMixOps, describeRanges, MixEditError, type MixOp } from './mix.js';
import { describeCatalogue, findEffect, loadCatalogue } from './catalogue.js';
import type { Config } from './config.js';
import type { Revision, Song } from './types.js';

/** Cap on raw passthrough output, so one call cannot flood the caller's context. */
const MAX_RAW_CHARS = 6000;

/**
 * Fields the server owns; a new revision must not carry them over.
 *
 * `mixdown` belongs here for a non-obvious reason. BandLab renders mixdowns
 * server-side, and the web app watches for `status !== 'Ready'` to know a render
 * is pending. Copying the parent's finished mixdown onto a new revision tells
 * the server the audio is already current, so it never queues a render and the
 * edit stays inaudible to anyone streaming the post. Dropping it is what asks
 * for a fresh one.
 */
const SERVER_OWNED_FIELDS = [
  'id',
  'postId',
  'createdOn',
  'modifiedOn',
  'counters',
  'stamp',
  'mixdown',
] as const;

const trackSelector = z
  .union([z.string(), z.number().int().positive()])
  .describe('Track id, track name, or 1-based track number as shown by bandlab_get_mix');

const mixOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_track_volume'), track: trackSelector, value: z.number() }),
  z.object({ op: z.literal('adjust_track_volume_db'), track: trackSelector, db: z.number() }),
  z.object({ op: z.literal('set_track_pan'), track: trackSelector, value: z.number() }),
  z.object({ op: z.literal('set_track_mute'), track: trackSelector, value: z.boolean() }),
  z.object({ op: z.literal('set_track_solo'), track: trackSelector, value: z.boolean() }),
  z.object({
    op: z.literal('set_track_color'),
    track: trackSelector,
    color: z.enum(['Red', 'Blue', 'Violet', 'Pink', 'Green', 'Yellow']),
  }),
  z.object({
    op: z.literal('add_effect'),
    track: trackSelector,
    slug: z.string(),
    params: z.record(z.unknown()).optional(),
  }),
  z.object({ op: z.literal('remove_effect'), track: trackSelector, slug: z.string() }),
  z.object({
    op: z.literal('set_effect_bypass'),
    track: trackSelector,
    slug: z.string(),
    value: z.boolean(),
  }),
  z.object({
    op: z.literal('set_effect_params'),
    track: trackSelector,
    slug: z.string(),
    params: z.record(z.unknown()),
  }),
  z.object({
    op: z.literal('set_aux_send'),
    track: trackSelector,
    auxId: z.string().describe('Aux channel id, e.g. "aux1" (the shared reverb bus)'),
    level: z.number(),
  }),
  z.object({ op: z.literal('set_track_fx_mix'), track: trackSelector, value: z.number() }),
  z.object({
    op: z.literal('move_region'),
    track: trackSelector,
    region: z.string(),
    startPosition: z.number(),
  }),
  z.object({
    op: z.literal('set_region_pitch'),
    track: trackSelector,
    region: z.string(),
    semitones: z.number(),
  }),
  z.object({
    op: z.literal('set_region_playback_rate'),
    track: trackSelector,
    region: z.string(),
    rate: z.number(),
  }),
  z.object({
    op: z.literal('set_region_gain'),
    track: trackSelector,
    region: z.string(),
    gain: z.number(),
  }),
  z.object({
    op: z.literal('set_region_fade'),
    track: trackSelector,
    region: z.string(),
    fadeIn: z.number().optional(),
    fadeOut: z.number().optional(),
  }),
  z.object({ op: z.literal('remove_region'), track: trackSelector, region: z.string() }),
  z.object({ op: z.literal('set_master_volume'), value: z.number() }),
  z.object({ op: z.literal('set_mastering_preset'), preset: z.string() }),
  z.object({ op: z.literal('set_bpm'), bpm: z.number() }),
  z.object({ op: z.literal('set_key'), key: z.string() }),
  z.object({ op: z.literal('set_description'), text: z.string() }),
  z.object({
    op: z.literal('automate_volume'),
    track: trackSelector,
    points: z
      .array(
        z.object({
          atSeconds: z.number().describe('Time in seconds from the start of the song'),
          value: z.number().describe('Track volume at that moment, 0 = silence, 1 = unity'),
        }),
      )
      .describe(
        'Volume automation envelope. Positions are given in seconds and converted to BandLab ' +
          'beat positions using the revision tempo. Replaces any existing volume lane; pass an ' +
          'empty array to clear it.',
      ),
  }),
]);

export function buildServer(client: BandLabClient, config: Config): McpServer {
  const server = new McpServer({ name: 'bandlab-mcp', version: '0.1.0' });

  server.registerTool(
    'bandlab_whoami',
    {
      title: 'Who am I on BandLab',
      description:
        'Returns the authenticated BandLab profile (id, username, counters). Call this first to confirm the session works and to get the user id other tools need.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const me = await client.get<Record<string, unknown>>('/me');
        return text(JSON.stringify(me, null, 2));
      }),
  );

  server.registerTool(
    'bandlab_list_songs',
    {
      title: 'List my songs',
      description:
        'Lists songs belonging to the authenticated user. Use the returned song id with bandlab_list_revisions.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('How many songs to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      wrap(async () => {
        const me = await client.get<{ id?: string }>('/me');
        if (!me.id) throw new Error('Could not determine the current user id from /me.');
        const songs = await client.listAll<Song>(`/users/${me.id}/songs`, {}, limit);
        if (songs.length === 0) return text('No songs found on this account.');
        const lines = songs.map(
          (song) =>
            `${song.name ?? '(untitled)'}\n  id=${song.id}  ${song.isPublic ? 'public' : 'private'}` +
            (song.canEdit === false ? '  [read-only]' : ''),
        );
        return text(`${songs.length} song(s):\n\n${lines.join('\n')}`);
      }),
  );

  server.registerTool(
    'bandlab_list_revisions',
    {
      title: 'List revisions of a song',
      description:
        'Lists the revision history of a song, oldest first (verified against the live API). BandLab is version-based: every save is a revision, so this is the undo history.',
      inputSchema: {
        songId: z.string().describe('Song id from bandlab_list_songs'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ songId, limit }) =>
      wrap(async () => {
        const revisions = await client.listAll<Revision>(`/songs/${songId}/revisions`, {}, limit);
        if (revisions.length === 0) return text('No revisions found for that song.');
        const lines = revisions.map(
          (revision) =>
            `${revision.createdOn ?? '(no date)'}  id=${revision.id}` +
            (revision.description ? `\n  "${revision.description}"` : ''),
        );
        return text(`${revisions.length} revision(s), oldest first:\n\n${lines.join('\n')}`);
      }),
  );

  server.registerTool(
    'bandlab_get_mix',
    {
      title: 'Read a mix',
      description:
        'Fetches one revision and renders its tracks, levels, panning, effects and regions as compact text. This is what you read before proposing an edit.',
      inputSchema: {
        revisionId: z.string().describe('Revision id from bandlab_list_revisions'),
        raw: z.boolean().default(false).describe('Also return the full JSON (large)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ revisionId, raw }) =>
      wrap(async () => {
        const revision = await client.get<Revision>(`/revisions/${revisionId}`);
        const summary = summarizeRevision(revision);
        return text(raw ? `${summary}\n\n--- raw ---\n${JSON.stringify(revision, null, 2)}` : summary);
      }),
  );

  server.registerTool(
    'bandlab_edit_mix',
    {
      title: 'Edit a mix',
      description:
        'Applies mix operations to a revision. Defaults to a dry run that shows the diff without sending anything. ' +
        'With dryRun=false it saves a NEW revision (the original is never overwritten — BandLab keeps every version).',
      inputSchema: {
        revisionId: z.string().describe('Revision to edit, from bandlab_list_revisions'),
        ops: z.array(mixOpSchema).min(1).describe('Operations applied in order'),
        dryRun: z
          .boolean()
          .default(true)
          .describe('true previews the change; false saves a new revision'),
        description: z.string().optional().describe('Description to attach to the new revision'),
        allowUnverifiedEffects: z
          .boolean()
          .default(false)
          .describe(
            'Effect slugs are checked against the harvested catalogue and unknown ones are ' +
              'refused, because a slug BandLab does not recognise is written into the project ' +
              'silently. Set true only for a slug you have confirmed elsewhere.',
          ),
        isPublic: z
          .boolean()
          .optional()
          .describe(
            'Visibility of the new revision. Omitted, it inherits the parent — so editing a public ' +
              'song produces another public revision. Pass false to keep the edit unlisted.',
          ),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ revisionId, ops, dryRun, description, isPublic, allowUnverifiedEffects }) =>
      wrap(async () => {
        if (!allowUnverifiedEffects) assertKnownEffects(ops as MixOp[]);

        const current = await client.get<Revision>(`/revisions/${revisionId}`);
        const { revision: edited, changes } = applyMixOps(current, ops as MixOp[]);
        const diff = summarizeChanges(changes);

        if (dryRun) {
          const visibility =
            isPublic === undefined
              ? `inherited from parent (${current.isPublic ? 'public' : 'private'})`
              : isPublic
                ? 'public'
                : 'private';
          return text(
            `DRY RUN — nothing was sent to BandLab.\n\n` +
              `Changes (${changes.length}):\n${diff}\n\n` +
              `New revision visibility: ${visibility}\n\n` +
              `Resulting mix:\n${summarizeRevision(edited)}\n\n` +
              `Re-run with dryRun=false to save this as a new revision.`,
          );
        }

        if (current.canEdit === false) {
          throw new Error('BandLab reports canEdit=false for this revision; it cannot be modified.');
        }

        const payload = prepareNewRevision(edited, current, description, isPublic);
        const created = await client.post<Revision>('/revisions', payload);
        return text(
          `Saved a new revision.\n\n` +
            `New revision id: ${created.id ?? '(not returned)'}\n` +
            `Parent revision: ${current.id}\n` +
            `Visibility:      ${created.isPublic ? 'public' : 'private'}\n` +
            // Saving a revision also creates a post; its state mirrors the visibility.
            `Post state:      ${postState(created)}\n\n` +
            `Applied (${changes.length}):\n${diff}\n\n` +
            mixdownNotice(created, current),
        );
      }),
  );

  server.registerTool(
    'bandlab_list_effects',
    {
      title: 'Effect catalogue',
      description:
        'Lists BandLab effect slugs and their parameters, harvested from real published projects. ' +
        'Consult this before add_effect or set_effect_params: BandLab has no effects endpoint, slugs ' +
        'are undocumented, and a slug that is not listed here is one this server cannot vouch for.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Filter by slug or parameter name, e.g. "reverb", "amp", "drive"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => wrap(async () => text(describeCatalogue(query))),
  );

  server.registerTool(
    'bandlab_capabilities',
    {
      title: 'Server capabilities and limits',
      description:
        'Reports the API base, whether writes are enabled, the request pacing, and the inferred value ranges the edit engine enforces. Useful for diagnosing a refusal.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () =>
        text(
          [
            `API base:        ${config.apiBase}`,
            `Writes enabled:  ${client.allowWrites} (BANDLAB_ALLOW_WRITES)`,
            `Min interval:    ${config.minIntervalMs} ms between requests`,
            '',
            'Inferred value ranges (verify against a real project before trusting):',
            ...Object.entries(describeRanges()).map(([key, value]) => `  ${key}: ${value}`),
          ].join('\n'),
        ),
      ),
  );

  server.registerTool(
    'bandlab_raw_request',
    {
      title: 'Raw API request',
      description:
        'Escape hatch for endpoints this server does not wrap yet. The BandLab API is undocumented, so this is how you explore it. ' +
        'GET always allowed; other methods require writes to be enabled.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).default('GET'),
        path: z.string().describe('Path after the API base, e.g. /users/me/songs'),
        query: z.record(z.string()).optional(),
        body: z.record(z.unknown()).optional(),
      },
    },
    async ({ method, path, query, body }) =>
      wrap(async () => {
        const normalized = path.startsWith('/') ? path : `/${path}`;
        const result = await client.request<unknown>(method, normalized, { query, body });
        const rendered = JSON.stringify(result, null, 2);
        // Undocumented endpoints can return enormous payloads; keep the tool usable.
        return text(
          rendered.length > MAX_RAW_CHARS
            ? `${rendered.slice(0, MAX_RAW_CHARS)}

... truncated (${rendered.length} chars total). Narrow the request with query params.`
            : rendered,
        );
      }),
  );

  return server;
}

/**
 * Strips server-owned fields and links the new revision to its parent.
 *
 * BandLab does not document the create contract, so this is the conservative
 * reading of it: keep the musical content, drop anything the server assigns.
 */
export function prepareNewRevision(
  edited: Revision,
  parent: Revision,
  description?: string,
  isPublic?: boolean,
): Revision {
  const payload: Revision = { ...edited };
  for (const field of SERVER_OWNED_FIELDS) delete payload[field];
  payload.parentId = parent.id;
  if (description !== undefined) payload.description = description;
  if (isPublic !== undefined) payload.isPublic = isPublic;
  return payload;
}


/**
 * Refuses effect slugs the catalogue has never seen in a real project.
 *
 * BandLab accepts whatever JSON it is given, so a typo does not fail loudly —
 * it lands in the saved revision and the effect simply never applies. Checking
 * first turns that silent corruption into an error the caller can act on.
 */
export function assertKnownEffects(ops: readonly MixOp[]): void {
  const catalogue = loadCatalogue();
  if (catalogue.effects.length === 0) return; // nothing harvested yet; do not block

  const unknown = new Set<string>();
  for (const op of ops) {
    if (op.op !== 'add_effect' && op.op !== 'set_effect_params') continue;
    if (!findEffect(op.slug)) unknown.add(op.slug);
  }
  if (unknown.size === 0) return;

  const known = catalogue.effects.map((effect) => effect.slug).join(', ');
  throw new MixEditError(
    `Unknown effect slug(s): ${[...unknown].join(', ')}. ` +
      `Not found in the catalogue harvested from real projects. Verified slugs: ${known}. ` +
      'Use bandlab_list_effects to inspect parameters, or pass allowUnverifiedEffects=true to override.',
  );
}

/** A saved revision carries a post; `state` is "Private" or "Public". */
function postState(revision: Revision): string {
  const post = revision.post as { state?: string } | undefined;
  return post?.state ?? '(not reported)';
}

/**
 * Warns when the saved revision still points at its parent's rendered audio.
 *
 * Verified live: BandLab does not re-render a mixdown in response to an API
 * write — the new revision inherits the parent's `mixdown.id`. The project data
 * is updated, but anyone streaming the post hears the old mix until it is
 * re-rendered from the Mix Editor. Reporting the write as done without saying
 * so would be misleading.
 */
function mixdownNotice(created: Revision, parent: Revision): string {
  const inherited =
    created.mixdown?.id !== undefined && created.mixdown.id === parent.mixdown?.id;
  return inherited
    ? 'NOTE: the rendered audio was NOT re-generated — this revision still points at the ' +
        "parent's mixdown, so streaming playback sounds unchanged. Open the song in BandLab's " +
        'Mix Editor to hear the edit and to render a new mixdown.'
    : 'The revision carries its own mixdown.';
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

/** Turns thrown errors into readable tool errors instead of transport failures. */
async function wrap(handler: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await handler();
  } catch (error) {
    return { content: [{ type: 'text', text: explain(error) }], isError: true };
  }
}

function explain(error: unknown): string {
  if (error instanceof WriteBlockedError) {
    return `${error.message}\n\nThis is the server's safety gate, not a BandLab error.`;
  }
  if (error instanceof MixEditError) return `Mix edit rejected: ${error.message}`;
  if (error instanceof BandLabApiError) {
    const hint =
      error.status === 401
        ? '\nHint: the session could not be refreshed. Check BANDLAB_REFRESH_TOKEN.'
        : error.status === 403
          ? '\nHint: the account lacks permission for this resource.'
          : error.status === 429
            ? '\nHint: rate limited. Raise BANDLAB_MIN_INTERVAL_MS.'
            : '';
    return `${error.message}\nResponse: ${error.body}${hint}`;
  }
  return error instanceof Error ? error.message : String(error);
}
