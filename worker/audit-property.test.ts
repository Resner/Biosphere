import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect } from 'vitest';
import { reachAt, vitalsCap } from '../src/ledger/gates';
import { createIdentity, memoryKeyStore } from '../src/ledger/identity';
import type { FightLog } from '../src/ledger/settlement';
import { verifyLineage } from '../src/ledger/verify';
import { verifyEncounter } from '../src/net/encounter-verify';
import type { Ancestor } from '../src/net/protocol';
import { createRng, seedFromString } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import { heavyTest } from '../tests/heavy';
import type { FlagKind } from './audit';
import {
  advance,
  advanceTo,
  authority,
  CALM_SEED,
  clock,
  join,
  lifeOn,
  lockIn,
  NEAR,
  type Plan,
  type Player,
  play as playFight,
  rehatch,
  seasoned,
  setEnv,
  slotOf,
  snap,
  useFightHub,
} from './fight-test-kit';
import { must } from './ledger-test-kit';
import {
  court,
  grower,
  promote,
  promoteRequest,
  restore,
  signed,
  sizeOf,
} from './lineage-test-kit';
import { lifeOf } from './lives';
import { fightProof, proofBundle } from './proof';
import { closeSockets, nextOf, publish, report, sql } from './test-hub';

// M9 T8, the guard against false positives (ADR 0055): seeded client scripts, honest and
// adversarial, play whole lineages against one hub (a test world: maturity in seconds). Every
// creature's bundle must verify with its fights replayed, every adversarial script must leave its
// flag in its creature's bundle, and no honest script may be flagged.

useFightHub();

/** Two scripts a pair: 40 in all. */
const PAIRS = 20;

type Attack =
  /** Mates at the very ms of maturity, its clock brought there with the slack. */
  | 'mature-exact'
  /** Courts again with its accepted ask: `replay`. */
  | 'replay-ask'
  /** Sends a signed promote for the child's earlier head: `replay`. */
  | 'stale-promote'
  /** Twelve reports in 6 s, each claiming the adult size: `growth-too-fast`. */
  | 'flood'
  /** Ten times the ticks the wall clock allows: `clock-too-fast`. */
  | 'ticks'
  /** A body twice its adult size: `biomass-over-max`. */
  | 'biomass'
  /** A lock-in snapshot four times its size: `claim-over` (the attacker of a fight). */
  | 'claim'
  /** Mates again at the very ms its cooldown ends (after a restore). */
  | 'cooldown-exact';

interface Script {
  name: string;
  attacks: Set<Attack>;
  /** Every creature it played, and the flags it must have left on them. */
  creatures: string[];
  owes: { creature: string; kind: FlagKind }[];
}

interface Actor extends Player {
  script: Script;
  /** The creature frozen by its last promotion, and its genome ref, for a return. */
  frozen?: { creature: string; ref: number };
}

const ATTACKS: Attack[] = [
  'mature-exact',
  'replay-ask',
  'stale-promote',
  'flood',
  'ticks',
  'biomass',
  'claim',
  'cooldown-exact',
];
/** The attacks that leave a flag; an adversarial script has at least one. */
const FLAGGING: Attack[] = ['replay-ask', 'stale-promote', 'flood', 'ticks', 'biomass'];

function scriptOf(name: string, rng: { next(): number; int(lo: number, hi: number): number }) {
  const attacks = new Set<Attack>();
  if (rng.next() < 0.5) {
    for (const a of ATTACKS) if (rng.next() < 0.4) attacks.add(a);
    attacks.add(FLAGGING[rng.int(0, FLAGGING.length - 1)] as Attack);
  }
  return { name, attacks, creatures: [], owes: [] } satisfies Script;
}

const owe = (p: Actor, kind: FlagKind) => p.script.owes.push({ creature: p.creature, kind });

/** A new creature for the actor: its ticks count from 0 on the binding. */
function bound(p: Actor, creature: string, ref = p.ref): void {
  p.creature = creature;
  p.ref = ref;
  p.ticks = 0;
  if (!p.script.creatures.includes(creature)) p.script.creatures.push(creature);
}

