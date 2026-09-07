import * as local from './localSource.ts';
import { RIG_FILES_FOLDER, parseMemberRig } from './rigFiles.ts';
import { isManifestName, setFolderOf } from './preparedSet.ts';
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
 * What a member keeps when nobody has said: the click and the cues, which are
 * a phone's own metronome and nothing to play along to. What they play is
 * theirs to add — the studio would have to guess an instrument from a name,
 * and a wrong guess sums the guitarist's guitar into the thing they play
 * along to, which is worse than asking.
 */
export const DEFAULT_KEEPS = ['click', 'cues'];

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
    keeps: [...new Set(list.map(clean))],
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

/** `Fix You [submix alex].mp3` — the label a member's submix carries. */
export const submixLabel = (member: string): string => `submix ${clean(member).toLowerCase()}`;

/** Whether a file name is a submix rather than a stem, wherever it is read. */
export const isSubmixFile = (name: string): boolean => /\[\s*submix\b[^\]]*\]/i.test(name);
