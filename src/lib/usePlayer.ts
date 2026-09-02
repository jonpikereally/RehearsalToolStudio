import { useCallback, useEffect, useRef, useState } from 'react';
import type { Song } from '../types';
import { SongEngine, type LoopRegion } from './audioEngine';
import { clearDecodedCache, downloadPlan, loadSong, variantsToLoad, visibleVariants, type DownloadItem, type LoadProgress } from './songLoader';
import { setSkipped, skippedFor } from './loadPrefs';
import { barToSec, clickBeats, nudgeBars, secToBar } from './bars';
import { resetMix, saveSetting } from './stemMix';

/** One engine for the whole app, so navigating away and back doesn't rebuild the audio graph. */
const engine = new SongEngine();

export interface PlayerState {
  loading: boolean;
  progress: LoadProgress | null;
  error: string | null;
  ready: boolean;
  playing: boolean;
  position: number;
  duration: number;
  activeVariantId: string | null;
  loop: LoopRegion | null;
  clickOn: boolean;
  /** The channel currently switched in for A/B, if any. */
  switchedId: string | null;
  /** Bumped whenever a fader, mute or solo changes, to re-render the mixer. */
  stemVersion: number;
  anySoloed: boolean;
  /** 'suspended' means the browser is still waiting for a tap before it will play. */
  audioState: AudioContextState | 'uninitialised';
}

/** What was chosen for a song's devices on this device: imitate them, or play raw. */
const LS_FX = 'ls.fx';
function readFxChoice(songId: string | null): 'approx' | 'raw' | null {
  if (!songId) return null;
  try {
    const all = JSON.parse(localStorage.getItem(LS_FX) ?? '{}') as Record<string, 'approx' | 'raw'>;
    return all[songId] ?? null;
  } catch {
    return null;
  }
}
function writeFxChoice(songId: string, choice: 'approx' | 'raw'): void {
  try {
    const all = JSON.parse(localStorage.getItem(LS_FX) ?? '{}') as Record<string, 'approx' | 'raw'>;
    all[songId] = choice;
    localStorage.setItem(LS_FX, JSON.stringify(all));
  } catch {
    /* a choice that does not persist still holds for the session */
  }
}

/** Whether any of a song's parts runs through a device on its own track or groups. */
export function hasDevices(song: Song | null): boolean {
  return !!song && song.variants.some((v) => v.devices?.some((d) => d.on));
}

