import { useEffect, useState } from 'react';
import { SongEngine } from '../lib/audioEngine';
import { useStore } from '../lib/store';

/**
 * Which device the studio plays out of.
 *
 * Only where the browser lets a page choose — Chromium does, and the Mac
 * app's WebKit window does not, where the honest thing is to say so and
 * point at the system's Sound settings. Devices are listed by name only once
 * a media permission has been granted, which is the browser's rule and not
 * ours; the button says why before it asks.
 */
export default function OutputDevice() {
  const { settings, saveSettings } = useStore();
  const [devices, setDevices] = useState<{ id: string; label: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [present, setPresent] = useState<boolean | null>(null);
  const chosen = settings.outputDevice;

  const list = async (): Promise<{ id: string; label: string }[]> => {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : 'An output (name withheld)') }));
  };

  // Whether the remembered device is actually here. Ids are given without
  // any permission, so this needs no prompt.
  useEffect(() => {
    if (!chosen || !SongEngine.supportsOutputSelection) return;
    let live = true;
    void list().then((found) => {
      if (live) setPresent(found.some((d) => d.id === chosen.id));
    }).catch(() => {
      if (live) setPresent(null);
    });
    return () => {
      live = false;
    };
  }, [chosen?.id]);

  const choose = async () => {
    setError(null);
    try {
      /*
       * Labels are withheld until a media permission is granted — asking for
       * the microphone is the only door to the names of the outputs. The
       * stream is closed the moment it opens; nothing is recorded.
       */
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setDevices(await list());
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Without that permission the browser will not name the outputs, so nothing can be chosen. Allow the microphone for this site and try again — nothing is recorded; it is only the key to the list.'
          : err instanceof Error ? err.message : String(err),
      );
    }
  };

  if (!SongEngine.supportsOutputSelection) {
    return (
      <div className="field">
        <label>
          Output device
          <span className="hint">
            This window cannot choose one — it plays to whatever the Mac's Sound settings say.
            The studio run in Chrome can pin an output; this app, being a WebKit window, cannot.
          </span>
        </label>
        <span className="code">system default</span>
      </div>
    );
  }

  return (
    <>
    <div className="field">
      <label>
        Output device
        <span className="hint">
          Pin playback to one output — the interface, not the laptop speakers. Remembered, and asked
          for again on every start.
          {chosen && present === false && ' Not connected right now, so playback is on the system default until it is.'}
        </span>
      </label>
      <div className="btn-row">
        <span className="code">{chosen ? chosen.label : 'system default'}</span>
        {devices === null ? (
          <button
            className="btn"
            onClick={() => void choose()}
            title="The browser only names outputs once it has microphone permission; nothing is recorded"
          >
            Choose output…
          </button>
        ) : (
          <select
            aria-label="Output device"
            value={chosen?.id ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              const device = devices.find((d) => d.id === id);
              saveSettings({ outputDevice: id && device && id !== 'default' ? device : null });
            }}
          >
            <option value="">System default</option>
            {devices.filter((d) => d.id !== 'default').map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        )}
        {chosen && (
          <button className="btn" onClick={() => saveSettings({ outputDevice: null })}>
            Back to default
          </button>
        )}
      </div>
    </div>
    {/* Below the field, not in it: a notice in the row would squeeze the label. */}
    {error && <div className="notice error">{error}</div>}
    </>
  );
}
