// The audio engine (M6 T22, ADR 0014): procedural Web Audio only, no files. One graph per context:
// ambience and cue voices → master gain (volume, mute) → limiter → speakers. `AudioGraph` takes any
// `BaseAudioContext`, so the render checks build the same graph on an `OfflineAudioContext`;
// `GameSound` owns the game's single `AudioContext`, started on the first gesture and suspended
// while the tab is hidden.

import type { Zone } from '../sim/bathymetry';
import { AMBIENCE, Ambience, type AmbienceParams, ambienceParams } from './ambience';
import { VoicePool } from './voices';

export type Cue =
  | 'eat'
  | 'hurt'
  | 'low-energy'
  | 'hazard-near'
  | 'dash'
  | 'death'
  | 'old-age'
  | 'court'
  | 'mate'
  | 'hatch'
  | 'reveal'
  | 'grow'
  | 'tier'
  | 'ping'
  | 'emote'
  | 'chat'
  | 'uv'
  | 'pressure';

export interface Sound {
  cue(c: Cue, at?: { x: number; y: number }): void;
  setZone(z: Zone, depth: number): void;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  dispose(): void;
}

/** A sounding cue: when it ends on the audio clock, and how to cut it short. */
export interface Voice {
  end: number;
  stop(at: number): void;
}

/** Plays one cue into `out` at `when`; T23 supplies one per cue. */
export type CuePatch = (ctx: BaseAudioContext, out: AudioNode, when: number) => Voice;

/** The limiter after the master gain: a fast, hard compressor just under full scale. */
export const LIMITER = { threshold: -6, knee: 0, ratio: 20, attack: 0.002, release: 0.2 } as const;

/** A stolen or muted voice fades out over this long, so it never clicks. */
const STEAL_SECONDS = 0.02;
/** Mute and volume land this fast: instant to the ear, without a click. */
const GAIN_SECONDS = 0.01;
/** A position change smaller than this keeps the ambience where it is (no re-targeting per frame). */
const DEPTH_STEP = 0.01;

/** Master gain for a volume of 0..100: a perceptual (squared) curve; mute is exactly zero. */
export function volumeGain(volume: number, muted: boolean): number {
  if (muted || !(volume > 0)) return 0;
  const v = Math.min(100, volume) / 100;
  return v * v;
}

export interface Measure {
  /** dBFS over every channel; -Infinity for digital silence. */
  rmsDb: number;
  peakDb: number;
  /** Every sample is exactly zero. */
  silent: boolean;
  /** RMS of the first difference over RMS of the signal: higher means brighter. */
  brightness: number;
}

const db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY);

export function measure(channels: readonly Float32Array[]): Measure {
  let sum = 0;
  let diff = 0;
  let peak = 0;
  let n = 0;
  for (const data of channels) {
    let last = data[0] ?? 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i] as number;
      sum += x * x;
      diff += (x - last) * (x - last);
      last = x;
      peak = Math.max(peak, Math.abs(x));
    }
    n += data.length;
  }
  const rms = n > 0 ? Math.sqrt(sum / n) : 0;
  return {
    rmsDb: db(rms),
    peakDb: db(peak),
    silent: peak === 0,
    brightness: sum > 0 ? Math.sqrt(diff / sum) : 0,
  };
}

