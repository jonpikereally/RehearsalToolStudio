import type { ChartLane, Marker, PatchClip, SamplerNote, SamplerSample, Song, TempoPoint, TimedText, Variant } from '../types';

/**
 * What a folder of files can't say for itself.
 *
 * A prepared set is deliberately an ordinary library — bracketed names, facts
 * in the folder name — so that anything can play it. But a folder name holds
 * one tempo, and a song may change tempo; it holds no sections and no chords;
 * and it can't mention that the encoder added a lead-in. All of that would be
 * thrown away in the writing.
 *
 * So one small file sits beside the songs carrying the rest. It is optional by
 * design: without it the set still plays, just with a single tempo and no
 * chart, exactly as a hand-made folder would.
 */

export const MANIFEST_NAME = 'set.json';
/** One per song folder: the song's own entry, readable without the set's manifest. */
export const SONG_FILE_NAME = 'song.json';

/**
 * A song folder is `<Title> (<date>)`: the title, and the day its audio was
 * last rendered, so a folder says how fresh its files are. Older sets named
 * it `<Title> {tempo, key, sig}`. What identifies the song across both — and
 * across renders, since the date moves — is the title part, which is what
 * every match in a prepared set goes by.
 */
export const RENDER_DATE_SUFFIX = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;

/** The song's name from its folder's: the title part, without the date or the older facts. */
export function folderBaseOf(folderName: string): string {
  return folderName.replace(RENDER_DATE_SUFFIX, '').replace(/\s*\{[^}]*\}\s*$/, '').trim();
}

/** The day a song folder's audio was rendered, from its name; null for an older folder. */
export function renderDateOf(folderName: string): string | null {
  return RENDER_DATE_SUFFIX.exec(folderName)?.[1] ?? null;
}

/** Whether two folder names — or a folder name and a song name — are the same song's. */
export function sameSong(a: string, b: string): boolean {
  return folderBaseOf(a).toLowerCase() === folderBaseOf(b).toLowerCase();
}

/** What a song folder's own file holds: the entry, and which set it belongs to. */
export function songFileFor(entry: PreparedSongInfo, setFolder: string, fromSet?: string): Record<string, unknown> {
  return { preparedBy: 'rehearsaltool', set: setFolder, ...(fromSet ? { fromSet } : {}), ...entry };
}

export interface PreparedSongInfo {
  /** The song's folder name, relative to the set: `<Title> (<date rendered>)`. */
  folder: string;
  title: string;
  /** When the song's audio was last rendered, in full; its folder carries the day. */
  renderedAt?: string;
  /** The tempo at the song's start, to one decimal, and its meter as `4/4`. */
  tempo?: number;
  timeSignature?: string;
  /** How long the song is: in bars, and in seconds through its tempo map. */
  bars?: number;
  durationSec?: number;
  /**
   * Seconds from the start of each file to the downbeat of bar 1.
   *
   * MP3 decodes back with a lead-in the encoder added, and browsers don't all
   * trim it — so every part starts fractionally late. They all start equally
   * late, so they stay locked to one another; this is what keeps the whole song
   * honest against its bars.
   */
  firstBarOffsetSec: number;
  originalKey?: string;
  /** Free text about the song — the info text on its group track in Live. */
  notes?: string;
  tempoMap?: TempoPoint[];
  markers?: { bar: number; name: string }[];
  chords?: TimedText[];
  /**
   * The set's `+LYRICS` tracks, kept apart the way AbleSet writes them — lead
   * lyrics, chords, backing-vocal cues, a note to the drummer. Merged into one
   * they would be unreadable, and which of them is worth looking at depends on
   * who is holding the phone.
   */
  lanes?: ChartLane[];
  /**
   * The song's parts, and what each one is.
   *
   * A part's file name already carries a `ref` marker, and the website could
   * read it off there — but a fact worth acting on should be stated rather
   * than parsed out of a string, and the display name is the studio's to
   * decide, not something each reader should re-derive. `label` is exactly
   * what stands in the file's square brackets, which is how a part is matched.
   */
  parts?: PreparedPart[];
  /**
   * A key over everything that decides what the parts sound like — files
   * by revision, clips, faders, devices, encoder settings — so the next
   * prepare can leave a song whose audio has not changed alone. The
   * studio's own; a player ignores it.
   */
  audioKey?: string;
  /**
   * Patch changes for the rig, exactly as the set carried them. Their ids are
   * derived from the set, so a re-publish replaces each clip with itself
   * rather than with an identical stranger every device then argues about.
   */
  patchClips?: PatchClip[];
}

