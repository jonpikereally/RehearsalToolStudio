/**
 * A song's lyric file, found in the lyrics folder by its title.
 *
 * Folders of lyrics are named every which way — "Fix You.txt", "03 Fix You
 * - Coldplay.docx", "fix_you (final).pdf" — so a name is matched on its
 * words: the same words as the title, or the title's words in a row inside
 * it. Of several, the plainest kind of file wins, then the shortest name.
 */

/** The kinds of file read for lyrics, plainest first. */
export const LYRIC_FILE_KINDS = ['txt', 'text', 'lrc', 'cho', 'chopro', 'chordpro', 'pro', 'crd', 'docx', 'doc', 'rtf', 'odt', 'pdf', 'pages'];

export interface LyricFileEntry {
  /** Where it is inside the lyrics folder. */
  path: string;
  name: string;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The files in a folder that are lyric files, one per document: a Pages
 * document can be a folder of its own, listed as the files inside it, and is
 * taken as the one document it is.
 */
export function lyricFilesIn(files: { path: string; name: string }[]): LyricFileEntry[] {
  const seen = new Map<string, LyricFileEntry>();
  for (const f of files) {
    const pkg = /^(.*?\.pages)\//i.exec(f.path);
    const path = pkg ? pkg[1] : f.path;
    const name = path.split('/').pop() ?? path;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (name.includes('.') && LYRIC_FILE_KINDS.includes(ext) && !seen.has(path)) seen.set(path, { path, name });
  }
  return [...seen.values()];
}

/** The lyric file for a song, or null. */
export function lyricFileFor(title: string, files: LyricFileEntry[]): LyricFileEntry | null {
  // A title's own brackets — "(Live)", "[Acoustic]" — are left out of the match.
  const want = words(title.replace(/[([][^)\]]*[)\]]/g, ' '));
  if (!want.length) return null;
  const rank = (f: LyricFileEntry): number | null => {
    const stem = f.name.replace(/\.[^.]+$/, '');
    const have = words(stem);
    const kind = LYRIC_FILE_KINDS.indexOf(f.name.split('.').pop()!.toLowerCase());
    if (have.join(' ') === want.join(' ')) return kind;
    for (let i = 0; i + want.length <= have.length; i++) {
      if (want.every((w, j) => have[i + j] === w)) return 100 + kind;
    }
    return null;
  };
  let best: { f: LyricFileEntry; r: number } | null = null;
  for (const f of files) {
    const r = rank(f);
    if (r === null) continue;
    if (!best || r < best.r || (r === best.r && f.name.length < best.f.name.length)) best = { f, r };
  }
  return best?.f ?? null;
}
