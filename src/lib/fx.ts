import type { Device } from '../types';

/**
 * Live's stock devices, approximated in Web Audio.
 *
 * A web view cannot host a plugin, so the devices on a set's tracks and
 * return buses can only ever be imitated here. What is imitated: EQ Eight's
 * bands as biquad filters, the Glue and the standard Compressor as the
 * browser's dynamics compressor, the Limiter as a hard one, Utility's gain,
 * Reverb as a convolution with a decaying noise, Auto Filter as one filter,
 * Saturator as a waveshaper. It is a likeness, never a match — the Glue
 * has a character, the browser's compressor has a spec sheet — and anything
 * else, a third-party plugin above all, is passed straight through and
 * named, so nobody mistakes the raw file for the mixed one.
 */

export const SUPPORTED = new Set(['Eq8', 'GlueCompressor', 'Compressor2', 'Limiter', 'Utility', 'Reverb', 'AutoFilter', 'Saturator']);

/** What a device is called on the page. */
export function deviceLabel(device: Device): string {
  const names: Record<string, string> = {
    Eq8: 'EQ Eight',
    GlueCompressor: 'Glue Compressor',
    Compressor2: 'Compressor',
    Limiter: 'Limiter',
    Utility: 'Utility',
    Reverb: 'Reverb',
    AutoFilter: 'Auto Filter',
    Saturator: 'Saturator',
    Delay: 'Delay',
    Echo: 'Echo',
    HybridReverb: 'Hybrid Reverb',
    Gate: 'Gate',
    MultibandDynamics: 'Multiband Dynamics',
    AudioEffectGroupDevice: 'Audio Effect Rack',
    MxDeviceAudioEffect: 'Max for Live device',
    PluginDevice: 'plugin',
    AuPluginDevice: 'plugin',
    Vst3PluginDevice: 'plugin',
    Vst2PluginDevice: 'plugin',
  };
  const base = names[device.kind] ?? device.kind;
  return device.name && device.name !== base ? `${base} “${device.name}”` : base;
}

const dbToGain = (db: number): number => 10 ** (db / 20);

/** A run of nodes, or nothing at all, which is a straight wire. */
interface Chain {
  input: AudioNode;
  output: AudioNode;
}

/**
 * The nodes for one device chain, in order. Devices switched off, and any
 * that cannot be imitated, are left out; a chain with nothing in it is a
 * single unity gain, so callers always have something to connect to.
 */
export function buildChain(ctx: BaseAudioContext, devices: Device[]): Chain {
  const input = ctx.createGain();
  let head: AudioNode = input;
  for (const device of devices) {
    if (!device.on || !SUPPORTED.has(device.kind)) continue;
    const built = buildDevice(ctx, device);
    if (!built) continue;
    head.connect(built.input);
    head = built.output;
  }
  return { input, output: head };
}

function buildDevice(ctx: BaseAudioContext, device: Device): Chain | null {
  const p = device.params;
  const num = (key: string, fallback: number): number =>
    typeof p[key] === 'number' && Number.isFinite(p[key] as number) ? (p[key] as number) : fallback;
  switch (device.kind) {
    case 'Eq8':
      return eqEight(ctx, device);
    case 'GlueCompressor': {
      const ratios = [2, 4, 10];
      const attacks = [0.01, 0.1, 0.3, 1, 3, 10, 30];
      const releases = [0.1, 0.2, 0.4, 0.6, 0.8, 1.2, 0.5];
      return compressor(ctx, {
        thresholdDb: num('Threshold', -18),
        ratio: ratios[Math.round(num('Ratio', 1))] ?? 4,
        attackSec: (attacks[Math.round(num('Attack', 3))] ?? 1) / 1000,
        releaseSec: releases[Math.round(num('Release', 2))] ?? 0.4,
        kneeDb: 6,
        makeupDb: num('Makeup', 0),
        wet: num('DryWet', 1),
      });
    }
    case 'Compressor2': {
      // Live keeps this threshold as an amplitude, not in dB.
      const threshold = num('Threshold', 1);
      return compressor(ctx, {
        thresholdDb: threshold > 0 ? 20 * Math.log10(threshold) : -60,
        ratio: num('Ratio', 4),
        attackSec: num('Attack', 10) / 1000,
        releaseSec: num('Release', 100) / 1000,
        kneeDb: num('Knee', 6),
        makeupDb: num('Gain', 0),
        wet: num('DryWet', 1),
      });
    }
    case 'Limiter': {
      const pre = ctx.createGain();
      pre.gain.value = dbToGain(num('Gain', 0));
      const dyn = ctx.createDynamicsCompressor();
      dyn.threshold.value = Math.max(-100, Math.min(0, num('Ceiling', -0.3)));
      dyn.ratio.value = 20;
      dyn.knee.value = 0;
      dyn.attack.value = 0.001;
      dyn.release.value = Math.max(0.01, num('Release', 300) / 1000);
      pre.connect(dyn);
      return { input: pre, output: dyn };
    }
    case 'Utility': {
      const gain = ctx.createGain();
      gain.gain.value = p.Mute === true ? 0 : dbToGain(num('Gain', 0));
      return { input: gain, output: gain };
    }
    case 'Reverb':
      return reverb(ctx, num('DecayTime', 1200) / 1000, num('PreDelay', 2.5) / 1000, num('DryWet', 1));
    case 'AutoFilter': {
      const filter = ctx.createBiquadFilter();
      const types: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass', 'notch'];
      filter.type = types[Math.round(num('FilterType', 0))] ?? 'lowpass';
      filter.frequency.value = Math.max(20, Math.min(20000, num('Cutoff', num('Frequency', 1000))));
      // Live's resonance runs 0..1.25; a plain filter's Q from gentle to ringing.
      filter.Q.value = 0.7 + Math.max(0, num('Resonance', 0)) * 8;
      return { input: filter, output: filter };
    }
    case 'Saturator': {
      const drive = dbToGain(Math.max(0, num('PreDrive', 0)));
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * drive) / Math.tanh(drive || 1e-6);
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
      return wetDry(ctx, { input: shaper, output: shaper }, num('DryWet', 1));
    }
    default:
      return null;
  }
}