/**
 * Plays `ms` honestly and reports it: a body grown at 90% of the fastest rate its genome allows
 * (up to its adult size), energy at 90%, health full.
 */
async function honest(p: Actor, ms: number): Promise<void> {
  const { biomass, growth, maxBiomass } = must(await lifeOn(p));
  await advance(ms);
  p.ticks += (ms * TICK_HZ) / 1000;
  const grown = reachAt(biomass, growth, ms * 0.9) - 100;
  sendCondition(p, Math.min(Math.floor(maxBiomass * 100), grown));
  await nextOf(p.c, 'ack');
}

function sendCondition(p: Actor, biomass: number, ticks = p.ticks): void {
  const cap = vitalsCap(biomass);
  report(p.c, ticks, { biomass, energy: Math.floor(cap.energy * 0.9), health: cap.health });
}

/**
 * Brings the creature's clock to exactly `target` with one report, from a binding it has not
 * reported since: the wall time to `target` less the slack, and the ticks for all of it.
 */
async function exactly(p: Actor, target: number): Promise<boolean> {
  const life = must(await lifeOn(p));
  const need = target - life.activeMs;
  const at = life.boundT + need - RULES.life.accrueSlackMs;
  if (life.n !== 0 || need <= RULES.life.accrueSlackMs || at < clock.t) return false;
  await advanceTo(at);
  p.ticks = Math.ceil((need * TICK_HZ) / 1000);
  sendCondition(p, Math.floor(RULES.starter.biomass * 100));
  const ack = await nextOf(p.c, 'ack');
  expect(ack.activeMs).toBe(target);
  return true;
}

/**
 * A flood, when the script floods: twelve reports in 6 s, each claiming the adult size, sent just
 * before the record that will hold what it kept (a fight's, a death's checkpoint, a mating's).
 */
async function flood(p: Actor): Promise<void> {
  if (!p.script.attacks.has('flood')) return;
  const { maxBiomass } = must(await lifeOn(p));
  // A fresh rate window: the flood and the request after it stay within the socket's limit.
  await advance(10_000);
  for (let i = 0; i < 12; i++) {
    await advance(500);
    p.ticks += TICK_HZ / 2;
    sendCondition(p, Math.floor(maxBiomass * 100));
  }
  for (let i = 0; i < 12; i++) await nextOf(p.c, 'ack');
  owe(p, 'growth-too-fast');
}

/** The other report attacks of an adversarial script, on its current creature. */
async function misreport(p: Actor): Promise<void> {
  const { maxBiomass } = must(await lifeOn(p));
  if (p.script.attacks.has('ticks')) {
    await advance(5_000);
    p.ticks += 50 * TICK_HZ;
    sendCondition(p, Math.floor(RULES.starter.biomass * 100));
    await nextOf(p.c, 'ack');
    owe(p, 'clock-too-fast');
  }
  if (p.script.attacks.has('biomass')) {
    await advance(1_000);
    p.ticks += TICK_HZ;
    report(p.c, p.ticks, { biomass: Math.floor(maxBiomass * 200), energy: 1, health: 1 });
    await nextOf(p.c, 'ack');
    owe(p, 'biomass-over-max');
  }
}

/** A hunts B with its weapon aimed while B idles, until the fight ends however it ends. */
async function fight(a: Actor, b: Actor): Promise<boolean> {
  const claim = a.script.attacks.has('claim');
  // A pond with no hazard or strong current at the fight's place, as the fight hub tests use.
  await sql('UPDATE ponds SET seed = ? WHERE id = ?', CALM_SEED, a.pond.id);
  for (const p of [a, b]) p.pond = { ...p.pond, seed: CALM_SEED };
  const [start] = await lockIn(
    a,
    b,
    snap(b, ...NEAR.b, { health: 0.01, biomass: await sizeOf(b) }),
    snap(a, ...NEAR.a, { health: 1, biomass: claim ? 400 : await sizeOf(a) }),
  );
  if (claim) owe(a, 'claim-over');
  const target = slotOf(start, b);
  const hunt: Plan = () => [drive(0, 15, { stance: 'aggressive', target }), IDLE_CODE];
  const played = await playFight(a, b, start, hunt);
  const end = must(played.ends)[0];
  return end.fighters.find((f) => f.player === b.id.playerId)?.outcome === 'killed';
}

