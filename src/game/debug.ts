import type { RarityTier } from '../genome/rarity';
import type { PeerEvent } from '../net/protocol';
import type { FxSnapshot } from '../render/effects';
import type { RenderInfo } from '../render/scene';
import type { PhysStats } from '../sim/body';
import type { InputLog } from '../sim/replay';
import type { FoodItem, FoodKind } from '../sim/types';
import type { LifeView } from './life';
import type { DeathSummary, Screen } from './screens';

/** Read-only views of the running game for tests and tools (`window.__bs`). */
export interface BsState {
  screen: Screen;
  tick: number;
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
    /** The body this life hatched with (M3). */
    genomeHash: string;
    species: string;
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
   * played (null on the title screen), `lastAckN` the last progress report the hub took.
   */
  life: LifeView & { genome: string | null };
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
  }[];
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
}

export interface BsHook {
  ready: true;
  state(): BsState;
  /** How many events of each type the sim has emitted since the player hatched. */
  events(): Record<string, number>;
  /** Re-runs an input log in a fresh world and returns its final state hash. */
  replay(log: InputLog): { hash: string; events: Record<string, number> };
  render: { info(): RenderInfo; fx(): FxState };
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
   * genome event skips the link and rate checks, which the unit tests cover.
   */
  deliver(from: string, event: unknown): void;
  /** Whether the food item (`c3_5_s2_k0`) is in the field now. */
  hasFood(id: string): boolean;
  /** Runs the sim this many times faster than real time. */
  timeScale(scale: number): void;
}

declare global {
  interface Window {
    __bs?: BsHook;
  }
}

export function installHook(hook: BsHook): void {
  window.__bs = hook;
}
