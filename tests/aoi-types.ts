// The harness's shared shapes (M11 T10): a scenario's clients and fights, and a run's counters.

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
}

/** A fight refereed by witnesses: its fighters and witnesses hold P0 links for its span (ms). */
export interface FightSpec {
  from: number;
  until: number;
  fighters: string[];
  witnesses: string[];
}

export interface Scenario {
  name: string;
  /** Simulated seconds. */
  seconds: number;
  clients: ClientSpec[];
  fights?: FightSpec[];
  /** Everyone is a friend: each pair's first link is timed from the later spawn (gate 4). */
  friends?: boolean;
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
  crowdedSeconds: number;
  clientSeconds: number;
  /** Duty links expected, and taken within 10 s. */
  duties: number;
  dutiesTaken: number;
  /** Remotes that came into view, and those already linked for 0.5 s. */
  entries: number;
  entriesLinked: number;
  hub: { relayed: number; hub: number; fallback: number; refused: number };
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
] as const;
export type GateKey = (typeof GATE_KEYS)[number];
