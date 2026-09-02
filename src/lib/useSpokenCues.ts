import { useEffect, useRef } from 'react';
import type { Song } from '../types';
import { secToBar } from './bars';
import { cueDue, cueLeadBars, cueVoiceName, loadVoices, speak, stopSpeaking, usableVoices } from './spokenCues';

/**
 * Call sections out loud as they approach.
 *
 * Driven off the same position subscription everything else uses, and it speaks
 * at most once per marker per pass — a cue repeating every frame for a whole
 * bar would be unusable, and looping a section should call it again each time
 * round, not once ever.
 */
export function useSpokenCues(
  song: Song | null,
  subscribePosition: (fn: (sec: number) => void) => () => void,
  playing: boolean,
  enabled: boolean,
): void {
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const spokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadVoices().then((all) => {
      if (cancelled) return;
      const usable = usableVoices(all);
      const wanted = cueVoiceName();
      voiceRef.current = usable.find((v) => v.name === wanted) ?? usable[0] ?? null;
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !song || !playing) {
      stopSpeaking();
      spokenRef.current = null;
      return;
    }

    const markers = [...song.markers].sort((a, b) => a.bar - b.bar);
    const lead = cueLeadBars();

    return subscribePosition((sec) => {
      const due = cueDue(markers, secToBar(sec, song), lead);
      if (!due) {
        // Out of every lead window: the next arrival is a fresh one.
        spokenRef.current = null;
        return;
      }
      if (spokenRef.current === due.id) return;
      spokenRef.current = due.id;
      speak(due.name, voiceRef.current);
    });
  }, [enabled, song, playing, subscribePosition]);

  // Nothing should still be talking once the page is gone.
  useEffect(() => () => stopSpeaking(), []);
}
