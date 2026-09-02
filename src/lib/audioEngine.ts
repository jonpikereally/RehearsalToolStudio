/**
 * Multi-track transport.
 *
 * Every file belonging to a song is decoded up front and played simultaneously
 * through its own gain node. What differs is how the gains are driven:
 *
 *   - `mix` tracks are complete mixes and mutually exclusive, so switching
 *     between "with vocal" and "without vocal" is a gain change — sample
 *     accurate, no reload, no seek, no drift, even mid-bar.
 *   - `stem` tracks are individual instruments and all sound together, each
 *     with its own fader, mute and solo.
 *   - the metronome is rendered to a buffer and played as one more track, so it
 *     loops and seeks in sync with everything else for free.
 */

const CLICK_TRACK_ID = '__click__';
/** How many loop passes of region automation to lay down in advance. */
const LOOP_PASSES_SCHEDULED = 200;

/** Equal-gain crossfade. The mixes are the same performance, so they're highly
 *  correlated and a linear ramp holds the level steady where equal-power would bump it. */
const SWITCH_RAMP_SEC = 0.012;

/** Small lead so scheduling lands ahead of the audio clock rather than on top of it. */
const START_LEAD_SEC = 0.02;

/**
 * `reference` is the finished record, played instead of the parts via SWITCH.
 * `mix` is any other whole rendering — an instrumental, an acapella, a print —
 * which is an ordinary channel you can mute, solo and blend.
 */
export type TrackRole = 'mix' | 'stem' | 'click' | 'reference';

/** A track as it stands, ready to be mixed down offline. */
export interface BounceSource {
  id: string;
  buffer: AudioBuffer;
  level: number;
  pan: number;
  regions?: { startSec: number; endSec: number }[];
  /** Song time at which the file's first sample plays. */
  fileStartSec?: number;
}

interface Track {
  id: string;
  buffer: AudioBuffer;
  gain: GainNode;
  /** Tapped after the fader, so the meter shows what you actually hear. */
  analyser: AnalyserNode | null;
  /**
   * Gates the part to the stretches the arrangement says it sounds in. Kept
   * separate from `gain` so scheduled automation and the mixer's own writes
   * can't cancel one another.
   */
  regionGain: GainNode | null;
  regions: { startSec: number; endSec: number }[] | null;
  /**
   * Song time at which the file's first sample plays. Zero for a file that
   * starts on bar 1; positive when the set places the clip later; negative
   * when the clip begins partway into the file.
   */
  fileStartSec: number;
  /** Null on browsers without StereoPannerNode; panning is then a no-op. */
  panner: StereoPannerNode | null;
  source: AudioBufferSourceNode | null;
  role: TrackRole;
  /** Fader position. Stems are user-controlled; mixes sit at unity. */
  level: number;
  muted: boolean;
  soloed: boolean;
  /** A/B: while anything is switched in, only that is heard, at full level. */
  switched: boolean;
}

/**
 * Whether a stem is sounding.
 *
 * Solo wins over mute — hitting solo on something you'd muted is how you check
 * what it was — and a stem that isn't soloed goes quiet as soon as anything
 * else is. Exported because the mixer draws from this too: the greyed-out row
 * and the meter have to agree with what you can actually hear.
 */
export function stemAudible(
  state: { muted: boolean; soloed: boolean },
  anySoloed: boolean,
): boolean {
  return state.soloed || (!state.muted && !anySoloed);
}

export interface TrackConfig {
  /** Stretches this part sounds in. Absent means throughout. */
  regions?: { startSec: number; endSec: number }[];
  /** Song time at which the file's first sample plays. Absent means bar 1. */
  fileStartSec?: number;
  buffer: AudioBuffer;
  role: Exclude<TrackRole, 'click'>;
  level?: number;
  muted?: boolean;
  /** -1 hard left, 0 centre, +1 hard right. */
  pan?: number;
}

/** One metronome blip. Times come from the bar maths, so a changing tempo
 *  spaces them correctly without the engine knowing anything about tempo. */
export interface ClickBeat {
  sec: number;
  accent: boolean;
}

export interface LoopRegion {
  startSec: number;
  endSec: number;
}

