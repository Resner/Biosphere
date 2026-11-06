import type { Genome } from '../src/genome/codec';
import { genomeHash } from '../src/genome/codec';
import { HUNDREDTHS, paidFor, type Scales } from '../src/ledger/gates';
import type { MateAsk } from '../src/ledger/mating';
import type { RecordRequest } from '../src/ledger/record';
import { type MateView, ownRefusal, pairRefusal } from '../src/sim/mating';
import { RULES, RULES_VERSION } from '../src/sim/rules';
import type { Head } from './ledger';
import type { LifeState } from './life';

// Courtship on the authority (ADR 0021): the pure parts. What each creature looks like to the
// rules, the scales a test world shortens the clocks by, and the `mate-commit` requests a
// commitment turns into. The gates themselves are the shared rulebook's (`src/ledger/gates.ts`). Nothing here can undo a commitment: its round is the beacons' (ADR 0010).

/** A fraction in (0, 1] that shortens a clock for E2E (`LIFESPAN_SCALE`, `MATING_SCALE`); only fixture mode honours it. */
export function fixtureScale(env: { DRAND_SOURCE?: string }, value: string | undefined): number {
  const scale = Number(value);
  return env.DRAND_SOURCE === 'fixture' && scale > 0 && scale <= 1 ? scale : 1;
}

/** The scales this object runs under: 1 each in production, the fixture entry's vars otherwise. */
export function scalesOf(env: {
  DRAND_SOURCE?: string;
  LIFESPAN_SCALE?: string;
  MATING_SCALE?: string;
}): Scales {
  return {
    lifespan: fixtureScale(env, env.LIFESPAN_SCALE),
    mating: fixtureScale(env, env.MATING_SCALE),
  };
}

/** What the rules see of one connected creature (sizes in wu). */
export function viewOf(
  life: LifeState,
  owner: string,
  head: Pick<Head, 'status'> | null,
  open: { pending: boolean; inFlight: boolean; locked: boolean },
): MateView {
  return {
    creature: life.creature,
    owner,
    active: head?.status === 'active' && !life.over,
    activeMs: life.activeMs,
    matureAtMs: life.matureAtMs,
    matureBiomass: life.matureBiomass / HUNDREDTHS,
    cooldownUntilMs: life.cooldownUntilMs,
    biomass: life.biomass / HUNDREDTHS,
    energy: life.energy / HUNDREDTHS,
    hasPending: open.pending,
    inFlight: open.inFlight,
    locked: open.locked,
  };
}

/** Why `me` cannot mate with `partner` now: my own reason, then theirs (prefixed `partner-`), then the pair's. */
export function refusalFor(me: MateView, partner: MateView): string | null {
  const own = ownRefusal(me);
  if (own) return own;
  const theirs = ownRefusal(partner);
  if (theirs) return `partner-${theirs}`;
  return pairRefusal(me, partner);
}

/** An ask is good for `signWindowMs` after the courting player sent it. */
export const askLive = (sentAt: number, now: number): boolean =>
  now - sentAt <= RULES.mating.signWindowMs;

export interface Parent {
  head: Head;
  life: LifeState;
  genome: Genome;
}

/** The two `mate-commit` requests: each parent's condition after paying and before it, and its cooldown. */
export function mateRequests(
  commit: { id: string; round: number },
  a: Parent,
  b: Parent,
  cooldown: number,
): [RecordRequest, RecordRequest] {
  const one = (self: Parent, other: Parent, role: 'a' | 'b'): RecordRequest => {
    const { biomass, energy, health } = self.life;
    const before = { biomass, energy, health };
    return {
      v: 1,
      rules: RULES_VERSION,
      kind: 'mate-commit',
      creature: self.head.id,
      seq: self.head.seq + 1,
      prev: self.head.hash,
      owner: self.head.owner,
      body: {
        commit: commit.id,
        round: commit.round,
        role,
        partner: other.head.owner,
        partnerCreature: other.head.id,
        genome: genomeHash(self.genome),
        partnerGenome: genomeHash(other.genome),
        generation: self.head.generation,
        activeMs: self.life.activeMs,
        ...paidFor(before),
        cooldownUntilMs: self.life.activeMs + cooldown,
        biomassBefore: before.biomass,
        energyBefore: before.energy,
        healthBefore: before.health,
      },
    };
  };
  return [one(a, b, 'a'), one(b, a, 'b')];
}

/** The invitation a courting session keeps until the partner answers, or the commitment it became. */
export type Court = { ask: MateAsk; sentAt: number } | { done: string; nonce: string };
