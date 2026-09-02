import { useEffect, useMemo, useState } from 'react';
import type { Song } from '../types';
import { DEVICES, choiceLabel, choiceValue, deviceById, optionById, startingDevice } from '../lib/devices';
import {
  defaultChannel, defaultDeviceId, describePatch, patchMessages, type Patch, type PatchClip,
} from '../lib/midi';
import { barToSec, formatTime, totalBars } from '../lib/bars';

/**
 * Choosing what the rig does, and where.
 *
 * Named the way the boxes name things — "Snapshot 3", not "CC69 value 2" —
 * because nobody standing in a rehearsal room should be translating their own
 * instrument into numbers. The messages are shown underneath anyway, since the
 * one thing worse than typing CC numbers is not being able to check them.
 *
 * Editing keeps the patch it already has until you pick another: a clip is
 * usually moved rather than rewritten, and re-choosing the same snapshot from
 * two dropdowns to nudge it two bars would be a silly thing to ask.
 */
export default function PatchDialog({
  song,
  duration,
  clip,
  onSave,
  onDelete,
  onClose,
}: {
  song: Song;
  duration: number;
  /** The clip being edited, or a fresh one to place. */
  clip: PatchClip;
  onSave: (clip: PatchClip) => void;
  /** Absent for a clip that hasn't been placed yet. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  // Opens on the rig named in Settings rather than on the first in the list.
  const [deviceId, setDeviceId] = useState(() => startingDevice(defaultDeviceId()).id);
  const device = deviceById(deviceId) ?? DEVICES[0];
  const [optionId, setOptionId] = useState(device.options[0].id);
  const option = optionById(device, optionId) ?? device.options[0];
  const [value, setValue] = useState(0);
  const [channel, setChannel] = useState(
    clip.patch.channel || defaultChannel() || device.defaultChannel,
  );
  const [bar, setBar] = useState(clip.bar);
  /** Until the dictionary is touched, the clip keeps whatever it already sent. */
  const [picked, setPicked] = useState(false);

  /** 0 is "until the next change", which is a clip with no length of its own. */
  const [lengthBars, setLengthBars] = useState(clip.lengthBars ?? 0);
  /** '' is "what was on before", which is what most endings want. */
  const [endOptionId, setEndOptionId] = useState('');
  const [endValue, setEndValue] = useState(0);
  /** As with the patch itself: keep what's stored until this is touched. */
  const [endPicked, setEndPicked] = useState(false);
  const endOption = endOptionId ? optionById(device, endOptionId) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Moving to another device starts at its first option rather than keeping an
  // id that belongs to something else.
  const pickDevice = (id: string) => {
    const next = deviceById(id) ?? DEVICES[0];
    setDeviceId(id);
    setOptionId(next.options[0].id);
    setValue(0);
    setChannel(defaultChannel() || next.defaultChannel);
    setPicked(true);
    // The ending belonged to the rig that just went; it can't carry over.
    setEndOptionId('');
    setEndValue(0);
    setEndPicked(true);
  };

  // `value` is which choice is picked; what it sends may be a different number.
  const chosen = useMemo(
    () => option.build(channel, choiceValue(option, value)),
    [option, channel, value],
  );
  const patch: Patch = picked ? chosen : { ...clip.patch, channel };
  const endPatch: Patch | undefined = endPicked
    ? endOption && endOption.build(channel, choiceValue(endOption, endValue))
    : clip.endPatch;
  const messages = useMemo(() => patchMessages(patch), [patch]);
  const choices = Array.from({ length: option.count ?? 1 }, (_, i) => i);
  const endChoices = Array.from({ length: endOption?.count ?? 1 }, (_, i) => i);
  const lastBar = totalBars(duration, song);

  /**
   * Lengths worth a tap — plus whatever this clip is already set to, since
   * dragging its end sets any number of bars and a select that can't show the
   * value it holds reads as though the length had been lost.
   */
  const lengths = [...new Set([...[1, 2, 4, 8, 12, 16, 24, 32], lengthBars])]
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={onDelete ? 'Edit patch change' : 'Add a patch change'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="spread">
          <h3>{onDelete ? 'Patch change' : 'Add a patch change'}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="dialog-note">
          Sent to your rig a moment before this bar, and held until the next change — or for as
          long as you give it, for the ones you undo. Yours alone: patch numbers mean something
          different on everyone's setup, so these never leave this device.
        </p>

        <div className="controls flush">
          <span className="control-label">At bar</span>
          <input
            type="number"
            min={1}
            max={Math.max(1, lastBar)}
            value={bar}
            onChange={(e) => setBar(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            aria-label="Bar"
            style={{ width: 90 }}
          />
          <span className="control-note">
            {lastBar > 0 ? `of ${lastBar} · ${formatTime(barToSec(bar, song))}` : ''}
          </span>
        </div>

        <div className="controls flush">
          <span className="control-label">Length</span>
          <select
            value={lengthBars}
            onChange={(e) => setLengthBars(Number(e.target.value))}
            aria-label="How long it lasts"
          >
            <option value={0}>Until the next change</option>
            {lengths.map((n) => (
              <option key={n} value={n}>
                {n} bar{n === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <span className="control-note">
            {lengthBars ? `ends at bar ${bar + lengthBars}` : 'holds until something else changes it'}
          </span>
        </div>

        <div className="controls flush">
          <span className="control-label">Rig</span>
          <select value={deviceId} onChange={(e) => pickDevice(e.target.value)} aria-label="Device">
            {DEVICES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          {/* A channel is a property of the box, not of one message, so it sits
              with the box. Set the usual one in Settings; this is the exception. */}
          <span className="control-label">Ch</span>
          <select
            value={channel}
            onChange={(e) => setChannel(Number(e.target.value))}
            aria-label="MIDI channel"
          >
            {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="controls flush">
          <span className="control-label">Send</span>
          <select
            value={optionId}
            onChange={(e) => {
              setOptionId(e.target.value);
              setValue(0);
              setPicked(true);
            }}
            aria-label="What to send"
          >
            {device.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {choices.length > 1 && (
            <select
              value={value}
              onChange={(e) => {
                setValue(Number(e.target.value));
                setPicked(true);
              }}
              aria-label={option.unit ?? 'Value'}
            >
              {choices.map((i) => (
                <option key={i} value={i}>
                  {choiceLabel(option, i)}
                </option>
              ))}
            </select>
          )}
        </div>

        {lengthBars > 0 && (
          <div className="controls flush">
            <span className="control-label">And then</span>
            <select
              value={endOptionId}
              onChange={(e) => {
                setEndOptionId(e.target.value);
                setEndValue(0);
                setEndPicked(true);
              }}
              aria-label="What to send when it ends"
            >
              <option value="">What was on before</option>
              {device.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {endOption && endChoices.length > 1 && (
              <select
                value={endValue}
                onChange={(e) => {
                  setEndValue(Number(e.target.value));
                  setEndPicked(true);
                }}
                aria-label={endOption.unit ?? 'Value'}
              >
                {endChoices.map((i) => (
                  <option key={i} value={i}>
                    {choiceLabel(endOption, i)}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {device.note && <div className="notice">{device.note}</div>}
        {option.note && <p className="dialog-note">{option.note}</p>}

        <p className="dialog-note">
          Sends <span className="code">{messages.map((m) => m.map((b) => b.toString(16).padStart(2, '0')).join(' ')).join('  ')}</span>
          {' — '}
          {describePatch(patch)}.
          {!picked && onDelete && ' Pick something above to change it.'}
          {lengthBars > 0 && (
            <>
              <br />
              At bar {bar + lengthBars}:{' '}
              {endPatch
                ? describePatch(endPatch)
                : 'back to whatever was on before this — nothing, if this is the first change in the song'}
              .
            </>
          )}
        </p>

        <div className="btn-row">
          <button
            className="btn primary"
            onClick={() =>
              onSave({ ...clip, bar, patch, lengthBars: lengthBars || undefined, endPatch })
            }
          >
            {onDelete ? 'Save' : 'Add it'}
          </button>
          {onDelete && (
            <button className="btn danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
