import type {
  AudioRenderOptions,
  AudioRenderResult,
  AudioView,
  CueRenderOptions,
  CueRenderResult,
} from '../audio/engine';
import type { RarityTier } from '../genome/rarity';
import type { Silhouette } from '../genome/silhouette';
import type { PeerEvent } from '../net/protocol';
import type { FxSnapshot } from '../render/effects';
import type { EggPhase } from '../render/egg';
import type { DrawnOutline } from '../render/outlines';
import type { Speck } from '../render/particles';
import type { ParticleLayerName, PresetName, QualitySetting } from '../render/presets';
import type { RenderInfo } from '../render/scene';
import type { ShakeKind } from '../render/shake';
import type { Zone } from '../sim/bathymetry';
import type { PhysStats } from '../sim/body';
import type { LifeStage } from '../sim/life';
import type { InputLog } from '../sim/replay';
import type { FoodItem, FoodKind } from '../sim/types';
import type { BenchStatus } from './auto-quality';
import type { Chip, HudBars } from './hud';
import type { Indicator } from './indicators';
import type { LifeView } from './life';
import type { MinimapInfo } from './minimap';
import type { DeathSummary, Screen } from './screens';
import type { WheelInfo } from './wheel';

/** Read-only views of the running game for tests and tools (`window.__bs`). */
export interface BsState {
  screen: Screen;
  /**
   * Graphics quality (M6 T4): the setting in force, the preset `auto` resolves to, and the
   * benchmark's status (`stored` means this GPU's result was read and no benchmark ran).
   */
  quality: { setting: QualitySetting; detected: PresetName; bench: BenchStatus };
  tick: number;
  /** The depth zone under the player and its depth, 0..1 (M6 T16); null on the title screen. */
  zone: Zone | null;
  depth: number | null;
  /** This browser's identity; null until the key is loaded. */
  playerId: string | null;
  /** Food items handed to the renderer this tick. */
  visibleFood: number;
  /** The creature being played; null on the title screen. */
  player: {
    x: number;
    y: number;
    /** World units. */
    radius: number;
    biomass: number;
    energy: number;
    health: number;
    alive: boolean;
    /** World units per second now. */
    speed: number;
    /** Past 85% of the lifespan: slower and hungrier. */
    elder: boolean;
    /** The body this life hatched with (M3). */
    genomeHash: string;
    species: string;
    /** The body's silhouette class (M6 T8). */
    silhouette: Silhouette;
    rarity: RarityTier;
    /** Size tier of the fully grown body. */
    tier: number;
    /** What the sim sees of the body. */
    stats: PhysStats;
  } | null;
  /** Set once the player has died. */
  death: DeathSummary | null;
  /**
   * The recorded life (M4): `status` is the client's state machine (`idle`, `requesting`,
   * `awaiting`, `verifying`, `playing`, `dead`, `practice`), `genome` the hash of the body now
   * played (null on the title screen), `lastAckN` the last progress report the hub took, `stage`
   * the life stage now (null without a recorded life), `remainingMs` the time left in it, and
   * `limitMs` how long until the next recorded hatch (0 when one is free).
   */
  life: LifeView & {
    genome: string | null;
    stage: LifeStage | null;
    remainingMs: number | null;
    limitMs: number;
  };
  /**
   * Courting (M5): the flow's `state`, the line it shows (`text`: the hint beside a creature in
   * reach, else the note), the invitation's `invite` name and seconds `left`, `visited` states, and
   * the cooldown line under the life bar.
   */
  mate: {
    state: string;
    text: string;
    invite: { name: string; from: string; leftMs: number } | null;
    visited: string[];
    ready: string;
  };
  /**
   * The pending child (M5 T11): the offspring flow's `kind` (`none`, `verifying`, `failed`, `egg`,
   * `card`), the child's creature id, species, rarity, generation and genome hash, whether the card
   * and the egg are on screen, and the ids of the choices the death and title screens offer.
   */
  offspring: {
    kind: string;
    creature: string | null;
    species: string | null;
    rarity: string | null;
    generation: number | null;
    genomeHash: string | null;
    cardShown: boolean;
    eggShown: boolean;
    options: string[];
  };
  /** The other players in the pond, as drawn (alpha fades when they go quiet). */
  remotes: {
    id: string;
    name: string;
    x: number;
    y: number;
    alpha: number;
    /** World units, from the snapshot's biomass. */
    radius: number;
    /** The genome hash of the body drawn, or null while the tinted fallback cell stands in. */
    genomeHash: string | null;
    species: string | null;
    /** Its snapshots say it carries an egg (M6 T20). */
    egg: boolean;
  }[];
  /**
   * The play screen's HUD (M6b T9): whether the `menu` is open, the stat `bars` as drawn (each
   * 0..1; `life` null while its bar is hidden, as on a practice cell), the `chips` shown beside them
   * and the first-life hint on screen (`hints`, its text, or null).
   */
  hud: { menu: boolean; bars: HudBars; chips: Chip[]; hints: string | null };
  /**
   * The egg (M6 T20, M6b T11): the reveal's `phase` (`none`, `waiting` for a beacon, `stirring`
   * once it came, `cracking`, `revealed`) and the `phases` it went through (the last 16), whether a
   * pending child is `carried`, whether the player's egg is `shown` this frame, the `peers` drawn
   * with one, whether a parent left by a hatch is still dissolving (`ghost`), and `motion` (`fade`
   * when motion is reduced: the setting, else `prefers-reduced-motion`; M6 T22). M6b: the player's
   * egg as last drawn, its `angle` (radians, the lean included) and `glow` (0..1), and `at`, its
   * CSS-pixel centre and half-height (null while it is not drawn); `card` is the result card or the
   * offspring card on screen, with its rarity.
   */
  egg: {
    phase: EggPhase;
    phases: EggPhase[];
    carried: boolean;
    shown: boolean;
    peers: string[];
    ghost: boolean;
    motion: 'shake' | 'fade';
    angle: number;
    glow: number;
    at: { x: number; y: number; r: number } | null;
    card: { shown: boolean; tier: RarityTier | null };
  };
  /** The pond this tab is in (the next hatch joins it); `members` are player ids, this one included. */
  pond: { id: string; seed: string; members: string[] } | null;
  /** Chat, emotes and pings as this tab sees them; `muted` holds player ids. */
  social: {
    chat: { from: string; name: string; text: string }[];
    muted: string[];
    emotes: { from: string; emote: number }[];
    pings: { from: string; kind: number; x: number; y: number }[];
    /** Social events dropped for a rate limit or a sender outside the roster. */
    dropped: number;
  };
  /**
   * The status chip's text, the hub's state ('none' without a hub), open peer connections, food
   * claims ignored as implausible and genome events dropped (too frequent, from a peer with no
   * link, or not a genome).
   */
  net: { text: string; status: string; open: number; foodIgnored: number; dropped: number };
  /**
   * Edge indicators as last drawn (M6 T19): the nearest six pond players off screen and the
   * nearby pings off screen. `angle` is the world bearing from the player in degrees
   * (counter-clockwise from east), `lengths` the distance in the player's body lengths, `x`, `y`
   * the indicator's CSS-pixel position.
   */
  indicators: Indicator[];
  /** The pond map (M): whether it is open, and the player dots and pings it shows. */
  map: { open: boolean; players: number; pings: number };
  /**
   * The minimap as last drawn (M6b T10): `shown`, its radius in world units, the zone and depth
   * under the player, the `hazard` hurting now (`uv`, `pressure` or null), and the `players` and
   * `pings` on it (`id`, CSS-pixel `x` and `y` inside the minimap; players' `size` class and
   * `ready`, pings' `kind`).
   */
  minimap: MinimapInfo;
  /**
   * The social wheel (M6 T24): open, its items (with each one's CSS-pixel centre while open), the
   * world point a ping would land on, the wheel's centre and the cursor it opened at.
   */
  wheel: WheelInfo;
  /**
   * Sound (M6 T22): the context's state (`idle` before the first gesture), cues asked for since
   * hatching, volume, mute, the master gain's target, the ambience's zone and parameter targets,
   * and the cue voices sounding.
   */
  audio: AudioView;
}

