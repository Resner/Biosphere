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
  /** The hold: the population is whole, nobody has arrived for a minute and nobody has left. */
  holdFrom: number;
  holdUntil: number;
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
  /** How far it landed from the group's centroid beyond the group's reach, in clearances (the group's radius counts the spawns of the last minute around it). Null without a group. */
  edgeClearances: number | null;
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
  /** Incoming authority messages per minute of each player that was in the water through the hold. */
  holdPerMinute: number[];
  /** Every incoming authority message of the run, and the player-minutes they were sent in. */
  messageTotal: number;
  lifeMinutes: number;
  /** The load scenario's reading of the hold (M13 T5): messages and player-minutes of everyone in the water in it. */
  holdMessages: number;
  holdMinutes: number;
  /** Messages per minute of each player after its first minute in the hold, and a joiner's first minute. */
  holdSteady: number[];
  holdJoin: number[];
  /** For each minute of the hold, the messages in it of each player past its first minute and in the water through it. */
  holdByMinute: number[][];
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
    holdPerMinute: [],
    messageTotal: 0,
    lifeMinutes: 0,
    holdMessages: 0,
    holdMinutes: 0,
    holdSteady: [],
    holdJoin: [],
    holdByMinute: [],
  };
}
