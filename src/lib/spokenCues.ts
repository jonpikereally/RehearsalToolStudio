/**
 * Calling the next section out loud, a bar before it arrives.
 *
 * The browser's own speech runs offline and costs nothing, but it writes
 * straight to the output device — it cannot be routed into Web Audio. So a cue
 * can't be a channel with a fader, can't be panned, and can't be written to a
 * file. It is spoken, live, over whatever is playing.
 *
 * Which is arguably what you want anyway: the point is hearing "chorus" coming
 * while your hands are busy, not having another stem to mix.
 */

const LS_ENABLED = 'ls.cues.on';

/**
 * Off for now.
 *
 * The feature works and its timing is tested, but nothing has judged how it
 * actually sounds over a band — and a voice talking over the music is the kind
 * of thing that wants trying before it is offered. Flip this to true to bring
 * it back; nothing else needs changing, and anyone who had switched it on keeps
 * their setting for when it returns.
 */
export const CUES_AVAILABLE = false;

/** Whether to offer spoken cues at all: built, supported, and switched on. */
export function cuesAvailable(): boolean {
  return CUES_AVAILABLE && speechSupported();
}
const LS_VOICE = 'ls.cues.voice';
const LS_LEAD = 'ls.cues.leadBars';

/** How far ahead to call it, in bars. Enough to react, not so far you forget. */
export const DEFAULT_LEAD_BARS = 1;

export function cuesEnabled(): boolean {
  return localStorage.getItem(LS_ENABLED) === '1';
}

export function setCuesEnabled(on: boolean): void {
  try {
    localStorage.setItem(LS_ENABLED, on ? '1' : '0');
  } catch {
    /* not worth failing over */
  }
}

export function cueVoiceName(): string {
  return localStorage.getItem(LS_VOICE) ?? '';
}

export function setCueVoiceName(name: string): void {
  try {
    localStorage.setItem(LS_VOICE, name);
  } catch {
    /* not worth failing over */
  }
}

export function cueLeadBars(): number {
  const raw = Number(localStorage.getItem(LS_LEAD));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEAD_BARS;
}

export function setCueLeadBars(bars: number): void {
  try {
    localStorage.setItem(LS_LEAD, String(bars));
  } catch {
    /* not worth failing over */
  }
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Voices, once the browser has them.
 *
 * They arrive asynchronously and the first call usually returns nothing, which
 * is why this waits rather than handing back an empty list.
 */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([]);
  const ready = speechSynthesis.getVoices();
  if (ready.length) return Promise.resolve(ready);

  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    window.setTimeout(done, 1500);
  });
}

/** English voices that work offline, which is what a rehearsal room needs. */
export function usableVoices(all: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const english = all.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const offline = english.filter((v) => v.localService);
  return (offline.length ? offline : english).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Say something, cancelling anything still being said.
 *
 * Sections can come close together, and a cue that arrives late is worse than
 * no cue — better to drop the last word of "verse" than to hear it over the
 * downbeat of the chorus.
 */
export function speak(text: string, voice: SpeechSynthesisVoice | null): void {
  if (!speechSupported() || !text) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (voice) utterance.voice = voice;
  // Slightly quick and slightly quiet: it's a prompt over music, not an
  // announcement, and a drawled cue lands after the bar it was warning about.
  utterance.rate = 1.15;
  utterance.volume = 0.9;
  speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechSupported()) speechSynthesis.cancel();
}

/**
 * The marker to call next, given where the playhead is.
 *
 * Returns the one whose bar falls inside the lead window, so it is called
 * before it arrives rather than as it does. Pure, so the decision can be tested
 * without a browser or a voice.
 */
export function cueDue(
  markers: { id: string; name: string; bar: number }[],
  bar: number,
  leadBars: number,
): { id: string; name: string; bar: number } | null {
  for (const marker of markers) {
    const from = marker.bar - leadBars;
    if (bar >= from && bar < marker.bar) return marker;
  }
  return null;
}
