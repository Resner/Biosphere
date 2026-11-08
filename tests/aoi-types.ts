// The harness's shared shapes (M11 T10): a scenario's clients and fights, and a run's counters.

import type { Meter } from './aoi-meter';
import type { WaveParams, WaveRecord } from './wave-record';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** How a creature moves: a heading kept within `turn` rad/s, at `speed` wu/s, dashing now and then. */
export interface Walk {
  heading: number;
  speed: number;
  turn: number;
  dash: boolean;
  /** It bounces off the walls of this box. */
  box?: Box | undefined;
  /** Radius growth per second (a share). */
  grow?: number;
}

export interface ClientSpec {
  id: string;
  x: number;
  y: number;
  r: number;
  adultR: number;
  /** ms. */
  spawnAt: number;
  walk: Walk;
  /** It enters the water where `place()` puts it (M12), around the best group; `x` and `y` are ignored. */
  place?: boolean;
  /** ms: it leaves the water then (M12 T9: the hub takes it out of the directory and the crowds). */
  leaveAt?: number;
}

/** A fight refereed by witnesses: its fighters and witnesses hold P0 links for its span (ms). */
export interface FightSpec {
  from: number;
  until: number;
  fighters: string[];
  witnesses: string[];
  /**
   * With one fighter named, the other is chosen at `from` as an engage does: the nearest comparable
   * creature sharing its water (M12: a fight between instances is refused).
   */
  engage?: boolean;
}

export interface Scenario {
  name: string;
  /** Simulated seconds. */
  seconds: number;
  clients: ClientSpec[];
  fights?: FightSpec[];
  /** Everyone is a friend: each pair's first link is timed from the later spawn (gate 4). */
  friends?: boolean;
  /** Crowds split into instances (M12); false runs the scenario without them, for comparison. */
  instances?: boolean;
  /** A client alone for `RIDE_ALONE_MS` rides the current, by `place()` (M12). */
  ride?: boolean;
  /** ms a client must be alone before it rides; default `RIDE_ALONE_MS` (the hub's fixture mode shortens it too). */
  rideAloneMs?: number;
  /** Records the wave's arrivals, rides and series (`RunResult.wave`, M12 T9). */
  wave?: WaveParams;
  /** The pair checks (discovery, hidden threats, views, tier links) run every this many ticks; default 1. */
  pairsEvery?: number;
  /** A seeded share of the clients is judged by the pair checks (the rest are only counted); default all. */
  pairSample?: number;
  /** Times the hub's operations, counts messages by type and the bandwidth (the load scenario, M13). */
  meter?: Meter;
}

/** The gates' counters: each is a count of violations, with the first few described. */
export interface RunResult {
  scenario: string;
  seed: string;
  seconds: number;
  clients: number;
  violations: Record<GateKey, number>;
  examples: Record<GateKey, string[]>;
  /** Links held (open, hello done) per client and tick: the histogram by count. */
  linkHistogram: number[];
  maxHeld: number;
  /** Seconds from the later spawn to a pair's hello, for each pair of the spawn ring. */
  friendMs: number[];
  /** ms from a creature entering another's query radius to its being known there. */
  discoveryMs: number[];
  /** Incoming authority messages in each full player-minute after a creature's first minute. */
  perMinute: number[];
  /** The same in each creature's first minute, the join: it dials everyone around it. */
  joinMinute: number[];
  /** Links made after the first minute, and how many of them an offer through a peer set up. */
  lateLinks: number;
  lateRelayed: number;
  gossipBytes: number;
  linkSeconds: number;
  /**
   * Snapshot upload (B/s) at the rates the receivers ask (M11 T15): the most a client sent while
   * holding 24 links or more, scaled to 24 links, with the sum and count of those samples, and the
   * most one link carried. Gossip is added from `gossipBytes` when judged.
   */
  upload24: number;
  upload24Sum: number;
  upload24Samples: number;
  linkUpload: number;
  crowdedSeconds: number;
  clientSeconds: number;
  /** Whether crowds split into instances in this run. */
  instances: boolean;
  /** The same two, counted only after each client's first 10 s (gate 10). */
  crowdedLate: number;
  clientLate: number;
  /** Instance changes per client-minute of life, for each client that lived a full minute. */
  changesPerMinute: number[];
  /** Placed spawns and rides, and how many fell back to the spawn centre (no clearance owed). */
  spawns: number;
  spawnFallbacks: number;
  rides: number;
  /** Duty links expected, and taken within 10 s. */
  duties: number;
  dutiesTaken: number;
  /** Remotes that came into view, and those already linked for 0.5 s. */
  entries: number;
  entriesLinked: number;
  hub: { relayed: number; hub: number; fallback: number; refused: number };
  /** The wave's record, when the scenario asked for it. */
  wave?: WaveRecord;
}

export const GATE_KEYS = [
  'cap',
  'hidden',
  'pops',
  'late',
  'tierLink',
  'swarm',
  'duty',
  'dutyCap',
  'fightWater',
  'clearance',
] as const;
export type GateKey = (typeof GATE_KEYS)[number];
