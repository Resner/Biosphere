// Event sounds (M6 T23, DESIGN §10): one short patch per feedback cue, synthesised from enveloped
// tones and filtered noise (ADR 0014: no audio files). The table is plain data, so its lengths and
// levels are checked in Node; `playCue` builds a voice on any `BaseAudioContext`, so the same
// patches render offline for the render checks. Quiet and organic: a microscope, not an arcade.

import { clamp } from '../sim/math';
import { createRng, hashU32 } from '../sim/prng';

export const CUES = [
  'eat',
  'hurt',
  'low-energy',
  'hazard-near',
  'dash',
  'death',
  'old-age',
  'court',
  'mate',
  'hatch',
  'reveal',
  'grow',
  'tier',
  'ping',
  'emote',
  'chat',
  'uv',
  'pressure',
] as const;

export type Cue = (typeof CUES)[number];

interface LayerBase {
  /** Seconds after the cue starts. */
  delay?: number;
  attack: number;
  /** Seconds at full level after the attack. */
  hold?: number;
  /** Exponential fall to silence. */
  decay: number;
  /** Linear peak amplitude before the master volume. */
  level: number;
  /** A tone's pitch or a noise's filter frequency at the start, Hz. */
  hz: number;
  /** Where it glides to by the layer's end (exponentially); none holds `hz`. */
  toHz?: number;
}

export interface ToneLayer extends LayerBase {
  kind: 'tone';
  wave: OscillatorType;
}

export interface NoiseLayer extends LayerBase {
  kind: 'noise';
  filter: BiquadFilterType;
  q: number;
}

export type Layer = ToneLayer | NoiseLayer;

export interface CueSound {
  /** The cue's pinned length: every layer has ended by then. */
  seconds: number;
  layers: readonly Layer[];
}

const tone = (wave: OscillatorType, l: LayerBase): ToneLayer => ({ kind: 'tone', wave, ...l });
const noise = (filter: BiquadFilterType, q: number, l: LayerBase): NoiseLayer => ({
  kind: 'noise',
  filter,
  q,
  ...l,
});

/** When a layer has fallen silent, seconds after the cue starts. */
export function layerEnd(l: Layer): number {
  return (l.delay ?? 0) + l.attack + (l.hold ?? 0) + l.decay;
}

