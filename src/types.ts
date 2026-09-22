/**
 * Type model for the BandLab API (v1.3).
 *
 * Derived from the community OpenAPI spec and verified against live responses.
 * The live API returns MORE fields than the spec documents, so every interface
 * here is intentionally open-ended: unknown keys are preserved verbatim so a
 * round-trip (GET -> mutate -> POST) never silently drops server-side state.
 */

export type ColorName = 'Red' | 'Blue' | 'Violet' | 'Pink' | 'Green' | 'Yellow';
export type SampleStatus = 'Empty' | 'NotReady' | 'Processing' | 'Ready' | 'Corrupted';
export type AuthProvider = 'Password' | 'Key' | 'Token' | 'Google' | 'Facebook' | 'Twitter' | 'Soundcloud';

/** Anything the server sent that we do not model explicitly. */
export type Extra = Record<string, unknown>;

export interface AudioSample extends Extra {
  id?: string;
  name?: string;
  status?: SampleStatus;
}

export interface Region extends Extra {
  id?: string;
  key?: string;
  name?: string;
  startPosition?: number;
  endPosition?: number;
  sampleOffset?: number;
  playbackRate?: number;
  pitchShift?: number;
  loopLength?: number;
  sampleId?: string;
  trackId?: string;
  /** Verified live; absent from the community spec. */
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
  pitchTimeCorrection?: boolean;
}

export interface Effect extends Extra {
  slug?: string;
  bypass?: boolean;
  params?: Record<string, unknown>;
  /** Per-parameter automation lanes, keyed by param name. Empty on a fresh effect. */
  automation?: Record<string, unknown>;
}

/**
 * Preset provenance for a track's effect chain — a display name and a link to
 * the preset it came from. This is metadata only: the actual chain lives in
 * `Track.effects`. Verified live; easy to mistake for the chain itself.
 */
export interface EffectsData extends Extra {
  displayName?: string | null;
  link?: string | null;
  originalPresetId?: string | null;
}

export interface AutomationPoint extends Extra {
  position?: number;
  value?: number;
}

export interface Automation extends Extra {
  pan?: AutomationPoint[];
  volume?: AutomationPoint[];
}

export interface AuxSend extends Extra {
  id?: string;
  /**
   * Lowercase `sendLevel` is what the live API returns. The community OpenAPI
   * spec says `SendLevel`; that is wrong and writing it creates a dead field.
   */
  sendLevel?: number;
  automation?: unknown[];
}

export interface AuxChannel extends Extra {
  id?: string;
  preset?: string;
  returnLevel?: number;
  effects?: Effect[];
}

export interface Track extends Extra {
  id?: string;
  /** Present on live responses even though the published spec omits it. */
  name?: string;
  order?: number;
  type?: string;
  preset?: string;
  soundbank?: string;
  volume?: number;
  pan?: number;
  isMuted?: boolean;
  isSolo?: boolean;
  isFrozen?: boolean;
  colorName?: ColorName;
  automation?: Automation;
  regions?: Region[];
  effects?: Effect[];
  /** Preset metadata for `effects` — not the chain. */
  effectsData?: EffectsData | null;
  auxSends?: AuxSend[];
  /** Verified live: wet/dry balance for the effect chain. */
  fxMix?: number;
  trackGroupId?: string | null;
  samplerKit?: unknown;
  canEdit?: boolean;
}

export interface Mastering extends Extra {
  preset?: string;
  drySampleId?: string;
}

export interface Signature extends Extra {
  notesCount?: number;
  noteValue?: number;
}

export interface Metronome extends Extra {
  signature?: Signature;
  bpm?: number;
}

export interface Revision extends Extra {
  id?: string;
  parentId?: string;
  postId?: string;
  songId?: string;
  description?: string;
  stamp?: string;
  isFork?: boolean;
  isPublic?: boolean;
  key?: string;
  metronome?: Metronome;
  mastering?: Mastering;
  mixdown?: AudioSample;
  samples?: AudioSample[];
  tracks?: Track[];
  auxChannels?: AuxChannel[];
  song?: Extra;
  /** Master output level. Verified live; absent from the community spec. */
  volume?: number;
  /** "manual" on a user save. Sent back unchanged unless a caller overrides it. */
  saveType?: string;
  trackGroups?: unknown[];
  /** Saving a revision also creates a post; its `state` mirrors the visibility. */
  post?: Extra;
  samplerKits?: unknown[];
  latestRevisionId?: string;
  /** Live-only permission flags; useful as a pre-flight check before writing. */
  canEdit?: boolean;
  canPublish?: boolean;
  canMaster?: boolean;
}

export interface Song extends Extra {
  id?: string;
  name?: string;
  slug?: string;
  description?: string;
  isPublic?: boolean;
  isForkable?: boolean;
  canEdit?: boolean;
}

export interface AuthorizationResult {
  sessionKey: string;
  refreshToken?: string;
  expireDate?: string;
}

export interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; nextCursor?: string };
}
