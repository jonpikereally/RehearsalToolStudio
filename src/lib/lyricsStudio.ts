/**
 * Finding Lyrics Studio.
 *
 * It is its own local server, and its home is port 8765 — but a port is not a
 * name. Another app on this Mac took to listening on 8765, and for a while
 * every "is Lyrics Studio running?" was answered by a light controller. So
 * the server steps to the next free port when it has to, names itself in its
 * version answer, and this asks a short run of ports which of them is really
 * it. A stranger's port fails the check (or, cross-origin, can't be read at
 * all), and a closed one fails at once.
 */

const HOME = 8765;
const PORTS = Array.from({ length: 11 }, (_, i) => HOME + i);

async function isLyricsStudio(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const answer = (await res.json()) as { app?: string };
    return answer.app === 'lyrics-studio';
  } catch {
    return false;
  }
}

/** The base URL Lyrics Studio answers on, or null when it isn't running. */
export async function findLyricsStudio(): Promise<string | null> {
  const found = await Promise.all(PORTS.map(isLyricsStudio));
  const at = found.findIndex(Boolean);
  return at < 0 ? null : `http://127.0.0.1:${PORTS[at]}`;
}
