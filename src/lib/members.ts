import * as local from './localSource.ts';
import { RIG_FILES_FOLDER, parseMemberRig } from './rigFiles.ts';
import { folderBaseOf, isManifestName, setFolderOf, type PreparedPart } from './preparedSet.ts';
import { isPreparedSet } from './prints.ts';

/**
 * The band, and what each of them wants on a fader of their own.
 *
 * A phone holding eight parts per song holds eight files and decodes eight
 * files, when the person carrying it plays one of them and needs the rest as
 * a single thing to play along to. So the studio writes that single thing:
 * one submix per member per song, everything they are not keeping separate,
 * summed here from the multitrack rather than on the phone from the stems.
 *
 * Who the band are is already known — the website writes a rig file per
 * member into each prepared set — but what each of them keeps separate is
 * theirs to say, so it is kept here, once per band, beside the sets.
 */

/** At the root of the band's folder, beside Sets/ and Resources/. */
export const MEMBERS_FILE = 'members.json';

export interface MemberMix {
  /** Their name, spelled as the rig files spell it: that is how they are matched. */
  member: string;
  /**
   * The part labels they keep on their own faders. Everything else in the
   * song is summed into their submix — the record itself excepted, which is
   * never in one.
   */
  keeps: string[];
  /** Set while a member is in the band but wants no submix written. */
  off?: boolean;
}

/**
 * The click and the cues are never in a submix, whoever it is for.
 *
 * They are the set's own timekeeping, not something to play along to, and a
 * click summed into the thing a member plays against is a click they can
 * never turn down. Usually they are sampler parts and could not be summed
 * anyway; a set that renders them as audio is the case this is for.
 */
const CLICK_OR_CUE = /^(?:the\s+)?(?:click|clicks|cue|cues|click\s*track|cue\s*track|count[\s-]*ins?)(?:\s*\d+)?$/i;

export const isClickOrCue = (name: string): boolean => CLICK_OR_CUE.test(clean(name));

/**
 * A whole song rather than a part of one: the record the band play against,
 * or their own full bounce. Never in a submix, whoever it is for — summing a
 * whole song into a submix puts everything in it twice — and so never a part
 * anybody has to decide about.
 */
const WHOLE_SONG = /^(?:the\s+)?(?:ref(?:erence)?\s+)?(?:song|master|record|original|full(?:\s*mix)?|mix)$/i;

export const isWholeSong = (name: string): boolean => WHOLE_SONG.test(clean(name));

/**
 * What a member keeps when nobody has said: nothing beyond the click and the
 * cues, which are kept out whatever anybody says. What they play is theirs to
 * add — the studio would have to guess an instrument from a name, and a wrong
 * guess sums the guitarist's guitar into the thing they play along to, which
 * is worse than asking.
 */
export const DEFAULT_KEEPS: string[] = [];

const clean = (text: string) => text.trim().replace(/\s+/g, ' ');
const same = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();

/** One member as read back, or null when the entry isn't one. */
export function parseMember(raw: unknown): MemberMix | null {
  if (!raw || typeof raw !== 'object') return null;
  const { member, keeps, off } = raw as Record<string, unknown>;
  if (typeof member !== 'string' || !member.trim()) return null;
  const list = Array.isArray(keeps) ? keeps.filter((k): k is string => typeof k === 'string' && !!k.trim()) : DEFAULT_KEEPS;
  return {
    member: clean(member),
    // The click and the cues are never in a submix, so keeping them is not a
    // choice anybody has to make, and a list saying so is a list to tidy.
    keeps: [...new Set(list.map(clean))].filter((keep) => !isClickOrCue(keep) && !isWholeSong(keep)),
    ...(off === true ? { off: true } : {}),
  };
}

export function parseMembers(raw: unknown): MemberMix[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { members?: unknown })?.members) ? (raw as { members: unknown[] }).members : [];
  const out: MemberMix[] = [];
  for (const item of list) {
    const member = parseMember(item);
    // One entry per person: a name written twice is one member, the last said.
    if (member && !out.some((m) => same(m.member, member.member))) out.push(member);
  }
  return out;
}

/** The band as the studio has them, or an empty list when none are set. */
export async function readMembers(band: local.FolderHandle): Promise<MemberMix[]> {
  const doc = await local.readJson<unknown>(band, '', MEMBERS_FILE).catch(() => null);
  return doc?.data ? parseMembers(doc.data) : [];
}

