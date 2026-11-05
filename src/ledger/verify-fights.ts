import { genomeFromBase64url } from '../genome/codec';
import { buildCreature } from '../genome/stats';
import { RULES, TICK_HZ } from '../sim/rules';
import {
  CLOCK_SLACK_MS,
  type Condition,
  HUNDREDTHS,
  lifespanOf,
  reachAt,
  type Scales,
  startFrom,
} from './gates';
import type { PubKey, StoredRecord } from './record';
import { checkSettledRecords, type FightLog, type SignedSettlement } from './settlement';
import type { BundleIndex, LineageReport, Problem, VerifyOptions } from './verify';
import { firstNamers, whereNamed } from './verify-chain';

// The fights family of `verifyLineage` (ADR 0055): each fight record against its settlement, the
// locked time and growth around a fight, and, with logs and a replay, the fight replayed and each
// held fighter's start and locked time checked against its log. The replay itself
// (`verifyEncounter`) lives in `src/net` and comes in through `opts.replay`. Every bound is
// inclusive, as the authority's are.

/** A fight frame's length in ms, as the referee steps it (`src/net/referee.ts`). */
const FRAME_MS = (RULES.encounter.frameTicks * 1000) / TICK_HZ;

const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

/** What a chain established before a record: the wall time its clock was read at (null while pending), its clock and condition. */
interface Before {
  t: number | null;
  activeMs: number;
  condition: Condition;
}

/** One of a creature's records of a fight, with the chain's state before the fight. */
interface FightRecord {
  s: StoredRecord;
  /** The encounter it belongs to: its own `enc`, or for a settlement's checkpoint, its death's. */
  enc: string;
  before: Before;
}

/** The genome's values the bounds need. */
interface Body {
  growth: number;
  maxBiomass: number;
  lifespan: number;
}

const encOf = (s: StoredRecord | undefined): string | null => {
  const enc = s?.record.body.enc;
  return typeof enc === 'string' ? enc : null;
};

/** A death the fight's settlement wrote: a kill, an eaten egg, or a hazard inside the fight. */
const fightDeath = (s: StoredRecord | undefined): boolean =>
  s?.record.kind === 'death' && encOf(s) !== null;

/** The checkpoint a settlement writes (the last report) just before a fight death, in the same transaction. */
const settlementCheckpoint = (s: StoredRecord, next: StoredRecord | undefined): boolean =>
  s.record.kind === 'checkpoint' && fightDeath(next) && next?.record.t === s.record.t;

function conditionIn(body: StoredRecord['record']['body']): Condition | null {
  const biomass = int(body.biomass);
  const energy = int(body.energy);
  const health = int(body.health);
  return biomass === null || energy === null || health === null
    ? null
    : { biomass, energy, health };
}

function bodyOf(text: string, scales: Scales): Body | null {
  const genome = genomeFromBase64url(text);
  if (!genome) return null; // The origin family names a genome that does not read.
  const { phys } = buildCreature(genome);
  return {
    growth: phys.growth,
    maxBiomass: phys.maxBiomass,
    lifespan: lifespanOf(genome, scales),
  };
}

/**
 * A chain's records of fights, each with the clock and condition before its fight: a settlement's
 * checkpoint before a death leaves the state as it was, so the death is bound from the same point.
 */
function fightRecordsOf(chain: readonly StoredRecord[], body: Body): FightRecord[] {
  const out: FightRecord[] = [];
  const first = chain[0]?.record;
  if (first?.seq !== 0 || (first.kind !== 'genesis' && first.kind !== 'birth')) return out;
  const state: Before = {
    t: first.kind === 'genesis' ? first.t : null,
    activeMs: 0,
    condition: startFrom(first.kind, body.maxBiomass),
  };
  for (let i = 1; i < chain.length; i++) {
    const s = chain[i] as StoredRecord;
    const next = chain[i + 1];
    // A fork or a gap is the chain family's; the bounds read the chain as far as it runs on.
    if (s.record.seq !== (chain[i - 1] as StoredRecord).record.seq + 1) break;
    const own = encOf(s);
    const checkpoint = settlementCheckpoint(s, next);
    if (own !== null || checkpoint) {
      out.push({ s, enc: own ?? (encOf(next) as string), before: { ...state } });
      if (checkpoint) continue;
    }
    const { kind, body: b, t } = s.record;
    if (kind === 'promote' && b.role === 'child') {
      state.t = t; // The child's life clock starts with its promotion.
      continue;
    }
    if (state.t === null) continue; // A pending child has no clock until then.
    const activeMs = int(b.activeMs);
    if (activeMs === null) continue;
    state.t = t;
    state.activeMs = activeMs;
    state.condition = conditionIn(b) ?? state.condition;
  }
  return out;
}

