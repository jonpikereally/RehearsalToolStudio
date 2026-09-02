import { useEffect, useRef, useState } from 'react';
import type { Song } from '../types';
import type { Player } from '../lib/usePlayer';
import { mixesOf, stemsOf } from '../lib/stemMix';
import { isReferenceName } from '../lib/scan';
import { hasDevices } from '../lib/usePlayer';
import { isSetClick } from '../lib/songLoader';
import { useStore } from '../lib/store';
import BlockHead, { type BlockChrome } from './BlockHead';
import { SongEngine } from '../lib/audioEngine';
import BounceDialog from './BounceDialog';
import { stemAudible } from '../lib/audioEngine';

/**
 * Fader, pan, mute and solo per stem, with drag-to-reorder and inline renaming.
 *
 * Solo follows DAW convention: soloing anything silences every other stem, and
 * overrides that stem's own mute, so you hear only what you picked.
 */
/** ~30fps: fast enough to read as a meter, a third of the cost of every frame. */
const METER_INTERVAL_MS = 33;
/** Per-update fall. Slow enough to see, fast enough not to smear. */
const METER_DECAY = 0.82;

/** A row in the mixer: a part of the song, the reference, or the metronome. */
interface Channel {
  id: string;
  name: string;
  kind: 'stem' | 'mix' | 'reference' | 'click';
  /** Position among the channels; every kind can be dragged. */
  order: number;
}