/**
 * One part of a song, as the prepared folder holds it.
 *
 * Two kinds. An audio part is a file, and `label` is what stands in its
 * square brackets. A sampler part is no file at all — `kind: "sampler"`, a
 * pattern of `notes` and the `samples` they strike — the shape the band's
 * library carries and their website already plays. Its samples live under
 * `Resources/` at the root of the band's folder, one file per distinct
 * content however many songs strike it.
 */
export interface PreparedPart {
  /** The bracketed label in the file name — `[ref drums]` is `ref drums`. */
  label: string;
  /** Present on a sampler part. Absent means audio, as every earlier file was. */
  kind?: 'sampler';
  /** A sampler part's id in the library, its revision, and its place among the parts. */
  id?: string;
  /**
   * What the part is to a mixer. A `stem` is a fader to blend in with the
   * others; a `mix` is a whole song, to be switched to on its own — the
   * record itself, or the band's own full bounce. Absent means stem.
   */
  role?: 'stem' | 'mix';
  rev?: string;
  order?: number;
  samples?: SamplerSample[];
  notes?: SamplerNote[];
  /**
   * What to call it on screen: the label with the reference marker taken off.
   * "ref drums" is drums, and a mixer full of faders reads better for it.
   */
  name: string;
  /**
   * The record's own part rather than the band's, to be said beside the name
   * rather than folded into it. Absent means an ordinary part.
   */
  reference?: boolean;
  /**
   * The record itself — the "REF SONG" or "Ref Master" a set keeps to play
   * against, never a fader in the mix. Said outright, because a player that
   * read it as one more reference stem would put the whole record under a
   * fader beside the band's drums. Always a `mix` and always `reference`.
   */
  record?: boolean;
  /*
   * What an audio part was made from — the studio's facts about the stem,
   * for whoever wonders why a part sounds as it does. All optional; a part
   * written before they existed carries none.
   */
  /** The file's name in the folder. */
  file?: string;
  /** The Live tracks the part was rendered from: one, or several for a combined part. */
  sources?: string[];
  /** Rendered from Live's own freeze of the track, its devices included. */
  frozen?: boolean;
  /** Transposed or stretched from its file in the render: semitones, and the speed ratio. */
  shifted?: { semitones: number; speed: number };
  /** The bars of the song the part has audio in, 1-based and inclusive. */
  covers?: { fromBar: number; toBar: number };
  /** The fader level the part was rendered at, in dB; absent at unity. */
  gainDb?: number;
  sizeBytes?: number;
  bitrate?: number;
  sampleRate?: number;
}

export interface PreparedManifest {
  preparedBy: 'rehearsaltool';
  preparedAt: string;
  /** The set this came from, for when someone wonders where it went. */
  /** The .als it came from — absent when written by hand or from the editor. */
  fromSet?: string;
  /**
   * The Ableton session that feeds this folder, as its absolute path on the
   * Mac the studio runs on: what the studio opens when this folder is
   * chosen. The studio's own; a player ignores it.
   */
  session?: string;
  paddingSec: number;
  songs: PreparedSongInfo[];
}

export function isManifestName(fileName: string): boolean {
  return fileName.toLowerCase() === MANIFEST_NAME;
}

/** The set folder a manifest sits in. */
export function setFolderOf(manifestPath: string): string {
  const cut = manifestPath.lastIndexOf('/');
  return cut > 0 ? manifestPath.slice(0, cut) : '';
}

function looksLikeManifest(value: unknown): value is PreparedManifest {
  const m = value as PreparedManifest | null;
  return !!m && m.preparedBy === 'rehearsaltool' && Array.isArray(m.songs);
}

