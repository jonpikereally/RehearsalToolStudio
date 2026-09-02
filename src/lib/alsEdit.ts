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

/** Where a new top-level track goes: before the returns, else at the end. */
export function trackInsertPoint(xml: string): number {
  const tracksClose = xml.indexOf('</Tracks>');
  if (tracksClose < 0) throw new Error('The set has no Tracks section.');
  const firstReturn = xml.indexOf('<ReturnTrack Id=');
  return firstReturn >= 0 && firstReturn < tracksClose
    ? xml.lastIndexOf('\n', firstReturn) + 1
    : xml.lastIndexOf('\n', tracksClose) + 1;
}

/** Strip a cloned track of the handles and envelopes belonging to its original. */
export function cleanTrack(track: string, name: string): string {
  let out = sub(track, /<EffectiveName Value="[^"]*"/, `<EffectiveName Value="${esc(name)}"`, 'track name');
  out = sub(out, /<UserName Value="[^"]*"/, `<UserName Value="${esc(name)}"`, 'track user name');
  out = sub(out, /<TrackGroupId Value="-?\d+"/, '<TrackGroupId Value="-1"', 'track group');
  out = out.replace(/<LomId Value="\d+"/g, '<LomId Value="0"');
  return out.replace(
    /<AutomationEnvelopes>[\s\S]*?<\/AutomationEnvelopes>/,
    '<AutomationEnvelopes>\n\t\t\t\t\t<Envelopes />\n\t\t\t\t</AutomationEnvelopes>',
  );
}