/** A scripted remote creature for tests: it swims in a straight line and sends real snapshots. */
export interface ScriptedRemote {
  id: string;
  name: string;
  x: number;
  y: number;
  /** World units per second. */
  vx?: number;
  vy?: number;
  /** Default 100. */
  biomass?: number;
  /** The remote's genome (base64url, any text): its snapshots carry the ref and the body is delivered. */
  genome?: string;
  /** With `genome`: send the ref but never deliver the genome event. */
  withholdGenome?: boolean;
  /** Its snapshots carry the ready-to-mate mark (M6 T19). */
  ready?: boolean;
  /** Its snapshots carry the egg mark (M6 T20). */
  egg?: boolean;
}

export interface BsHook {
  ready: true;
  state(): BsState;
  /** How many events of each type the sim has emitted since the player hatched; `eat@<id>` and `stolen@<id>` follow single items. */
  events(): Record<string, number>;
  /** Re-runs an input log in a fresh world and returns its final state hash. */
  replay(log: InputLog): { hash: string; events: Record<string, number> };
  audio: {
    /** Renders the sound engine's ambience on an `OfflineAudioContext` and measures it (M6 T22). */
    render(options: AudioRenderOptions): Promise<AudioRenderResult>;
    /** Renders one cue alone on an `OfflineAudioContext`: its measures, length and channels (M6 T23). */
    renderCue(options: CueRenderOptions): Promise<CueRenderResult>;
  };
  render: {
    info(): RenderInfo;
    fx(): FxState;
    /** The specks of a particle layer as last drawn: on-screen position, size, depth and blur. */
    specks(layer: ParticleLayerName): Speck[];
    /** The size outlines as last drawn (M6 T21): kind, CSS-pixel centre and radius, pulse 0..1. */
    outlines(): DrawnOutline[];
    /**
     * The player's egg's swing in radians at `atMs` on the egg's clock (`performance.now()` while
     * the world runs), lean included (M6b T11): a slow software frame cannot hide a wobble's peak.
     */
    eggAngle(atMs: number): number;
  };
  life: {
    /** The DNA of the last genesis, recomputed from its beacon and commitment; null before one. */
    recompute(): Promise<{ round: number; commit: string; genomeHash: string } | null>;
  };
  /** Genome code run in this engine; present only with `?debug=1`. */
  genome?: BsGenome;
  /** Mutating helpers; present only with `?debug=1`. */
  debug?: BsDebug;
}