/**
 * EQ Eight, band by band. Live's modes, in the order its menu shows them:
 * low cut at 12 or 48 dB per octave, low shelf, bell, notch, high shelf, and
 * high cut at 12 or 48. A 48 dB cut is four 12 dB filters in a row.
 */
function eqEight(ctx: BaseAudioContext, device: Device): Chain | null {
  const nodes: AudioNode[] = [];
  for (const band of device.bands ?? []) {
    if (!band.on) continue;
    const mode = Math.round(band.mode);
    const make = (type: BiquadFilterType, withGain: boolean, q = band.q): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = Math.max(10, Math.min(22000, band.freq));
      f.Q.value = Math.max(0.05, q);
      if (withGain) f.gain.value = band.gain;
      return f;
    };
    switch (mode) {
      case 0:
        nodes.push(make('highpass', false, 0.707));
        break;
      case 1:
        for (let i = 0; i < 4; i++) nodes.push(make('highpass', false, 0.707));
        break;
      case 2:
        if (band.gain !== 0) nodes.push(make('lowshelf', true));
        break;
      case 3:
        if (band.gain !== 0) nodes.push(make('peaking', true));
        break;
      case 4:
        nodes.push(make('notch', false));
        break;
      case 5:
        if (band.gain !== 0) nodes.push(make('highshelf', true));
        break;
      case 6:
        nodes.push(make('lowpass', false, 0.707));
        break;
      case 7:
        for (let i = 0; i < 4; i++) nodes.push(make('lowpass', false, 0.707));
        break;
      default:
        break;
    }
  }
  const globalDb = typeof device.params.GlobalGain === 'number' ? (device.params.GlobalGain as number) : 0;
  if (globalDb !== 0) {
    const g = ctx.createGain();
    g.gain.value = dbToGain(globalDb);
    nodes.push(g);
  }
  if (!nodes.length) return null;
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  return { input: nodes[0], output: nodes[nodes.length - 1] };
}

function compressor(
  ctx: BaseAudioContext,
  o: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number; kneeDb: number; makeupDb: number; wet: number },
): Chain {
  const dyn = ctx.createDynamicsCompressor();
  dyn.threshold.value = Math.max(-100, Math.min(0, o.thresholdDb));
  dyn.ratio.value = Math.max(1, Math.min(20, o.ratio));
  dyn.attack.value = Math.max(0, Math.min(1, o.attackSec));
  dyn.release.value = Math.max(0.01, Math.min(1, o.releaseSec));
  dyn.knee.value = Math.max(0, Math.min(40, o.kneeDb));
  const makeup = ctx.createGain();
  makeup.gain.value = dbToGain(o.makeupDb);
  dyn.connect(makeup);
  return wetDry(ctx, { input: dyn, output: makeup }, o.wet);
}

/**
 * Reverb as a convolution with a noise that dies away over the decay time —
 * the shape of a room with none of its character, which is as far as a
 * browser goes without an impulse response to hand.
 */
function reverb(ctx: BaseAudioContext, decaySec: number, preDelaySec: number, wet: number): Chain {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.round(rate * Math.min(12, Math.max(0.1, decaySec + preDelaySec))));
  const impulse = ctx.createBuffer(2, length, rate);
  const pre = Math.round(rate * Math.max(0, preDelaySec));
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / rate;
      // -60 dB by the end of the decay, which is how a decay time is defined.
      data[i] = (Math.random() * 2 - 1) * Math.exp((-6.9078 * t) / Math.max(0.05, decaySec));
    }
  }
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse;
  return wetDry(ctx, { input: convolver, output: convolver }, wet);
}

/** Blend a device's output with what went in, as its Dry/Wet knob does. */
function wetDry(ctx: BaseAudioContext, chain: Chain, wet: number): Chain {
  const w = Math.max(0, Math.min(1, Number.isFinite(wet) ? wet : 1));
  if (w >= 0.999) return chain;
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1 - w;
  const wetGain = ctx.createGain();
  wetGain.gain.value = w;
  input.connect(dry);
  dry.connect(output);
  input.connect(chain.input);
  chain.output.connect(wetGain);
  wetGain.connect(output);
  return { input, output };
}

/** One line for a chain: "EQ Eight, Glue Compressor". */
export function chainSummary(devices: Device[]): string {
  return devices.filter((d) => d.on).map(deviceLabel).join(', ');
}

/** The devices in a chain this app cannot imitate, by name. */
export function unsupportedIn(devices: Device[]): string[] {
  return devices.filter((d) => d.on && !SUPPORTED.has(d.kind)).map(deviceLabel);
}
