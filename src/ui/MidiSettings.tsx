import { useEffect, useState } from 'react';
import {
  chosenOutputId, defaultChannel, defaultDeviceId, describePatch, midiEnabled, midiSupported,
  onPortsChanged, openMidi, outputs, sendPatchReporting, setChosenOutputId, setDefaultChannel,
  setDefaultDeviceId, setMidiEnabled, type MidiPort, type SendReport,
} from '../lib/midi';
import { DEVICES, choiceLabel, choiceValue, optionById, startingDevice } from '../lib/devices';
import SettingsSection from './SettingsSection';

/** Where patch changes go, and whether they go at all. */
export default function MidiSettings() {
  const [on, setOn] = useState(midiEnabled);
  const [ports, setPorts] = useState<MidiPort[]>([]);
  const [chosen, setChosen] = useState(chosenOutputId);
  const [asked, setAsked] = useState(false);
  const [refused, setRefused] = useState(false);
  const [rig, setRig] = useState(defaultDeviceId);
  const [channel, setChannel] = useState(defaultChannel);

  const device = startingDevice(rig);
  const [testOptionId, setTestOptionId] = useState(device.options[0].id);
  const testOption = optionById(device, testOptionId) ?? device.options[0];
  const [testValue, setTestValue] = useState(0);
  const [report, setReport] = useState<SendReport | null>(null);

  /*
   * Asking for MIDI is what makes the ports readable, so it happens as soon as
   * this panel is open rather than waiting for sending to be switched on: the
   * usual reason for opening it is that something isn't working, and an empty
   * port list would be the first misleading thing you saw.
   */
  useEffect(() => {
    if (asked) return;
    setAsked(true);
    void openMidi().then((ok) => {
      setRefused(!ok);
      if (ok) setPorts(outputs());
    });
  }, [asked]);

  /*
   * Gear switched on after the page loaded is the ordinary case, not the
   * exception. Without this the list was whatever happened to be plugged in at
   * the moment MIDI was first granted, and a rig turned on afterwards showed as
   * "nothing connected yet" while sitting right there.
   */
  useEffect(() => onPortsChanged(() => setPorts(outputs())), [asked]);

  if (!midiSupported()) return null;

  /* Closed, the only thing worth reading is where the patch changes end up. */
  const destination = (chosen ? ports.find((p) => p.id === chosen) : ports[0])?.name;
  const summary = !on
    ? 'off'
    : refused
      ? <><span className="badge warn">blocked</span>the browser refused MIDI access</>
      : destination
        ? `to ${destination}`
        : 'on — nothing connected yet';

  return (
    <SettingsSection id="midi" title="MIDI patch changes" summary={summary}>
      <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
        Send a program change to your rig as the song reaches each one. Which changes, and where, is
        the Rig block on the song page — they're yours alone, not shared with the band, since a
        patch number means something different on every rig.
      </div>

      {/*
        Above the on/off switch on purpose: naming your rig is worth doing even
        with sending switched off, since it's what the patch dictionary opens on.
      */}
      <div className="field">
        <label htmlFor="midi-rig">
          Your rig
          <span className="hint">What a new patch change starts on.</span>
        </label>
        <select
          id="midi-rig"
          value={rig || DEVICES[0].id}
          onChange={(e) => {
            setRig(e.target.value);
            setDefaultDeviceId(e.target.value);
          }}
        >
          {DEVICES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="midi-channel">
          On channel
          <span className="hint">
            A rig moved off its usual channel is moved off it for every song.
          </span>
        </label>
        <select
          id="midi-channel"
          value={channel}
          onChange={(e) => {
            setChannel(Number(e.target.value));
            setDefaultChannel(Number(e.target.value));
          }}
        >
          <option value={0}>Its own default ({startingDevice(rig).defaultChannel})</option>
          {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="midi-on">
          Send patch changes
          <span className="hint">
            {refused ? 'The browser refused MIDI access.' : 'Asks for MIDI access the first time.'}
          </span>
        </label>
        <input
          id="midi-on"
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setMidiEnabled(e.target.checked);
          }}
          style={{ width: 24, height: 24 }}
        />
      </div>

      <div className="field">
        <label htmlFor="midi-out">
          Send to
          <span className="hint">
            {ports.length
              ? `${ports.length} output${ports.length === 1 ? '' : 's'} found`
              : 'nothing connected yet'}
          </span>
        </label>
        <select
          id="midi-out"
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
            setChosenOutputId(e.target.value);
            setReport(null);
          }}
        >
          {/*
              "First available" is only sensible with one port. With several it
              is a coin toss, and a patch going to the wrong box looks exactly
              like one that never sent — so it names which one it would be.
            */}
          <option value="">
            {ports.length > 1 ? `First available (${ports[0].name})` : 'First available'}
          </option>
          {ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/*
        The thing to reach for when nothing is happening: it separates "the app
        can't talk to the box" from "the clips aren't firing", which otherwise
        look identical from the stage. Shown even after a refusal — that is
        exactly when someone needs it, and pressing it asks again.
      */}
      <div className="controls flush">
        <span className="control-label">Test</span>
        <select
          value={testOptionId}
          onChange={(e) => {
            setTestOptionId(e.target.value);
            setTestValue(0);
            setReport(null);
          }}
          aria-label="What to send as a test"
        >
          {device.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {(testOption.count ?? 1) > 1 && (
          <select
            value={testValue}
            onChange={(e) => {
              setTestValue(Number(e.target.value));
              setReport(null);
            }}
            aria-label={testOption.unit ?? 'Value'}
          >
            {Array.from({ length: testOption.count ?? 1 }, (_, i) => i).map((i) => (
              <option key={i} value={i}>
                {choiceLabel(testOption, i)}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn"
          onClick={async () => {
            // Sending needs access even when the clips are switched off.
            const ok = await openMidi();
            setRefused(!ok);
            setPorts(outputs());
            if (!ok) {
              setReport({
                ok: false,
                port: null,
                reason: 'The browser refused MIDI access.',
              });
              return;
            }
            setReport(
              sendPatchReporting(
                testOption.build(
                  channel || device.defaultChannel,
                  choiceValue(testOption, testValue),
                ),
              ),
            );
          }}
        >
          Send now
        </button>
      </div>

      {report && (
        <div className={report.ok ? 'notice' : 'notice error'}>
          {report.ok ? (
            <>
              Sent{' '}
              {describePatch(
                testOption.build(
                  channel || device.defaultChannel,
                  choiceValue(testOption, testValue),
                ),
              )}{' '}
              to <strong>{report.port}</strong>. If the rig didn't change, it isn't listening on
              that channel — or that port isn't the one it's on.
            </>
          ) : (
            report.reason
          )}
        </div>
      )}

      <div style={{ color: '#6b7789', fontSize: 12.5 }}>
        Sent a moment before the section rather than on the downbeat, so the rig has changed by the
        time you play it. Chrome and Edge only — Safari and Firefox have no MIDI.
      </div>
    </SettingsSection>
  );
}
