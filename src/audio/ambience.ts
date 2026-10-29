// Ambience by depth (M6 T22, DESIGN §10): looped, seeded noise through filters plus slow drones,
// all in Web Audio (ADR 0014: no audio files). The shallows are an airy hiss with a sunlit shimmer;
// the deep darkens to a low wash and drone, and the abyss adds a slow pressure throb. The mapping
// from zone and depth to parameters is pure (tested in Node); `Ambience` builds the graph on any
// `BaseAudioContext`, so the same code renders offline for the render checks.

import type { Zone } from '../sim/bathymetry';
import { clamp, lerp } from '../sim/math';
import { createRng, hashU32 } from '../sim/prng';

export interface AmbienceParams {
  /** Level of the high, band-passed hiss (the air over sunlit water). */
  air: number;
  /** Its band centre, Hz. */
  airHz: number;
  /** Level of the low-passed wash (brown noise: the water's body). */
  body: number;
  /** Its cutoff, Hz. */
  bodyHz: number;
  /** Level of the drone (a root, its fifth and a slowly beating octave). */
  drone: number;
  /** The drone's root, Hz. */
  droneHz: number;
  /** Rate of the drone's slow swell, Hz. */
  swellHz: number;
  /** 0..1, how much the hiss flickers like caustics (the shallows only). */
  shimmer: number;
  /** Level of the pressure throb, a low pulsing tone (the abyss only). */
  pressure: number;
}

type Row = Omit<AmbienceParams, 'shimmer' | 'pressure'> & { depth: number };

/** Presentation constants. Levels are linear amplitudes before the master volume. */
export const AMBIENCE = {
  /** One row per zone, anchored at a depth inside it; depths between rows interpolate. */
  rows: {
    shallows: {
      depth: 0.125,
      air: 0.16,
      airHz: 3200,
      body: 0.12,
      bodyHz: 1100,
      drone: 0.012,
      droneHz: 220,
      swellHz: 0.13,
    },
    twilight: {
      depth: 0.4,
      air: 0.06,
      airHz: 1800,
      body: 0.16,
      bodyHz: 520,
      drone: 0.024,
      droneHz: 110,
      swellHz: 0.08,
    },
    deep: {
      depth: 0.675,
      air: 0.02,
      airHz: 1100,
      body: 0.2,
      bodyHz: 260,
      drone: 0.034,
      droneHz: 73.4,
      swellHz: 0.05,
    },
    abyss: {
      depth: 0.9,
      air: 0.006,
      airHz: 700,
      body: 0.24,
      bodyHz: 130,
      drone: 0.044,
      droneHz: 49,
      swellHz: 0.03,
    },
  } satisfies Record<Zone, Row>,
  /** The shallows' hiss flickers this deep, at two unrelated rates. */
  shimmer: 0.6,
  shimmerHz: [2.3, 3.7],
  /** The abyss's throb: its level, tone and pulse rate. */
  pressure: 0.05,
  pressureHz: 41,
  throbHz: 0.4,
  /** A change of zone lands within this long (98%). */
  fadeSeconds: 2,
  /** The ambience fades in this long after the engine starts, so it never pops. */
  startSeconds: 1.5,
  /** The noise loops are this long (two decorrelated channels). */
  loopSeconds: 4,
} as const;

const ORDER: readonly Zone[] = ['shallows', 'twilight', 'deep', 'abyss'];
const ROWS: readonly Row[] = ORDER.map((z) => AMBIENCE.rows[z]);

/** The time constant of `setTargetAtTime` that lands 98% of a change in `fadeSeconds`. */
export function fadeTimeConstant(): number {
  return AMBIENCE.fadeSeconds / 4;
}

const geo = (a: number, b: number, t: number): number => a * (b / a) ** t;

/**
 * The ambience at a depth (0..1) in a zone. Filters, levels and the drone follow depth
 * continuously; the zone adds its character (the shallows' shimmer, the abyss's pressure).
 */
