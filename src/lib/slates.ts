/**
 * Spoken slates and cues for a set: what to say, and who says it.
 *
 * The browser's own speech cannot be written to a file (see spokenCues.ts), so
 * the voice lives in a small helper on the studio machine — `npm run
 * slates:helper` — which wraps macOS's `say` and its downloaded premium
 * voices. This module decides the texts from a parsed set and talks to that
 * helper; the panel in Settings does the downloading.
 */

import type { AlsProject } from './alsParser';

/** Where the helper listens. Loopback only — the voice is this machine's. */
export const HELPER_URL = 'http://127.0.0.1:5175';

/**
 * One slate per song, in set order.
 *
 * Consecutive locators with one name are one song — a count-in locator repeats
 * the title just ahead of the downbeat — so they collapse here exactly as the
 * player collapses them.
 */
export function slateTitles(project: AlsProject): string[] {
  const titles: string[] = [];
  for (const song of project.songs) {
    if (titles[titles.length - 1] !== song.title) titles.push(song.title);
  }
  return titles;
}

/**
 * Every distinct section name in the set, in first-appearance order. "Chorus"
 * is the same word in every song, so one file serves them all.
 */
export function cueSections(project: AlsProject): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const song of project.songs) {
    for (const section of song.sections) {
      const name = section.text.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/** What the voice should actually say: underscores are spacing, not words. */
export function speakable(text: string): string {
  return text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A file name the filesystem will take, keeping the text recognisable. */
export function slateFileName(text: string): string {
  const safe = text.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return `${safe || 'slate'}.wav`;
}

export interface HelperVoice {
  name: string;
  lang: string;
}

/**
 * The voice worth defaulting to: the best one the machine has bothered to
 * download. Premium beats Enhanced beats Samantha beats whatever is first.
 */
export function defaultVoice(voices: HelperVoice[]): string {
  const english = voices.filter((v) => v.lang.startsWith('en'));
  const pool = english.length ? english : voices;
  return (
    pool.find((v) => /premium/i.test(v.name))?.name ??
    pool.find((v) => /enhanced/i.test(v.name))?.name ??
    pool.find((v) => v.name === 'Samantha')?.name ??
    pool[0]?.name ??
    ''
  );
}

/** null when the helper isn't running, which the panel treats as its cue to say how to start it. */
export async function helperVoices(): Promise<HelperVoice[] | null> {
  try {
    const res = await fetch(`${HELPER_URL}/voices`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { voices?: HelperVoice[] };
    return body.voices ?? [];
  } catch {
    return null;
  }
}

export async function synthesize(text: string, voice: string): Promise<Uint8Array> {
  const res = await fetch(`${HELPER_URL}/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error(`the helper refused: ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}