/** FNV-1a over the samples' bit patterns: equal only for sample-identical buffers. */
export function hashSamples(channels: readonly Float32Array[]): string {
  let h = 0x811c9dc5;
  for (const data of channels) {
    const words = new Uint32Array(data.buffer, data.byteOffset, data.length);
    for (let i = 0; i < words.length; i++) h = Math.imul(h ^ (words[i] as number), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface GraphOptions {
  seed: number;
  volume: number;
  muted: boolean;
  patches?: Partial<Record<Cue, CuePatch>>;
}

/** The whole sound graph on one context. */
export class AudioGraph {
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly cues: GainNode;
  private readonly ambience: Ambience;
  private readonly pool = new VoicePool();
  private readonly voices = new Map<number, Voice>();
  private readonly patches: Partial<Record<Cue, CuePatch>>;
  private volume: number;
  private muted: boolean;
  private place: { zone: Zone; depth: number; params: AmbienceParams } | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    options: GraphOptions,
  ) {
    this.volume = options.volume;
    this.muted = options.muted;
    this.patches = options.patches ?? {};
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMITER.threshold;
    this.limiter.knee.value = LIMITER.knee;
    this.limiter.ratio.value = LIMITER.ratio;
    this.limiter.attack.value = LIMITER.attack;
    this.limiter.release.value = LIMITER.release;
    this.master = ctx.createGain();
    this.master.gain.value = this.gain;
    this.master.connect(this.limiter).connect(ctx.destination);
    // Cue voices mix here (T23); a wide mix sums in a run-dependent order, so only the ambience
    // renders sample-identically (see `Ambience`).
    this.cues = ctx.createGain();
    this.cues.connect(this.master);
    this.ambience = new Ambience(ctx, this.master, options.seed);
  }

  /** The master gain's target. */
  get gain(): number {
    return volumeGain(this.volume, this.muted);
  }

  get zone(): Zone | null {
    return this.place?.zone ?? null;
  }

  get params(): AmbienceParams | null {
    return this.place?.params ?? null;
  }

  activeVoices(): number {
    return this.pool.active(undefined, this.ctx.currentTime);
  }

  /** Plays a cue if it has a patch (T23 adds them), within the polyphony caps. */
  cue(c: Cue): void {
    const patch = this.patches[c];
    if (!patch) return;
    const now = this.ctx.currentTime;
    const voice = patch(this.ctx, this.cues, now);
    const { id, stolen } = this.pool.acquire(c, now, voice.end);
    for (const old of stolen) {
      this.voices.get(old)?.stop(now + STEAL_SECONDS);
      this.voices.delete(old);
    }
    this.voices.set(id, voice);
    for (const [held, v] of this.voices) if (v.end <= now) this.voices.delete(held);
  }

  /** Follows the zone under the player; the first call lands at once, later ones cross-fade. */
  setZone(zone: Zone, depth: number): void {
    const last = this.place;
    if (last && last.zone === zone && Math.abs(last.depth - depth) < DEPTH_STEP) return;
    const params = ambienceParams(zone, depth);
    this.ambience.set(params, last === null);
    this.place = { zone, depth, params };
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  private applyGain(): void {
    const now = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.gain, now + GAIN_SECONDS);
  }

  dispose(): void {
    for (const v of this.voices.values()) v.stop(this.ctx.currentTime);
    this.voices.clear();
    this.ambience.dispose();
    this.cues.disconnect();
    this.master.disconnect();
    this.limiter.disconnect();
  }
}

export type AudioStatus = 'idle' | AudioContextState;

export interface AudioView {
  /** `idle` until the first gesture creates the context, then the context's state. */
  state: AudioStatus;
  /** Cues asked for since hatching, audible or not. */
  cues: Partial<Record<Cue, number>>;
  volume: number;
  muted: boolean;
  /** The master gain's target (0 when muted). */
  gain: number;
  /** The zone the ambience is set to and its parameters' targets; null before the first `setZone`. */
  zone: Zone | null;
  ambience: AmbienceParams | null;
  /** Cue voices sounding now. */
  voices: number;
}

export interface GameSoundOptions {
  seed: number;
  volume: number;
  muted: boolean;
  patches?: Partial<Record<Cue, CuePatch>>;
  /** Makes the context; tests and browsers without Web Audio return null. */
  create?: () => AudioContext | null;
}

const defaultContext = (): AudioContext | null => {
  try {
    return typeof AudioContext === 'function'
      ? new AudioContext({ latencyHint: 'playback' })
      : null;
  } catch {
    return null;
  }
};

/**
 * The game's sound: one `AudioContext`, made on the first pointer or key gesture (browsers start
 * audio only then), suspended while the tab is hidden and resumed on return. Settings and the
 * zone given before the context exists are applied when it starts.
 */
export class GameSound implements Sound {
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private counts: Partial<Record<Cue, number>> = {};
  private volume: number;
  private muted: boolean;
  private zone: { zone: Zone; depth: number } | null = null;
  private hidden = false;
  private readonly detach: (() => void)[] = [];

  constructor(private readonly options: GameSoundOptions) {
    this.volume = options.volume;
    this.muted = options.muted;
  }

  /** Starts on the first gesture and follows the tab's visibility. */
  attach(win: Window, doc: Document): void {
    const gesture = (): void => this.start();
    const visibility = (): void => this.setHidden(doc.hidden);
    win.addEventListener('pointerdown', gesture, true);
    win.addEventListener('keydown', gesture, true);
    doc.addEventListener('visibilitychange', visibility);
    this.hidden = doc.hidden;
    this.detach.push(
      () => win.removeEventListener('pointerdown', gesture, true),
      () => win.removeEventListener('keydown', gesture, true),
      () => doc.removeEventListener('visibilitychange', visibility),
    );
  }

  /** Makes the context on the first call; later gestures resume one the browser left suspended. */
  start(): void {
    if (!this.ctx) {
      const ctx = (this.options.create ?? defaultContext)();
      if (!ctx) return;
      this.ctx = ctx;
      this.graph = new AudioGraph(ctx, {
        seed: this.options.seed,
        volume: this.volume,
        muted: this.muted,
        ...(this.options.patches ? { patches: this.options.patches } : {}),
      });
      if (this.zone) this.graph.setZone(this.zone.zone, this.zone.depth);
      else this.graph.setZone('twilight', AMBIENCE.rows.twilight.depth);
    }
    if (this.hidden) void this.ctx.suspend().catch(() => {});
    else if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend().catch(() => {});
    else void this.ctx.resume().catch(() => {});
  }

  cue(c: Cue, _at?: { x: number; y: number }): void {
    this.counts[c] = (this.counts[c] ?? 0) + 1;
    if (!this.muted && this.ctx?.state === 'running') this.graph?.cue(c);
  }

  /** Clears the cue counts (a new hatch). */
  resetCues(): void {
    this.counts = {};
  }

  setZone(zone: Zone, depth: number): void {
    this.zone = { zone, depth };
    this.graph?.setZone(zone, depth);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.graph?.setVolume(volume);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.graph?.setMuted(muted);
  }

  view(): AudioView {
    return {
      state: this.ctx?.state ?? 'idle',
      cues: { ...this.counts },
      volume: this.volume,
      muted: this.muted,
      gain: volumeGain(this.volume, this.muted),
      zone: this.graph?.zone ?? null,
      ambience: this.graph?.params ? { ...this.graph.params } : null,
      voices: this.graph?.activeVoices() ?? 0,
    };
  }

  dispose(): void {
    for (const off of this.detach.splice(0)) off();
    this.graph?.dispose();
    this.graph = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

export interface AudioRenderOptions {
  zone: Zone;
  /** Defaults to the zone's anchor depth. */
  depth?: number;
  seed: number;
  seconds: number;
  /** 0..100; default 100. */
  volume?: number;
  muted?: boolean;
  sampleRate?: number;
}

export interface AudioRenderResult extends Measure {
  hash: string;
  length: number;
}

/** Renders the engine's ambience offline (the render checks, M6 T22). */
export async function renderOffline(o: AudioRenderOptions): Promise<AudioRenderResult> {
  const rate = o.sampleRate ?? 44100;
  const ctx = new OfflineAudioContext(2, Math.round(o.seconds * rate), rate);
  const graph = new AudioGraph(ctx, {
    seed: o.seed,
    volume: o.volume ?? 100,
    muted: o.muted ?? false,
  });
  graph.setZone(o.zone, o.depth ?? AMBIENCE.rows[o.zone].depth);
  const buffer = await ctx.startRendering();
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i),
  );
  return { ...measure(channels), hash: hashSamples(channels), length: buffer.length };
}