/** The patches, in DESIGN §10's words. */
export const CUE_SOUNDS: Record<Cue, CueSound> = {
  // A soft bubble pop: a quick upward blip with a wet click.
  eat: {
    seconds: 0.16,
    layers: [
      tone('sine', { attack: 0.004, decay: 0.15, level: 0.3, hz: 360, toHz: 900 }),
      noise('bandpass', 4, { attack: 0.002, decay: 0.04, level: 0.12, hz: 2600 }),
    ],
  },
  // A dull hit: a low thud and a muffled knock.
  hurt: {
    seconds: 0.26,
    layers: [
      tone('sine', { attack: 0.003, decay: 0.25, level: 0.4, hz: 150, toHz: 60 }),
      noise('lowpass', 0.8, { attack: 0.002, decay: 0.12, level: 0.35, hz: 500, toHz: 200 }),
    ],
  },
  // A slow low pulse: two soft heartbeats, the second weaker.
  'low-energy': {
    seconds: 0.68,
    layers: [
      tone('sine', { attack: 0.03, decay: 0.24, level: 0.32, hz: 62, toHz: 52 }),
      tone('sine', { attack: 0.03, decay: 0.2, level: 0.12, hz: 124, toHz: 104 }),
      tone('sine', { delay: 0.34, attack: 0.03, decay: 0.3, level: 0.22, hz: 58, toHz: 48 }),
      tone('sine', { delay: 0.34, attack: 0.03, decay: 0.24, level: 0.08, hz: 116, toHz: 96 }),
    ],
  },
  // A rumble: a dark swell of low noise over a sub tone.
  'hazard-near': {
    seconds: 1.05,
    layers: [
      noise('lowpass', 0.7, { attack: 0.25, hold: 0.2, decay: 0.6, level: 0.45, hz: 180 }),
      tone('sine', { attack: 0.25, hold: 0.2, decay: 0.55, level: 0.18, hz: 44, toHz: 38 }),
    ],
  },
  // A whoosh: band-passed noise sweeping up.
  dash: {
    seconds: 0.36,
    layers: [
      noise('bandpass', 1.4, { attack: 0.08, decay: 0.28, level: 0.5, hz: 500, toHz: 2400 }),
    ],
  },
  // A descending tone: a slow fall over an octave and a half, with a hollow undertone.
  death: {
    seconds: 1.5,
    layers: [
      tone('sine', { attack: 0.02, hold: 0.25, decay: 1.23, level: 0.3, hz: 440, toHz: 140 }),
      tone('triangle', { attack: 0.04, hold: 0.2, decay: 1.2, level: 0.12, hz: 220, toHz: 70 }),
    ],
  },
  // A slow low swell: a soft fifth rising and falling.
  'old-age': {
    seconds: 2,
    layers: [
      tone('sine', { attack: 0.8, decay: 1.2, level: 0.22, hz: 98 }),
      tone('sine', { attack: 0.9, decay: 1.05, level: 0.1, hz: 147 }),
    ],
  },
  // A chime: two soft bells a fifth apart.
  court: {
    seconds: 0.75,
    layers: [
      tone('sine', { attack: 0.005, decay: 0.65, level: 0.2, hz: 660 }),
      tone('sine', { delay: 0.09, attack: 0.005, decay: 0.65, level: 0.14, hz: 990 }),
    ],
  },
  // A bright chime: a rising triad of bells.
  mate: {
    seconds: 0.95,
    layers: [
      tone('sine', { attack: 0.004, decay: 0.75, level: 0.18, hz: 880 }),
      tone('sine', { delay: 0.08, attack: 0.004, decay: 0.75, level: 0.15, hz: 1108.7 }),
      tone('sine', { delay: 0.16, attack: 0.004, decay: 0.78, level: 0.13, hz: 1318.5 }),
    ],
  },
  // The egg cracks: two dry ticks, then a soft pop as the creature comes out.
  hatch: {
    seconds: 0.36,
    layers: [
      noise('highpass', 0.7, { attack: 0.001, decay: 0.03, level: 0.14, hz: 3000 }),
      noise('highpass', 0.7, { delay: 0.07, attack: 0.001, decay: 0.035, level: 0.11, hz: 2600 }),
      tone('sine', { delay: 0.14, attack: 0.006, decay: 0.21, level: 0.24, hz: 280, toHz: 620 }),
    ],
  },
  // The beacon's burst: a shimmer of high bells over a breath of air.
  reveal: {
    seconds: 1.2,
    layers: [
      tone('sine', { attack: 0.01, decay: 1.0, level: 0.14, hz: 784 }),
      tone('sine', { delay: 0.05, attack: 0.01, decay: 1.05, level: 0.11, hz: 1174.7 }),
      tone('sine', { delay: 0.1, attack: 0.01, decay: 1.08, level: 0.09, hz: 1568 }),
      noise('bandpass', 1, { attack: 0.02, decay: 0.45, level: 0.08, hz: 4000, toHz: 7000 }),
    ],
  },
  // A soft swell: one warm tone.
  grow: {
    seconds: 0.55,
    layers: [tone('sine', { attack: 0.15, decay: 0.4, level: 0.14, hz: 330 })],
  },
  // A bigger swell for a new size tier: a rising fifth, longer.
  tier: {
    seconds: 1.2,
    layers: [
      tone('sine', { attack: 0.3, decay: 0.85, level: 0.18, hz: 262 }),
      tone('sine', { delay: 0.12, attack: 0.3, decay: 0.78, level: 0.12, hz: 392 }),
    ],
  },
  // A ping: a sonar blip and its faint echo.
  ping: {
    seconds: 0.42,
    layers: [
      tone('sine', { attack: 0.003, decay: 0.22, level: 0.2, hz: 1250 }),
      tone('sine', { delay: 0.17, attack: 0.003, decay: 0.24, level: 0.07, hz: 1250 }),
    ],
  },
  // An emote: a short rising chirp.
  emote: {
    seconds: 0.24,
    layers: [tone('triangle', { attack: 0.01, decay: 0.23, level: 0.16, hz: 520, toHz: 820 })],
  },
  // A chat line: two small bubbles.
  chat: {
    seconds: 0.2,
    layers: [
      tone('sine', { attack: 0.003, decay: 0.07, level: 0.14, hz: 700, toHz: 1000 }),
      tone('sine', { delay: 0.1, attack: 0.003, decay: 0.09, level: 0.12, hz: 820, toHz: 1150 }),
    ],
  },
  // UV burns: a thin sizzle.
  uv: {
    seconds: 0.4,
    layers: [
      noise('highpass', 0.7, { attack: 0.03, decay: 0.37, level: 0.13, hz: 5500 }),
      tone('sine', { attack: 0.03, decay: 0.3, level: 0.04, hz: 2900, toHz: 2600 }),
    ],
  },
  // Pressure crushes: a low squeeze, falling.
  pressure: {
    seconds: 0.6,
    layers: [
      noise('lowpass', 1.2, { attack: 0.05, decay: 0.55, level: 0.35, hz: 140, toHz: 70 }),
      tone('triangle', { attack: 0.05, decay: 0.5, level: 0.16, hz: 82, toHz: 55 }),
    ],
  },
};

