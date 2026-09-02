import { useEffect, useState } from 'react';
import {
  cueLeadBars, cueVoiceName, loadVoices, setCueLeadBars, setCueVoiceName,
  cuesAvailable, usableVoices,
} from '../lib/spokenCues';
import SettingsSection from './SettingsSection';

/** Which voice calls the sections, and how far ahead. */
export default function CueSettings() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [name, setName] = useState(cueVoiceName);
  const [lead, setLead] = useState(cueLeadBars);

  useEffect(() => {
    let cancelled = false;
    void loadVoices().then((all) => {
      if (!cancelled) setVoices(usableVoices(all));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!cuesAvailable()) return null;

  return (
    <SettingsSection
      id="cues"
      title="Spoken cues"
      summary={`${name || 'First available'} · ${lead} bar${lead === 1 ? '' : 's'} before`}
    >
      <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
        Each section called out loud just before it arrives, so you hear the chorus coming while
        your hands are busy. Switched on per song from the Navigate block.
      </div>

      <div className="field">
        <label htmlFor="cue-voice">
          Voice
          <span className="hint">
            {voices.length ? `${voices.length} available on this device` : 'loading…'}
          </span>
        </label>
        <select
          id="cue-voice"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setCueVoiceName(e.target.value);
          }}
        >
          <option value="">First available</option>
          {voices.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="cue-lead">
          Called
          <span className="hint">How far ahead of the section.</span>
        </label>
        <select
          id="cue-lead"
          value={lead}
          onChange={(e) => {
            const bars = Number(e.target.value);
            setLead(bars);
            setCueLeadBars(bars);
          }}
        >
          {[1, 2, 4].map((bars) => (
            <option key={bars} value={bars}>
              {bars} bar{bars === 1 ? '' : 's'} before
            </option>
          ))}
        </select>
      </div>

      <div style={{ color: '#6b7789', fontSize: 12.5 }}>
        Spoken by the browser, offline and free — but it plays through the device's own output
        rather than the mixer, so it has no fader and won't appear in a printed mix.
      </div>
    </SettingsSection>
  );
}