export function verifyFights(index: BundleIndex, opts: VerifyOptions): Problem[] {
  const out: Problem[] = [];
  const scales = index.bundle.world.scales;
  const replayed = replayable(index, opts);
  for (const [id, text] of index.creatures) {
    const chain = index.records.get(id) ?? [];
    if (!chain.some((s) => encOf(s) !== null)) continue;
    const body = bodyOf(text, scales);
    if (!body) continue;
    for (const f of fightRecordsOf(chain, body)) {
      const at = (code: string) =>
        out.push({ creature: id, seq: f.s.record.seq, family: 'fights', code });
      const signed = index.settlements.get(f.enc);
      if (!signed) {
        // A settlement's checkpoint names no fight itself: its death names the missing settlement.
        if (encOf(f.s) !== null) at('settlement-missing');
        continue;
      }
      if (encOf(f.s) !== null) {
        for (const p of checkSettledRecords(signed.settlement, [f.s]))
          at(`settled:${p.split(':').slice(2).join(':')}`);
      }
      for (const code of aroundFight(f, signed, body)) at(code);
      const log = replayed.get(f.enc);
      if (log) for (const code of againstLog(f, signed, log, body)) at(code);
    }
  }
  if (opts.replay) {
    const keys: PubKey[] = [...index.keys.values()].map((k) => ({
      id: k.id,
      publicKey: k.publicKey,
    }));
    const naming = firstNamers(index).enc;
    for (const [enc, log] of replayed) {
      const signed = index.settlements.get(enc) as SignedSettlement;
      const [creature, seq] = whereNamed(index, naming.get(enc));
      for (const code of opts.replay(signed, log, keys)) {
        // The countersignature and its key history are the signature family's to name.
        if (code === 'key' || code === 'signature') continue;
        out.push({ creature, seq, family: 'fights', code: `replay:${code}` });
      }
    }
  }
  return out;
}

/** The settlements that get replayed: those whose log is given, when a replay is. */
function replayable(index: BundleIndex, opts: VerifyOptions): Map<string, FightLog> {
  const out = new Map<string, FightLog>();
  if (!opts.replay || !opts.logs) return out;
  for (const enc of index.settlements.keys()) {
    const log = opts.logs.get(enc);
    if (log) out.set(enc, log);
  }
  return out;
}

/**
 * The bounds from the record before the fight, as a lock-in claim is clamped: the clock rises by
 * at most the wall time, the slack and the fight's frames, and the biomass less the fight's
 * winnings stays within the growth reach over the same time.
 */
function aroundFight(f: FightRecord, signed: SignedSettlement, body: Body): string[] {
  const out: string[] = [];
  const { s, before } = f;
  const settlement = signed.settlement;
  const b = s.record.body;
  const result = settlement.results.find((r) => r.creature === s.record.creature);
  const reward = int(b.reward) ?? (s.record.kind === 'death' ? (result?.reward ?? 0) : 0);
  const biomass = int(b.biomass);
  if (before.t === null) {
    // A pending child neither ages nor grows: it dies as it was born.
    if (biomass !== null && biomass - reward > reachAt(before.condition.biomass, body.growth, 0))
      out.push('fight-growth');
    return out;
  }
  const allowance =
    Math.max(0, s.record.t - before.t) + settlement.frames * FRAME_MS + CLOCK_SLACK_MS;
  const activeMs = int(b.activeMs);
  if (activeMs !== null && activeMs > before.activeMs + allowance) out.push('fight-clock');
  if (
    biomass !== null &&
    biomass - reward > reachAt(before.condition.biomass, body.growth, allowance)
  )
    out.push('fight-growth');
  return out;
}

/**
 * A held fighter against the replayed log: its start (in `enc-start` or its join) within the
 * growth reach from the record before the fight over the wall time to the lock-in, and its clock
 * at the end the frames from its frame 0 (or its join) on, within its lifespan.
 */
function againstLog(f: FightRecord, signed: SignedSettlement, log: FightLog, body: Body): string[] {
  const out: string[] = [];
  const { s, before } = f;
  const id = s.record.creature;
  const settlement = signed.settlement;
  // Only a fighter's own result record: a settlement's checkpoint and an eaten egg's death are not.
  if (before.t === null || s.record.kind === 'checkpoint') return out;
  if (!settlement.results.some((r) => r.creature === id)) return out;
  const starter = log.start.fighters.find((x) => x.creature === id);
  const join = starter ? undefined : log.joins.find((j) => j.fighter.creature === id);
  const info = starter ?? join?.fighter;
  if (!info) return out;
  // A joiner is clamped when it joins, some time before the fight's end.
  const lockedAt = starter ? log.start.at : settlement.t;
  const wall = Math.max(0, lockedAt - before.t);
  const claimed = Number.isFinite(info.biomass) ? Math.round(info.biomass * HUNDREDTHS) : null;
  if (claimed === null || claimed > reachAt(before.condition.biomass, body.growth, wall))
    out.push('start-growth');
  const activeMs = int(s.record.body.activeMs);
  const from = join ? join.f : 0;
  const locked = Math.max(0, settlement.frames - from) * FRAME_MS;
  // The hub's locked time from a clock `c` at the start: c + the frames locked, within the lifespan.
  const end = (c: number) => Math.max(c, Math.min(c + locked, body.lifespan));
  const lo = end(before.activeMs);
  const hi = end(before.activeMs + wall + CLOCK_SLACK_MS);
  if (activeMs === null || activeMs < lo || activeMs > hi) out.push('locked-time');
  return out;
}

/** The bundle's settlements: how many were replayed, had their log pruned, or had none given. */
export function fightsOf(index: BundleIndex, opts: VerifyOptions): LineageReport['fights'] {
  const settled = index.settlements.size;
  let pruned = 0;
  let replayed = 0;
  for (const enc of index.settlements.keys()) {
    const log = opts.logs?.get(enc);
    if (log === null) pruned++;
    else if (log && opts.replay) replayed++;
  }
  return { settled, replayed, pruned, unreplayed: settled - pruned - replayed };
}
