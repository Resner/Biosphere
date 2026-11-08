// What the harness records for the population wave (M12 T9): arrivals, rides, fights and the
// minute-by-minute series, from which `tests/wave.ts` judges the gates. Recorded only when a
// scenario has `wave` params; nothing here touches the sim.

/** The windows the wave's gates read, in ms of simulated time. */
export interface WaveParams {
  /** The peak: crowded share and fights are judged here. */
  peakFrom: number;
  peakUntil: number;
  /** From this time a player must hold a link to a creature it can link with. */
  regroupFrom: number;
  /** From this time no crowd may be left. */
  crowdsGoneAt: number;
}

/** One spawn or ride arrival. */
export interface Arrival {
  id: string;
  /** ms. */
  t: number;
  ride: boolean;
  /** The size tier of the arriving creature. */
  tier: number;
  /** Members of the group it was placed around, 0 when it found none. */
  groupSize: number;
  fallback: 'none' | 'centre-rings' | 'centre';
  /** Distance from the group's centroid beyond its radius plus twice the clearance (wu); at most 0 is at the edge. Null without a group. */
  beyondEdge: number | null;
  /** ms to its first hello with anyone, and with a member of its group; null if never. */
  linkMs: number | null;
  groupLinkMs: number | null;
}

export interface WaveMinute {
  minute: number;
  population: number;
  groups: number;
  /** Clients whose page counts itself crowded now. */
  crowded: number;
  /** Distinct instances in use. */
  instances: number;
  spawns: number;
  rides: number;
  /** Incoming authority messages in the minute, all clients. */
  messages: number;
}

export interface WaveRecord {
  params: WaveParams;
  arrivals: Arrival[];
  rides: { id: string; t: number }[];
  fights: { fighters: string[]; from: number; until: number }[];
  minutes: WaveMinute[];
  /** Each second from `regroupFrom`: players that have a creature to link with, and those holding a link to one. */
  regroup: { t: number; eligible: number; linked: number }[];
  /** The most crowds standing in any second from `crowdsGoneAt`. */
  crowdsLeft: number;
  /** Client-seconds in the peak after a client's first 10 s, and those crowded. */
  peakSeconds: number;
  peakCrowded: number;
}

export function emptyWave(params: WaveParams): WaveRecord {
  return {
    params,
    arrivals: [],
    rides: [],
    fights: [],
    minutes: [],
    regroup: [],
    crowdsLeft: 0,
    peakSeconds: 0,
    peakCrowded: 0,
  };
}
