import { sha256 } from '@noble/hashes/sha2.js';
import { genomeFromBase64url, genomeHash } from '../src/genome/codec';
import { rarityOf } from '../src/genome/rarity';
import { buildCreature } from '../src/genome/stats';
import { LIVE_SCALES, matureBiomassOf, reachAt, vitalsCap } from '../src/ledger/gates';
import { createIdentity, type Identity, memoryKeyStore } from '../src/ledger/identity';
import { type Born, genomeRefOf } from '../src/net/protocol';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { sizeTier } from '../src/sim/size';
import type { KillLog, LifeLog, Measure } from '../tools/farm-sim';
import { HOUR, MIN, REPORT_MS } from '../tools/farm-sim';
import {
  advance,
  authority,
  CALM_SEED,
  clock,
  engage,
  join,
  killB,
  lifeOn,
  NEAR,
  rehatch,
  snap,
} from './fight-test-kit';
import { must } from './ledger-test-kit';
import {
  breed,
  type Grower,
  grower,
  promote as promoteChild,
  restore as restoreAncestor,
  sizeOf,
} from './lineage-test-kit';
import { fallbackAfter } from './lives';
import { flush, nextOf, report, sql } from './test-hub';
import { playedMs } from './witness-pool';
import { poolNow, setAvail } from './witness-test-kit';

// The bot-farm simulation's hands (M10 T13, ADR 0059): scripted identities on one hub, on the hand
// clock, under the live scales. A test aid: they never join the live world. `worker/farm.test.ts`
// drives them; `tools/farm-sim.ts` holds the strategies' numbers and the report.

/** The snapshot sequence the fights' signed claims use: a later engage must not look older. */
let seq = 0;
const FIGHT = RULES.encounter;

/** How a player's reports grow its creature. */
export type Growth = 'max' | { perMinute: number };

export interface Actor extends Grower {
  /** Generations promoted since the first hatch. */
  gen: number;
  /** The hub time of this actor's last report. */
  last: number;
  /** The creature's last ack. */
  ack: { activeMs: number; matureAtMs: number; cooldownUntilMs: number };
  growth: Growth;
  /** Hub times of each promotion, gen 1 first. */
  promotedAt: number[];
  /** False while the actor is locked in a fight: its reports wait. */
  free: boolean;
  /** Dead with no ancestor, waiting for its hatch bucket. */
  waiting: boolean;
  /** The hub time the scenario began. */
  t0: number;
  /** One entry per creature the identity has played since the first hatch, the last the active one. */
  lives: LifeLog[];
}

const freshLife = (a: Pick<Actor, 't0'>): LifeLog => ({
  startedAt: clock.t - a.t0,
  matureAtMs: Number.POSITIVE_INFINITY,
  readyAfterMs: null,
  matedAtMs: null,
  children: 0,
});
const lifeOf = (a: Actor): LifeLog => a.lives[a.lives.length - 1] as LifeLog;

const ackOf = { activeMs: 0, matureAtMs: Number.POSITIVE_INFINITY, cooldownUntilMs: 0 };

/** A signed-in player with a fresh creature, ready to report. */
export async function actor(growth: Growth, t0: number, seed?: Identity): Promise<Actor> {
  const p = await join(seed);
  const g = await grower(await rehatch(p));
  const a: Actor = {
    ...g,
    gen: 0,
    last: clock.t,
    ack: { ...ackOf },
    growth,
    promotedAt: [],
    free: true,
    waiting: false,
    t0,
    lives: [],
  };
  a.lives.push(freshLife(a));
  return a;
}

/** The condition an actor claims for its creature after `ms` more of play: the most the rules accept, or a forager's pace. */
function claimOf(a: Actor, biomass: number, ms: number) {
  const body = buildCreature(a.genome);
  const ceiling = Math.floor(body.phys.maxBiomass * 100);
  const fastest = reachAt(biomass, body.phys.growth, ms) - 100;
  const next =
    a.growth === 'max'
      ? fastest
      : Math.min(fastest, biomass + Math.floor((a.growth.perMinute * 100 * ms) / MIN));
  const grown = Math.max(biomass, Math.min(next, ceiling));
  const cap = vitalsCap(grown);
  return { biomass: grown, energy: Math.floor(cap.energy * 0.9), health: cap.health };
}