export interface BsGenome {
  /** The plan and stats hashes of each genome (base64url), for comparing engines against the Node goldens. */
  hashes(genomes: readonly string[]): { planHash: string; statsHash: string }[];
}

/** The feedback cues now showing: counts since hatching, plus the camera's current zoom. */
export interface FxState extends FxSnapshot {
  /**
   * The damage shake now (M6b T10): the body's offset and the camera's, in CSS pixels, and the
   * strongest shake running (`uv`, `pressure`, `jolt`) or null.
   */
  shake: { body: number; camera: number; kind: ShakeKind | null };
  /** Visible half-height in world units, as drawn. */
  halfHeight: number;
  /** Where the camera looks, in world units. */
  camX: number;
  camY: number;
}

export interface BsDebug {
  /** Sets the player's energy (clamped to its maximum). */
  setEnergy(energy: number): void;
  /** Sets the player's biomass (growth to a new size); energy and health keep their fractions. */
  setBiomass(biomass: number): void;
  /** Moves the player and stops it. */
  teleport(x: number, y: number): void;
  /**
   * Moves the player (as `teleport`) to the nearest point well inside that zone, clear of its edge
   * bands with its surround in the zone too, and returns it (M6 T16).
   */
  setZone(zone: Zone): { x: number; y: number };
  /** The food item closest to the player (of this kind, if given), or null. */
  nearestFood(kind?: FoodKind): FoodItem | null;
  /** Swims at full throttle towards a target; resolves true once it is eaten or reached, false on a timeout or if it vanished. */
  steerTo(target: { id?: string; x: number; y: number }): Promise<boolean>;
  /** Adds a toxic plume to the world. */
  spawnPlume(x: number, y: number, radius?: number): void;
  /** Replaces the scripted remotes (an empty list removes them); they send snapshots at 10 Hz. */
  setRemotes(remotes: readonly ScriptedRemote[]): void;
  /**
   * Joins a pond for the next hatch without a hub: its seed, epoch and the hub clock's reading now
   * (hub ms), and where this tab's food claims go. Tests relay them to other tabs.
   */
  joinPond(spec: {
    seed: string;
    epoch: number;
    hubNow: number;
    send(event: PeerEvent): void;
  }): void;
  /**
   * Delivers a peer's `event` message as if its data channel had; invalid ones are dropped. A
   * genome event skips the link and rate checks, which the unit tests cover. Chat, emotes and
   * pings go through `Social`, from a scripted remote's id (it is in the roster).
   */
  deliver(from: string, event: unknown): void;
  /** Whether the food item (`c3_5_s2_k0`) is in the field now. */
  hasFood(id: string): boolean;
  /**
   * Replaces every measured frame time with `ms` and re-runs the auto-detect benchmark on it at
   * once; adaptive resolution then follows `ms` too, even where it is otherwise pinned at 1.
   */
  setBench(ms: number): void;
  /** Runs the sim this many times faster than real time; 0 also holds the shaders' animation clock. */
  timeScale(scale: number): void;
  /** Zeroes the marine snow's flow and, in a frozen world, the shaders' clock: frozen shots then agree (M6 T17). */
  resetWater(): void;
  /** Sets the shaders' clock to this many seconds in a frozen world, leaving the snow's flow (M6b T8). */
  setClock(seconds: number): void;
}

declare global {
  interface Window {
    __bs?: BsHook;
  }
}

export function installHook(hook: BsHook): void {
  window.__bs = hook;
}