export function usePlayer(song: Song | null, cacheBudgetGB: number, keepAwake: boolean) {
  const [state, setState] = useState<PlayerState>({
    loading: false,
    progress: null,
    error: null,
    ready: false,
    playing: false,
    position: 0,
    duration: 0,
    activeVariantId: null,
    loop: null,
    clickOn: engine.clickEnabled,
    switchedId: null,
    stemVersion: 0,
    anySoloed: false,
    audioState: engine.state,
  });

  const abortRef = useRef<AbortController | null>(null);
  /** Tells a key change apart from opening a different song. */
  const lastSongIdRef = useRef<string | null>(null);
  const songId = song?.id ?? null;
  const transpose = song?.transpose ?? 0;
  const tempoScale = song?.tempoScale ?? 1;
  /*
   * What the load will actually fetch, as a string, so switching a part off or
   * back on reloads. Keying on the song id alone missed it: the id doesn't
   * change when the set of parts does.
   */
  const loadKey = song ? variantsToLoad(song).map((v) => v.id).join('|') : '';

  /*
   * The set's devices, imitated or not. Asked once per song and remembered
   * on this device; until it is answered a song with devices plays raw, and
   * the page says so.
   */
  const [fxChoice, setFxChoice] = useState<'approx' | 'raw' | null>(() => readFxChoice(songId));
  useEffect(() => {
    setFxChoice(readFxChoice(songId));
  }, [songId]);
  const effects = fxChoice === 'approx';
  const setEffects = useCallback(
    (on: boolean) => {
      if (!songId) return;
      const choice = on ? 'approx' : 'raw';
      writeFxChoice(songId, choice);
      setFxChoice(choice);
    },
    [songId],
  );

  /*
   * Parts to be asked about before anything is fetched.
   *
   * Only when there is something to ask about: a part that is neither on this
   * device nor already turned down. Everything else opens straight into the
   * song — being asked to approve a download of nothing, every time, on a song
   * whose stems are all sitting on the disk, is a question with one answer.
   *
   * It is still where the version and the parts are chosen, so it stays one tap
   * away in the mixer for the times that is what you came to do.
   */
  const [choice, setChoice] = useState<DownloadItem[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const askedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!song) return;
    let cancelled = false;
    if (askedRef.current === song.id) return;
    askedRef.current = song.id;
    void (async () => {
      const plan = await downloadPlan(song);
      if (cancelled) return;
      const skipped = new Set(skippedFor(song.id));
      const wouldFetch = plan.some((item) => !item.cached && !skipped.has(item.variant.id));
      if (!wouldFetch) return;
      setChoice(plan);
      setChoosing(true);
    })();
    return () => {
      cancelled = true;
      /*
       * Let a remount ask again. React sets an effect up, tears it down and
       * sets it up once more in development, and a guard that outlives the
       * teardown leaves the second run thinking the question was already put —
       * so the picker never appeared there at all.
       */
      if (askedRef.current === song.id) askedRef.current = null;
    };
  }, [song?.id]);

  /** Open the picker on demand, with fresh cache information. */
  const openDownloadPicker = useCallback(async () => {
    if (!song) return;
    setChoice(await downloadPlan(song));
    setChoosing(true);
  }, [song?.id]);

  const confirmDownloads = useCallback(
    (skipIds: string[]) => {
      if (!song) return;
      setSkipped(song.id, skipIds);
      setChoosing(false);
      setChoice(null);
    },
    [song?.id],
  );

  /* --------------------------------- loading -------------------------------- */

  useEffect(() => {
    if (!song) return;
    abortRef.current?.abort();
    // Hold off while the picker is up: fetching first would defeat the point.
    if (choosing) return;

    const controller = new AbortController();
    abortRef.current = controller;

    /*
     * Changing key reloads every part, but it should feel like a mixer control,
     * not like opening the song again: hold the playhead where it is, and pick
     * playback back up if it was running. Opening a *different* song of course
     * starts from the top.
     */
    const sameSong = lastSongIdRef.current === songId;
    const wasPlaying = sameSong && engine.isPlaying;
    // pause() folds the live position into pausedAt, so the readout doesn't
    // jump while the new renders are being prepared.
    if (sameSong) engine.pause();
    const resumeAt = sameSong ? engine.position : 0;
    lastSongIdRef.current = songId;

    setState((s) => ({ ...s, loading: true, ready: false, error: null, progress: null }));

    /*
     * Progress arrives once per network chunk — hundreds of times for a large
     * stem, thousands across a whole song — and every one of those used to
     * re-render the player. Report a change of file or phase immediately, and
     * otherwise no more than a few times a second.
     */
    let lastStep = '';
    let lastAt = 0;
    const reportProgress = (p: LoadProgress) => {
      const step = `${p.phase}:${p.index}`;
      const now = performance.now();
      if (step === lastStep && now - lastAt < 125 && p.ratio < 1) return;
      lastStep = step;
      lastAt = now;
      setState((s) => ({ ...s, progress: p }));
    };

    void (async () => {
      try {
        await loadSong(engine, song, {
          semitones: song.transpose,
          tempoScale: song.tempoScale ?? 1,
          budgetBytes: Math.max(0.1, cacheBudgetGB) * 1024 * 1024 * 1024,
          effects,
          signal: controller.signal,
          onProgress: reportProgress,
        });
        if (controller.signal.aborted) return;

        engine.seek(resumeAt);
        // Awaited, so `playing` below reflects the engine rather than racing it.
        if (wasPlaying) await engine.play();

        setState((s) => ({
          ...s,
          loading: false,
          ready: true,
          duration: engine.duration,
          position: engine.position,
          playing: engine.isPlaying,
          activeVariantId: engine.activeVariantId,
          clickOn: engine.clickEnabled,
        }));
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setState((s) => ({ ...s, loading: false, ready: false, error: err instanceof Error ? err.message : String(err) }));
      }
    })();

    return () => controller.abort();
    // Reload only when the song or its key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, transpose, tempoScale, cacheBudgetGB, loadKey, choosing, effects]);

  // Free decoded audio when leaving a song entirely.
  useEffect(() => {
    return () => {
      if (!songId) return;
      engine.pause();
      clearDecodedCache();
    };
  }, [songId]);

  /* ------------------------------- click track ------------------------------ */

  useEffect(() => {
    if (!song || !state.duration) return;
    // Worked out from the tempo map, so a song that changes tempo still clicks
    // on the beat after the change.
    engine.setClickBeats(clickBeats(song, state.duration));
  }, [
    song?.bpm, song?.timeSigNum, song?.timeSigDen, song?.firstBarOffsetSec,
    song?.tempoMap, state.ready, state.duration,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------------------------------- position -------------------------------- */

  /**
   * Position tracking, kept off React's critical path.
   *
   * The playhead needs to move at frame rate, but re-rendering the whole player
   * sixty times a second — timeline, mixer rows, every slider — is what made
   * this expensive. Instead the frame loop pushes the raw position to
   * subscribers, which move the playhead by writing to the DOM directly, and
   * React state is updated only when the bar/beat readout would actually
   * change. The loop doesn't run at all while paused.
   */
  const positionListeners = useRef(new Set<(sec: number) => void>());

  const subscribePosition = useCallback((cb: (sec: number) => void) => {
    positionListeners.current.add(cb);
    cb(engine.position);
    return () => {
      positionListeners.current.delete(cb);
    };
  }, []);

  const broadcastPosition = useCallback((sec: number) => {
    for (const listener of positionListeners.current) listener(sec);
  }, []);

  useEffect(() => {
    if (!state.playing) {
      // Settle on the exact resting position, then stop doing any work.
      const pos = engine.position;
      broadcastPosition(pos);
      setState((s) => (Math.abs(s.position - pos) < 0.0005 ? s : { ...s, position: pos }));
      return;
    }

    let raf = 0;
    let lastReadout = -1;
    const tick = () => {
      const pos = engine.position;
      broadcastPosition(pos);

      // ~12 Hz is well past what a bar.beat readout can show.
      const readout = Math.floor(pos * 12);
      if (readout !== lastReadout) {
        lastReadout = readout;
        setState((s) => ({ ...s, position: pos }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.playing, broadcastPosition]);

  /** The engine is the source of truth; pull transport state off it after any change. */
  const syncTransport = useCallback(() => {
    const pos = engine.position;
    broadcastPosition(pos);
    setState((s) => ({ ...s, playing: engine.isPlaying, position: pos }));
  }, [broadcastPosition]);

  useEffect(() => {
    engine.onEnded = () => setState((s) => ({ ...s, playing: false }));
    engine.onStateChange = (audioState) =>
      setState((s) => ({ ...s, audioState: audioState as AudioContextState }));
    return () => {
      engine.onEnded = null;
      engine.onStateChange = null;
    };
  }, []);

  /**
   * Mobile browsers refuse to start audio outside a user gesture, and iOS routes
   * Web Audio through the ringer channel — silenced by the hardware mute switch —
   * until a media element has played. Unlock on the first touch anywhere.
   */
  useEffect(() => {
    const onGesture = () => {
      if (engine.isUnlocked) return;
      void engine.unlock().then(() => setState((s) => ({ ...s, audioState: engine.state })));
    };
    /*
     * Not `once`. Unlocking can fail — iOS refuses it outside a live gesture —
     * and a listener removed after one attempt has no way to try again, which
     * left the app silent for the rest of the session with no way back. It
     * stays registered until it actually succeeds, then does nothing.
     */
    const opts = { capture: true } as const;
    window.addEventListener('pointerdown', onGesture, opts);
    window.addEventListener('touchend', onGesture, opts);
    window.addEventListener('keydown', onGesture, opts);
    return () => {
      window.removeEventListener('pointerdown', onGesture, opts);
      window.removeEventListener('touchend', onGesture, opts);
      window.removeEventListener('keydown', onGesture, opts);
    };
  }, []);

  /* -------------------------------- wake lock ------------------------------- */

  const wakeLockRef = useRef<any>(null);
  useEffect(() => {
    if (!keepAwake) return;
    const nav = navigator as any;
    if (!nav.wakeLock) return;

    const acquire = async () => {
      if (!state.playing || wakeLockRef.current) return;
      try {
        wakeLockRef.current = await nav.wakeLock.request('screen');
        wakeLockRef.current.addEventListener?.('release', () => {
          wakeLockRef.current = null;
        });
      } catch {
        /* denied or unsupported */
      }
    };
    const release = () => {
      wakeLockRef.current?.release?.();
      wakeLockRef.current = null;
    };

    if (state.playing) void acquire();
    else release();
    return release;
  }, [state.playing, keepAwake]);

  /* --------------------------------- actions -------------------------------- */

  const play = useCallback(async () => {
    await engine.play();
    syncTransport();
  }, [syncTransport]);

  const pause = useCallback(() => {
    engine.pause();
    syncTransport();
  }, [syncTransport]);

  const toggle = useCallback(async () => {
    await engine.toggle();
    syncTransport();
  }, [syncTransport]);

  const seek = useCallback(
    (sec: number) => {
      engine.seek(sec);
      syncTransport();
    },
    [syncTransport],
  );

  const jumpBars = useCallback(
    (bars: number) => {
      if (!song) return;
      seek(nudgeBars(engine.position, bars, song));
    },
    [song, seek],
  );

  const seekToBar = useCallback(
    (bar: number) => {
      if (!song) return;
      seek(barToSec(bar, song));
    },
    [song, seek],
  );

  /** Switch between loading every part and just the reference mix. */
  const setVariant = useCallback((id: string | null) => {
    engine.setActiveVariant(id);
    setState((s) => ({ ...s, activeVariantId: engine.activeVariantId }));
  }, []);

  /* ---------------------------- stem mixer ---------------------------- */

  const bumpStems = useCallback(() => {
    setState((s) => ({ ...s, stemVersion: s.stemVersion + 1, anySoloed: engine.anySoloed }));
  }, []);

  /**
   * Faders and pan emit an event per pixel of travel, and re-rendering the
   * player for each one is far more work than the readouts are worth. Coalesce
   * them: the slider itself keeps up natively, and the dB and L/R labels catch
   * up a few times a second, ending on the true value.
   */
  const pendingBump = useRef<number | null>(null);
  const bumpStemsSoon = useCallback(() => {
    if (pendingBump.current !== null) return;
    pendingBump.current = window.setTimeout(() => {
      pendingBump.current = null;
      bumpStems();
    }, 60);
  }, [bumpStems]);

  /** Persist whatever the engine now holds for this stem. */
  const persistStem = useCallback(
    (variantId: string) => {
      if (!song) return;
      const current = engine.getStemState(variantId);
      if (current) {
        saveSetting(song.id, variantId, {
          level: current.level,
          muted: current.muted,
          pan: current.pan,
        });
      }
    },
    [song],
  );

  const setStemLevel = useCallback(
    (variantId: string, level: number) => {
      engine.setStemLevel(variantId, level);
      persistStem(variantId);
      bumpStemsSoon();
    },
    [persistStem, bumpStemsSoon],
  );

  const setStemMuted = useCallback(
    (variantId: string, muted: boolean) => {
      engine.setStemMuted(variantId, muted);
      persistStem(variantId);
      bumpStems();
    },
    [persistStem, bumpStems],
  );

  const setStemPan = useCallback(
    (variantId: string, pan: number) => {
      engine.setStemPan(variantId, pan);
      persistStem(variantId);
      bumpStemsSoon();
    },
    [persistStem, bumpStemsSoon],
  );

  /** Solo is momentary and never persisted — it's a "let me hear that" control. */
  const setStemSolo = useCallback(
    (variantId: string, soloed: boolean) => {
      engine.setStemSolo(variantId, soloed);
      bumpStems();
    },
    [bumpStems],
  );

  const clearSolos = useCallback(() => {
    engine.clearSolos();
    bumpStems();
  }, [bumpStems]);

  const stemState = useCallback((variantId: string) => engine.getStemState(variantId), []);

  /**
   * A plain-text account of the audio path, for a device that is silent for
   * reasons nothing on screen explains.
   */
  const [audioReport, setAudioReport] = useState<string | null>(null);
  const showAudioReport = useCallback((show: boolean) => {
    setAudioReport(
      show
        ? Object.entries(engine.audioReport())
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')
        : null,
    );
  }, []);

  /** A/B against the reference: hear it alone, whatever the faders say. */
  const setSwitched = useCallback((id: string, on: boolean) => {
    engine.setSwitched(id, on);
    setState((s) => ({ ...s, switchedId: on ? id : null }));
  }, []);

  const resetStemMix = useCallback(() => {
    if (!song) return;
    resetMix(song.id);
    for (const variant of song.variants) {
      if (variant.role !== 'stem') continue;
      engine.setStemLevel(variant.id, 1);
      engine.setStemMuted(variant.id, false);
      engine.setStemSolo(variant.id, false);
      engine.setStemPan(variant.id, 0);
    }
    bumpStems();
  }, [song, bumpStems]);

  /** Cycle through the song's visible variants — handy as a single tap/key. */
  const cycleVariant = useCallback(
    (direction = 1) => {
      if (!song) return;
      // Only complete mixes are exclusive; stems are controlled from the mixer.
      const ids = visibleVariants(song)
        .filter((v) => v.role !== 'stem')
        .map((v) => v.id);
      if (ids.length < 2) return;
      const current = engine.activeVariantId;
      const index = current ? ids.indexOf(current) : 0;
      const next = ids[(index + direction + ids.length) % ids.length];
      setVariant(next);
    },
    [song, setVariant],
  );

  const setLoop = useCallback((region: LoopRegion | null) => {
    engine.setLoop(region);
    setState((s) => ({ ...s, loop: engine.getLoop() }));
  }, []);

  /** Loop the `bars` bars starting at the current position's bar line. */
  const loopBarsFromHere = useCallback(
    (bars: number) => {
      if (!song) return;
      const startBar = Math.floor(secToBar(engine.position, song));
      setLoop({ startSec: barToSec(startBar, song), endSec: barToSec(startBar + bars, song) });
    },
    [song, setLoop],
  );

  const toggleClick = useCallback(() => {
    engine.setClickEnabled(!engine.clickEnabled);
    setState((s) => ({ ...s, clickOn: engine.clickEnabled }));
  }, []);

  const setVolume = useCallback((v: number) => engine.setMasterVolume(v), []);
  const setClickVolume = useCallback((v: number) => engine.setClickVolume(v), []);

  return {
    ...state,
    engine,
    play,
    pause,
    toggle,
    seek,
    jumpBars,
    seekToBar,
    setVariant,
    cycleVariant,
    setLoop,
    loopBarsFromHere,
    toggleClick,
    setVolume,
    setClickVolume,
    subscribePosition,
    setStemLevel,
    setStemMuted,
    setStemPan,
    setStemSolo,
    clearSolos,
    stemState,
    downloadChoice: choosing ? choice : null,
    openDownloadPicker,
    confirmDownloads,
    skippedVariants: song ? skippedFor(song.id) : [],
    setSwitched,
    audioReport,
    showAudioReport,
    /** The set's devices: imitated in Web Audio, or not. */
    effects,
    effectsDecided: fxChoice !== null,
    setEffects,
    resetStemMix,
    supportsPanning: engine.supportsPanning,
    unlock: () => engine.unlock().then(() => setState((s) => ({ ...s, audioState: engine.state }))),
  };
}

export type Player = ReturnType<typeof usePlayer>;
