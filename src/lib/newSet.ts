import { esc, extractBlock, idMinter, sub } from './alsEdit.ts';
import { parseAlsXml, songKey, type AlsProject } from './alsParser.ts';

/**
 * New songs from a folder of stems, in the set's own format.
 *
 * A song arrives as a folder of bounces — `ADDICTED_Drum.wav`,
 * `Click 148 - INTO YOU_V2_02.wav`, `FOREVER_REF_F# Major.wav` — and
 * getting it into a set is an hour of the same clicks: a group named for
 * the song, a REF folder, a track per stem routed and sent the way every
 * other song's are, the click onto the click track, a locator with its
 * length, key and tempo, an AUTOSTOP after it.
 *
 * "The way every other song's are" is the format, and each set has its own:
 * one keeps DRUMS, BASS, MUSIC, VOX 1 and VOX 2 sent to their buses, another
 * a REF folder of the record's parts beside BASS, GUITAR, OTHER and PIANO.
 * So nothing here knows a format. A song already in the set is the model:
 * each file is matched to one of its tracks by what it is, and that track —
 * its folder, routing, sends, devices, fader, switch — is copied with the
 * file put in its clip. What Live opens is a document it wrote, patched.
 *
 * Two ways out, both copies: the set with the songs added after everything
 * it has, or a new set with only the songs, on the set's returns, click
 * track and the rest of its furniture. The original is never touched.
 */

/* --------------------------------- files --------------------------------- */

export interface StemFile {
  name: string;
  /** As a clip names its file: relative to the set's folder. */
  relPath: string;
  absPath: string;
  size: number;
  /** Epoch ms. */
  modified: number;
  seconds: number;
  sampleRate: number;
  frames: number;
}

export type StemRole = 'stem' | 'ref' | 'click';

/** What a bounce's name says about it. */
export interface NamedPart {
  /** The words left once the song, the version and the tags are gone: "Bass", "Extra Prod". */
  part: string;
  role: StemRole;
  /** Said outright — "93BPM" — in the file's name. */
  bpm: number | null;
  /** The number beside "Click", which is often the tempo and sometimes double it. */
  clickBpm: number | null;
  key: string | null;
}

