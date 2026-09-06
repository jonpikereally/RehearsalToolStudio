/**
 * Cutting and patching Ableton's XML.
 *
 * Nobody can write Live's schema from scratch and be believed, so everything
 * written into a set is harvested from that same set and patched: a track
 * skeleton, a clip, the ids they hang on. These are the tools for it, shared
 * by everything that edits a set, because the scars are shared too — Live
 * refuses a whole document over one duplicate id, and the id it means may be
 * hiding behind a dotted tag name like `<ControllerTargets.4>`.
 */

export interface Block {
  start: number;
  end: number;
  text: string;
}

/** Cut one whole element out, from the tag `startRe` matches to its balanced close. */
export function extractBlock(xml: string, startRe: RegExp, from = 0): Block | null {
  const m = xml.slice(from).match(startRe);
  if (!m || m.index === undefined) return null;
  const start = from + m.index;
  if (m[0].endsWith('/>')) return { start, end: start + m[0].length, text: m[0] };
  const tag = (m[0].match(/^<([\w.]+)/) ?? [])[1];
  if (!tag) return null;
  const name = tag.replace('.', '\\.');
  const scan = new RegExp(`<${name}(?=[\\s>/])[^>]*?(/?)>|</${name}>`, 'g');
  scan.lastIndex = start;
  let depth = 0;
  for (let mm; (mm = scan.exec(xml)); ) {
    if (mm[0].startsWith('</')) {
      if (--depth === 0) return { start, end: scan.lastIndex, text: xml.slice(start, scan.lastIndex) };
    } else if (!mm[1]) {
      depth++;
    }
  }
  return null;
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Replace only the first match, and insist there was one. */
export function sub(chunk: string, re: RegExp, replacement: string, what: string): string {
  if (!re.test(chunk)) throw new Error(`nothing to patch for ${what}`);
  return chunk.replace(re, replacement);
}

/**
 * The document's id counter, and fresh numbers from it.
 *
 * Every kind of target, `<Pointee>` and the dotted `ControllerTargets.N`
 * variants share one namespace that must be unique document-wide and below
 * NextPointeeId. Cloning a skeleton copies its ids, so each copy is renumbered
 * on the way in.
 */
export function idMinter(xml: string): { next: () => number; renumber: (chunk: string) => string; value: () => number } {
  const found = xml.match(/<NextPointeeId Value="(\d+)"/);
  if (!found) throw new Error('The set has no NextPointeeId — is this a Live set?');
  let id = Number(found[1]);
  return {
    next: () => id++,
    renumber: (chunk) =>
      chunk.replace(/<([\w.]*Target[\w.]*|Pointee) Id="\d+"/g, (_, tag: string) => `<${tag} Id="${id++}"`),
    value: () => id,
  };
}

/**
 * Where a new top-level track goes: the top of the track list.
 *
 * Live shows tracks in the order the file lists them, and a track the
 * studio adds — slates, chords, song info — is the one somebody opens the
 * copy to look at. At the top it is the first thing seen; at the bottom it
 * was under every stem of every song, which is where nobody looks. The
 * track carries no group, so the top of the list is where it lands.
 */
export function trackInsertPoint(xml: string): number {
  const tracksOpen = xml.indexOf('<Tracks>');
  if (tracksOpen < 0) throw new Error('The set has no Tracks section.');
  const lineEnd = xml.indexOf('\n', tracksOpen);
  return lineEnd < 0 ? tracksOpen + '<Tracks>'.length : lineEnd + 1;
}

/**
 * Every track the studio adds to a copy of a set is named to say so. The
 * copy is never the set; what is in it is meant to be dragged into the
 * real one, and a track called "ADD THIS Chords +LYRICS" says exactly what
 * to do with it, however long the copy sits beside the original.
 */
export const ADD_THIS = 'ADD THIS';

export function addThis(name: string): string {
  return new RegExp(`^${ADD_THIS}\\b`, 'i').test(name.trim()) ? name.trim() : `${ADD_THIS} ${name.trim()}`;
}

/** Strip a cloned track of the handles and envelopes belonging to its original, and name it. */
export function cleanTrack(track: string, name: string): string {
  const named = addThis(name);
  let out = sub(track, /<EffectiveName Value="[^"]*"/, `<EffectiveName Value="${esc(named)}"`, 'track name');
  out = sub(out, /<UserName Value="[^"]*"/, `<UserName Value="${esc(named)}"`, 'track user name');
  out = sub(out, /<TrackGroupId Value="-?\d+"/, '<TrackGroupId Value="-1"', 'track group');
  out = out.replace(/<LomId Value="\d+"/g, '<LomId Value="0"');
  return out.replace(
    /<AutomationEnvelopes>[\s\S]*?<\/AutomationEnvelopes>/,
    '<AutomationEnvelopes>\n\t\t\t\t\t<Envelopes />\n\t\t\t\t</AutomationEnvelopes>',
  );
}

/** What an attribute value said before it was escaped. */
function unesc(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * A copy with only the tracks a tool added.
 *
 * The copy exists to be opened beside the real set and its new tracks
 * dragged across; the set's own tracks in it are dead weight, and a copy
 * the size of the set is slow to open and easy to mistake for it. So every
 * track goes except the ones named ADD THIS — and any named in `keep`, for
 * a tool that put its clips on a track the set already had — and the
 * return tracks, which every track's sends are counted against and which
 * weigh nothing. The master track, the locators, the tempo and everything
 * else on the timeline are outside the track list and untouched. A kept
 * track is taken out of whatever group it sat in, since the group is gone.
 */
export function keepOnlyAdded(xml: string, keep: string[] = []): { xml: string; kept: number; removed: number } {
  const tracks = extractBlock(xml, /<Tracks>/);
  if (!tracks) throw new Error('The set has no track list.');
  const wanted = new Set(keep.map((n) => n.trim().toLowerCase()));
  const added = new RegExp(`^${ADD_THIS}\\b`, 'i');
  const inner = tracks.text;
  let out = '';
  let at = 0;
  let kept = 0;
  let removed = 0;
  for (;;) {
    const block = extractBlock(inner, /<(?:AudioTrack|MidiTrack|GroupTrack|ReturnTrack) Id="\d+"[^>]*>/, at);
    if (!block) break;
    const kind = block.text.match(/^<(\w+)/)?.[1] ?? '';
    const name = unesc(block.text.match(/<EffectiveName Value="([^"]*)"/)?.[1] ?? '').trim();
    out += inner.slice(at, block.start);
    if (kind === 'ReturnTrack') {
      kept++;
      out += block.text;
    } else if (added.test(name) || wanted.has(name.toLowerCase())) {
      kept++;
      out += block.text.replace(/<TrackGroupId Value="-?\d+"/, '<TrackGroupId Value="-1"');
    } else {
      removed++;
    }
    at = block.end;
  }
  out += inner.slice(at);
  return { xml: xml.slice(0, tracks.start) + out + xml.slice(tracks.end), kept, removed };
}