export class SongEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Reused by every meter read, so metering allocates nothing per frame. */
  private meterBuffer = new Uint8Array(256);
  private tracks = new Map<string, Track>();

  private activeId: string | null = null;
  private playing = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private pausedAt = 0;
  private generation = 0;

  private loop: LoopRegion | null = null;
  private clickBeats: ClickBeat[] = [];
  private clickOn = false;
  private clickGain = 0.5;
  /** Kept so a rebuilt click track kicks off where the old one was panned. */
  private clickPan = 0;
  /** True between entering play() and actually starting, to bar a second entry. */
  private starting = false;
  /** Set once the iOS audio session has actually been promoted. */
  private unlocked = false;

  /** Keeps the iOS audio session in "playback" mode; see `unlock`. */
  private keepAlive: HTMLAudioElement | null = null;

  duration = 0;
  onEnded: (() => void) | null = null;
  /** Fires when the context is suspended or resumed, so the UI can prompt a tap. */
  onStateChange: ((state: AudioContextState | 'closed') => void) | null = null;

  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * Create and resume the context. Safari will only start audio from inside a
   * user gesture, so this must be reachable from a real tap the first time.
   */
  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        (window as any).AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
      this.ctx.onstatechange = () => this.onStateChange?.(this.ctx?.state ?? 'closed');
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  get state(): AudioContextState | 'uninitialised' {
    return this.ctx?.state ?? 'uninitialised';
  }

  /**
   * Called from the first real user gesture.
   *
   * Besides resuming the context, this starts a silent looping `<audio>`
   * element. iOS routes Web Audio through the ringer channel — which the
   * hardware mute switch silences — until an HTMLMediaElement has played, at
   * which point the session becomes "playback" and the switch is ignored.
   */
  async unlock(): Promise<void> {
    if (this.unlocked) return;

    if (!this.keepAlive) {
      const el = document.createElement('audio');
      el.setAttribute('playsinline', '');
      el.loop = true;
      el.preload = 'auto';
      /*
       * Half a second of real silence, not an empty file.
       *
       * This used to be a WAV header with zero data bytes. A file with no
       * samples in it can finish before it has begun — and looping nothing
       * loops nothing — so the element never really played and iOS never
       * promoted the session, leaving Web Audio on the ringer channel where the
       * mute switch silences it.
       */
      el.src = silentWavUrl();
      // Some iOS versions won't play an element that isn't in the document.
      el.style.display = 'none';
      document.body.appendChild(el);
      this.keepAlive = el;
    }

    const started = this.keepAlive.play();
    await this.ensureContext();
    try {
      await started;
      this.unlocked = true;
    } catch {
      /* blocked outside a gesture; a later tap tries again */
    }
  }

  /** True once the silent element has played and the session is promoted. */
  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /**
   * What the audio path is actually doing, for when a device is silent and the
   * cause isn't visible from here.
   */
  audioReport(): Record<string, string | number | boolean> {
    const el = this.keepAlive;
    return {
      contextState: this.ctx?.state ?? 'none',
      sampleRate: this.ctx?.sampleRate ?? 0,
      unlocked: this.unlocked,
      keepAliveExists: !!el,
      keepAlivePaused: el ? el.paused : 'n/a',
      keepAliveTime: el ? Number(el.currentTime.toFixed(2)) : 'n/a',
      keepAliveError: el?.error ? `code ${el.error.code}` : 'none',
      keepAliveInDom: el ? document.body.contains(el) : false,
      masterGain: this.master?.gain.value ?? 'none',
      destChannels: this.ctx?.destination.channelCount ?? 0,
      tracks: this.tracks.size,
      playing: this.playing,
    };
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Decode compressed bytes into a buffer at the context's sample rate. */
  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = await this.ensureContext();
    // decodeAudioData detaches the buffer, so hand it a copy.
    return ctx.decodeAudioData(bytes.slice(0));
  }

  /* --------------------------------- load --------------------------------- */

  /**
   * Install the full set of tracks, replacing anything loaded before.
   * Playback is stopped; call `seek` + `play` afterwards to resume in place.
   */
  async setTracks(configs: Map<string, TrackConfig>, activeMixId: string | null): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopSources();
    for (const track of this.tracks.values()) this.disconnectTrack(track);
    this.tracks.clear();

    let maxDuration = 0;
    for (const [id, config] of configs) {
      const fileStartSec = config.fileStartSec ?? 0;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const regions = config.regions ?? null;
      const regionGain = regions ? ctx.createGain() : null;
      const panner = this.createPanner(ctx, config.pan ?? 0);
      // source -> [regionGain] -> gain -> [panner] -> master
      if (panner) {
        gain.connect(panner);
        panner.connect(this.master!);
      } else {
        gain.connect(this.master!);
      }

      /*
       * A meter tap, hung off the fader rather than the source, so muting or
       * pulling a stem down reads as silence — the meter answers "is this
       * sounding?", not "does this file have audio in it".
       *
       * An analyser is a sink here: nothing is connected downstream of it, so
       * it adds no signal path, and 256 samples is enough for a level.
       */
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      gain.connect(analyser);

      this.tracks.set(id, {
        id,
        buffer: config.buffer,
        gain,
        analyser,
        regionGain,
        regions,
        fileStartSec,
        panner,
        source: null,
        role: config.role,
        level: config.level ?? 1,
        muted: config.muted ?? false,
        soloed: false,
        switched: false,
      });
      maxDuration = Math.max(maxDuration, fileStartSec + config.buffer.duration);
    }
    this.duration = maxDuration;

    const mixIds = [...this.tracks.values()].filter((t) => t.role === 'mix').map((t) => t.id);
    this.activeId = activeMixId && this.tracks.has(activeMixId) ? activeMixId : (mixIds[0] ?? null);

    this.rebuildClickTrack();
    if (this.pausedAt > this.duration) this.pausedAt = 0;
    this.applyGains(0);
  }

  hasTrack(id: string): boolean {
    return this.tracks.has(id);
  }

  /**
   * Swap a single track's buffer in place (used when a pitch-shifted render
   * finishes). Keeps playing without interruption.
   */
  replaceBuffer(id: string, buffer: AudioBuffer): void {
    const track = this.tracks.get(id);
    if (!track) return;
    track.buffer = buffer;
    this.duration = Math.max(...[...this.tracks.values()].map((t) => t.fileStartSec + t.buffer.duration));
    if (this.playing && this.ctx) {
      const pos = this.position;
      // startTrack stops whatever was running on this track first.
      this.startTrack(track, this.ctx.currentTime + START_LEAD_SEC, pos + START_LEAD_SEC);
    }
  }

  /* ------------------------------- transport ------------------------------ */

  get isPlaying(): boolean {
    return this.playing;
  }

  get position(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    if (elapsed <= 0) return this.startOffset;
    let p = this.startOffset + elapsed;
    if (this.loop) {
      const len = this.loop.endSec - this.loop.startSec;
      if (len > 0 && p >= this.loop.endSec) {
        p = this.loop.startSec + ((p - this.loop.startSec) % len);
      }
    } else if (p > this.duration) {
      p = this.duration;
    }
    return p;
  }

  /**
   * Start playing.
   *
   * `starting` guards the await below. Without it two calls arriving close
   * together — a double tap, or the lock-screen control landing alongside a
   * click — both passed the `playing` check while the first was still waiting
   * on the context, and both went on to start sources. The second start
   * overwrote `track.source`, so the first set was orphaned: not in `tracks`
   * any more, therefore impossible to stop, playing on through pause and
   * doubling the song on the next play.
   */
  async play(): Promise<void> {
    if (this.playing || this.starting || !this.tracks.size) return;
    this.starting = true;
    try {
      const ctx = await this.ensureContext();
      if (this.playing || !this.tracks.size) return;
      let from = this.pausedAt;
      if (from >= this.duration - 0.01) from = this.loop ? this.loop.startSec : 0;
      this.startSources(ctx.currentTime + START_LEAD_SEC, from);
    } finally {
      this.starting = false;
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.position;
    this.stopSources();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  /** Move the playhead. Keeps playing if it already was. */
  seek(sec: number): void {
    const target = Math.max(0, Math.min(sec, Math.max(0, this.duration - 0.01)));
    if (this.playing && this.ctx) {
      this.stopSources();
      this.startSources(this.ctx.currentTime + START_LEAD_SEC, target);
    } else {
      this.pausedAt = target;
    }
  }

  stop(): void {
    this.stopSources();
    this.pausedAt = this.loop ? this.loop.startSec : 0;
  }

  /* -------------------------------- mixing -------------------------------- */

  get activeVariantId(): string | null {
    return this.activeId;
  }

  /** The seamless switch between complete mixes. `null` silences them all. */
  setActiveVariant(id: string | null): void {
    if (id !== null && !this.tracks.has(id)) return;
    this.activeId = id;
    this.applyGains();
  }

  setStemLevel(id: string, level: number): void {
    const clamped = Math.max(0, Math.min(1.5, level));
    if (id === CLICK_TRACK_ID) this.clickGain = clamped;
    const track = this.tracks.get(id);
    if (!track) return;
    track.level = clamped;
    this.applyGains(0.02);
  }

  /** -1 hard left, 0 centre, +1 hard right. */
  setStemPan(id: string, pan: number): void {
    if (id === CLICK_TRACK_ID) this.clickPan = Math.max(-1, Math.min(1, pan));
    const track = this.tracks.get(id);
    if (!track?.panner || !this.ctx) return;
    const value = Math.max(-1, Math.min(1, pan));
    const now = this.ctx.currentTime;
    const p = track.panner.pan;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    // Ramp so dragging the control doesn't zipper.
    p.linearRampToValueAtTime(value, now + 0.02);
  }

  /** Null when the browser has no StereoPannerNode, so callers can hide the control. */
  private createPanner(ctx: AudioContext, pan: number): StereoPannerNode | null {
    if (typeof ctx.createStereoPanner !== 'function') return null;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    return panner;
  }

  get supportsPanning(): boolean {
    return typeof this.ctx?.createStereoPanner === 'function';
  }

  /**
   * What is currently audible, ready to be rendered offline.
   *
   * Taken from the same `stemAudible` rule the live gains use, so a bounce is
   * exactly what you were hearing — the faders, the pans, the mutes and any
   * solo, at the moment you pressed it.
   */
  bounceTracks(): BounceSource[] {
    const soloing = this.anySoloed;
    const out: BounceSource[] = [];
    for (const track of this.tracks.values()) {
      if (!stemAudible(track, soloing)) continue;
      if (track.level <= 0) continue;
      out.push({
        id: track.id,
        buffer: track.buffer,
        level: track.level,
        pan: track.panner?.pan.value ?? 0,
        // Carried through, so a part the arrangement drops is dropped in the
        // print too rather than playing on where you can't hear it.
        regions: track.regions ?? undefined,
        fileStartSec: track.fileStartSec,
      });
    }
    return out;
  }

  get anySwitched(): boolean {
    for (const track of this.tracks.values()) if (track.switched) return true;
    return false;
  }

  /** Hear this track alone at full level, whatever the faders say. */
  setSwitched(id: string, on: boolean): void {
    for (const track of this.tracks.values()) track.switched = false;
    const track = this.tracks.get(id);
    if (track) track.switched = on;
    this.applyGains();
  }

  isSwitched(id: string): boolean {
    return this.tracks.get(id)?.switched ?? false;
  }

  setStemMuted(id: string, muted: boolean): void {
    // The click is a channel now, so muting it is what turns it off — keep the
    // flag that survives a click rebuild in step with the fader.
    if (id === CLICK_TRACK_ID) this.clickOn = !muted;
    const track = this.tracks.get(id);
    if (!track) return;
    track.muted = muted;
    this.applyGains();
  }

  setStemSolo(id: string, soloed: boolean): void {
    const track = this.tracks.get(id);
    if (!track) return;
    track.soloed = soloed;
    this.applyGains();
  }

  clearSolos(): void {
    for (const track of this.tracks.values()) track.soloed = false;
    this.applyGains();
  }

  get anySoloed(): boolean {
    return [...this.tracks.values()].some((t) => t.role === 'stem' && t.soloed);
  }

  getStemState(id: string): { level: number; muted: boolean; soloed: boolean; pan: number } | null {
    const track = this.tracks.get(id);
    if (!track) return null;
    return {
      level: track.level,
      muted: track.muted,
      soloed: track.soloed,
      pan: track.panner?.pan.value ?? 0,
    };
  }

  setMasterVolume(v: number): void {
    if (this.master) this.master.gain.value = v;
  }

  /**
   * Recompute every track's gain from the current selection, faders, mutes and
   * solos. One place, so the rules can't drift apart between controls.
   */
  private applyGains(ramp = SWITCH_RAMP_SEC): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const soloing = this.anySoloed;

    /*
     * With stems loaded, a full mix is just another channel — its own fader,
     * pan and mute — so the reference can be blended against the parts. With no
     * stems, the mixes are alternate versions of the whole song and only the
     * chosen one sounds.
     */
    const asChannels = this.hasStemTracks;

    /*
     * SWITCH is the reference's whole on/off. With stems loaded, a full mix is
     * silent unless it is switched in, and switching it in solos it — you are
     * hearing the record instead of the parts, never both. Its fader and pan
     * still set how it sounds when it is the one playing.
     */
    const switching = this.anySwitched;

    for (const track of this.tracks.values()) {
      let target: number;
      if (switching) {
        target = track.switched ? track.level : 0;
      } else if (track.role === 'click' || track.role === 'stem' || track.role === 'mix') {
        target = stemAudible(track, soloing) ? track.level : 0;
      } else if (asChannels) {
        // A reference beside parts only sounds when switched in.
        target = 0;
      } else {
        // A soloed stem isolates itself from the full mix too, as in a DAW.
        const active = track.id === this.activeId;
        target = active && !soloing && !track.muted ? track.level : 0;
      }

      const g = track.gain.gain;
      if (ramp <= 0) {
        g.cancelScheduledValues(now);
        g.value = target;
        continue;
      }
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + ramp);
    }
  }

  /* --------------------------------- loop --------------------------------- */

  getLoop(): LoopRegion | null {
    return this.loop;
  }

  setLoop(region: LoopRegion | null): void {
    if (region && region.endSec - region.startSec < 0.05) region = null;
    this.loop = region;
    for (const track of this.tracks.values()) this.applyLoop(track.source, track.fileStartSec);
    if (!this.playing && region && (this.pausedAt < region.startSec || this.pausedAt > region.endSec)) {
      this.pausedAt = region.startSec;
    }
  }

  private applyLoop(source: AudioBufferSourceNode | null, fileStartSec = 0): void {
    if (!source) return;
    // Loop points are song time; the source loops in its own file time.
    const start = this.loop ? this.loop.startSec - fileStartSec : 0;
    const end = this.loop ? this.loop.endSec - fileStartSec : 0;
    if (this.loop && end > Math.max(0, start)) {
      source.loop = true;
      source.loopStart = Math.max(0, start);
      source.loopEnd = end;
    } else {
      source.loop = false;
    }
  }

  /* ------------------------------- metronome ------------------------------ */

  setClickBeats(beats: ClickBeat[]): void {
    // Cheap identity check: rebuilding renders a whole buffer.
    const same =
      beats.length === this.clickBeats.length &&
      (beats.length === 0 ||
        (beats[0].sec === this.clickBeats[0].sec &&
          beats[beats.length - 1].sec === this.clickBeats[this.clickBeats.length - 1].sec));
    this.clickBeats = beats;
    if (!same) this.rebuildClickTrack();
  }

  /** The click is a channel like any other; enabling it is unmuting it. */
  setClickEnabled(on: boolean): void {
    this.clickOn = on;
    const track = this.tracks.get(CLICK_TRACK_ID);
    if (track) track.muted = !on;
    this.applyGains();
  }

  setClickVolume(v: number): void {
    this.clickGain = v;
    const track = this.tracks.get(CLICK_TRACK_ID);
    if (track) track.level = v;
    this.applyGains(0.02);
  }

  get clickEnabled(): boolean {
    return this.clickOn;
  }

  /** True once any separated part is loaded, as opposed to whole mixes only. */
  get hasStemTracks(): boolean {
    for (const track of this.tracks.values()) if (track.role === 'stem') return true;
    return false;
  }

  static readonly clickTrackId = CLICK_TRACK_ID;

  /** Render the whole metronome to a buffer so it rides along with the tracks. */
  private rebuildClickTrack(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const existing = this.tracks.get(CLICK_TRACK_ID);
    if (existing) {
      /*
       * Through stopTrackSource, which clears `onended` first. Stopping the
       * source directly left the handler attached, and it fired: the click is
       * rendered to the full length of the song, so it passed the "longest
       * track" test and the engine decided the song had ended. Editing the
       * tempo therefore flipped the play button to paused while every other
       * source carried on, and the next play started a second set on top.
       */
      this.stopTrackSource(existing);
      this.disconnectTrack(existing);
      this.tracks.delete(CLICK_TRACK_ID);
    }
    if (!this.clickBeats.length || this.duration <= 0) return;

    const buffer = renderClickBuffer(ctx, this.clickBeats, this.duration);
    const gain = ctx.createGain();
    gain.gain.value = this.clickOn ? this.clickGain : 0;

    // Same chain as a stem, so the click can be panned and metered too —
    // a click hard left with the band centred is a common way to work.
    const panner = this.createPanner(ctx, this.clickPan);
    if (panner) {
      gain.connect(panner);
      panner.connect(this.master!);
    } else {
      gain.connect(this.master!);
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    gain.connect(analyser);

    const track: Track = {
      id: CLICK_TRACK_ID,
      buffer,
      gain,
      analyser,
      panner,
      source: null,
      role: 'click',
      regionGain: null,
      regions: null,
      fileStartSec: 0,
      level: this.clickGain,
      muted: !this.clickOn,
      soloed: false,
      switched: false,
    };
    this.tracks.set(CLICK_TRACK_ID, track);

    if (this.playing && this.ctx) {
      const pos = this.position;
      this.startTrack(track, this.ctx.currentTime + START_LEAD_SEC, pos + START_LEAD_SEC);
    }
  }

  /* -------------------------------- internals ------------------------------ */

  private startSources(when: number, offset: number): void {
    this.generation++;
    this.startCtxTime = when;
    this.startOffset = offset;
    this.playing = true;
    for (const track of this.tracks.values()) this.startTrack(track, when, offset);
  }

  private startTrack(track: Track, when: number, offset: number): void {
    const ctx = this.ctx!;
    // Never leave a running source behind: once it's off `track.source` there
    // is no handle left to stop it, and it plays to the end of the buffer.
    this.stopTrackSource(track);
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.connect(track.regionGain ?? track.gain);
    this.scheduleRegions(track, when, offset);
    this.applyLoop(source, track.fileStartSec);

    const gen = this.generation;
    source.onended = () => {
      // Only a natural end of the longest track counts; stop()/seek() bump the generation.
      if (gen !== this.generation || !this.playing || source.loop) return;
      // And only from the source this track is actually playing — one that has
      // been replaced has no business ending the song.
      if (track.source !== source) return;
      if (track.fileStartSec + track.buffer.duration < this.duration - 0.01) return;
      this.playing = false;
      this.pausedAt = this.duration;
      this.onEnded?.();
    };

    /*
     * The file's own clock runs from where the set placed it. A part placed
     * two bars in starts two bars late rather than playing its intro under
     * the region gate; one placed before the song begins is entered partway.
     */
    const fileOffset = offset - track.fileStartSec;
    if (fileOffset >= 0) {
      source.start(when, Math.min(fileOffset, track.buffer.duration));
    } else {
      source.start(when - fileOffset, 0);
    }
    track.source = source;
  }

  private disconnectTrack(track: Track): void {
    track.regionGain?.disconnect();
    track.gain.disconnect();
    track.panner?.disconnect();
    track.analyser?.disconnect();
  }

  /**
   * Peak level of a track right now, 0..1.
   *
   * Peak rather than RMS: it answers "is this making a sound" quickly, where
   * an average lags behind the transient that tells you the drums just came in.
   */
  peakLevel(id: string): number {
    const analyser = this.tracks.get(id)?.analyser;
    if (!analyser || !this.playing) return 0;
    if (this.meterBuffer.length !== analyser.fftSize) {
      this.meterBuffer = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(this.meterBuffer);
    let peak = 0;
    for (const sample of this.meterBuffer) {
      // Silence sits at 128; distance from it is the amplitude.
      const magnitude = Math.abs(sample - 128);
      if (magnitude > peak) peak = magnitude;
    }
    return Math.min(1, peak / 128);
  }

  private stopSources(): void {
    this.generation++;
    this.playing = false;
    for (const track of this.tracks.values()) this.stopTrackSource(track);
  }

  /**
   * Open and close the region gate in time with the music.
   *
   * The stem file usually runs the whole song even where the arrangement has
   * the part dropping out, so the gate is what makes playback match the set.
   * Scheduled rather than watched, so it lands sample-accurately rather than
   * whenever a timer happens to fire.
   *
   * Under a loop the automation is laid down for each pass, because the source
   * loops itself and the schedule would otherwise only be right the first time.
   */
  private scheduleRegions(track: Track, when: number, offset: number): void {
    const node = track.regionGain;
    if (!node || !track.regions) return;
    const g = node.gain;
    g.cancelScheduledValues(0);

    const loop = this.loop;
    const passLength = loop ? loop.endSec - loop.startSec : 0;
    const passes = loop && passLength > 0.01 ? LOOP_PASSES_SCHEDULED : 1;
    const from = loop ? loop.startSec : offset;

    // Whatever the state is at the moment playback begins.
    const startsInside = track.regions.some((r) => offset >= r.startSec && offset < r.endSec);
    g.setValueAtTime(startsInside ? 1 : 0, when);

    for (let pass = 0; pass < passes; pass++) {
      const passStart = loop ? from + pass * passLength : offset;
      const passEnd = loop ? passStart + passLength : Number.POSITIVE_INFINITY;
      for (const region of track.regions) {
        const openAt = when + (region.startSec - offset) + (loop ? pass * passLength : 0);
        const closeAt = when + (region.endSec - offset) + (loop ? pass * passLength : 0);
        if (closeAt <= when) continue;
        if (loop && (region.startSec >= passEnd - passStart + from)) continue;
        if (openAt > when) g.setValueAtTime(1, openAt);
        if (closeAt > when) g.setValueAtTime(0, closeAt);
      }
    }
    node.connect(track.gain);
  }

  private stopTrackSource(track: Track): void {
    if (!track.source) return;
    try {
      track.source.onended = null;
      track.source.stop();
    } catch {
      /* already stopped */
    }
    track.source.disconnect();
    track.source = null;
  }

  dispose(): void {
    this.stopSources();
    for (const track of this.tracks.values()) this.disconnectTrack(track);
    this.tracks.clear();
    this.keepAlive?.pause();
    this.keepAlive = null;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}

/** A short pitched blip at each supplied time, accented on the downbeat. */
/**
 * Half a second of silence as a playable WAV, for the iOS unlock.
 *
 * Built rather than pasted so it is unmistakably real audio: 8 kHz mono PCM,
 * every sample zero.
 */
function silentWavUrl(): string {
  const rate = 8000;
  const frames = rate / 2;
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function renderClickBuffer(ctx: BaseAudioContext, beats: ClickBeat[], duration: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const frames = Math.max(1, Math.ceil(duration * sr));
  const buffer = ctx.createBuffer(1, frames, sr);
  const data = buffer.getChannelData(0);

  const blipFrames = Math.floor(0.035 * sr);
  for (const beat of beats) {
    if (beat.sec < 0 || beat.sec >= duration) continue;
    const freq = beat.accent ? 1600 : 1000;
    const amp = beat.accent ? 0.9 : 0.55;
    const start = Math.floor(beat.sec * sr);
    for (let i = 0; i < blipFrames && start + i < frames; i++) {
      const env = Math.exp(-i / (sr * 0.008));
      data[start + i] += Math.sin((2 * Math.PI * freq * i) / sr) * env * amp;
    }
  }
  return buffer;
}
