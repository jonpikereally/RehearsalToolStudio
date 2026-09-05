/**
 * Holding the machine awake through a long job.
 *
 * A prepare of a set runs for many minutes and asks nothing of anyone, and
 * that is exactly what a Mac takes for idleness. Left alone, the display
 * sleeps, the app is napped, and then the Mac itself sleeps: a set that
 * wrote a part every seven seconds while someone was watching wrote its
 * next in three minutes, the one after in twenty, and then nothing for two
 * hours until somebody came back and woke it.
 *
 * Three holds, all taken for the job's duration and let go after. The
 * screen wake lock is the browser's own, and keeps the display — and so
 * the machine — awake wherever the page runs. The Mac app is told as
 * well, because a WebKit window in the background is napped whatever the
 * display is doing, and only the app can refuse that. And an inaudible
 * tone plays, because a page that is playing audio is the one page no
 * browser throttles when it is covered. The hold is counted, so
 * overlapping jobs share one.
 */

interface WakeLockSentinel {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

let holds = 0;
let sentinel: WakeLockSentinel | null = null;
let watching = false;
let hum: { ctx: AudioContext; stop: () => void } | null = null;

/**
 * A tone nobody can hear, played for as long as the hold stands.
 *
 * Every browser throttles a page it cannot see — timers slowed, the whole
 * process napped in WebKit's case — and every browser exempts one thing
 * from that: a page playing audio. So a prepare plays some: a 30 Hz sine
 * eighty decibels down, well under anything a speaker or an ear resolves,
 * on the page's normal output. It is what keeps the work going while the
 * window is behind something else.
 */
function startHum(): void {
  if (hum) return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 30;
    gain.gain.value = 1e-4;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    void ctx.resume();
    hum = {
      ctx,
      stop: () => {
        try {
          osc.stop();
          osc.disconnect();
          gain.disconnect();
        } catch {
          /* already stopped */
        }
        void ctx.close();
      },
    };
  } catch {
    /* no audio here; the other holds still stand */
  }
}

function stopHum(): void {
  hum?.stop();
  hum = null;
}

/** The Mac app's ear, when the page is in it. */
function tellHost(awake: boolean, reason: string): void {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: Record<string, { postMessage(m: unknown): void }> } })
    .webkit?.messageHandlers;
  try {
    handlers?.studio?.postMessage({ awake, reason });
  } catch {
    /* not the app, or an app without the handler */
  }
}

async function acquire(): Promise<void> {
  const wakeLock = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } }).wakeLock;
  if (!wakeLock || sentinel || holds === 0 || document.visibilityState !== 'visible') return;
  try {
    const got = await wakeLock.request('screen');
    // The browser drops the lock when the page is hidden; it is taken
    // again when the page comes back, for as long as anything holds it.
    got.addEventListener?.('release', () => {
      if (sentinel === got) sentinel = null;
    });
    if (holds === 0) {
      void got.release();
      return;
    }
    sentinel = got;
  } catch {
    /* denied or unsupported: the app-side hold still stands */
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void acquire();
}

/**
 * Hold the machine awake until the returned function is called. Safe to
 * call from anywhere; releasing twice is harmless.
 */
export function holdAwake(reason: string): () => void {
  holds++;
  if (holds === 1) {
    tellHost(true, reason);
    startHum();
    if (!watching) {
      watching = true;
      document.addEventListener('visibilitychange', onVisible);
    }
  }
  void acquire();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds > 0) return;
    tellHost(false, reason);
    stopHum();
    document.removeEventListener('visibilitychange', onVisible);
    watching = false;
    void sentinel?.release();
    sentinel = null;
  };
}