/** Reports `a`'s play up to the hub's now and takes the ack. */
export async function reportNow(a: Actor): Promise<void> {
  const ms = clock.t - a.last;
  if (ms <= 0 || !a.free) return;
  const life = must(await lifeOn(a));
  a.last = clock.t;
  a.ticks += Math.round((ms * TICK_HZ) / 1000);
  report(a.c, a.ticks, claimOf(a, life.biomass, ms));
  // The ack, or the death that old age (or anything else that ends the life) sends instead.
  for (;;) {
    const msg = await a.c.next();
    if (msg.t === 'ack') {
      a.ack = msg;
      lifeOf(a).matureAtMs = msg.matureAtMs;
      return;
    }
    if (msg.t === 'died') return recover(a);
  }
}

/** Moves the hub's clock by `ms`, then every actor reports. */
export async function pass(actors: readonly Actor[], ms: number): Promise<void> {
  await advance(ms);
  for (const a of actors) {
    if (a.waiting) continue;
    await reportNow(a);
    const log = lifeOf(a);
    if (log.readyAfterMs === null && (await ready(a)))
      log.readyAfterMs = clock.t - a.t0 - log.startedAt;
  }
}

/** Whether the creature may mate by the hub's own rules, as its ack and condition say. */
export async function ready(a: Actor): Promise<boolean> {
  if (a.waiting) return false;
  if (a.ack.activeMs < a.ack.matureAtMs || a.ack.activeMs < a.ack.cooldownUntilMs) return false;
  const life = must(await lifeOn(a));
  return life.biomass >= matureBiomassOf(a.genome, LIVE_SCALES);
}

/** Becomes the promoted child: the actor's connection now plays it. */
async function adopt(a: Actor, born: Born): Promise<void> {
  const next = await promoteChild(a, born);
  Object.assign(a, next, { last: clock.t, ack: { ...ackOf } });
  a.lives.push(freshLife(a));
  a.gen += 1;
  a.promotedAt.push(clock.t);
}

/** A and B mate, the round comes out and both promote their child. */
export async function mate(a: Actor, b: Actor, children: string[]): Promise<void> {
  for (const p of [a, b]) await reportNow(p);
  const [bornA, bornB] = await breed(a, b);
  for (const p of [a, b]) {
    lifeOf(p).matedAtMs = p.ack.activeMs;
    lifeOf(p).children = 1;
  }
  children.push(bornA.genome, bornB.genome);
  await adopt(a, bornA);
  await adopt(b, bornB);
  // The child starts its own life; its first ack names its maturity and cooldown.
  for (const p of [a, b]) {
    p.last = clock.t;
    p.ticks = 0;
  }
}

/** What the authority counts as the identity's play: the measure of eligibility and of worth. */
const playedOf = (a: Actor): Promise<number> => authority((o) => playedMs(o, a.id.playerId));

/**
 * `killer` locks `victim` in at 1 hp and kills it. Both must be out of spawn protection and
 * past their reports. The victim falls back to its ancestor (restored) or a new hatch.
 */