/** A frozen creature as a fallback names it. */
const ancestorOf = (creature: string): Promise<Ancestor> =>
  authority((o) => {
    const head = must(o.ledger.head(creature));
    return { ...lifeOf(o, head), hash: head.hash };
  });

/** One pair of scripts through a lineage: genesis, a mating, promotions, misreports, a fight or a death and a return. */
async function pairRun(n: number): Promise<Script[]> {
  const rng = createRng(seedFromString(`audit-${n}`), 'scripts');
  const actors: Actor[] = [];
  for (const side of ['A', 'B']) {
    // Seeded identities: the commitments, and so the genomes, are the same on every run.
    const seed = sha256(new TextEncoder().encode(`audit-${n}${side}`));
    const joined = await join(await createIdentity(memoryKeyStore(seed)));
    const p = await rehatch(joined);
    await seasoned(p);
    const actor: Actor = { ...p, script: scriptOf(`${n}${side}`, rng) };
    bound(actor, p.creature);
    actors.push(actor);
  }
  const [a, b] = actors as [Actor, Actor];

  // Maturity: exactly at its ms for the scripts that try it (earliest first), else 10 s of play.
  const matureAt = await Promise.all(actors.map(async (p) => must(await lifeOn(p)).matureAtMs));
  const order = [0, 1].sort((i, j) => (matureAt[i] as number) - (matureAt[j] as number));
  for (const i of order) {
    const p = actors[i] as Actor;
    const exact = p.script.attacks.has('mature-exact') && (await exactly(p, matureAt[i] as number));
    if (!exact) {
      p.script.attacks.delete('mature-exact');
      await honest(p, 10_000);
    }
  }

  // The mating, and the asks replayed: each player's own ask of it, A's court or B's acceptance.
  const { askA, askB, ma } = await court(a, b);
  for (const [p, ask] of [
    [a, askA],
    [b, askB],
  ] as const) {
    if (!p.script.attacks.has('replay-ask')) continue;
    for (let i = 0; i < 2; i++) {
      p.c.send({ t: 'court', ask });
      expect((await nextOf(p.c, 'refused')).reason).toBe('used');
    }
    owe(p, 'replay');
  }
  await publish(ma.commit.commitment.round);
  const born = await Promise.all([nextOf(a.c, 'born'), nextOf(b.c, 'born')]);
  const parents = [a.creature, b.creature];

  // Both promote; a stale promote is the same head's request naming another parent.
  for (const [i, p] of actors.entries()) {
    const child = await promote(await grower(p), born[i] as (typeof born)[number]);
    p.frozen = { creature: p.creature, ref: p.ref };
    bound(p, child.creature, child.ref);
    if (p.script.attacks.has('stale-promote')) {
      const stale = promoteRequest(p, born[i] as (typeof born)[number], parents[1 - i]);
      for (let k = 0; k < 2; k++) {
        p.c.send({ t: 'promote', request: stale, sig: signed(p.id, stale) });
        await nextOf(p.c, 'refused');
      }
      owe(p, 'replay');
    }
  }

  // The children misreport, then play 20 s honestly (past spawn protection and maturity).
  for (const p of actors) {
    await misreport(p);
    await honest(p, 10_000);
    await honest(p, 10_000);
  }

  // Only A attacks in a fight, and only A returns to mate again at its cooldown's end.
  b.script.attacks.delete('claim');
  b.script.attacks.delete('cooldown-exact');
  if (rng.next() < 0.5) {
    a.script.attacks.delete('cooldown-exact');
    for (const p of actors) await flood(p);
    if (await fight(a, b)) {
      // Its `died` went by during the fight's frames: the return is to the creature it froze.
      const ancestor = await ancestorOf(must(b.frozen).creature);
      await restore(b, ancestor, b.creature);
      bound(b, ancestor.creature, must(b.frozen).ref);
      await honest(b, 10_000);
    }
  } else {
    a.script.attacks.delete('claim');
    // A's child dies of a toxin; A returns to its ancestor and mates again once rested.
    await flood(a);
    await advance(5_000);
    a.ticks += 5 * TICK_HZ;
    a.c.send({ t: 'death', cause: 'toxin', ticks: a.ticks });
    const died = await nextOf(a.c, 'died');
    const ancestor = must(died.fallback?.ancestor);
    await restore(a, ancestor, a.creature);
    bound(a, ancestor.creature, must(a.frozen).ref);
    const until = ancestor.cooldownUntilMs;
    const exact = a.script.attacks.has('cooldown-exact') && (await exactly(a, until));
    if (!exact) {
      a.script.attacks.delete('cooldown-exact');
      await honest(a, 10_000);
    }
    await flood(b);
    const again = await court(a, b);
    await publish(again.ma.commit.commitment.round);
    const [ba, bb] = await Promise.all([nextOf(a.c, 'born'), nextOf(b.c, 'born')]);
    a.script.creatures.push(ba.record.hash);
    b.script.creatures.push(bb.record.hash);
  }
  await closeSockets();
  return actors.map((p) => p.script);
}