export function ambienceParams(zone: Zone, depth: number): AmbienceParams {
  const d = clamp(Number.isFinite(depth) ? depth : 0, 0, 1);
  let i = 0;
  while (i < ROWS.length - 2 && d > (ROWS[i + 1] as Row).depth) i++;
  const lo = ROWS[i] as Row;
  const hi = ROWS[i + 1] as Row;
  const t = clamp((d - lo.depth) / (hi.depth - lo.depth), 0, 1);
  return {
    air: lerp(lo.air, hi.air, t),
    airHz: geo(lo.airHz, hi.airHz, t),
    body: lerp(lo.body, hi.body, t),
    bodyHz: geo(lo.bodyHz, hi.bodyHz, t),
    drone: lerp(lo.drone, hi.drone, t),
    droneHz: geo(lo.droneHz, hi.droneHz, t),
    swellHz: geo(lo.swellHz, hi.swellHz, t),
    shimmer: zone === 'shallows' ? AMBIENCE.shimmer : 0,
    pressure: zone === 'abyss' ? AMBIENCE.pressure : 0,
  };
}

/** Two seeded noise loops: white (for the hiss) and brown (for the wash), stereo and seamless. */
function noiseBuffers(
  ctx: BaseAudioContext,
  seed: number,
): { white: AudioBuffer; brown: AudioBuffer } {
  const length = Math.round(AMBIENCE.loopSeconds * ctx.sampleRate);
  const white = ctx.createBuffer(2, length, ctx.sampleRate);
  const brown = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const rng = createRng([hashU32(seed), ch, 0x5ea, 0xa0d10], 'ambience');
    const w = white.getChannelData(ch);
    const b = brown.getChannelData(ch);
    let level = 0;
    let sum = 0;
    for (let i = 0; i < length; i++) {
      const x = rng.next() * 2 - 1;
      w[i] = x * 0.5;
      level = (level + 0.02 * x) / 1.02;
      b[i] = level;
      sum += level;
    }
    // Remove the walk's drift and offset so the loop meets itself without a click.
    const drift = (b[length - 1] as number) - (b[0] as number);
    const mean = sum / length;
    let peak = 0;
    for (let i = 0; i < length; i++) {
      const v = (b[i] as number) - mean - drift * (i / length - 0.5);
      b[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    const norm = peak > 0 ? 0.5 / peak : 0;
    for (let i = 0; i < length; i++) b[i] = (b[i] as number) * norm;
  }
  return { white, brown };
}

/** The drone's partials: type, ratio to the root and level. */
const DRONE_MIX: readonly [OscillatorType, number, number][] = [
  ['sine', 1, 1],
  ['triangle', 1.5, 0.35],
  ['sine', 2.006, 0.25],
];

/**
 * The ambience graph: built once per engine, steered by `set`. Every summing point takes at most
 * two inputs: Chromium sums a node's inputs in an order that changes between runs, and float
 * addition only commutes for two terms, so wider mixes would break sample-identical renders.
 */
export class Ambience {
  private readonly out: GainNode;
  private readonly air: GainNode;
  private readonly airFilter: BiquadFilterNode;
  private readonly flicker: GainNode;
  private readonly body: GainNode;
  private readonly bodyFilter: BiquadFilterNode;
  private readonly drone: GainNode;
  private readonly swell: GainNode;
  private readonly swellLfo: OscillatorNode;
  private readonly droneOscs: OscillatorNode[];
  private readonly pressure: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private started = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
    seed: number,
  ) {
    const now = ctx.currentTime;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(1, now + AMBIENCE.startSeconds);
    this.out.connect(destination);
    // Two-input mixes into `out`: the noises, and the tones.
    const wash = ctx.createGain();
    const tones = ctx.createGain();
    wash.connect(this.out);
    tones.connect(this.out);
    const { white, brown } = noiseBuffers(ctx, seed);

    // The hiss: white noise, band-passed, flickering in the shallows.
    const airSrc = this.loop(white);
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.Q.value = 0.7;
    this.air = ctx.createGain();
    this.flicker = ctx.createGain();
    airSrc.connect(this.airFilter).connect(this.air).connect(wash);
    for (const hz of AMBIENCE.shimmerHz) {
      const lfo = this.osc('sine', hz);
      lfo.connect(this.flicker);
    }
    this.flicker.connect(this.air.gain);

    // The wash: brown noise, low-passed twice for a soft slope.
    const bodySrc = this.loop(brown);
    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'lowpass';
    this.bodyFilter.Q.value = 0.5;
    const second = ctx.createBiquadFilter();
    second.type = 'lowpass';
    second.Q.value = 0.5;
    second.frequency.value = 2400;
    this.body = ctx.createGain();
    bodySrc.connect(this.bodyFilter).connect(second).connect(this.body).connect(wash);

    // The drone: root, fifth and a slowly beating octave, swelling slowly.
    this.drone = ctx.createGain();
    this.swell = ctx.createGain();
    this.swellLfo = this.osc('sine', 0.1);
    this.swellLfo.connect(this.swell).connect(this.drone.gain);
    // The root and fifth mix first, then the octave joins: two inputs at each point.
    const pair = ctx.createGain();
    pair.connect(this.drone);
    this.droneOscs = DRONE_MIX.map(([type, ratio, level], i) => {
      const o = this.osc(type, 110 * ratio);
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(i < 2 ? pair : this.drone);
      return o;
    });
    this.drone.connect(tones);

    // The pressure: a low tone and its octave, pulsing slowly.
    const root = this.osc('sine', AMBIENCE.pressureHz);
    const octave = this.osc('sine', AMBIENCE.pressureHz * 2);
    const octaveLevel = ctx.createGain();
    octaveLevel.gain.value = 0.4;
    const tone = ctx.createGain();
    tone.gain.value = 0.5;
    const throb = this.osc('sine', AMBIENCE.throbHz);
    const throbDepth = ctx.createGain();
    throbDepth.gain.value = 0.5;
    throb.connect(throbDepth).connect(tone.gain);
    root.connect(tone);
    octave.connect(octaveLevel).connect(tone);
    this.pressure = ctx.createGain();
    tone.connect(this.pressure).connect(tones);
  }

  private loop(buffer: AudioBuffer): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    this.sources.push(src);
    return src;
  }

  private osc(type: OscillatorType, hz: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    this.sources.push(o);
    return o;
  }

  /** Steers every parameter towards `p`: at once, or cross-fading over `AMBIENCE.fadeSeconds`. */
  set(p: AmbienceParams, instant: boolean): void {
    const now = this.ctx.currentTime;
    const tau = fadeTimeConstant();
    const to = (param: AudioParam, value: number): void => {
      if (instant) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(value, now);
      } else {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, tau);
      }
    };
    to(this.air.gain, p.air);
    to(this.flicker.gain, (p.air * p.shimmer) / AMBIENCE.shimmerHz.length);
    to(this.airFilter.frequency, p.airHz);
    to(this.body.gain, p.body);
    to(this.bodyFilter.frequency, p.bodyHz);
    to(this.drone.gain, p.drone);
    to(this.swell.gain, p.drone * 0.5);
    to(this.swellLfo.frequency, p.swellHz);
    this.droneOscs.forEach((o, i) => {
      to(o.frequency, p.droneHz * (DRONE_MIX[i] as [OscillatorType, number, number])[1]);
    });
    to(this.pressure.gain, p.pressure);
    if (!this.started) {
      this.started = true;
      for (const s of this.sources) s.start(now);
    }
  }

  dispose(): void {
    for (const s of this.sources) {
      if (this.started) s.stop();
      s.disconnect();
    }
    this.out.disconnect();
  }
}
