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

import * as local from './localSource';

/** The base URL Lyrics Studio answers on, or null when it isn't running. */
export async function findLyricsStudio(): Promise<string | null> {
  const found = await Promise.all(PORTS.map(isLyricsStudio));
  const at = found.findIndex(Boolean);
  return at < 0 ? null : `http://127.0.0.1:${PORTS[at]}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lyrics Studio, running: found where it is, or started through the file
 * server and waited for. Its first start on a Mac can take a while, since
 * uv builds its environment; the wait says how long it has been.
 */
export async function ensureLyricsStudio(onWait?: (note: string) => void): Promise<string> {
  const found = await findLyricsStudio();
  if (found) return found;
  const { log } = await local.startLyricsStudio();
  for (let i = 1; i <= 180; i++) {
    await sleep(1000);
    onWait?.(`Starting Lyrics Studio… ${i}s${i > 20 ? ' (its first start builds its environment, which takes a while)' : ''}`);
    const url = await findLyricsStudio();
    if (url) return url;
  }
  throw new Error(`Lyrics Studio did not start within three minutes. Its log says why: ${log}`);
}

/**
 * Stop the Lyrics Studio at `base` and start one under the studio's own
 * permissions, then wait for it. For a Lyrics Studio that answered but could
 * not read the set's folder.
 */
export async function restartLyricsStudio(base: string, onWait?: (note: string) => void): Promise<string> {
  const port = Number(new URL(base).port);
  const { log } = await local.startLyricsStudio({ restart: true, port });
  for (let i = 1; i <= 180; i++) {
    await sleep(1000);
    onWait?.(`Restarting Lyrics Studio under the studio's own permissions… ${i}s`);
    const url = await findLyricsStudio();
    if (url) return url;
  }
  throw new Error(`Lyrics Studio did not come back within three minutes. Its log says why: ${log}`);
}

/** Whether an error from Lyrics Studio is macOS refusing it the folder, which a restart from here cures. */
export function isFolderRefusal(err: unknown): boolean {
  return /operation not permitted|permissionerror|errno 1\b/i.test(err instanceof Error ? err.message : String(err));
}

export interface TranscribedWord {
  text: string;
  /** Arrangement seconds, and beats through the set's tempo map. */
  start: number;
  end: number;
  startBeat: number;
  endBeat: number;
}

export interface TranscribedSegment extends TranscribedWord {
  words: TranscribedWord[];
}

export interface Transcription {
  text: string;
  language: string;
  segments: TranscribedSegment[];
  regions: { transcribed: number; missing: number; short: number; out_of_range: number; total: number };
}

/**
 * Transcribe one track of a set, inside one song's bars, with Lyrics Studio
 * reading the set itself: it cuts each region of the track out of its file,
 * warping and tempo map honoured, and answers with the words in arrangement
 * time. Progress is polled while it works, since a track is a few regions
 * and each is a minute of listening.
 */
export async function transcribeTrack(
  base: string,
  req: {
    alsPath: string;
    trackId: string;
    startBar?: number;
    endBar?: number;
    language?: string;
    lyrics?: string;
    isolate?: boolean;
  },
  onProgress?: (done: number, total: number, phase: string) => void,
): Promise<Transcription> {
  let polling = true;
  const poll = async () => {
    while (polling) {
      await sleep(2000);
      if (!polling) break;
      try {
        const q = new URLSearchParams({ als_path: req.alsPath, track_id: req.trackId });
        const res = await fetch(`${base}/api/als_progress?${q}`);
        const p = (await res.json()) as { done: number; total: number; phase: string };
        if (p.total) onProgress?.(p.done, p.total, p.phase);
      } catch {
        /* the next poll may do better */
      }
    }
  };
  void poll();
  try {
    /*
     * Started, then asked after. The listening takes minutes, and a window's
     * request that gets no answer in about one is cut off with "Load failed";
     * so the server takes the job and the page comes back for the result.
     */
    const started = await fetch(`${base}/api/als_transcribe_start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        als_path: req.alsPath,
        track_id: req.trackId,
        start_bar: req.startBar ?? null,
        end_bar: req.endBar ?? null,
        language: req.language ?? '',
        lyrics: req.lyrics ?? '',
        isolate: !!req.isolate,
      }),
    });
    const raw = await started.text();
    let opened: Record<string, unknown> = {};
    try {
      opened = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A crash comes back as a traceback, not JSON: its last line is the error.
      throw new Error(raw.trim().split('\n').pop() || `${started.status} from Lyrics Studio`);
    }
    if (!started.ok || typeof opened.job !== 'string') {
      const detail = opened.detail ?? opened.error ?? `${started.status} from Lyrics Studio`;
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    let body: Record<string, unknown>;
    for (;;) {
      await sleep(2000);
      const res = await fetch(`${base}/api/als_job?${new URLSearchParams({ job: opened.job })}`);
      const state = (await res.json().catch(() => ({}))) as { status?: string; result?: Record<string, unknown>; error?: string };
      if (state.status === 'done' && state.result) {
        body = state.result;
        break;
      }
      if (state.status === 'failed' || !res.ok) throw new Error(state.error ?? `${res.status} from Lyrics Studio`);
    }
    type Raw = { text: string; start: number; end: number; start_beat: number; end_beat: number; words?: Raw[] };
    const word = (w: Raw): TranscribedWord => ({ text: w.text, start: w.start, end: w.end, startBeat: w.start_beat, endBeat: w.end_beat });
    return {
      text: String(body.text ?? ''),
      language: String(body.language ?? ''),
      segments: ((body.segments as Raw[]) ?? []).map((s) => ({ ...word(s), words: (s.words ?? []).map(word) })),
      regions: (body.regions as Transcription['regions']) ?? { transcribed: 0, missing: 0, short: 0, out_of_range: 0, total: 0 },
    };
  } finally {
    polling = false;
  }
}
