import { useEffect, useRef } from 'react';
import type { Song } from '../types';
import { barToSec } from './bars';
import { clipsOf, openMidi, patchPoints, sendPatch } from './midi';
import { totalBars } from './bars';

/**
 * How far ahead of a clip its patch is sent.
 *
 * A rig needs a moment to change, and a program change landing on the downbeat
 * arrives audibly late. Far enough ahead to be ready, close enough that it
 * doesn't cut the end of what came before.
 */
const LEAD_SEC = 0.25;

/**
 * Send each patch clip as it comes up.
 *
 * Fires once per clip per pass — so looping a section changes the patch again
 * each time round, and sitting inside one doesn't machine-gun the rig.
 *
 * `revision` is bumped when the clips are edited, so a change made while the
 * song is playing takes effect on the next pass rather than at the next reload.
 */
export function useMidiPatches(
  song: Song | null,
  subscribePosition: (fn: (sec: number) => void) => () => void,
  playing: boolean,
  enabled: boolean,
  revision = 0,
): void {
  const readyRef = useRef(false);
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void openMidi().then((ok) => {
      if (!cancelled) readyRef.current = ok;
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !song || !playing) {
      sentRef.current = null;
      return;
    }

    /*
     * The song's own remembered length, since nothing here has the decoded one
     * — it only decides whether a clip's ending falls inside the song, and a
     * clip past the end never comes up anyway.
     */
    const lastBar = totalBars(song.durationSec ?? 0, song);
    const points = patchPoints(clipsOf(song), lastBar)
      .map((point, i) => ({
        id: `${i}`,
        at: barToSec(point.bar, song) - LEAD_SEC,
        patch: point.patch,
      }))
      .sort((a, b) => a.at - b.at);
    if (!points.length) return;

    return subscribePosition((sec) => {
      // The latest point the playhead has passed, within a window — so seeking
      // into the middle of a section still lands on its patch, while scrubbing
      // across the whole song doesn't fire every patch on the way.
      let due: (typeof points)[number] | null = null;
      for (const point of points) {
        if (sec >= point.at && sec < point.at + 1) due = point;
      }
      if (!due) {
        sentRef.current = null;
        return;
      }
      if (sentRef.current === due.id) return;
      sentRef.current = due.id;
      if (readyRef.current) sendPatch(due.patch);
    });
  }, [enabled, song, playing, subscribePosition, revision]);
}