describe('the audit against the verifier', () => {
  heavyTest(
    'an honest authority writes only histories the verifier accepts, and flags each attack (40 scripts)',
    async () => {
      await setEnv(true);
      const scripts: Script[] = [];
      for (let n = 0; n < PAIRS; n++) scripts.push(...(await pairRun(n)));

      const adversarial = scripts.filter((s) => s.owes.length > 0);
      const honestOnes = scripts.filter((s) => s.attacks.size === 0);
      expect(adversarial.length).toBeGreaterThan(5);
      expect(honestOnes.length).toBeGreaterThan(5);
      const tried = new Set(scripts.flatMap((s) => [...s.attacks]));
      expect([...tried].sort()).toEqual([...ATTACKS].sort());

      let verified = 0;
      let replayed = 0;
      let flagged = 0;
      for (const s of scripts) {
        for (const id of s.creatures) {
          const { bundle, logs } = await authority((o) => {
            const b = must(proofBundle(o, id, o.clock.now()));
            const l = new Map<string, FightLog | null>();
            for (const x of b.settlements) {
              l.set(x.settlement.enc, fightProof(o, x.settlement.enc)?.log ?? null);
            }
            return { bundle: b, logs: l };
          });
          const verdict = verifyLineage(bundle, { logs, replay: verifyEncounter });
          expect(verdict.problems, `${s.name} ${id}`).toEqual([]);
          expect(verdict.fights.replayed).toBe(verdict.fights.settled);
          const mine = bundle.flags.filter((f) => f.creature === id).map((f) => f.kind);
          const owed = s.owes.filter((o) => o.creature === id).map((o) => o.kind);
          for (const kind of owed) expect(mine, `${s.name} owes ${kind}`).toContain(kind);
          // Each kind once, however often it was repeated.
          expect(new Set(mine).size).toBe(mine.length);
          if (s.attacks.size === 0) expect(mine, `${s.name} is honest`).toEqual([]);
          verified++;
          replayed += verdict.fights.replayed;
          flagged += owed.length;
        }
      }
      // Every pair's lineage was checked, fights among them, and every owed flag found.
      expect(verified).toBeGreaterThanOrEqual(4 * PAIRS);
      expect(replayed).toBeGreaterThan(0);
      expect(flagged).toBe(adversarial.reduce((n, s) => n + s.owes.length, 0));
    },
  );
});