export async function slay(
  killer: Actor,
  victim: Actor,
): Promise<Omit<KillLog, 'victim' | 'atMs'>> {
  for (const p of [killer, victim]) await reportNow(p);
  killer.free = false;
  victim.free = false;
  const sizeK = await sizeOf(killer);
  const sizeV = await sizeOf(victim);
  seq += 1;
  engage(
    killer,
    victim,
    snap(victim, ...NEAR.b, { seq, health: 0.01, biomass: sizeV }),
    snap(killer, ...NEAR.a, { seq, health: 1, biomass: sizeK }),
  );
  const refused = (await flush(killer.c)).find((m) => m.t === 'refused');
  if (refused) throw new Error(`the farmer's engage was refused: ${refused.reason}`);
  await nextOf(victim.c, 'lock-ask');
  await advance(FIGHT.lockAnswerMs);
  const [start] = await Promise.all([nextOf(killer.c, 'enc-start'), nextOf(victim.c, 'enc-start')]);
  const worth = start.fighters.find((f) => f.player === victim.id.playerId)?.worth ?? 1;
  const { end } = await killB(killer, victim, start);
  const settled = end.settlement?.settlement.results.find((r) => r.player === killer.id.playerId);
  killer.free = true;
  victim.free = true;
  killer.last = clock.t;
  victim.last = clock.t;
  return {
    victimPlayMs: await playedOf(victim),
    worth,
    victimBiomass: sizeV,
    reward: (settled?.reward ?? 0) / 100,
    carrion:
      FIGHT.reward.carrion *
      end.fighters.filter((f) => f.outcome === 'killed').length *
      sizeV *
      worth,
  };
}

/**
 * A killed player falls back on its nearest surviving ancestor, restoring it (the `died` message went to
 * `killB`'s wait), or hatches again when it has none.
 */
export async function recover(a: Actor): Promise<void> {
  const dead = a.creature;
  const fallback = await authority((o) => fallbackAfter(o, o.ledger.head(dead)));
  if (!fallback.ancestor) {
    // Nothing to fall back on: it hatches again once its bucket has a hatch (ADR 0021's genesis bucket).
    a.waiting = true;
    a.free = false;
    return;
  }
  await restoreAncestor(a, fallback.ancestor, dead);
  await adoptLife(a);
}

/** A waiting identity hatches when its bucket allows. */
export async function revive(a: Actor): Promise<void> {
  if (!a.waiting) return;
  if ((await authority((o) => o.ledger.hatches(a.id.playerId, clock.t))).left === 0) return;
  Object.assign(a, await rehatch(a));
  a.waiting = false;
  a.free = true;
  await adoptLife(a);
}

async function adoptLife(a: Actor): Promise<void> {
  const life = must(await lifeOn(a));
  const genome = genomeFromBase64url(
    await authority((o) => must(o.ledger.head(life.creature)).genome),
  );
  if (!genome) throw new Error('genome does not decode');
  Object.assign(a, {
    creature: life.creature,
    genome,
    ref: genomeRefOf(genomeHash(genome)),
    ticks: 0,
    last: clock.t,
  });
  a.ack = { ...ackOf };
  a.lives.push(freshLife(a));
}

const seeded = (label: string) =>
  createIdentity(memoryKeyStore(sha256(new TextEncoder().encode(`farm|${label}`))));

export interface Scenario {
  name: string;
  bots: number;
  farmer: Growth;
  botGrowth: Growth;
  hours: number;
  /** Once its lineage has generation 3, the farmer kills a bot every `killEveryMs`; 0 for none. */
  killEveryMs: number;
}

/** When the bots' eligibility as witnesses is read: before and after the 20 minutes of play. */
const CHECKS = [
  ['before', 19 * MIN],
  ['after', 21 * MIN],
] as const;

/** How many of `bots` the pool the object would draw now holds. */
async function pooled(bots: readonly Actor[]): Promise<number> {
  for (const b of bots) await setAvail(b.c, true);
  const pool = await poolNow();
  for (const b of bots) await setAvail(b.c, false);
  const ids = new Set(bots.map((b) => b.id.playerId));
  return pool.filter((id) => ids.has(id)).length;
}

/**
 * One scenario on the hub: a farmer (or the honest pair's first player) with `bots` partners mating in
 * turn and promoting every child, the farmer killing bots on a schedule, for `hours` of hub time.
 */