const KEY_WORDS = /^([A-G])\s*([#b♯♭]?)\s*(major|minor|maj|min|m)?$/i;

/** A key as a locator writes it: C, F#, Bbm. */
export function keyFrom(token: string): string | null {
  const m = token.trim().match(KEY_WORDS);
  if (!m) return null;
  const accidental = m[2] === '♭' ? 'b' : m[2] === '♯' ? '#' : m[2];
  const minor = !!m[3] && /^(minor|min|m)$/i.test(m[3]);
  return `${m[1].toUpperCase()}${accidental}${minor ? 'm' : ''}`;
}

/** Lowercase words only, brackets and punctuation gone, for telling whether two names are one. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether a stretch of a file name is the song's own name — or a typo of it, or its start. */
function isTitle(segment: string, title: string): boolean {
  const s = words(segment);
  const t = words(title);
  if (!s || !t) return false;
  return s === t || s.startsWith(t) || (t.startsWith(s) && s.length >= 3);
}

/**
 * Read a bounce's name. Producers write them every which way —
 * `ADDICTED_Bass`, `Bass - INTO YOU_V2_02`, `Click_138_Hold You Down_V2_02`,
 * `LOST_Bass-Gain_01-01`, `22 (F)_Bass`, `FULLY LOADED.Click_92BPM` — so the
 * name is cut into stretches at underscores, spaced dashes and dots before
 * a word; the stretch that is the song goes, a version (`V2`, `02`) goes, a
 * DAW's `-Gain` goes, and what is left says the part, and perhaps the key
 * and the tempo. Nothing left is the song itself: the mixdown, a reference.
 */
export function namePart(fileName: string, songTitle: string): NamedPart {
  let base = fileName.replace(/\.[^.]+$/, '');
  let bpm: number | null = null;
  let clickBpm: number | null = null;
  let key: string | null = null;
  let role: StemRole = 'stem';

  base = base.replace(/-Gain(?:_\d+-\d+)?/gi, ' ').replace(/\b\d{4}[.-]\d{2}[.-]\d{2}\b/g, ' ');
  base = base.replace(/\(\s*([A-G][#b♯♭]?\s*(?:m|min|minor|maj|major)?)\s*\)/g, (_, k: string) => {
    key ??= keyFrom(k);
    return ' ';
  });
  base = base.replace(/(\d{2,3}(?:\.\d+)?)\s*bpm\b/gi, (_, n: string) => {
    bpm ??= parseFloat(n);
    return ' ';
  });

  const segments = base
    .split(/_+|\s+[-–]\s+|\.(?=[A-Za-z])/)
    .map((s) => s.replace(/^[\s.\-–]+|[\s.\-–]+$/g, ''))
    .filter(Boolean);

  const left: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (isTitle(segment, songTitle)) continue;
    const click = segment.match(/^click\b\s*(\d{2,3}(?:\.\d+)?)?/i);
    if (click) {
      role = 'click';
      if (click[1]) clickBpm ??= parseFloat(click[1]);
      else if (/^\d{2,3}(?:\.\d+)?$/.test(segments[i + 1] ?? '')) clickBpm ??= parseFloat(segments[++i]);
      continue;
    }
    const k = keyFrom(segment);
    if (k && /\s|major|minor|maj|min|[#b]/i.test(segment)) {
      key ??= k;
      continue;
    }
    if (/^(ref|reference|mix|mixdown|master|full ?mix|song)$/i.test(segment)) {
      if (role !== 'click') role = 'ref';
      continue;
    }
    if (/^v\d+$/i.test(segment) || /^\d{1,2}$/.test(segment)) continue;
    left.push(segment);
  }
  const part = left.join(' ').replace(/\s+/g, ' ').trim();
  if (role === 'stem' && !part) role = 'ref';
  return { part, role, bpm, clickBpm, key };
}

/** A song's name from its folder: "Fearless 100BPM 2026.08.10 Stems" is Fearless. */
export function titleFromFolder(name: string): string {
  return name
    .replace(/\.(wav|aiff?|aifc|flac|mp3|m4a|caf)$/i, '')
    .replace(/\b\d{4}[.-]\d{2}[.-]\d{2}\b/g, ' ')
    .replace(/\b\d{2,3}(?:\.\d+)?\s*bpm\b/gi, ' ')
    .replace(/\bstems?\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–_.]+|[\s\-–_.]+$/g, '')
    .trim();
}

const AUDIO_RE = /\.(wav|aiff?|aifc|flac|mp3|m4a|caf)$/i;

export interface FoundSong {
  title: string;
  /** The folder's own name, which may say the tempo; '' for a file loose at the top. */
  folder: string;
  files: { path: string; name: string }[];
}

/**
 * Songs from a folder's files. A folder holding audio is a song, named for
 * the folder, wherever it sits — a producer's delivery is often a folder of
 * song folders inside another. What sits at the top of the folder picked is
 * that folder's song when nothing below it is a song; beside song folders,
 * a loose file is a song of its own. Files that are not audio are left out,
 * and so is anything in a folder called Backup.
 */
export function songsFromFiles(files: { path: string; name: string }[], pickedName = ''): FoundSong[] {
  const audio = files.filter((file) => {
    if (!AUDIO_RE.test(file.name) || file.name.startsWith('.')) return false;
    return !file.path.replace(/^\/+/, '').split('/').some((s) => /^backup$/i.test(s));
  });
  const nested = audio.some((file) => file.path.replace(/^\/+/, '').includes('/'));
  const bySong = new Map<string, FoundSong>();
  for (const file of audio) {
    const segments = file.path.replace(/^\/+/, '').split('/');
    const dir = segments.slice(0, -1).join('/');
    const folder = dir ? segments[segments.length - 2] : nested ? '' : pickedName;
    const key = dir ? `dir:${dir}` : nested ? `file:${file.name}` : 'picked';
    let song = bySong.get(key);
    if (!song) {
      song = { title: titleFromFolder(folder || file.name), folder, files: [] };
      bySong.set(key, song);
    }
    song.files.push(file);
  }
  return [...bySong.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/* ------------------------------- the model ------------------------------- */

/** What a track is for, from its name — the set's or a file's. */
export type Category = 'song' | 'drums' | 'bass' | 'guitar' | 'piano' | 'music' | 'vox2' | 'vox1' | 'other';

const CATEGORY_RE: [Category, RegExp][] = [
  ['song', /^(song|mix|mixdown|master|record|full ?mix)\b/i],
  ['vox2', /^((vocals?|vox|voc)\s*(2|bg|bgvs?|backing|harm)|bgvs?|bgs|bvs?|backing ?vo|harmon|choir|vocal ?bg)/i],
  ['vox1', /^(vocals?|vox|voca?|lv|lead|voice|vocal ?1|vox ?1)\b|^voc/i],
  ['drums', /^(drum|kit|beat)/i],
  ['bass', /^bass/i],
  ['guitar', /^(guitar|gtr|gtrs)/i],
  ['piano', /^(piano|keys|keyboard|synth|organ|pad)/i],
  ['music', /^(music|instrumental|inst\b|backing|track|band)/i],
  ['other', /^(other|extra|prod|fx|perc|strings|horns|brass)/i],
];

export function categoryOf(name: string): { category: Category | null; ref: boolean } {
  let rest = name.trim();
  const ref = /^ref(erence)?\b/i.test(rest);
  if (ref) rest = rest.replace(/^ref(erence)?\s*/i, '');
  if (ref && !rest) return { category: 'song', ref };
  const found = CATEGORY_RE.find(([, re]) => re.test(rest));
  return { category: found ? found[0] : null, ref };
}

/** A name for a track the model song has nothing like. */
const NEW_NAME: Record<Category, string> = {
  song: 'REF SONG',
  drums: 'DRUMS',
  bass: 'BASS',
  guitar: 'GUITAR',
  piano: 'PIANO',
  music: 'MUSIC',
  vox1: 'VOX 1',
  vox2: 'VOX 2',
  other: 'OTHER',
};

export interface ModelTrack {
  kind: 'GroupTrack' | 'AudioTrack';
  id: string;
  /** The track or folder this one sits in: the song's group, or a folder inside it. */
  parentId: string;
  name: string;
  text: string;
}

export interface ModelSong {
  title: string;
  group: ModelTrack;
  /** Every folder and audio track inside the song's group, in the set's order. */
  inside: ModelTrack[];
}

interface TrackBlock {
  kind: string;
  id: string;
  groupId: string;
  name: string;
  start: number;
  end: number;
  text: string;
}

function trackBlocks(xml: string): { blocks: TrackBlock[]; tracksStart: number } {
  const tracks = extractBlock(xml, /<Tracks>/);
  if (!tracks) throw new Error('The set has no track list.');
  const blocks: TrackBlock[] = [];
  let at = 0;
  for (;;) {
    const block = extractBlock(tracks.text, /<(?:AudioTrack|MidiTrack|GroupTrack|ReturnTrack) Id="\d+"[^>]*>/, at);
    if (!block) break;
    const head = block.text.match(/^<(\w+) Id="(\d+)"/)!;
    blocks.push({
      kind: head[1],
      id: head[2],
      groupId: block.text.match(/<TrackGroupId Value="(-?\d+)"/)?.[1] ?? '-1',
      name: block.text.match(/<EffectiveName Value="([^"]*)"/)?.[1] ?? '',
      start: tracks.start + block.start,
      end: tracks.start + block.end,
      text: block.text,
    });
    at = block.end;
  }
  return { blocks, tracksStart: tracks.start };
}

/** The root group of a track, by walking up its groups. */
function rootOf(blocks: TrackBlock[], id: string): string {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let cur = byId.get(id);
  for (let i = 0; i < 16 && cur && cur.groupId !== '-1'; i++) cur = byId.get(cur.groupId);
  return cur?.id ?? id;
}

/** The groups the set's songs are in, by the tracks the parser gave each. */
function songGroupIds(xml: string, project: AlsProject): Map<string, string> {
  const { blocks } = trackBlocks(xml);
  const byTitle = new Map<string, string>();
  for (const song of project.songs) {
    const stem = song.stems.find((s) => s.trackId);
    if (stem?.trackId && !byTitle.has(song.title)) byTitle.set(song.title, rootOf(blocks, stem.trackId));
  }
  return byTitle;
}

/** The songs that can be a model: ones with a group of their own holding audio tracks. */
export function modelCandidates(xml: string, project: AlsProject): string[] {
  const groups = songGroupIds(xml, project);
  return project.songs.filter((s, i, all) => groups.has(s.title) && all.findIndex((x) => x.title === s.title) === i).map((s) => s.title);
}

/** One song's group and everything in it, to copy. */
export function modelSong(xml: string, project: AlsProject, title: string): ModelSong {
  const groupId = songGroupIds(xml, project).get(title);
  if (!groupId) throw new Error(`${title} has no group of its own in the set to model new songs on.`);
  const { blocks } = trackBlocks(xml);
  const group = blocks.find((b) => b.id === groupId)!;
  const inside = blocks
    .filter((b) => b.id !== groupId && (b.kind === 'GroupTrack' || b.kind === 'AudioTrack') && rootOf(blocks, b.id) === groupId)
    .map((b) => ({ kind: b.kind as ModelTrack['kind'], id: b.id, parentId: b.groupId, name: b.name, text: b.text }));
  return {
    title,
    group: { kind: 'GroupTrack', id: group.id, parentId: '-1', name: group.name, text: group.text },
    inside,
  };
}

/* ------------------------------- a new song ------------------------------- */

export interface StemPart {
  file: StemFile;
  /** What the file's name calls it, for the page to show. */
  part: string;
  role: StemRole;
  /** Written into the set, or left out. */
  include: boolean;
  /** The model's track it is copied from, by name; '' for a new track of its own. */
  target: string;
  /** The track's name: the target's, unless it is a new track. */
  name: string;
}

export interface NewSong {
  title: string;
  bpm: number | null;
  /** Where the tempo came from, so the page can say how far to trust it. */
  bpmFrom: 'name' | 'click' | 'audio' | null;
  key: string | null;
  parts: StemPart[];
}

/**
 * One song's parts matched to the model's tracks. Each track is taken once:
 * a second vocal goes to the next vocal track, and then to a track of its
 * own. A part named exactly as a track wins; otherwise the band's track of
 * that kind is tried before the record's, since a delivered stem is the
 * band's to play until someone says it is the record's.
 */
export function songFromFiles(found: Pick<FoundSong, 'title' | 'folder'>, files: StemFile[], model: ModelSong | null): NewSong {
  let bpm: number | null = null;
  let clickBpm: number | null = null;
  let key: string | null = null;
  const folderTempo = found.folder.match(/(\d{2,3}(?:\.\d+)?)\s*bpm\b/i);
  if (folderTempo) bpm = parseFloat(folderTempo[1]);
  const named = files.map((file) => ({ file, ...namePart(file.name, found.title) }));
  for (const n of named) {
    bpm ??= n.bpm;
    clickBpm ??= n.clickBpm;
    key ??= n.key;
  }
  const tracks = (model?.inside ?? []).filter((t) => t.kind === 'AudioTrack');
  const used = new Set<string>();
  const take = (want: (t: ModelTrack) => boolean): ModelTrack | undefined => {
    const t = tracks.find((x) => !used.has(x.id) && want(x));
    if (t) used.add(t.id);
    return t;
  };
  // The references and the named first, so a plain part cannot take the track a better match wanted.
  const order = [...named.keys()].sort((a, b) => rank(named[a]) - rank(named[b]));
  const parts: StemPart[] = new Array(named.length);
  for (const i of order) {
    const n = named[i];
    if (n.role === 'click') {
      parts[i] = { file: n.file, part: n.part || 'Click', role: 'click', include: true, target: '', name: 'CLICK' };
      continue;
    }
    const cat = n.role === 'ref' ? { category: 'song' as Category, ref: true } : categoryOf(n.part);
    const sameKind = (t: ModelTrack) => categoryOf(t.name).category === cat.category;
    const match =
      (n.part ? take((t) => words(t.name) === words(n.part)) : undefined) ??
      (cat.category === 'song'
        ? take((t) => categoryOf(t.name).category === 'song')
        : cat.category
          ? (take((t) => sameKind(t) && !categoryOf(t.name).ref) ??
            take((t) => words(t.name) === words(`ref ${n.part}`)) ??
            take(sameKind))
          : undefined);
    const name = match?.name ?? (cat.category ? NEW_NAME[cat.category] : (n.part || 'AUDIO').toUpperCase());
    parts[i] = { file: n.file, part: n.part || (n.role === 'ref' ? 'Mix' : ''), role: n.role, include: true, target: match?.name ?? '', name };
  }
  return { title: found.title, bpm: bpm ?? clickBpm, bpmFrom: bpm ? 'name' : clickBpm ? 'click' : null, key, parts };
}

function rank(n: NamedPart): number {
  if (n.role === 'ref') return 0;
  if (n.role === 'click') return 3;
  return categoryOf(n.part).category ? 1 : 2;
}

/* ------------------------------ writing the set ------------------------------ */

export interface BuildOptions {
  model: ModelSong;
  /** A new set with only these songs, rather than the set with them added. */
  fresh?: boolean;
  /** Bars between one song's AUTOSTOP and the next song's start, and before the first. */
  gapBars?: number;
}

export interface BuiltSong {
  title: string;
  startBar: number;
  bars: number;
  locator: string;
  tracks: string[];
  clickOn: string | null;
}

export interface BuildResult {
  xml: string;
  songs: BuiltSong[];
  notes: string[];
}

const clock = (seconds: number): string => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const NL = '\n';
const T = '\t';
const line = (depth: number, text: string) => NL + T.repeat(depth) + text;

/** The locator name in the set's own form: `Title / 3:00 / C / 100BPM`. */
export function locatorFor(song: Pick<NewSong, 'title' | 'bpm' | 'key'>, seconds: number): string {
  const fields = [song.title, clock(seconds), song.key ?? '', song.bpm ? `${Math.round(song.bpm * 100) / 100}BPM` : ''].filter(Boolean);
  return fields.join(' / ');
}

/** The Events of a track's arrangement, emptied, or holding `clips`. */
function setArrangement(chunk: string, holder: 'Sample' | 'ClipTimeable' | 'any', clips: string | null): string {
  let out = chunk;
  const re = holder === 'any' ? /<(?:Sample|ClipTimeable)>\s*<ArrangerAutomation>/g : new RegExp(`<${holder}>\\s*<ArrangerAutomation>`, 'g');
  const spots = [...out.matchAll(re)].map((m) => m.index!).reverse();
  for (const at of spots) {
    const events = extractBlock(out, /<Events(?: \/)?>/, at);
    if (!events) continue;
    out = out.slice(0, events.start) + (clips === null ? '<Events />' : `<Events>${clips}${NL}</Events>`) + out.slice(events.end);
  }
  return out;
}

/** A track as copied: fresh id, named, in its folder, with nothing of the original's playing. */
function copyTrack(text: string, kind: string, id: number, name: string, groupId: string): string {
  let out = text.replace(new RegExp(`^(\\s*<${kind}) Id="\\d+"`), `$1 Id="${id}"`);
  out = sub(out, /<EffectiveName Value="[^"]*"/, `<EffectiveName Value="${esc(name)}"`, 'track name');
  out = sub(out, /<UserName Value="[^"]*"/, `<UserName Value="${esc(name)}"`, 'track user name');
  out = sub(out, /<TrackGroupId Value="-?\d+"/, `<TrackGroupId Value="${groupId}"`, 'track group');
  out = out.replace(/<MemorizedFirstClipName Value="[^"]*"/, '<MemorizedFirstClipName Value=""');
  out = out.replace(/<LomId Value="\d+"/g, '<LomId Value="0"');
  out = out.replace(/<AutomationEnvelopes>[\s\S]*?<\/AutomationEnvelopes>/, '<AutomationEnvelopes>' + line(5, '<Envelopes />') + line(4, '</AutomationEnvelopes>'));
  // No session clips, no freeze: the copy plays only what is put in it.
  out = out.replace(/(<ClipSlot Id="\d+">\s*<LomId Value="\d+" \/>\s*<ClipSlot>\s*)<Value>[\s\S]*?<\/Value>/g, '$1<Value />');
  out = out.replace(/<Freeze Value="true"/, '<Freeze Value="false"');
  const freeze = extractBlock(out, /<FreezeSequencer>/);
  if (freeze) out = out.slice(0, freeze.start) + setArrangement(freeze.text, 'any', null) + out.slice(freeze.end);
  return out;
}

/**
 * The copy: a group per song modelled on the model song, the clicks on the
 * set's click track, locators, AUTOSTOPs and tempo steps — after everything
 * the set has, or in a set emptied of its songs.
 */
export function buildSongsIntoSet(xml: string, songs: NewSong[], opts: BuildOptions): BuildResult {
  const original = parseAlsXml(xml);
  const notes: string[] = [];
  const beatsPerBar = original.timeSigNum * (4 / original.timeSigDen);
  const { model } = opts;
  const gap = Math.max(0, opts.gapBars ?? 8);

  /* --------------------------- the templates --------------------------- */

  // A clip to copy: the model's own, else any audio clip on the arrangement.
  const anyClip = (text: string): string | null => {
    const at = text.search(/<Sample>\s*<ArrangerAutomation>\s*<Events>\s*<AudioClip/);
    return at >= 0 ? (extractBlock(text, /<AudioClip Id="\d+"[^>]*>/, at)?.text ?? null) : null;
  };
  const clipTemplate = model.inside.map((t) => anyClip(t.text)).find(Boolean) ?? anyClip(xml);
  if (!clipTemplate) throw new Error('The set has no audio clip on its arrangement to model a clip on.');
  const audioModels = model.inside.filter((t) => t.kind === 'AudioTrack');
  if (!audioModels.length) throw new Error(`${model.title} has no audio tracks to model new ones on.`);
  /*
   * A track the model has nothing like is copied from its nearest relation,
   * so it lands on the bus its kind goes to: a guitar where the music goes,
   * a second vocal where the first does. Failing any, the first of the
   * band's own tracks.
   */
  const FAMILY: Record<Category, Category[]> = {
    song: ['song'],
    drums: ['drums'],
    bass: ['bass'],
    guitar: ['guitar', 'music', 'other', 'piano'],
    piano: ['piano', 'music', 'other', 'guitar'],
    other: ['other', 'music', 'guitar', 'piano'],
    music: ['music', 'other', 'guitar', 'piano'],
    vox1: ['vox1', 'vox2'],
    vox2: ['vox2', 'vox1'],
  };
  const plain = audioModels.filter((t) => !categoryOf(t.name).ref && categoryOf(t.name).category !== 'song');
  const templateFor = (part: StemPart): ModelTrack => {
    const cat = part.role === 'ref' ? 'song' : (categoryOf(part.name).category ?? categoryOf(part.part).category);
    for (const kin of cat ? FAMILY[cat] : []) {
      const found = plain.find((t) => categoryOf(t.name).category === kin) ?? audioModels.find((t) => categoryOf(t.name).category === kin);
      if (found) return found;
    }
    return plain[0] ?? audioModels[0];
  };

  const existing = new Set(original.songs.map((s) => songKey(s.title)));
  const writable = songs.filter((song) => {
    if (!song.parts.some((p) => p.include)) return false;
    if (!opts.fresh && existing.has(songKey(song.title))) {
      notes.push(`${song.title} is already in the set, so it was left out — rename it to add it again`);
      return false;
    }
    return true;
  });
  if (!writable.length) throw new Error('No songs to write.');
  const titles = new Set<string>();
  for (const song of writable) {
    const key = songKey(song.title);
    if (titles.has(key)) throw new Error(`Two songs are called ${song.title}; rename one.`);
    titles.add(key);
  }

  /* ---------------------------- the base set ---------------------------- */

  let base = xml;
  let { blocks } = trackBlocks(base);
  if (opts.fresh) {
    // Every song's group and what is in it goes; every other track keeps its place with its clips taken off.
    const songRoots = new Set(songGroupIds(base, original).values());
    let out = '';
    let at = 0;
    for (const b of blocks) {
      out += base.slice(at, b.start);
      at = b.end;
      if (b.kind !== 'ReturnTrack' && songRoots.has(rootOf(blocks, b.id))) {
        // Take the indentation before it too.
        out = out.replace(/[\t ]*$/, '');
        continue;
      }
      let text = b.text;
      if (b.kind !== 'ReturnTrack') {
        const main = extractBlock(text, /<MainSequencer>/);
        if (main) text = text.slice(0, main.start) + setArrangement(main.text, 'any', null) + text.slice(main.end);
        const freeze = extractBlock(text, /<FreezeSequencer>/);
        if (freeze) text = text.slice(0, freeze.start) + setArrangement(freeze.text, 'any', null) + text.slice(freeze.end);
        text = text.replace(/<AutomationEnvelopes>[\s\S]*?<\/AutomationEnvelopes>/, '<AutomationEnvelopes>' + line(5, '<Envelopes />') + line(4, '</AutomationEnvelopes>'));
      }
      out += text;
    }
    base = out + base.slice(at);
    // No locators, and every envelope on the main track back to where it starts.
    const locators = extractBlock(base, /<Locators>/);
    if (locators) base = base.slice(0, locators.start) + '<Locators>' + line(3, '<Locators />') + line(2, '</Locators>') + base.slice(locators.end);
    const mainTrack = extractBlock(base, /<(?:MainTrack|MasterTrack)>/);
    if (mainTrack) {
      const reset = mainTrack.text.replace(/<Events>([\s\S]*?)<\/Events>/g, (whole, inner: string) => {
        const first = inner.match(/<(?:FloatEvent|EnumEvent|BoolEvent) Id="\d+" Time="-63072000"[^>]*\/>/);
        return first ? `<Events>${line(8, first[0])}${line(7, '</Events>')}` : whole;
      });
      base = base.slice(0, mainTrack.start) + reset + base.slice(mainTrack.end);
    }
    ({ blocks } = trackBlocks(base));
  }
  const project = opts.fresh ? parseAlsXml(base) : original;
  const ids = idMinter(base);

  /* --------------------------- where they go --------------------------- */

  const locatorBeats = [...base.matchAll(/<Locator Id="\d+">[\s\S]*?<Time Value="([-\d.]+)"/g)].map((m) => parseFloat(m[1]));
  const clipEnds = blocks.flatMap((b) => [...b.text.matchAll(/<CurrentEnd Value="([-\d.]+)"/g)].map((m) => parseFloat(m[1])));
  const songEnds = project.songs.map((s) => (s.endBar - 1) * beatsPerBar);
  const lastBeat = Math.max(0, ...locatorBeats, ...clipEnds, ...songEnds);
  const barLine = (beat: number) => Math.ceil(beat / beatsPerBar - 1e-9) * beatsPerBar;
  let cursor = barLine(lastBeat + gap * beatsPerBar);

  const mainTempo = original.tempo;
  const lastSong = [...project.songs].sort((a, b) => b.startBar - a.startBar)[0];
  // A new set starts at its first song's tempo; one added to runs on from the tempo where the set ends.
  const firstBpm = writable[0].bpm ?? mainTempo;
  let lastBpm = opts.fresh ? firstBpm : (lastSong?.tempoChanges.slice(-1)[0]?.bpm ?? lastSong?.startBpm ?? mainTempo);
  if (opts.fresh) {
    base = base.replace(/(<Tempo>[\s\S]{0,200}?<Manual Value=")[\d.]+/, `$1${firstBpm}`);
    const targetId = base.match(/<Tempo>[\s\S]*?<AutomationTarget Id="(\d+)"/)?.[1];
    const envelope = targetId
      ? extractBlock(base, new RegExp(`<AutomationEnvelope Id="\\d+">\\s*<EnvelopeTarget>\\s*<PointeeId Value="${targetId}"`))
      : null;
    if (envelope) {
      const patched = envelope.text.replace(/(<FloatEvent Id="\d+" Time="-63072000" Value=")[\d.]+/, `$1${firstBpm}`);
      base = base.slice(0, envelope.start) + patched + base.slice(envelope.end);
    }
  }

  const clickTrack = clickTrackOf(blocks);

  /* ------------------------------ the clips ------------------------------ */

  let clipsWritten = 0;
  const clipFor = (file: StemFile, clipId: number, startBeat: number, bpm: number): string => {
    clipsWritten++;
    const beats = (file.seconds * bpm) / 60;
    let c = clipTemplate.replace(/^(\s*)<AudioClip Id="\d+" Time="[-\d.]+">/, `$1<AudioClip Id="${clipId}" Time="${startBeat}">`);
    c = sub(c, /<CurrentStart Value="[-\d.]+"/, `<CurrentStart Value="${startBeat}"`, 'clip start');
    c = sub(c, /<CurrentEnd Value="[-\d.]+"/, `<CurrentEnd Value="${startBeat + beats}"`, 'clip end');
    // Unwarped, as the set's own bounces are: the loop is in seconds and the file plays at its own speed.
    c = sub(
      c,
      /<Loop>[\s\S]*?<\/Loop>/,
      '<Loop>' +
        line(11, '<LoopStart Value="0" />') +
        line(11, `<LoopEnd Value="${file.seconds}" />`) +
        line(11, '<StartRelative Value="0" />') +
        line(11, '<LoopOn Value="false" />') +
        line(11, `<OutMarker Value="${file.seconds}" />`) +
        line(11, '<HiddenLoopStart Value="0" />') +
        line(11, `<HiddenLoopEnd Value="${file.seconds}" />`) +
        line(10, '</Loop>'),
      'clip loop',
    );
    c = sub(c, /<Name Value="[^"]*"/, `<Name Value="${esc(file.name.replace(/\.[^.]+$/, ''))}"`, 'clip name');
    c = c.replace(/<Disabled Value="true"/, '<Disabled Value="false"');
    c = sub(c, /<IsWarped Value="(?:true|false)"/, '<IsWarped Value="false"', 'warped flag');
    c = sub(c, /<RelativePathType Value="\d+"/, '<RelativePathType Value="3"', 'path type');
    c = sub(c, /<RelativePath Value="[^"]*"/, `<RelativePath Value="${esc(file.relPath)}"`, 'relative path');
    c = sub(c, /<Path Value="[^"]*"/, `<Path Value="${esc(file.absPath)}"`, 'absolute path');
    c = sub(c, /<OriginalFileSize Value="\d+"/, `<OriginalFileSize Value="${file.size}"`, 'file size');
    c = c.replace(/<OriginalCrc Value="\d+"/, '<OriginalCrc Value="0"');
    c = sub(c, /<LastModDate Value="\d+"/, `<LastModDate Value="${Math.floor(file.modified / 1000)}"`, 'mod date');
    c = sub(c, /<DefaultDuration Value="\d+"/, `<DefaultDuration Value="${file.frames}"`, 'duration');
    c = sub(c, /<DefaultSampleRate Value="\d+"/, `<DefaultSampleRate Value="${file.sampleRate}"`, 'sample rate');
    c = sub(
      c,
      /<WarpMarkers>[\s\S]*?<\/WarpMarkers>|<WarpMarkers \/>/,
      '<WarpMarkers>' +
        line(11, '<WarpMarker Id="0" SecTime="0" BeatTime="0" />') +
        line(11, `<WarpMarker Id="1" SecTime="${file.seconds}" BeatTime="${beats}" />`) +
        line(10, '</WarpMarkers>'),
      'warp markers',
    );
    c = c.replace(/<IsSongTempoLeader Value="true"/, '<IsSongTempoLeader Value="false"');
    c = c.replace(/<Fade Value="true"/, '<Fade Value="false"');
    c = c.replace(/<FadeInLength Value="[^"]*"/, '<FadeInLength Value="0"').replace(/<FadeOutLength Value="[^"]*"/, '<FadeOutLength Value="0"');
    c = c.replace(/<SampleVolume Value="[^"]*"/, '<SampleVolume Value="1"');
    c = c.replace(/<PitchCoarse Value="[^"]*"/, '<PitchCoarse Value="0"').replace(/<PitchFine Value="[^"]*"/, '<PitchFine Value="0"');
    return NL + ids.renumber(c);
  };

  /* ------------------------------ the songs ------------------------------ */

  const built: BuiltSong[] = [];
  const newTracks: string[] = [];
  const clickClips: string[] = [];
  const locators: string[] = [];
  const tempoSteps: { beat: number; bpm: number }[] = [];
  let clickClipId = clickTrack ? Math.max(-1, ...[...clickTrack.text.matchAll(/<AudioClip Id="(\d+)"/g)].map((m) => Number(m[1]))) + 1 : 0;

  const locatorXml = (beat: number, name: string) =>
    T.repeat(4) +
    `<Locator Id="${ids.next()}">` +
    line(5, '<LomId Value="0" />') +
    line(5, `<Time Value="${beat}" />`) +
    line(5, `<Name Value="${esc(name)}" />`) +
    line(5, '<Annotation Value="" />') +
    line(5, '<IsSongStart Value="false" />') +
    line(4, '</Locator>');

  for (const song of writable) {
    const parts = song.parts.filter((p) => p.include);
    const bpm = song.bpm ?? mainTempo;
    if (!song.bpm) notes.push(`${song.title} has no tempo and takes the set's ${mainTempo} BPM`);
    const seconds = Math.max(...parts.map((p) => p.file.seconds));
    const bars = Math.max(1, Math.ceil((seconds * bpm) / 60 / beatsPerBar - 1e-6));
    const start = cursor;
    const end = start + bars * beatsPerBar;

    const groupId = ids.next();
    newTracks.push(ids.renumber(copyTrack(model.group.text, 'GroupTrack', groupId, song.title, '-1')));

    // The model's folders are copied as they are needed, in the model's order, each into its own parent.
    const newIdOf = new Map<string, number>([[model.group.id, groupId]]);
    const byTarget = new Map<string, StemPart[]>();
    const loose: StemPart[] = [];
    let clickOn: string | null = null;
    for (const part of parts) {
      if (part.role === 'click' && clickTrack && part.target === '') {
        clickClips.push(clipFor(part.file, clickClipId++, start, bpm));
        clickOn = clickTrack.name;
        continue;
      }
      const target = audioModels.find((t) => t.name === part.target);
      if (target) {
        const list = byTarget.get(target.id) ?? [];
        list.push(part);
        byTarget.set(target.id, list);
      } else loose.push(part);
    }
    const needed = new Set<string>();
    for (const t of model.inside) {
      if (t.kind !== 'AudioTrack' || !byTarget.has(t.id)) continue;
      for (let p = t.parentId; p !== model.group.id && p !== '-1'; p = model.inside.find((x) => x.id === p)?.parentId ?? '-1') needed.add(p);
    }
    const trackNames: string[] = [];
    const writeTrack = (template: ModelTrack, part: StemPart, parent: number) => {
      const id = ids.next();
      let text = copyTrack(template.text, 'AudioTrack', id, part.name, String(parent));
      // Into the arrangement Live plays, not the freeze's, which has the same shape.
      const main = extractBlock(text, /<MainSequencer>/);
      if (!main) throw new Error(`${template.name} has no arrangement to put a clip in.`);
      text = text.slice(0, main.start) + setArrangement(main.text, 'Sample', clipFor(part.file, 0, start, bpm)) + text.slice(main.end);
      newTracks.push(ids.renumber(text));
      trackNames.push(part.name);
    };
    for (const t of model.inside) {
      const parent = newIdOf.get(t.parentId) ?? groupId;
      if (t.kind === 'GroupTrack') {
        if (!needed.has(t.id)) continue;
        const id = ids.next();
        newIdOf.set(t.id, id);
        newTracks.push(ids.renumber(copyTrack(t.text, 'GroupTrack', id, t.name, String(parent))));
        continue;
      }
      for (const part of byTarget.get(t.id) ?? []) writeTrack(t, part, parent);
    }
    for (const part of loose) {
      const template = templateFor(part);
      // Beside its relation, in the folder that one is in.
      writeTrack(template, part, newIdOf.get(template.parentId) ?? groupId);
    }
    if (!trackNames.length && !clickOn) continue;

    const locator = locatorFor(song, seconds);
    locators.push(locatorXml(start, locator), locatorXml(end, 'AUTOSTOP'));
    if (Math.abs(bpm - lastBpm) > 1e-6) {
      tempoSteps.push({ beat: start, bpm: lastBpm }, { beat: start, bpm });
      lastBpm = bpm;
    }
    built.push({ title: song.title, startBar: start / beatsPerBar + 1, bars, locator, tracks: trackNames, clickOn });
    cursor = barLine(end + gap * beatsPerBar);
  }
  if (!built.length) throw new Error('No songs to write.');
  if (!clickTrack && writable.some((s) => s.parts.some((p) => p.include && p.role === 'click'))) {
    notes.push('the set has no CLICK group, so each click is a track of its own inside its song');
  }

  /* ------------------------------ assembling ------------------------------ */

  let out = base;
  if (clickClips.length && clickTrack) {
    const at = out.indexOf(clickTrack.text);
    const mainAt = clickTrack.text.indexOf('<MainSequencer>');
    const sample = mainAt >= 0 ? clickTrack.text.slice(mainAt).search(/<Sample>\s*<ArrangerAutomation>/) + mainAt : -1;
    const events = sample >= 0 ? extractBlock(clickTrack.text, /<Events(?: \/)?>/, sample) : null;
    if (!events) throw new Error('The click track has no arrangement to put clips in.');
    const inner = events.text.endsWith('/>') ? '' : events.text.slice('<Events>'.length, -'</Events>'.length);
    const track = clickTrack.text.slice(0, events.start) + `<Events>${inner.replace(/\s+$/, '')}${clickClips.join('')}${NL}</Events>` + clickTrack.text.slice(events.end);
    out = out.slice(0, at) + track + out.slice(at + clickTrack.text.length);
  }

  // New tracks go at the end of the track list, before the returns, where songs follow one another.
  const tracksClose = out.indexOf('</Tracks>');
  const returnsAt = out.indexOf('<ReturnTrack Id=');
  const insertAt = returnsAt >= 0 && returnsAt < tracksClose ? out.lastIndexOf(NL, returnsAt) + 1 : out.lastIndexOf(NL, tracksClose) + 1;
  out = out.slice(0, insertAt) + newTracks.map((t) => T.repeat(3) + t.trim() + NL).join('') + out.slice(insertAt);

  // Locators after the set's own; an empty list opened up first.
  out = out.replace(/(<Locators>\s*)<Locators \/>/, `$1<Locators>${line(3, '</Locators>')}`);
  const outer = extractBlock(out, /<Locators>/);
  const innerOpen = outer ? out.indexOf('<Locators>', outer.start + '<Locators>'.length) : -1;
  const innerClose = innerOpen >= 0 ? extractBlock(out, /<Locators>/, innerOpen) : null;
  if (!innerClose) throw new Error('The set has no locators list.');
  const closeAt = innerClose.end - '</Locators>'.length;
  out = out.slice(0, closeAt).replace(/\s*$/, '') + NL + locators.join(NL) + line(3, '') + out.slice(closeAt);

  if (tempoSteps.length) {
    const targetId = out.match(/<Tempo>[\s\S]*?<AutomationTarget Id="(\d+)"/)?.[1];
    const envelope = targetId
      ? extractBlock(out, new RegExp(`<AutomationEnvelope Id="\\d+">\\s*<EnvelopeTarget>\\s*<PointeeId Value="${targetId}"`))
      : null;
    const events = envelope ? extractBlock(envelope.text, /<Events(?: \/)?>/) : null;
    if (envelope && events) {
      const used = [...envelope.text.matchAll(/<\w+Event Id="(\d+)"/g)].map((m) => Number(m[1]));
      let eventId = Math.max(0, ...used) + 1;
      const inner = events.text.endsWith('/>') ? '' : events.text.slice('<Events>'.length, -'</Events>'.length);
      const added = tempoSteps.map((s) => line(8, `<FloatEvent Id="${eventId++}" Time="${s.beat}" Value="${s.bpm}" />`)).join('');
      const patched = envelope.text.slice(0, events.start) + `<Events>${inner.replace(/\s+$/, '')}${added}${line(7, '</Events>')}` + envelope.text.slice(events.end);
      out = out.slice(0, envelope.start) + patched + out.slice(envelope.end);
    } else {
      notes.push("the set has no tempo automation to hold each song's tempo — set them in Live");
    }
  }
  out = out.replace(/<NextPointeeId Value="\d+"/, `<NextPointeeId Value="${ids.value()}"`);

  /* ------------------------------- checking ------------------------------- */

  const after = parseAlsXml(out);
  for (const song of built) {
    const found = after.songs.find((s) => songKey(s.title) === songKey(song.title) && Math.abs(s.startBar - song.startBar) < 1e-6);
    if (!found) throw new Error(`${song.title} did not come out as a song of the set, so nothing was written.`);
    const tracks = found.stems.filter((s) => s.trackId).length;
    if (tracks !== song.tracks.length) throw new Error(`${song.title} came out with ${tracks} tracks where ${song.tracks.length} were written, so nothing was written.`);
  }
  const before = (base.match(/<AudioClip Id=/g) ?? []).length;
  const now = (out.match(/<AudioClip Id=/g) ?? []).length;
  if (now - before !== clipsWritten) throw new Error(`The copy holds ${now - before} new clips where ${clipsWritten} were written, so nothing was written.`);
  return { xml: out, songs: built, notes };
}

/** The set's click track: the first audio track in a group at the root called CLICK. */
function clickTrackOf(blocks: TrackBlock[]): TrackBlock | undefined {
  const group = blocks.find((b) => b.kind === 'GroupTrack' && b.groupId === '-1' && /^click/i.test(b.name.trim()));
  return group ? blocks.find((b) => b.kind === 'AudioTrack' && b.groupId === group.id) : undefined;
}

/** The name of the track a set's clicks go onto, or null when it has none. */
export function clickTrackIn(xml: string): string | null {
  return clickTrackOf(trackBlocks(xml).blocks)?.name ?? null;
}

/** A path from one folder to a file, the way a clip names it. */
export function relativePath(fromDir: string, to: string): string {
  const a = fromDir.replace(/\/+$/, '').split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/**
 * The tempo a click track plays, from its audio.
 *
 * The number beside "Click" in a file's name is a guess by whoever named it:
 * sometimes the tempo, sometimes double it, sometimes neither — "145ish".
 * The clicks themselves are exact. Each is found where the level leaps up
 * out of quiet, and the tempo is the commonest gap between neighbours: an
 * accent or a count-in changes the level, not the gap. A click playing
 * eighths says the eighths' tempo, which is the page's to halve.
 */
export function clickTempo(samples: Float32Array, sampleRate: number): number | null {
  const hop = Math.max(1, Math.round(sampleRate * 0.002));
  const frames = Math.floor(samples.length / hop);
  if (frames < 10) return null;
  const level = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let m = 0;
    const end = Math.min(samples.length, (f + 1) * hop);
    for (let i = f * hop; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > m) m = v;
    }
    level[f] = m;
    if (m > peak) peak = m;
  }
  if (peak <= 0) return null;
  const high = peak * 0.25;
  const low = peak * 0.05;
  const refractory = Math.round(0.08 / (hop / sampleRate));
  const onsets: number[] = [];
  let quiet = true;
  for (let f = 0; f < frames; f++) {
    if (quiet && level[f] >= high && (!onsets.length || f - onsets[onsets.length - 1] >= refractory)) {
      // The exact sample where it starts, within the frame.
      let at = f * hop;
      const end = Math.min(samples.length, at + hop);
      while (at < end && Math.abs(samples[at]) < high) at++;
      onsets.push(at / hop);
      quiet = false;
    } else if (!quiet && level[f] < low) {
      quiet = true;
    }
  }
  if (onsets.length < 4) return null;
  const gaps = onsets.slice(1).map((o, i) => ((o - onsets[i]) * hop) / sampleRate).filter((g) => g > 0.15 && g < 2);
  if (gaps.length < 3) return null;
  /*
   * The commonest gap, to the millisecond, then the mean of the gaps that
   * agree with it. Clicks are made to a tempo map: a count-in a notch slower,
   * a nudge at the bridge. The commonest gap is the song's tempo, and
   * averaging only what agrees with it keeps the count-in out.
   */
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(Math.round(g * 1000), (counts.get(Math.round(g * 1000)) ?? 0) + 1);
  const mode = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] / 1000;
  const agree = gaps.filter((g) => Math.abs(g - mode) <= 0.0012);
  const gap = agree.reduce((sum, g) => sum + g, 0) / agree.length;
  return Math.round((60 / gap) * 100) / 100;
}
