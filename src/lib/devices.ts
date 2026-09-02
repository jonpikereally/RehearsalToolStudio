import type { Patch } from './midi';

/**
 * What to send to the rigs people actually have on the floor.
 *
 * Typing "CC69 value 2" is asking someone to translate their own instrument
 * into numbers mid-rehearsal. These are the messages the two commonest modellers
 * respond to, named the way the boxes name them, so setting a section's patch is
 * picking "Snapshot 3" rather than remembering what carries it.
 *
 * The distinction that matters on stage: a *preset* reloads the whole rig and
 * takes a moment, where a *snapshot* (Helix) or *scene* (Quad Cortex) switches
 * within the preset already loaded and is instant. Between sections of a song
 * you almost always want the second.
 *
 * Sources, checked rather than remembered:
 *   Helix — helixhelp.com/tips-and-guides/universal/midi and the Line 6 manuals
 *   Quad Cortex — neuraldsp.com/manual/quad-cortex
 *
 * One caveat carried honestly: the Quad Cortex scene CC is documented by Neural
 * DSP's own community rather than in the manual pages I could read, so it is
 * marked below. Everything else came from official documentation.
 */

export interface DeviceOption {
  id: string;
  label: string;
  /** What the value means, for the picker to label its choices. */
  unit?: string;
  /** How many choices, when the action takes one. */
  count?: number;
  /** Names for each choice, when they aren't simply numbered. */
  names?: string[];
  /**
   * The value each choice actually sends, when they aren't 0, 1, 2…
   *
   * The Stadium's top-panel CC is the reason: its documented values run 0–27
   * and then jump to 33 and 34, so a choice's position in the list is not the
   * number that goes down the wire.
   */
  values?: number[];
  /** Build the patch for a chosen value. */
  build: (channel: number, value: number) => Patch;
  note?: string;
}

export interface Device {
  id: string;
  name: string;
  /** The channel these boxes are usually set to out of the box. */
  defaultChannel: number;
  options: DeviceOption[];
  /** Something true about this rig worth saying before you go looking. */
  note?: string;
}

/**
 * The Helix stomps, and the CC that presses each.
 *
 * FS6 and FS12 are missing on purpose: on the hardware those are the mode and
 * tap switches rather than stomps, and Line 6 documents no CC for them. The
 * numbering runs 49–58 across the ten that exist, so the list is written out
 * rather than computed — an off-by-one here would press the wrong pedal.
 */
const HELIX_FOOTSWITCHES: { label: string; cc: number }[] = [
  { label: 'FS1', cc: 49 },
  { label: 'FS2', cc: 50 },
  { label: 'FS3', cc: 51 },
  { label: 'FS4', cc: 52 },
  { label: 'FS5', cc: 53 },
  { label: 'FS7', cc: 54 },
  { label: 'FS8', cc: 55 },
  { label: 'FS9', cc: 56 },
  { label: 'FS10', cc: 57 },
  { label: 'FS11', cc: 58 },
];

const footswitch = (channel: number, index: number, on: boolean): Patch => {
  const fs = HELIX_FOOTSWITCHES[index] ?? HELIX_FOOTSWITCHES[0];
  return {
    channel,
    controls: [{ cc: fs.cc, value: on ? 127 : 0 }],
    source: `Helix ${fs.label} ${on ? 'on' : 'off'}`,
  };
};

/** What the Stadium's top-panel CC calls each value it accepts. */
const STADIUM_PANEL: Record<number, string> = {
  34: 'tuner', 23: 'click', 24: 'mute all', 0: 'home view', 1: 'song view', 2: 'amp',
  3: 'save', 4: 'XY', 5: 'page left', 6: 'page right', 10: 'undo', 11: 'redo',
  12: 'preset down', 13: 'preset up', 14: 'preset list', 15: 'preset info',
  16: 'info scroll up', 17: 'info scroll down', 18: 'info zoom in', 19: 'info zoom out',
  20: 'preset clip', 21: 'stopwatch', 22: 'stopwatch reset', 25: 'focus panel',
  26: 'song list', 27: 'flag list', 33: 'song settings',
  7: 'matrix 1/4"', 8: 'matrix XLR', 9: 'matrix phones',
};