export async function writeMembers(band: local.FolderHandle, members: MemberMix[]): Promise<void> {
  const body = { writtenBy: 'rehearsaltool', writtenAt: new Date().toISOString(), members };
  await local.writeFile(band, '', MEMBERS_FILE, new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
}

/**
 * The names the band's rig files carry, for a band whose members have never
 * been listed here. The website writes one per member per prepared set, so
 * these are the people who have actually set something up.
 */
export async function membersFromRigs(band: local.FolderHandle): Promise<string[]> {
  const files = await local.listFiles(band, '');
  const rigs = files.filter((f) => isPreparedSet(f.path) && /\.json$/i.test(f.name) && !isManifestName(f.name)
    && f.path.toLowerCase().includes(`/${RIG_FILES_FOLDER.toLowerCase()}/`));
  const names: string[] = [];
  for (const file of rigs) {
    try {
      const { bytes } = await local.readBytes(band, '', file.path);
      const rig = parseMemberRig(JSON.parse(new TextDecoder().decode(bytes)));
      if (rig && !names.some((n) => same(n, rig.member))) names.push(rig.member);
    } catch {
      // A rig file that will not parse names nobody.
    }
  }
  // Newest set first is no order to read a band in; alphabetical is.
  return names.sort((a, b) => a.localeCompare(b));
}

/** Which prepared set a rig file belongs to, for saying where a name came from. */
export const setOfRig = (path: string): string => setFolderOf(path.slice(0, path.lastIndexOf('/')));

/** Whether a part label is one this member keeps on a fader of their own. */
export function keepsPart(member: MemberMix, label: string): boolean {
  return member.keeps.some((keep) => same(keep, label));
}

/**
 * What a member's submix should fold in, read off a song as it was prepared.
 *
 * The same rule the render follows, over the manifest's own parts rather than
 * the set's tracks: everything but what they keep, the record, and the click
 * and cues, which are patterns striking samples. Empty when there would be
 * fewer than two parts in it, which is not worth a file.
 */
export function expectedSubmixOf(parts: PreparedPart[], member: MemberMix): string[] {
  if (member.off) return [];
  const folded = parts.filter(
    (part) => !part.hidden && !part.record && part.role !== 'mix' && part.kind !== 'sampler'
      && !isClickOrCue(part.name) && !isClickOrCue(part.label)
      && !isWholeSong(part.name) && !isWholeSong(part.label)
      && !keepsPart(member, part.name) && !keepsPart(member, part.label),
  );
  return folded.length < 2 ? [] : folded.map((part) => part.name);
}

/** Where one prepared song stands for one member. */
export type SubmixState = 'ready' | 'missing';

/**
 * Whether the song already holds the submix this member needs. By contents:
 * a submix is the parts in it, so one written for somebody else who keeps the
 * same things is this member's submix too.
 */
export function submixState(parts: PreparedPart[], member: MemberMix): SubmixState {
  const want = expectedSubmixOf(parts, member);
  if (!want.length) return 'ready';
  return parts.some((part) => part.submixOf && sameParts(part.submixOf, want)) ? 'ready' : 'missing';
}

/** Submixes in a song that no member's list asks for any more. */
export function spareSubmixes(parts: PreparedPart[], members: MemberMix[]): string[] {
  const wanted = members.map((member) => expectedSubmixOf(parts, member)).filter((list) => list.length);
  return parts
    .filter((part) => part.submixOf?.length && !wanted.some((want) => sameParts(part.submixOf!, want)))
    .map((part) => part.name);
}

/**
 * Which prepared songs are behind the band as it now stands: one written for
 * nobody, one written from a list that has changed, one never written at all.
 * A song prepared before parts were listed says nothing and is left alone.
 */
export function submixesBehind(
  songs: { title?: string; folder: string; parts?: PreparedPart[] }[],
  members: MemberMix[],
): { title: string; who: string[] }[] {
  const out: { title: string; who: string[] }[] = [];
  for (const song of songs) {
    if (!song.parts?.length) continue;
    const who = members.filter((member) => submixState(song.parts!, member) === 'missing').map((m) => m.member);
    // A submix nobody's list asks for any more is behind too: the song is
    // carrying a file for a band that has moved on.
    const spare = spareSubmixes(song.parts, members);
    if (who.length || spare.length) out.push({ title: song.title ?? folderBaseOf(song.folder), who });
  }
  return out;
}

/**
 * Where a song's submixes sit: a folder of their own inside the song's.
 *
 * They are parts like any other and could sit beside the stems, but a song
 * folder of eight stems and four submixes is a folder nobody can read at a
 * glance — the things the band play are lost among the things the studio
 * summed for them. The manifest names each one by its path from the song
 * folder, so nothing has to guess where they are.
 */
export const SUBMIX_FOLDER = 'submixes';

/**
 * What a submix is called: the parts inside it, not the person it was worked
 * out for.
 *
 * `Fix You [submix drums+bass+keys].mp3`. A submix is a sum of parts and
 * nothing else — two members who keep the same things want the same file, and
 * a file named for one of them is a file the other has to be told about. Named
 * for its contents it is worth having to anybody who wants that combination,
 * and the same combination is the same file however many people it is for.
 *
 * A long list is cut short and marked with a few letters of its own hash, so
 * a song with a dozen parts still gets a name a file system and a person can
 * both hold, and two different lists can never come out alike.
 */
const LABEL_ROOM = 52;

export function submixLabel(parts: string[]): string {
  const names = parts.map((p) => clean(p).toLowerCase());
  const full = names.join('+');
  if (full.length <= LABEL_ROOM) return `submix ${full}`;
  let short = '';
  for (const name of names) {
    if (short.length + name.length + 1 > LABEL_ROOM - 6) break;
    short += (short ? '+' : '') + name;
  }
  return `submix ${short || `${names.length} parts`}+${digest(full)}`;
}

/** Four letters that stand for a list, so two lists never share a name. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 4).padStart(4, '0');
}

/** Whether two lists of part names are the same list, in any order. */
export const sameParts = (a: string[], b: string[]): boolean =>
  a.length === b.length
  && [...a].map((n) => clean(n).toLowerCase()).sort().join('|') === [...b].map((n) => clean(n).toLowerCase()).sort().join('|');

/** Whether a file name is a submix rather than a stem, wherever it is read. */
export const isSubmixFile = (name: string): boolean => /\[\s*submix\b[^\]]*\]/i.test(name);