export async function runScenario(o: Scenario): Promise<Measure> {
  const t0 = clock.t;
  const farmer = await actor(o.farmer, t0, await seeded(`${o.name}|farmer`));
  const bots: Actor[] = [];
  for (let i = 0; i < o.bots; i++) {
    bots.push(await actor(o.botGrowth, t0, await seeded(`${o.name}|bot${i}`)));
  }
  const all = [farmer, ...bots];
  // A pond with no UV or pressure where the fights are staged (`fighters` in the fight kit).
  await sql('UPDATE ponds SET seed = ? WHERE id = ?', CALM_SEED, farmer.pond.id);
  for (const a of all) a.pond = { ...a.pond, seed: CALM_SEED };
  const children: string[] = [];
  const kills: KillLog[] = [];
  const end = t0 + o.hours * HOUR;
  let turn = 0;
  let killTurn = 0;
  let nextKill = 0;
  let maxSizeAtMs: number | null = null;
  let gen3AtMs: number | null = null;
  const eligibility = { before: -1, after: -1 };
  let sacrifice: Actor | null = null;
  let sacrificed = false;
  let sacrificeAt = 0;

  /** Kills `victim` if it is out of spawn protection and comparable in size; logs the kill. */
  const kill = async (victim: Actor, index: number): Promise<boolean> => {
    if (victim.waiting) return false;
    await pass(all, 16_000);
    const mine = sizeTier(await sizeOf(farmer));
    const theirs = sizeTier(await sizeOf(victim));
    if (Math.abs(theirs - mine) > RULES.encounter.maxTierGap) return false;
    kills.push({ victim: index, atMs: clock.t - t0, ...(await slay(farmer, victim)) });
    return true;
  };
  let nextCheck = 0;

  while (clock.t < end) {
    await pass(all, REPORT_MS);
    for (const b of bots) await revive(b);
    const now = clock.t - t0;
    if (maxSizeAtMs === null) {
      const life = must(await lifeOn(farmer));
      if (life.biomass >= 0.95 * life.maxBiomass * 100) maxSizeAtMs = now;
    }
    if (gen3AtMs === null && farmer.gen >= 3) gen3AtMs = (farmer.promotedAt[2] as number) - t0;

    const due = CHECKS[nextCheck];
    if (due && o.bots > 0 && now >= due[1]) {
      eligibility[due[0]] = await pooled(bots);
      nextCheck += 1;
    }

    if (await ready(farmer)) {
      for (let k = 0; k < Math.max(1, o.bots); k++) {
        const b = bots[(turn + k) % bots.length];
        if (b && (await ready(b))) {
          await mate(farmer, b, children);
          turn = (turn + k + 1) % bots.length;
          break;
        }
      }
    }

    // Phase 2, once the lineage has its generation 3: the farmer starts killing, and a fresh
    // identity is made to be killed young.
    if (o.killEveryMs > 0 && o.bots > 0 && gen3AtMs !== null) {
      if (!sacrifice && !sacrificed) {
        sacrifice = await actor('max', t0, await seeded(`${o.name}|sacrifice`));
        sacrifice.pond = { ...sacrifice.pond, seed: CALM_SEED };
        sacrificeAt = now;
        all.push(sacrifice);
      }
      if (sacrifice && now - sacrificeAt >= 10 * MIN) {
        const fed = await kill(sacrifice, o.bots);
        if (fed) {
          all.splice(all.indexOf(sacrifice), 1);
          sacrifice = null;
          sacrificed = true;
        }
      }
      if (now >= nextKill) {
        nextKill += o.killEveryMs;
        for (let k = 0; k < bots.length; k++) {
          const i = (killTurn + k) % bots.length;
          if (await kill(bots[i] as Actor, i)) {
            killTurn = i + 1;
            await recover(bots[i] as Actor);
            break;
          }
        }
      }
    }
  }

  let rare = 0;
  let rarityBits = 0;
  for (const text of children) {
    const genome = genomeFromBase64url(text);
    if (!genome) continue;
    const r = rarityOf(genome);
    rarityBits += r.score;
    if (['rare', 'exotic'].includes(r.tier)) rare += 1;
  }
  return {
    name: o.name,
    bots: o.bots,
    hours: o.hours,
    gen3AtMs,
    lives: farmer.lives,
    kills,
    children: children.length,
    rare,
    rarityBits,
    maxSizeAtMs,
    eligibility: o.bots > 0 ? eligibility : null,
  };
}