/** Where a placed cue sits on the stereo stage, and how loud it is there. */
export interface Placement {
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** 0..1. */
  gain: number;
}

/** The listener: the camera's centre and the visible half-width, in world units. */
export interface Listener {
  x: number;
  y: number;
  halfWidth: number;
}

export const PLACE = {
  /** The pan at the screen's side edge; it never hard-pans. */
  edgePan: 0.85,
  /** Gain falls to half this many half-widths away (1 / (1 + d²)). */
  halfAt: 1,
} as const;

/** Pans a cue by its screen position and quietens it with distance from the screen's centre. */
export function placeCue(at: { x: number; y: number }, listener: Listener): Placement {
  const half = Math.max(listener.halfWidth, 1e-6);
  const dx = at.x - listener.x;
  const dy = at.y - listener.y;
  const pan = dx === 0 ? 0 : clamp(dx / half, -1, 1) * PLACE.edgePan;
  const d = Math.hypot(dx, dy) / half / PLACE.halfAt;
  return { pan, gain: 1 / (1 + d * d) };
}

/** A sounding cue: when it ends on the audio clock, and how to cut it short. */
export interface Voice {
  end: number;
  stop(at: number): void;
}

/** One second of seeded white noise per context, shared by every noise layer. */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = noiseCache.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const rng = createRng([hashU32(0xc0e5), 1, 2, 3], 'cue-noise');
    for (let i = 0; i < data.length; i++) data[i] = rng.next() * 2 - 1;
    noiseCache.set(ctx, buffer);
  }
  return buffer;
}

/** The envelope's floor before the final cut to zero: -60 dB under the layer's peak. */
const FLOOR = 1e-3;

/** Plays `sound` into `out` from `when`, through one gain that a stolen voice fades. */
export function playSound(
  ctx: BaseAudioContext,
  out: AudioNode,
  when: number,
  sound: CueSound,
): Voice {
  const voice = ctx.createGain();
  voice.connect(out);
  const sources: AudioScheduledSourceNode[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  let last: AudioScheduledSourceNode | null = null;
  sound.layers.forEach((l, i) => {
    const start = when + (l.delay ?? 0);
    const peak = start + l.attack;
    const fall = peak + (l.hold ?? 0);
    const end = when + layerEnd(l);
    const env = ctx.createGain();
    // Silent before its first event too: a source may start a sample before `start` is reached,
    // and a gain still at its default of 1 there clicks.
    env.gain.value = 0;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(l.level, peak);
    env.gain.setValueAtTime(l.level, fall);
    env.gain.exponentialRampToValueAtTime(l.level * FLOOR, end);
    env.gain.setValueAtTime(0, end);
    env.connect(voice);
    let src: AudioScheduledSourceNode;
    let swept: AudioParam;
    if (l.kind === 'tone') {
      const osc = ctx.createOscillator();
      osc.type = l.wave;
      osc.connect(env);
      src = osc;
      swept = osc.frequency;
    } else {
      const buf = ctx.createBufferSource();
      buf.buffer = noiseBuffer(ctx);
      buf.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = l.filter;
      filter.Q.value = l.q;
      buf.connect(filter).connect(env);
      src = buf;
      swept = filter.frequency;
    }
    swept.setValueAtTime(l.hz, start);
    if (l.toHz !== undefined) swept.exponentialRampToValueAtTime(l.toHz, end);
    if (src instanceof AudioBufferSourceNode) src.start(start, (i * 0.137) % 1);
    else src.start(start);
    src.stop(end);
    sources.push(src);
    if (end > lastEnd) {
      lastEnd = end;
      last = src;
    }
  });
  // The voice lets go of the mix once its last layer has ended (or was cut short).
  if (last) (last as AudioScheduledSourceNode).onended = () => voice.disconnect();
  const end = when + sound.seconds;
  return {
    end,
    stop(at: number): void {
      const now = ctx.currentTime;
      voice.gain.cancelScheduledValues(now);
      voice.gain.setValueAtTime(voice.gain.value, now);
      voice.gain.linearRampToValueAtTime(0, Math.max(at, now));
      for (const s of sources) s.stop(Math.max(at, now));
    },
  };
}

/** The patch for one cue, in the engine's `CuePatch` shape. */
export const cuePatch =
  (cue: Cue) =>
  (ctx: BaseAudioContext, out: AudioNode, when: number): Voice =>
    playSound(ctx, out, when, CUE_SOUNDS[cue]);

/** Every cue's patch: the engine's default table. */
export const CUE_PATCHES: Record<Cue, ReturnType<typeof cuePatch>> = Object.fromEntries(
  CUES.map((c) => [c, cuePatch(c)]),
) as Record<Cue, ReturnType<typeof cuePatch>>;
