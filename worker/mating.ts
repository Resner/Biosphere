import type { Genome } from '../src/genome/codec';
import { genomeHash } from '../src/genome/codec';
import type { MateAsk } from '../src/ledger/mating';
import type { RecordRequest } from '../src/ledger/record';
import { cooldownMs, type MateView, ownRefusal, pairRefusal } from '../src/sim/mating';
import { RULES, RULES_VERSION } from '../src/sim/rules';
import type { Head } from './ledger';
import { type LifeState, paidFor } from './life';

// Courtship on the authority (ADR 0021): the pure parts. What each creature looks like to the
// rules, how the fixture scale shortens the clocks, and the `mate-commit` requests a commitment
// turns into. Nothing here can undo a commitment: its round is the beacons' (ADR 0010).

const HUNDREDTHS = 100;

/** A fraction in (0, 1] that shortens a clock for E2E (`LIFESPAN_SCALE`, `MATING_SCALE`); only fixture mode honours it. */
export function fixtureScale(env: { DRAND_SOURCE?: string }, value: string | undefined): number {
  const scale = Number(value);
  return env.DRAND_SOURCE === 'fixture' && scale > 0 && scale <= 1 ? scale : 1;
}

/** The active time from which a creature with this base lifespan may mate. */
export function matureAtMsOf(baseLifespanMs: number, scale: number): number {
  const l = RULES.life;
  return Math.round(scale * Math.max(l.matureMinMs, l.matureMinShare * baseLifespanMs));
}

/** The cooldown after a mating with a partner mated `prior` times in the window, in active ms. */
export const cooldownFor = (prior: number, scale: number): number =>
  Math.round(cooldownMs(prior) * scale);

/** How far back the same pair's earlier matings count towards the doubling, in wall ms. */
export const repeatWindowMs = (scale: number): number =>
  Math.round(RULES.mating.repeatWindowMs * scale);

/** What the rules see of one connected creature (sizes in wu). */
export function viewOf(
  life: LifeState,
  owner: string,
  head: Pick<Head, 'status'> | null,
  open: { pending: boolean; inFlight: boolean },
): MateView {
  return {
    creature: life.creature,
    owner,
    active: head?.status === 'active' && !life.over,
    activeMs: life.activeMs,
    matureAtMs: life.matureAtMs,
    cooldownUntilMs: life.cooldownUntilMs,
    biomass: life.biomass / HUNDREDTHS,
    energy: life.energy / HUNDREDTHS,
    hasPending: open.pending,
    inFlight: open.inFlight,
    locked: false,
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

/** The two `mate-commit` requests: each parent's condition after paying, and its cooldown. */
export function mateRequests(
  commit: { id: string; round: number },
  a: Parent,
  b: Parent,
  cooldown: number,
): [RecordRequest, RecordRequest] {
  const one = (self: Parent, other: Parent, role: 'a' | 'b'): RecordRequest => {
    const paid = paidFor(self.life);
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
        ...paid,
        cooldownUntilMs: self.life.activeMs + cooldown,
      },
    };
  };
  return [one(a, b, 'a'), one(b, a, 'b')];
}

/** The invitation a courting session keeps until the partner answers, or the commitment it became. */
export type Court = { ask: MateAsk; sentAt: number } | { done: string; nonce: string };
