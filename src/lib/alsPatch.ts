import type { Patch, PatchClip } from '../types';

/**
 * Patch changes, written into an Ableton set as locators.
 *
 * A set is where the arrangement lives, so the changes that go with it belong
 * there too — visible in Ableton, and read back on the next scan the way songs
 * and setlists already are.
 *
 * A locator is only a name at a point in time, so the name carries everything:
 * what it is in words, then the message in brackets. Both halves matter. The
 * words are what you read at a glance in the arrangement; the brackets are what
 * comes back in one piece on the next scan.
 *
 *   *rig Helix FS3 on [ch1 cc51=127 len8 > cc51=0]
 *
 * The leading `*` is AbleSet's mark for a locator that isn't a song, which our
 * own reader already skips — so these can't be mistaken for the start of a song
 * by either.
 */

const PREFIX = '*rig ';

/** The name Ableton shows, carrying enough to rebuild the clip exactly. */
export function rigLocatorName(clip: PatchClip): string {
  const words = clip.patch.source ?? 'patch change';
  const parts = [describeForName(clip.patch)];
  if (clip.lengthBars) parts.push(`len${clip.lengthBars}`);
  if (clip.endPatch) parts.push(`> ${messagesOf(clip.endPatch).join(' ')}`);
  return `${PREFIX}${words} [${parts.join(' ')}]`;
}

export function isRigLocator(name: string): boolean {
  return name.trimStart().toLowerCase().startsWith(PREFIX.trim().toLowerCase() + ' ');
}

const messagesOf = (patch: Patch): string[] => {
  const parts: string[] = [];
  if (patch.bank !== undefined) parts.push(`bk${patch.bank}`);
  if (patch.program !== undefined) parts.push(`pc${patch.program}`);
  for (const c of patch.controls ?? []) parts.push(`cc${c.cc}=${c.value}`);
  return parts;
};

const describeForName = (patch: Patch): string =>
  [`ch${patch.channel}`, ...messagesOf(patch)].join(' ');

/**
 * Read one back.
 *
 * Anything that doesn't parse returns null rather than a half-built patch — a
 * locator someone edited by hand into nonsense should be left alone in the set,
 * not turned into a message the rig will act on.
 */
export function parseRigLocator(name: string): Omit<PatchClip, 'id' | 'bar'> | null {
  if (!isRigLocator(name)) return null;
  const inside = name.slice(name.indexOf('[') + 1, name.lastIndexOf(']'));
  if (name.indexOf('[') < 0 || name.lastIndexOf(']') < 0) return null;

  const [startPart, endPart] = inside.split('>');
  const words = name.slice(PREFIX.length, name.indexOf('[')).trim();

  const channel = Number((startPart.match(/\bch(\d+)\b/) ?? [])[1]);
  if (!Number.isFinite(channel) || channel < 1 || channel > 16) return null;

  const patch = readMessages(startPart, channel, words);
  if (!patch) return null;

  const length = Number((startPart.match(/\blen(\d+)\b/) ?? [])[1]);
  const endPatch = endPart ? readMessages(endPart, channel) : undefined;

  return {
    patch,
    ...(Number.isFinite(length) && length > 0 ? { lengthBars: length } : {}),
    ...(endPatch ? { endPatch } : {}),
  };
}

function readMessages(text: string, channel: number, source?: string): Patch | null {
  const patch: Patch = { channel };
  const bank = Number((text.match(/\bbk(\d+)\b/) ?? [])[1]);
  if (Number.isFinite(bank)) patch.bank = bank;
  const program = Number((text.match(/\bpc(\d+)\b/) ?? [])[1]);
  if (Number.isFinite(program)) patch.program = program;

  const controls = [...text.matchAll(/\bcc(\d+)=(\d+)\b/g)].map((m) => ({
    cc: Number(m[1]),
    value: Number(m[2]),
  }));
  if (controls.length) patch.controls = controls;

  // A patch that says nothing is not a patch.
  if (patch.bank === undefined && patch.program === undefined && !patch.controls) return null;
  if (source) patch.source = source;
  return patch;
}

/* ------------------------------- file naming ------------------------------ */

/** What the app calls the set it writes, so it can't be mistaken for yours. */
export const COPY_SUFFIX = ' (rehearsaltool)';

export function rehearsalCopyPath(alsPath: string): string {
  return `${alsPath.replace(/\.als$/i, '')}${COPY_SUFFIX}.als`;
}

/**
 * The set a path stands for, whether it's the original or the app's copy.
 *
 * Song ids are built from the set's path, so without this a copy would arrive
 * as a second set full of new songs — losing every tempo, key and setlist
 * entry pinned to the originals.
 */
export function canonicalAlsPath(alsPath: string): string {
  return alsPath.replace(new RegExp(`${COPY_SUFFIX.replace(/[()]/g, '\\$&')}(\\.als)$`, 'i'), '$1');
}

export function isRehearsalCopy(alsPath: string): boolean {
  return canonicalAlsPath(alsPath) !== alsPath;
}

/* -------------------------------- rewriting ------------------------------- */

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Put a set of rig locators into a set's XML, replacing any already there.
 *
 * The new elements are **cloned from a locator already in this file** rather
 * than written from a template of our own. Live's XML has changed shape between
 * versions and carries children we have no business guessing at; copying one
 * the file already contains means the result matches whatever wrote it.
 *
 * Returns null when there is no locator to copy — a set with none is also a set
 * with no songs, so there is nothing to write changes for anyway.
 */
export function writeRigLocators(
  xml: string,
  entries: { beat: number; name: string }[],
): string | null {
  const all = [...xml.matchAll(/<Locator Id="(\d+)">([\s\S]*?)<\/Locator>/g)];
  if (!all.length) return null;

  // Drop what we wrote last time, so writing twice doesn't stack up.
  let out = xml;
  for (const match of all) {
    const name = (match[2].match(/<Name Value="([^"]*)"/) ?? [])[1] ?? '';
    if (isRigLocator(name)) out = out.replace(match[0], '');
  }
  if (!entries.length) return out;

  const kept = [...out.matchAll(/<Locator Id="(\d+)">([\s\S]*?)<\/Locator>/g)];
  const template = kept[0]?.[0] ?? all[0][0];
  let nextId = Math.max(...all.map((m) => Number(m[1])), 0) + 1;

  const added = entries
    .map(({ beat, name }) =>
      template
        .replace(/<Locator Id="\d+">/, `<Locator Id="${nextId++}">`)
        .replace(/<Time Value="[^"]*"/, `<Time Value="${beat}"`)
        .replace(/<Name Value="[^"]*"/, `<Name Value="${escapeAttr(name)}"`)
        .replace(/<Annotation Value="[^"]*"/, '<Annotation Value=""'),
    )
    .join('\n');

  // After the last one, which puts them inside whatever container holds them
  // without having to know how that container is nested in this Live version.
  const at = out.lastIndexOf('</Locator>');
  if (at < 0) return null;
  const end = at + '</Locator>'.length;
  return `${out.slice(0, end)}\n${added}${out.slice(end)}`;
}
