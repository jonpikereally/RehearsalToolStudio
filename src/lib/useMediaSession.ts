import { useEffect } from 'react';
import type { Song } from '../types';
import { transposeKeyName } from './pitchService';

/**
 * Lock screen and Control Center integration.
 *
 * Gives the phone's own transport — and the media keys on a laptop — control of
 * playback, with the song named alongside. Note this does not grant background
 * audio on iOS, where Safari suspends the AudioContext once the page leaves the
 * foreground; it makes the controls work where background audio already does.
 */

export interface MediaSessionOptions {
  song: Song | null;
  playing: boolean;
  position: number;
  duration: number;
  play: () => void;
  pause: () => void;
  seek: (sec: number) => void;
  jumpBars: (bars: number) => void;
  onPrevious?: () => void;
  onNext?: () => void;
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function useMediaSession(opts: MediaSessionOptions): void {
  const { song, playing, position, duration } = opts;
  const title = song?.title ?? '';
  const artist = song?.artist ?? '';
  const project = song?.project ?? '';
  const key = song ? transposeKeyName(song.originalKey, song.transpose) : null;

  /* -------------------------------- metadata ------------------------------- */

  useEffect(() => {
    if (!supported() || !song) return;
    try {
      // Tempo and key belong here as much as anywhere — it's what you'd want to
      // see on a lock screen mid-rehearsal.
      const detail = [song.tempoUnset ? null : `${song.bpm} BPM`, key].filter(Boolean).join(' · ');
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: artist || 'Rehearsal Tool Studio',
        album: [project === 'Unfiled' ? '' : project, detail].filter(Boolean).join(' — '),
        artwork: [
          { src: './icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch {
      /* metadata is cosmetic */
    }
  }, [song, title, artist, project, key]);

  /* ------------------------------ playback state ---------------------------- */

  useEffect(() => {
    if (!supported()) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);

  useEffect(() => {
    if (!supported() || !navigator.mediaSession.setPositionState) return;
    // Throws on nonsense values, and an unloaded song legitimately has none.
    if (!(duration > 0) || position < 0 || position > duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 });
    } catch {
      /* ignore */
    }
  }, [position, duration]);

  /* -------------------------------- controls -------------------------------- */

  useEffect(() => {
    if (!supported()) return;
    const ms = navigator.mediaSession;

    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => opts.play()],
      ['pause', () => opts.pause()],
      ['stop', () => opts.pause()],
      // A bar is a more useful jump than a fixed number of seconds here.
      ['seekbackward', () => opts.jumpBars(-4)],
      ['seekforward', () => opts.jumpBars(4)],
      ['seekto', (details: any) => {
        if (typeof details?.seekTime === 'number') opts.seek(details.seekTime);
      }],
      ['previoustrack', opts.onPrevious ? () => opts.onPrevious!() : null],
      ['nexttrack', opts.onNext ? () => opts.onNext!() : null],
    ];

    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* not every browser implements every action */
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
    // Rebinding on every position tick would be wasteful; the callbacks close
    // over refs that stay current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.play, opts.pause, opts.seek, opts.jumpBars, opts.onPrevious, opts.onNext]);
}