/**
 * Say what is wrong with a manifest, instead of silently ignoring it.
 *
 * A set.json is Prepare's output, but it is also a file a person can write by
 * hand beside a folder of audio — that is the point of it being an ordinary
 * file. Hand-written files come with hand-written mistakes, and the old
 * behaviour was to shrug and apply nothing, which reads as "the app is
 * broken" rather than "bar wants a number".
 *
 * Tolerant of fields it doesn't know — later versions may add some — and
 * strict about the types of the ones it does.
 */
export function validateManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const m = raw as Partial<PreparedManifest> | null;
  if (!m || typeof m !== 'object') return { ok: false, errors: ['not a JSON object'] };
  if (m.preparedBy !== 'rehearsaltool') {
    errors.push(`"preparedBy" must be exactly "rehearsaltool" — it is how the scan knows this file is meant for it`);
  }
  if (m.session !== undefined && typeof m.session !== 'string') errors.push('"session" must be text');
  if (m.session !== undefined && typeof m.session !== 'string') errors.push('"session" must be text');
  if (!Array.isArray(m.songs)) {
    errors.push('"songs" must be a list');
    return { ok: false, errors };
  }
  m.songs.forEach((song, i) => {
    const at = `songs[${i}]`;
    const bad = (msg: string) => errors.push(`${at}: ${msg}`);
    if (!song || typeof song !== 'object') return bad('not an object');
    if (typeof song.folder !== 'string' || !song.folder) bad('"folder" must name the song\'s folder');
    if (song.title !== undefined && typeof song.title !== 'string') bad('"title" must be text');
    if (song.notes !== undefined && typeof song.notes !== 'string') bad('"notes" must be text');
    if (song.firstBarOffsetSec !== undefined && typeof song.firstBarOffsetSec !== 'number') {
      bad('"firstBarOffsetSec" must be a number of seconds');
    }
    if (song.originalKey !== undefined && typeof song.originalKey !== 'string') bad('"originalKey" must be text');
    if (song.renderedAt !== undefined && typeof song.renderedAt !== 'string') bad('"renderedAt" must be text');
    if (song.tempo !== undefined && typeof song.tempo !== 'number') bad('"tempo" must be a number');
    if (song.timeSignature !== undefined && !/^\d+\/\d+$/.test(String(song.timeSignature))) bad('"timeSignature" must be like "4/4"');
    if (song.bars !== undefined && typeof song.bars !== 'number') bad('"bars" must be a number');
    if (song.durationSec !== undefined && typeof song.durationSec !== 'number') bad('"durationSec" must be a number');
    for (const [field, wantBar] of [['tempoMap', 'bpm'], ['chords', 'text']] as const) {
      const list = song[field] as unknown;
      if (list === undefined) continue;
      if (!Array.isArray(list)) { bad(`"${field}" must be a list`); continue; }
      (list as Record<string, unknown>[]).forEach((item, j) => {
        if (!item || typeof item.bar !== 'number') bad(`"${field}"[${j}] needs a numeric "bar"`);
        else if (typeof item[wantBar] !== (wantBar === 'bpm' ? 'number' : 'string')) {
          bad(`"${field}"[${j}] needs ${wantBar === 'bpm' ? 'a numeric "bpm"' : 'a "text" string'}`);
        }
      });
    }
    if (song.markers !== undefined) {
      if (!Array.isArray(song.markers)) bad('"markers" must be a list');
      else song.markers.forEach((mk, j) => {
        if (!mk || typeof mk.bar !== 'number' || typeof mk.name !== 'string') {
          bad(`"markers"[${j}] needs a numeric "bar" and a "name"`);
        }
      });
    }
    if (song.lanes !== undefined && !Array.isArray(song.lanes)) bad('"lanes" must be a list');
    if (song.audioKey !== undefined && typeof song.audioKey !== 'string') bad('"audioKey" must be text');
    if (song.patchClips !== undefined && !Array.isArray(song.patchClips)) bad('"patchClips" must be a list');
    if (song.parts !== undefined) {
      if (!Array.isArray(song.parts)) bad('"parts" must be a list');
      else {
        song.parts.forEach((part, j) => {
          if (!part || typeof part !== 'object') bad(`"parts"[${j}] is not an object`);
          else if (typeof part.label !== 'string' || !part.label.trim()) {
            bad(`"parts"[${j}] wants a "label"`);
          } else if (part.name !== undefined && typeof part.name !== 'string') {
            bad(`"parts"[${j}].name must be text`);
          } else if (part.reference !== undefined && typeof part.reference !== 'boolean') {
            bad(`"parts"[${j}].reference must be true or false`);
          } else if (part.record !== undefined && typeof part.record !== 'boolean') {
            bad(`"parts"[${j}].record must be true or false`);
          } else if (part.role !== undefined && part.role !== 'stem' && part.role !== 'mix') {
            bad(`"parts"[${j}].role can only be "stem" or "mix"`);
          } else if (part.kind !== undefined && part.kind !== 'sampler') {
            bad(`"parts"[${j}].kind can only be "sampler"`);
          } else if (part.kind === 'sampler') {
            if (!Array.isArray(part.samples) || !part.samples.length) bad(`"parts"[${j}] is a sampler with no "samples"`);
            else part.samples.forEach((smp, k) => {
              if (!smp || typeof smp.note !== 'number' || typeof smp.path !== 'string') {
                bad(`"parts"[${j}].samples[${k}] needs a numeric "note" and a "path"`);
              }
            });
            if (!Array.isArray(part.notes) || !part.notes.length) bad(`"parts"[${j}] is a sampler with no "notes"`);
            else part.notes.forEach((n, k) => {
              if (!n || typeof n.bar !== 'number' || typeof n.note !== 'number') {
                bad(`"parts"[${j}].notes[${k}] needs a numeric "bar" and "note"`);
              } else if (n.velocity !== undefined && (typeof n.velocity !== 'number' || n.velocity < 0 || n.velocity > 1)) {
                bad(`"parts"[${j}].notes[${k}].velocity must be 0..1`);
              }
            });
          }
        });
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Put a manifest's facts back onto the songs the scan found.
 *
 * Matched by folder, since that is what the manifest names and what the scan
 * groups by. A song the manifest doesn't mention is left exactly as scanned —
 * files added to a prepared set by hand keep working.
 */
/**
 * A manifest from library songs — the inverse of applyManifest.
 *
 * This is how edits made in the studio survive outside the library file: the
 * same set.json a person could write by hand, written by the machine instead,
 * beside the audio it describes. Songs already in `previous` that aren't
 * being rewritten keep their entries, so one song's edit doesn't erase the
 * others'.
 */
export function manifestFromSongs(
  songs: Song[],
  setFolder: string,
  previous?: PreparedManifest | null,
): PreparedManifest {
  const prefix = setFolder ? `${setFolder.toLowerCase()}/` : '';
  const entries = songs
    .filter((song) => song.folderPath.toLowerCase().startsWith(prefix))
    .map((song) => {
      const info: PreparedSongInfo = {
        folder: song.folderPath.slice(prefix.length),
        title: song.title,
        firstBarOffsetSec: song.firstBarOffsetSec ?? 0,
      };
      if (song.originalKey) info.originalKey = song.originalKey;
      if (song.notes) info.notes = song.notes;
      if (song.tempoMap?.length) info.tempoMap = song.tempoMap;
      if (song.markers?.length) info.markers = song.markers.map((m) => ({ bar: m.bar, name: m.name }));
      if (song.chords?.length) info.chords = song.chords;
      if (song.lyrics?.length || song.lanes?.length) {
        info.lanes = song.lanes?.length
          ? song.lanes
          : [{ id: 'lead', name: 'Lead', kind: 'lyrics', items: song.lyrics! }];
      }
      if (song.patchClips?.length) info.patchClips = song.patchClips;
      /*
       * What the entry says about files on disk — which parts were written,
       * which samples the click and cues play — is not in the library and
       * cannot be re-derived from it. It is carried from the entry being
       * replaced, or an edit to a section name would quietly strip it.
       */
      const before = previous?.songs.find((e) => e.folder.toLowerCase() === info.folder.toLowerCase());
      if (before?.parts?.length) info.parts = before.parts;
      if (before?.renderedAt) info.renderedAt = before.renderedAt;
      if (before?.audioKey) info.audioKey = before.audioKey;
      if (before?.bars) info.bars = before.bars;
      if (before?.durationSec) info.durationSec = before.durationSec;
      if (song.bpm) info.tempo = song.bpm;
      if (song.timeSigNum && song.timeSigDen) info.timeSignature = `${song.timeSigNum}/${song.timeSigDen}`;
      return info;
    });

  const mine = new Set(entries.map((e) => e.folder.toLowerCase()));
  const kept = (previous?.songs ?? []).filter((e) => !mine.has(e.folder.toLowerCase()));
  return {
    preparedBy: 'rehearsaltool',
    preparedAt: new Date().toISOString(),
    paddingSec: previous?.paddingSec ?? 0,
    songs: [...kept, ...entries],
  };
}

export function applyManifest(
  songs: Song[],
  manifestPath: string,
  raw: unknown,
): { applied: number; errors?: string[] } {
  if (!looksLikeManifest(raw)) {
    // Not even shaped like ours — but if somebody clearly *tried*, say why.
    const verdict = validateManifest(raw);
    return { applied: 0, errors: verdict.errors.length ? verdict.errors : undefined };
  }
  const verdict = validateManifest(raw);
  if (!verdict.ok) return { applied: 0, errors: verdict.errors };
  const setFolder = setFolderOf(manifestPath).toLowerCase();

  const byFolder = new Map<string, PreparedSongInfo>();
  for (const info of raw.songs) {
    byFolder.set(`${setFolder}/${info.folder}`.toLowerCase(), info);
  }

  let applied = 0;
  for (const song of songs) {
    const info = byFolder.get(song.folderPath.toLowerCase());
    if (!info) continue;
    applied++;

    // The folder's name no longer carries these; the entry does.
    if (info.title) song.title = info.title;
    if (typeof info.tempo === 'number' && info.tempo > 0) song.bpm = info.tempo;
    const sig = info.timeSignature?.match(/^(\d+)\/(\d+)$/);
    if (sig) {
      song.timeSigNum = Number(sig[1]);
      song.timeSigDen = Number(sig[2]);
    }
    song.firstBarOffsetSec = info.firstBarOffsetSec ?? song.firstBarOffsetSec;
    if (info.originalKey) song.originalKey = info.originalKey;
    if (info.notes !== undefined) song.notes = info.notes || undefined;
    if (info.tempoMap?.length) song.tempoMap = info.tempoMap;
    if (info.chords?.length) song.chords = info.chords;
    if (info.lanes?.length) song.lanes = info.lanes;
    // Set-wins-else-keep, the same bargain the direct importer strikes: a
    // manifest with none must not wipe what was programmed in the app.
    if (info.patchClips?.length) song.patchClips = info.patchClips;
    if (info.markers?.length) song.markers = markersFrom(info.markers, song.markers);
    if (info.parts?.some((p) => p.kind === 'sampler')) samplerVariants(song, info.parts);
    song.tempoUnset = false;
  }
  return { applied };
}

/**
 * Sections become markers, keeping any id they already had so the library file
 * doesn't churn on every scan.
 */
function markersFrom(
  sections: { bar: number; name: string }[],
  existing: Marker[],
): Marker[] {
  const old = new Map(existing.map((m) => [`${m.bar}:${m.name}`, m]));
  return sections.map((s, i) => {
    const key = `${s.bar}:${s.name}`;
    return old.get(key) ?? { id: `p_${i}_${s.bar}`, name: s.name, bar: s.bar };
  });
}

/**
 * A sampler part of the manifest as a part of the song. What the band's
 * library carries, exactly; the studio's own loader turns the notes into
 * placements when the song is opened. Replaces its earlier self by id on a
 * rescan rather than piling up.
 */
function samplerVariants(song: Song, parts: PreparedPart[]): void {
  const made: Variant[] = parts
    .filter((p) => p.kind === 'sampler' && p.samples?.length && p.notes?.length)
    .map((p) => ({
      id: (p.id ?? `${song.folderPath}#sampler:${p.label}`).toLowerCase(),
      name: p.name || p.label,
      role: 'stem' as const,
      kind: 'sampler' as const,
      rev: p.rev ?? 'sampler',
      sizeBytes: 0,
      path: p.samples![0].path,
      order: p.order,
      samples: p.samples!,
      notes: p.notes!,
    }));
  const mine = new Set(made.map((v) => v.id));
  song.variants = [...song.variants.filter((v) => !mine.has(v.id)), ...made];
}