const STADIUM_SETLISTS = ['Factory', 'User 1', 'User 2', 'User 3', 'User 4'];

const snapshot = (channel: number, value: number, source: string): Patch => ({
  channel,
  controls: [{ cc: 69, value }],
  source,
});

export const DEVICES: Device[] = [
  {
    id: 'helix',
    name: 'Line 6 Helix / HX',
    defaultChannel: 1,
    options: [
      {
        id: 'helix-snapshot',
        label: 'Snapshot',
        unit: 'snapshot',
        count: 8,
        note: 'Instant, within the preset already loaded — what you want between sections.',
        build: (channel, value) => snapshot(channel, value, `Helix snapshot ${value + 1}`),
      },
      {
        id: 'helix-preset',
        label: 'Preset',
        unit: 'preset',
        count: 128,
        note: 'Reloads the whole rig. Slower than a snapshot, and can cut the tail of what came before.',
        build: (channel, value) => ({
          channel,
          program: value,
          source: `Helix preset ${value + 1}`,
        }),
      },
      {
        id: 'helix-setlist',
        label: 'Setlist',
        unit: 'setlist',
        count: 8,
        note: 'Sent as bank LSB (CC32). Follow it with a preset to land somewhere specific.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 32, value }],
          source: `Helix setlist ${value + 1}`,
        }),
      },
      {
        id: 'helix-fs-on',
        label: 'Footswitch on',
        unit: 'footswitch',
        count: HELIX_FOOTSWITCHES.length,
        names: HELIX_FOOTSWITCHES.map((f) => f.label),
        note: 'Presses a stomp in Stomp mode. FS6 and FS12 are the mode and tap switches, so they have no CC.',
        build: (channel, value) => footswitch(channel, value, true),
      },
      {
        id: 'helix-fs-off',
        label: 'Footswitch off',
        unit: 'footswitch',
        count: HELIX_FOOTSWITCHES.length,
        names: HELIX_FOOTSWITCHES.map((f) => f.label),
        build: (channel, value) => footswitch(channel, value, false),
      },
      {
        id: 'helix-toe',
        label: 'EXP toe switch',
        names: ['Off', 'On'],
        count: 2,
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 59, value: value ? 127 : 0 }],
          source: `Helix toe switch ${value ? 'on' : 'off'}`,
        }),
      },
      {
        id: 'helix-tuner',
        label: 'Tuner',
        names: ['Off', 'On'],
        count: 2,
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 68, value: value ? 127 : 0 }],
          source: `Helix tuner ${value ? 'on' : 'off'}`,
        }),
      },
      {
        id: 'helix-tap',
        label: 'Tap tempo',
        names: ['Tap'],
        count: 1,
        build: (channel) => ({
          channel,
          controls: [{ cc: 64, value: 127 }],
          source: 'Helix tap tempo',
        }),
      },
    ],
  },
  {
    id: 'helix-stadium',
    name: 'Line 6 Helix Stadium',
    defaultChannel: 1,
    /*
     * A different machine from the Helix above, not a newer revision of it. The
     * tuner moved from its own CC onto a value of the top-panel CC, the toe
     * switch moved from 59 to 36, EXP 3 is gone, and there is a player built in
     * with transport CCs the original never had. Anything assuming the old
     * numbers carries over will quietly do the wrong thing.
     */
    note: 'A separate implementation from the original Helix — the tuner, toe switch and pedals are all on different CCs. It has no per-footswitch CC either; the top panel and footswitch mode are how you reach the board.',
    options: [
      {
        id: 'stadium-snapshot',
        label: 'Snapshot',
        unit: 'snapshot',
        count: 10,
        names: ['1', '2', '3', '4', '5', '6', '7', '8', 'Next', 'Previous'],
        note: 'Instant, within the loaded preset. Stadium adds next and previous, which the original does not have.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 69, value }],
          source:
            value < 8 ? `Stadium snapshot ${value + 1}` : `Stadium ${value === 8 ? 'next' : 'previous'} snapshot`,
        }),
      },
      {
        id: 'stadium-preset',
        label: 'Preset',
        unit: 'preset',
        count: 128,
        note: 'Reloads the rig. Send a setlist first if you are crossing folders.',
        build: (channel, value) => ({ channel, program: value, source: `Stadium preset ${value + 1}` }),
      },
      {
        id: 'stadium-setlist',
        label: 'Setlist',
        count: 9,
        names: ['Factory', 'User 1', 'User 2', 'User 3', 'User 4', 'Custom 1', 'Custom 2', 'Custom 3', 'Custom 4'],
        note: 'CC32. Factory is 0, the four user banks are 1–4, and custom setlists start at 5.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 32, value }],
          source: `Stadium setlist ${STADIUM_SETLISTS[value] ?? `custom ${value - 4}`}`,
        }),
      },
      {
        id: 'stadium-panel',
        label: 'Top panel button',
        count: 30,
        names: [
          'Tuner', 'Click on/off', 'Mute all', 'Home View', 'Song View', 'Amp', 'Save',
          'XY open/close', 'Page left', 'Page right', 'Undo', 'Redo',
          'Preset down', 'Preset up', 'Preset list', 'Preset info',
          'Info scroll up', 'Info scroll down', 'Info zoom in', 'Info zoom out',
          'Preset clip', 'Stopwatch start/stop', 'Stopwatch reset',
          'Focus panel', 'Song list', 'Flag list', 'Song settings',
          'Matrix 1/4"', 'Matrix XLR', 'Matrix phones',
        ],
        // The values are what the panel actually listens for; the order above is
        // by usefulness rather than by number, so they are listed explicitly.
        values: [34, 23, 24, 0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27, 33, 7, 8, 9],
        note: 'One CC carries the whole top panel, chosen by value.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 9, value }],
          source: `Stadium ${STADIUM_PANEL[value] ?? `panel ${value}`}`,
        }),
      },
      {
        id: 'stadium-fs-mode',
        label: 'Footswitch mode',
        count: 7,
        names: ['Mode 1', 'Mode 2', 'Mode 3', 'Mode 4', 'Mode 5', 'Mode 6', 'Mode 7'],
        note: 'CC37. Stadium switches the whole board rather than pressing one switch.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 37, value }],
          source: `Stadium footswitch mode ${value + 1}`,
        }),
      },
      {
        id: 'stadium-transport',
        label: 'Player',
        count: 6,
        names: ['Play / pause', 'Return to zero', 'Next song', 'Previous song', 'Next marker', 'Previous marker'],
        note: 'Stadium has a player of its own. These drive it.',
        build: (channel, value) => {
          const moves: { cc: number; value: number; label: string }[] = [
            { cc: 51, value: 127, label: 'play/pause' },
            { cc: 47, value: 0, label: 'return to zero' },
            { cc: 49, value: 127, label: 'next song' },
            { cc: 49, value: 0, label: 'previous song' },
            { cc: 50, value: 127, label: 'next marker' },
            { cc: 50, value: 0, label: 'previous marker' },
          ];
          const move = moves[value] ?? moves[0];
          return {
            channel,
            controls: [{ cc: move.cc, value: move.value }],
            source: `Stadium ${move.label}`,
          };
        },
      },
      {
        id: 'stadium-toe',
        label: 'EXP toe switch',
        names: ['Toggle'],
        count: 1,
        note: 'CC36 on Stadium, not 59 — and it alternates rather than taking on and off.',
        build: (channel) => ({
          channel,
          controls: [{ cc: 36, value: 127 }],
          source: 'Stadium toe switch',
        }),
      },
      {
        id: 'stadium-tap',
        label: 'Tap tempo',
        names: ['Tap'],
        count: 1,
        build: (channel) => ({
          channel,
          controls: [{ cc: 64, value: 127 }],
          source: 'Stadium tap tempo',
        }),
      },
    ],
  },
  {
    id: 'quad-cortex',
    name: 'Neural DSP Quad Cortex',
    defaultChannel: 1,
    /*
     * Neural DSP documents only four incoming CCs — tap, tuner, gig view and
     * mode — plus preset addressing. There is no way to press an individual
     * footswitch from outside, as there is on a Helix. Saying so beats leaving
     * someone hunting for an option that was never built.
     */
    note: 'The Quad Cortex has no CC for pressing an individual footswitch — Neural DSP does not implement it. Use Scene for switching within a preset.',
    options: [
      {
        id: 'qc-scene',
        label: 'Scene',
        unit: 'scene',
        count: 8,
        note: 'Instant, within the loaded preset. Documented by Neural DSP’s community rather than the manual.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 43, value }],
          source: `Quad Cortex scene ${value + 1}`,
        }),
      },
      {
        id: 'qc-preset',
        label: 'Preset',
        unit: 'preset',
        count: 128,
        note: 'Reloads the rig. Setlists are addressed with the bank below.',
        build: (channel, value) => ({
          channel,
          program: value,
          source: `Quad Cortex preset ${value + 1}`,
        }),
      },
      {
        id: 'qc-setlist',
        label: 'Setlist',
        unit: 'setlist',
        count: 128,
        note: 'Bank LSB (CC32), as the Quad Cortex addresses setlists. Follow with a preset.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 32, value }],
          source: `Quad Cortex setlist ${value + 1}`,
        }),
      },
      {
        id: 'qc-mode',
        label: 'Mode',
        names: ['Preset', 'Scene', 'Stomp'],
        count: 3,
        note: 'Mode slots 1, 2 and 3, which default to Preset, Scene and Stomp.',
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 47, value }],
          source: `Quad Cortex ${['preset', 'scene', 'stomp'][value] ?? 'preset'} mode`,
        }),
      },
      {
        id: 'qc-tuner',
        label: 'Tuner',
        names: ['Off', 'On'],
        count: 2,
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 45, value: value ? 127 : 0 }],
          source: `Quad Cortex tuner ${value ? 'on' : 'off'}`,
        }),
      },
      {
        id: 'qc-gig-view',
        label: 'Gig View',
        names: ['Close', 'Open'],
        count: 2,
        build: (channel, value) => ({
          channel,
          controls: [{ cc: 46, value: value ? 127 : 0 }],
          source: `Quad Cortex gig view ${value ? 'open' : 'closed'}`,
        }),
      },
      {
        id: 'qc-tap',
        label: 'Tap tempo',
        names: ['Tap'],
        count: 1,
        build: (channel) => ({
          channel,
          controls: [{ cc: 44, value: 127 }],
          source: 'Quad Cortex tap tempo',
        }),
      },
    ],
  },
  {
    id: 'generic',
    name: 'Anything else',
    defaultChannel: 1,
    options: [
      {
        id: 'generic-program',
        label: 'Program change',
        unit: 'program',
        count: 128,
        /*
         * Numbered from zero here, unlike the modellers above. Those name their
         * presets the way the box does, starting at one; a bare program change
         * has no box to agree with, so it shows the number that actually goes
         * down the wire rather than one that looks tidier.
         */
        names: Array.from({ length: 128 }, (_, n) => String(n)),
        note: 'The one message every MIDI instrument made since 1983 understands. Numbered as sent, from 0.',
        build: (channel, value) => ({ channel, program: value, source: `Program ${value}` }),
      },
    ],
  },
];