export default function StemMixer({
  song,
  player,
  chrome,
}: {
  song: Song;
  player: Player;
  chrome: BlockChrome;
}) {
  const { updateSong } = useStore();
  /*
   * Only what the engine actually holds. A device that downloaded the reference
   * alone has no stems loaded, and rows for parts that aren't there would be
   * controls that do nothing — while requiring stems to show the mixer at all
   * left that device with no controls whatsoever.
   */
  const loaded = (id: string) => !player.ready || player.engine.hasTrack(id);
  const stems = stemsOf(song).filter((v) => loaded(v.id));

  /*
   * The reference and the click are channels too. They sit below the parts
   * because they're things to play *against* — a reference to match, a click to
   * follow — rather than pieces of the arrangement, and neither can be renamed
   * or reordered: one is named by the set, the other is generated.
   */
  const CLICK_ID = SongEngine.clickTrackId;
  const LAST = Number.MAX_SAFE_INTEGER;

  const channels: Channel[] = [
    ...stems.map((v) => ({ id: v.id, name: v.name, kind: 'stem' as const, order: v.order ?? LAST })),
    ...mixesOf(song)
      .filter((v) => loaded(v.id))
      .map((v) => ({
        id: v.id,
        name: v.name,
        // Only the reference master gets SWITCH; an instrumental or an acapella
        // is an ordinary channel you can blend.
        kind: isReferenceName(v.name) ? ('reference' as const) : ('mix' as const),
        order: v.order ?? LAST,
      })),
    // The metronome's row, unless the set brought its own click, which is
    // already among the stems above and is the click then.
    ...(stems.some((v) => isSetClick(song, v))
      ? []
      : [{ id: CLICK_ID, name: 'Click', kind: 'click' as const, order: song.clickOrder ?? LAST }]),
  ].sort((a, b) => a.order - b.order);

  const meterRefs = useRef(new Map<string, HTMLSpanElement>());

  /*
   * Metering runs on its own frame loop writing straight to the DOM. Putting
   * eight levels through React state would re-render the whole mixer many
   * times a second, which is exactly what the transport was taken out of.
   */
  useEffect(() => {
    if (chrome.collapsed || !player.playing) {
      for (const el of meterRefs.current.values()) el.style.transform = 'scaleX(1)';
      return;
    }
    const engine = player.engine;
    const held = new Map<string, number>();
    let frame = 0;
    let previousTime = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // A meter reads fine at a third of the frame rate and costs a third as much.
      if (now - previousTime < METER_INTERVAL_MS) return;
      previousTime = now;

      for (const [id, el] of meterRefs.current) {
        const peak = engine.peakLevel(id);
        // Instant attack, gentle release: the fall is what makes a meter
        // readable, since the peaks themselves are far too brief to see.
        const last = held.get(id) ?? 0;
        const level = peak > last ? peak : last * METER_DECAY;
        held.set(id, level);
        // The mask covers what isn't lit, so it shrinks as the level rises.
        el.style.transform = `scaleX(${(1 - level).toFixed(3)})`;
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [chrome.collapsed, player.playing, player.engine]);

  /** While dragging, the provisional order; null the rest of the time. */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [bouncing, setBouncing] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // With no stems loaded the reference is simply the song, and plays normally.
  const hasStemChannels = channels.some((c) => c.kind === 'stem');

  const shown: Channel[] = dragOrder
    ? (dragOrder.map((id) => channels.find((c) => c.id === id)).filter(Boolean) as Channel[])
    : channels;

  /**
   * Persist an arrangement.
   *
   * Order lives in the library file rather than on the device: a sensible
   * layout is worth sharing with the band, where a personal balance is not.
   */
  const commitOrder = (ids: string[]) => {
    const positions = new Map(ids.map((id, i) => [id, i]));
    updateSong(song.id, {
      variants: song.variants.map((v) =>
        positions.has(v.id) ? { ...v, order: positions.get(v.id)! } : v,
      ),
      // The click has no variant to hang an order on, so it keeps its own.
      clickOrder: positions.get(CLICK_ID) ?? song.clickOrder,
    });
  };

  const moveBy = (id: string, delta: number) => {
    const ids = channels.map((c) => c.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    commitOrder(ids);
  };

  /**
   * Turning a stem off.
   *
   * `hidden` already keeps a variant out of the load entirely, so a stem
   * switched off here isn't downloaded, decoded, played, or put through the
   * pitch and stretch renders — which is the point: a song of eight parts you
   * only need five of changes key in five renders instead of eight.
   *
   * It lives in the library rather than on the device, alongside the stem
   * order, so a part nobody needs is off for the whole band.
   */
  const setEnabled = (id: string, enabled: boolean) => {
    updateSong(song.id, {
      variants: song.variants.map((v) => (v.id === id ? { ...v, hidden: !enabled } : v)),
    });
  };

  const disabled = song.variants.filter((v) => v.hidden && v.role === 'stem');

  const rename = (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateSong(song.id, {
      variants: song.variants.map((v) => (v.id === id ? { ...v, name: trimmed } : v)),
    });
  };

  /* -------------------------------- dragging ------------------------------- */

  const startDrag = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDraggingId(id);
    setDragOrder(channels.map((c) => c.id));
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!draggingId || !dragOrder) return;
    // Reorder as soon as the pointer crosses into another row's box, so the
    // list rearranges under the finger rather than only on release.
    const y = e.clientY;
    let over = -1;
    dragOrder.forEach((id, index) => {
      const rect = rowRefs.current.get(id)?.getBoundingClientRect();
      if (rect && y >= rect.top && y <= rect.bottom) over = index;
    });

    const from = dragOrder.indexOf(draggingId);
    if (over < 0 || over === from) return;
    const next = [...dragOrder];
    next.splice(over, 0, next.splice(from, 1)[0]);
    setDragOrder(next);
  };

  const endDrag = () => {
    if (dragOrder && draggingId) commitOrder(dragOrder);
    setDraggingId(null);
    setDragOrder(null);
  };

  if (channels.length <= 1) return null; // the click alone is not a mixer

  return (
    <section
      className={chrome.dragging ? 'block mixer dragging' : 'block mixer'}
      aria-label="Stem mixer"
    >
      <BlockHead
        title="Mixer"
        chrome={chrome}
        extra={
          <div className="block-actions">
            <button
              className="chip"
              onClick={() => player.showAudioReport(true)}
              title="What this device's audio is actually doing"
            >
              ?
            </button>
            <button
              className="chip"
              onClick={() => setBouncing(true)}
              title="Print what you hear to a file"
            >
              Print mix…
            </button>
            {hasDevices(song) && (
              <button
                className={player.effects ? 'chip on' : 'chip'}
                onClick={() => player.setEffects(!player.effects)}
                title={
                  player.effects
                    ? "The set's devices are imitated in Web Audio — tap to play the files raw"
                    : "The files play raw — tap to imitate the set's devices in Web Audio"
                }
              >
                {player.effects ? 'Devices: imitated' : 'Devices: off'}
              </button>
            )}
            {player.anySoloed && (
              <button className="chip on" onClick={player.clearSolos}>
                Clear solo
              </button>
            )}
            <button className="chip" onClick={player.resetStemMix}>
              Reset
            </button>
          </div>
        }
      />

      {!chrome.collapsed && disabled.length > 0 && (
        <div className="stems-off">
          <span className="control-label">Off</span>
          {disabled.map((v) => (
            <button
              key={v.id}
              className="chip"
              onClick={() => setEnabled(v.id, true)}
              title="Load this part again"
            >
              {v.name} <span className="chip-plus">+</span>
            </button>
          ))}
        </div>
      )}

      {bouncing && (
        <BounceDialog song={song} player={player} onClose={() => setBouncing(false)} />
      )}

      {!chrome.collapsed && shown.map((stem) => {
        const movable = stem.kind === 'stem';
        const state = player.stemState(stem.id) ?? { level: 1, muted: false, soloed: false, pan: 0 };
        /*
         * Grey out only what genuinely isn't sounding, mirroring the engine.
         * A reference beside stems is silent unless SWITCH brings it in, and
         * switching it in silences everything else — so the whole mixer greys
         * out around it.
         */
        const switching = player.switchedId !== null;
        const switchedIn = player.switchedId === stem.id;
        const audible = switching
          ? switchedIn
          : stem.kind === 'reference' && hasStemChannels
            ? false
            : stemAudible(state, player.anySoloed);
        const soloBeatsMute = state.muted && state.soloed;
        const classes = [
          'stem',
          audible ? '' : 'quiet',
          switchedIn ? 'switched' : '',
          draggingId === stem.id ? 'dragging' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={stem.id}
            className={classes}
            ref={(el) => {
              if (el) rowRefs.current.set(stem.id, el);
              else rowRefs.current.delete(stem.id);
            }}
          >
            <div className="stem-row">
              <button
                className="stem-grip"
                onPointerDown={(e) => startDrag(e, stem.id)}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(e) => {
                  // Arrow keys do the same job without a pointer.
                  if (e.key === 'ArrowUp') { e.preventDefault(); moveBy(stem.id, -1); }
                  if (e.key === 'ArrowDown') { e.preventDefault(); moveBy(stem.id, 1); }
                }}
                aria-label={`Reorder ${stem.name}. Use arrow keys to move it.`}
                title="Drag to reorder"
              >
                ⠿
              </button>

              {movable && renamingId === stem.id ? (
                <input
                  className="stem-name-input"
                  defaultValue={stem.name}
                  autoFocus
                  onBlur={(e) => {
                    rename(stem.id, e.target.value);
                    setRenamingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  aria-label={`Rename ${stem.name}`}
                />
              ) : movable ? (
                <button
                  className="stem-name"
                  onClick={() => setRenamingId(stem.id)}
                  title="Tap to rename"
                >
                  {stem.name}
                </button>
              ) : (
                <span className={`stem-name ${stem.kind}`}>{stem.name}</span>
              )}

              {stem.kind === 'reference' ? (
                /*
                 * One button instead of mute and solo. The channel still has
                 * both underneath — the engine treats it like any other — they
                 * simply aren't worth a control here: what you want from a
                 * reference is "let me hear the record", and SWITCH is that,
                 * audible whatever the blend fader is set to.
                 */
                <button
                  className={player.switchedId === stem.id ? 'stem-switch on' : 'stem-switch'}
                  onClick={() => player.setSwitched(stem.id, player.switchedId !== stem.id)}
                  aria-pressed={player.switchedId === stem.id}
                  title={
                    player.switchedId === stem.id
                      ? 'Playing the reference — tap to go back to the parts'
                      : 'Play the reference instead of the parts'
                  }
                >
                  SWITCH
                </button>
              ) : (
                <>
              {movable && (
                <button
                  className="stem-btn off-btn"
                  onClick={() => setEnabled(stem.id, false)}
                  aria-label={`Turn off ${stem.name}`}
                  title="Turn this part off — it won't be loaded or rendered at all"
                >
                  ⏻
                </button>
              )}
              <button
                className={`stem-btn${state.muted ? ' mute-on' : ''}${soloBeatsMute ? ' overridden' : ''}`}
                onClick={() => player.setStemMuted(stem.id, !state.muted)}
                aria-pressed={state.muted}
                aria-label={
                  soloBeatsMute
                    ? `${stem.name} is muted, but solo is overriding it`
                    : `Mute ${stem.name}`
                }
                title={
                  soloBeatsMute
                    ? 'Muted — but soloed, so it is sounding. Drop the solo to silence it again.'
                    : 'Mute'
                }
              >
                M
              </button>
              <button
                className={`stem-btn${state.soloed ? ' solo-on' : ''}`}
                onClick={() => player.setStemSolo(stem.id, !state.soloed)}
                aria-pressed={state.soloed}
                aria-label={`Solo ${stem.name}`}
                title="Solo"
              >
                S
              </button>
                </>
              )}

              {player.supportsPanning && (
                <>
                  <span className="stem-sub">pan</span>
                  <input
                    type="range"
                    className="stem-pan"
                    min={-1}
                    max={1}
                    step={0.02}
                    value={state.pan}
                    onChange={(e) => player.setStemPan(stem.id, Number(e.target.value))}
                    aria-label={`${stem.name} pan`}
                  />
                  <button
                    className="stem-db secondary mono"
                    onClick={() => player.setStemPan(stem.id, 0)}
                    title="Centre"
                  >
                    {formatPan(state.pan)}
                  </button>
                </>
              )}
            </div>

            <span className="stem-meter" aria-hidden>
              <span
                className="stem-meter-fill"
                ref={(el) => {
                  if (el) meterRefs.current.set(stem.id, el);
                  else meterRefs.current.delete(stem.id);
                }}
              />
            </span>

            {/* Volume gets a row to itself, full width. */}
            <div className="stem-row">
              <input
                type="range"
                className="stem-fader"
                min={0}
                max={1.5}
                step={0.01}
                value={state.level}
                onChange={(e) => player.setStemLevel(stem.id, Number(e.target.value))}
                aria-label={`${stem.name} level`}
              />
              {/* Tap the readout to snap back to unity. */}
              <button
                className="stem-db mono"
                onClick={() => player.setStemLevel(stem.id, 1)}
                title="Reset to 0 dB"
              >
                {formatLevel(state.level)}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Show the fader in dB, which is how the number actually reads to a musician. */
function formatLevel(level: number): string {
  if (level <= 0.001) return '−∞';
  const db = 20 * Math.log10(level);
  if (Math.abs(db) < 0.05) return '0.0';
  return `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1)}`;
}

/** Desk-style pan readout: C in the middle, L/R with a percentage either side. */
function formatPan(pan: number): string {
  const amount = Math.round(Math.abs(pan) * 100);
  if (amount < 2) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${amount}`;
}
