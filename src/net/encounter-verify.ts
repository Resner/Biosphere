// A settled fight rechecked from its log (ADR 0054): the authority's settlement document from its own
// encounter, and `verifyEncounter`, which replays the log and compares. It lives in `src/net`
// because the replay starts from the protocol's messages (`encounterStartOf`), and
// `src/net/encounter-start` already imports `src/ledger/encounter`: a module in `src/ledger` that
// imported it back would close a cycle.

import type { PubKey } from '../ledger/record';
import { rulesProblem } from '../ledger/registry';
import {
  checkSettlementSig,
  type FightLog,
  framesRoot,
  joinHash,
  type SettledFighter,
  type Settlement,
  type SignedSettlement,
  startHash,
} from '../ledger/settlement';
import { createEncounter, hashEncounter, results, stepFrame } from '../sim/encounter/encounter';
import { applyJoins } from '../sim/encounter/join';
import type { Encounter, EncounterJoin } from '../sim/encounter/types';
import { RULES_VERSION } from '../sim/rules';
import { encounterStartOf, fighterStartOf } from './encounter-start';

/** Amounts in a settlement are hundredths, rounded down, as the fighters' records hold them. */
const hundredthsDown = (x: number): number => Math.floor(x * 100);

/**
 * The joins that took a seat: each one's frame was stepped. A join admitted for a frame the fight
 * never reached fought nothing, so it is no part of the settlement.
 */
const seatedJoins = (log: FightLog): FightLog['joins'] =>
  log.joins.filter((j) => j.f < log.frames.length);

/** Slots that play frame `f`: the starters and every seated join from its frame on. */
const widthAt = (starters: number, joins: FightLog['joins'], f: number): number => {
  let n = starters;
  for (const j of joins) if (j.f <= f) n++;
  return n;
};

const rootOf = (log: FightLog): string => framesRoot(log.frames);

/** Each slot's result from the encounter at its end. An absent cause or slot is an absent key. */
function resultsOf(enc: Encounter): SettledFighter[] {
  const done = results(enc);
  return enc.fighters.map((f, slot) => {
    const r = done[slot] as (typeof done)[number];
    return {
      player: f.player,
      creature: f.creature,
      outcome: r.outcome,
      ...(r.cause === null ? {} : { cause: r.cause }),
      ...(r.by === null ? {} : { by: r.by }),
      frame: r.frame,
      egg: r.egg,
      ...(r.eggBy === null ? {} : { eggBy: r.eggBy }),
      biomass: hundredthsDown(f.body.biomass),
      energy: hundredthsDown(f.body.energy),
      health: hundredthsDown(f.body.health),
      reward: hundredthsDown(f.reward),
    };
  });
}

/** The authority's settlement of the fight `log` records, from its own encounter `enc` at the end, at hub time `t`. */
export function settlementOf(log: FightLog, enc: Encounter, t: number): Settlement {
  return {
    v: 1,
    kind: 'settlement',
    rules: RULES_VERSION,
    enc: log.start.enc,
    pondSeed: log.pondSeed,
    start: startHash(log.pondSeed, log.start),
    joins: seatedJoins(log).map(joinHash),
    frames: log.frames.length,
    root: rootOf(log),
    hash: hashEncounter(enc),
    referee: 'authority',
    results: resultsOf(enc),
    t,
  };
}

/** The encounter the log plays to its end, or null when it does not build or does not end there. */
function replay(log: FightLog, joins: FightLog['joins']): Encounter | null {
  try {
    const start = encounterStartOf(log.start, log.pondSeed);
    if (!start) return null;
    const seated: EncounterJoin[] = [];
    for (const j of joins) {
      const fighter = fighterStartOf(j.fighter);
      if (!fighter) return null;
      seated.push({ f: j.f, fighter });
    }
    const enc = createEncounter(start);
    for (const frame of log.frames) {
      if (enc.over) return null;
      applyJoins(enc, seated);
      stepFrame(enc, frame);
    }
    const whole = enc.fighters.length === log.start.fighters.length + seated.length;
    return enc.over && whole ? enc : null;
  } catch {
    return null;
  }
}

/**
 * Rechecks a settlement from the fight's log (ADR 0054); empty when it holds. Never throws. The
 * problems:
 * - `key`, `signature`: the countersignature (an unlisted key, or a hash or signature that fails);
 * - `start`, `joins`, `frames`, `root`: the document against the log it claims to settle;
 * - `width:<f>`: frame `f` holds an input per slot that plays it, no more and no fewer;
 * - `rules-retired`, `rules-unknown`: the settlement's rules version is not live (the registry, ADR 0055);
 * - `replay`: the log does not build, or does not end the fight at its last frame;
 * - `hash`, `result:<slot>:<field>`: the replayed end state and results disagree with the document.
 */
export function verifyEncounter(
  s: SignedSettlement,
  log: FightLog,
  keys: readonly PubKey[],
): string[] {
  const problems = checkSettlementSig(s, keys);
  try {
    const doc = s.settlement;
    const joins = seatedJoins(log);
    if (
      doc.enc !== log.start.enc ||
      doc.pondSeed !== log.pondSeed ||
      doc.start !== startHash(log.pondSeed, log.start)
    )
      problems.push('start');
    const joinHashes = joins.map(joinHash);
    if (doc.joins.length !== joinHashes.length || doc.joins.some((h, k) => h !== joinHashes[k]))
      problems.push('joins');
    if (doc.frames !== log.frames.length) problems.push('frames');
    if (doc.root !== rootOf(log)) problems.push('root');
    log.frames.forEach((inputs, f) => {
      if (inputs.length !== widthAt(log.start.fighters.length, joins, f))
        problems.push(`width:${f}`);
    });
    const rules = rulesProblem(doc.rules);
    if (rules) return [...problems, rules];
    // One live version per build: a fight replays only under the rules that settled it.
    if (doc.rules !== RULES_VERSION) return [...problems, 'rules-unknown'];
    if (problems.some((p) => p.startsWith('width:'))) return [...problems, 'replay'];
    const enc = replay(log, joins);
    if (!enc) return [...problems, 'replay'];
    if (doc.hash !== hashEncounter(enc)) problems.push('hash');
    const replayed = resultsOf(enc);
    const slots = Math.max(replayed.length, doc.results.length);
    for (let slot = 0; slot < slots; slot++) {
      const want = (replayed[slot] ?? {}) as Record<string, unknown>;
      const got = (doc.results[slot] ?? {}) as Record<string, unknown>;
      const fields = new Set([...Object.keys(want), ...Object.keys(got)]);
      for (const field of fields) {
        if (want[field] !== got[field]) problems.push(`result:${slot}:${field}`);
      }
    }
    return problems;
  } catch {
    return [...problems, 'replay'];
  }
}
