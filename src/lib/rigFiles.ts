import type { AlsProject } from './alsParser';
import type { Patch, PatchClip } from '../types';
import { songFolderName } from './prepare.ts';
import type { RigTrackSpec } from './rigTrack.ts';

/**
 * A band member's patch changes, as the website writes them.
 *
 * Each member drives their own rig from their own laptop, and sets their
 * own changes on the website; it writes them into the band's folder, one
 * file per member per prepared set, under `Sets/<set>/rigs/`. The studio
 * reads those and puts them into a copy of the set as MIDI clips, one
 * track per member, for the leader to drag into the real set. The next
 * prepare then reads them back as the set's own, and the loop is closed.
 *
 * Keyed by song folder, as everything in a prepared set is, with bars
 * counted from the song's own first bar. The patch is the shape the
 * manifest already uses, so the website reads and writes one thing.
 */

export const RIG_FILES_FOLDER = 'rigs';

export interface MemberChange {
  /** 1-based bar within the song. */
  bar: number;
  name?: string;
  patch: Patch;
}

export interface MemberRig {
  member: string;
  rig?: string;
  updatedAt?: string;
  /** By song folder name, as the manifest names songs. */
  songs: Record<string, MemberChange[]>;
}

const isPatch = (p: unknown): p is Patch => {
  if (!p || typeof p !== 'object') return false;
  const { channel, program, bank, controls } = p as Record<string, unknown>;
  if (typeof channel !== 'number' || channel < 1 || channel > 16) return false;
  if (program !== undefined && typeof program !== 'number') return false;
  if (bank !== undefined && typeof bank !== 'number') return false;
  if (controls !== undefined) {
    if (!Array.isArray(controls)) return false;
    if (!controls.every((c) => c && typeof c === 'object' && typeof (c as { cc?: unknown }).cc === 'number' && typeof (c as { value?: unknown }).value === 'number')) return false;
  }
  return true;
};

/** A member file read back, or null when it isn't one. */
export function parseMemberRig(raw: unknown): MemberRig | null {
  if (!raw || typeof raw !== 'object') return null;
  const { member, rig, updatedAt, songs } = raw as Record<string, unknown>;
  if (typeof member !== 'string' || !member.trim()) return null;
  if (!songs || typeof songs !== 'object') return null;
  const out: MemberRig = { member: member.trim(), songs: {} };
  if (typeof rig === 'string' && rig.trim()) out.rig = rig.trim();
  if (typeof updatedAt === 'string') out.updatedAt = updatedAt;
  for (const [folder, list] of Object.entries(songs as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const changes: MemberChange[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const { bar, name, patch } = item as Record<string, unknown>;
      if (typeof bar !== 'number' || !Number.isFinite(bar) || !isPatch(patch)) continue;
      changes.push({ bar, ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}), patch });
    }
    out.songs[folder] = changes;
  }
  return out;
}

/**
 * A member's changes as a track for the set: song bars onto the set's
 * ruler, by matching each file entry to the song whose folder it names.
 * `only` keeps to the songs being worked on; a song the set no longer has
 * is left out and named.
 */
export function rigTrackSpecFor(
  file: MemberRig,
  project: AlsProject,
  only?: Set<string>,
): { spec: RigTrackSpec; unknownFolders: string[] } {
  const byFolder = new Map<string, (typeof project.songs)[number]>();
  for (const song of project.songs) {
    const folder = songFolderName(song, project).toLowerCase();
    if (!byFolder.has(folder)) byFolder.set(folder, song);
  }
  const changes: RigTrackSpec['changes'] = [];
  const unknownFolders: string[] = [];
  for (const [folder, list] of Object.entries(file.songs)) {
    const song = byFolder.get(folder.toLowerCase());
    if (!song) {
      if (list.length) unknownFolders.push(folder);
      continue;
    }
    if (only && !only.has(song.title)) continue;
    for (const change of list) {
      changes.push({
        bar: song.startBar + (change.bar - 1),
        name: change.name ?? `${file.member}: bar ${change.bar}`,
        patch: { ...change.patch, source: change.patch.source ?? `${file.member}${file.rig ? ` (${file.rig})` : ''}` },
      });
    }
  }
  return { spec: { member: file.member, rig: file.rig, changes }, unknownFolders };
}

/**
 * The studio's own changes for a song — programmed in the player, not
 * read from the set — as changes on the set's ruler, for a track of the
 * leader's own.
 */
export function studioChanges(
  clips: PatchClip[],
  startBar: number,
  isFromSet: (clip: PatchClip) => boolean,
): RigTrackSpec['changes'] {
  return clips
    .filter((c) => !isFromSet(c))
    .map((c) => ({ bar: startBar + (c.bar - 1), name: c.patch.source ?? 'patch change', patch: c.patch }));
}