export function deviceById(id: string): Device | undefined {
  return DEVICES.find((d) => d.id === id);
}

/**
 * The rig a patch change starts on: the one named in Settings, or the first
 * here. Falls back rather than failing, so a stored id from a dictionary that
 * has since changed doesn't leave the dialog with nothing selected.
 */
export function startingDevice(id: string): Device {
  return deviceById(id) ?? DEVICES[0];
}

/**
 * What a brand new clip sends before anything is chosen.
 *
 * A rig's first option is its most useful one — a Helix snapshot, a Quad
 * Cortex scene — so a clip dropped on the lane already does the thing you
 * reach for between sections, rather than a bare program change.
 */
export function startingPatch(deviceId: string, channel = 0): Patch {
  const device = startingDevice(deviceId);
  const option = device.options[0];
  return option.build(channel || device.defaultChannel, choiceValue(option, 0));
}

export function optionById(device: Device, id: string): DeviceOption | undefined {
  return device.options.find((o) => o.id === id);
}

/** What to call choice `index` of an option — its own name, or a 1-based number. */
export function choiceLabel(option: DeviceOption, index: number): string {
  return option.names?.[index] ?? String(index + 1);
}

/** The value choice `index` sends, which is not always the index itself. */
export function choiceValue(option: DeviceOption, index: number): number {
  return option.values?.[index] ?? index;
}
