// A settled encounter's document (ADR 0054): what the fight was, countersigned by the authority over
// a Merkle root of its frames. Canonical JSON of integers and strings: an absent cause or slot is an
// absent key. The protocol (`enc-end.settlement`, protocol 8) carries it.

/** One slot's result: its outcome and final condition (hundredths, rounded down). `by` and `eggBy` are slots. */
export interface SettledFighter {
  player: string;
  creature: string;
  outcome: string;
  cause?: string;
  by?: number;
  frame: number;
  egg: 'none' | 'kept' | 'eaten';
  eggBy?: number;
  biomass: number;
  energy: number;
  health: number;
  reward: number;
}

/** The document: `start` and `joins` hash the start and join messages, `root` the frames, `hash` is `hashEncounter` at the end. */
export interface Settlement {
  v: 1;
  kind: 'settlement';
  rules: number;
  enc: string;
  pondSeed: string;
  start: string;
  joins: string[];
  frames: number;
  root: string;
  hash: string;
  referee: 'authority';
  results: SettledFighter[];
  t: number;
}

/** The settlement with its hash (`bs/settle/v1`) and the authority's countersignature over it. */
export interface SignedSettlement {
  settlement: Settlement;
  hash: string;
  authSig: string;
  keyId: string;
}
