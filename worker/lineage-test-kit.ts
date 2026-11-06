import { type Genome, genomeFromBase64url, genomeHash } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import { reachAt, vitalsCap } from '../src/ledger/gates';
import { type Identity, toBase64Url } from '../src/ledger/identity';
import { type MateAsk, signMateAsk } from '../src/ledger/mating';
import type { ProofBundle } from '../src/ledger/proof';
import {
  type PubKey,
  REQUEST_DOMAIN,
  type RecordRequest,
  requestMessage,
} from '../src/ledger/record';
import { type Ancestor, type Born, genomeRefOf } from '../src/net/protocol';
import { RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import { advance, authority, lifeOn, type Player } from './fight-test-kit';
import { must } from './ledger-test-kit';
import { freshNonce, nextOf, publish, report } from './test-hub';

// The lineage hub tests' moves (proofs, the audit): a creature grown by honest reports, a mating
// through courtship, a promotion and a restore, each as a client sends it.

/** A player's creature as the test drives it: its genome and the reports it sends. */
export interface Grower extends Player {
  genome: Genome;
}

const genomeText = (p: Player) => authority((o) => must(o.ledger.head(p.creature)).genome);

export async function grower(p: Player): Promise<Grower> {
  const genome = genomeFromBase64url(await genomeText(p));
  if (!genome) throw new Error('genome does not decode');
  return { ...p, genome };
}

/**
 * Plays `stepMs` at a time (10 s by default), reporting a body that grows at 90% of the fastest
 * rate its genome allows, until it holds `target` hundredths, with energy at 90% and health full:
 * honest play.
 */
export async function growTo(p: Grower, target: number, stepMs = 10_000): Promise<void> {
  const growth = buildCreature(p.genome).phys.growth;
  for (let i = 0; i < 400; i++) {
    const life = must(await lifeOn(p));
    if (life.biomass >= target) return;
    await advance(stepMs);
    p.ticks += (stepMs * TICK_HZ) / 1000;
    const biomass = Math.min(target, reachAt(life.biomass, growth, stepMs * 0.9) - 100);
    const cap = vitalsCap(biomass);
    report(p.c, p.ticks, { biomass, energy: Math.floor(cap.energy * 0.9), health: cap.health });
    await nextOf(p.c, 'ack');
  }
  throw new Error(`never grew to ${target}`);
}

export const signed = (who: Identity, req: RecordRequest) =>
  toBase64Url(who.sign(REQUEST_DOMAIN, requestMessage(req)));

export const askOf = (from: Player, to: Player, nonce: string): MateAsk =>
  signMateAsk(from.id, {
    creature: from.creature,
    partner: to.id.playerId,
    partnerCreature: to.creature,
    nonce,
  });

/** A courts B and B accepts: both get their `mating` (the round is not out yet). */
export async function court(a: Player, b: Player, nonce = freshNonce()) {
  const askA = askOf(a, b, nonce);
  a.c.send({ t: 'court', ask: askA });
  await nextOf(b.c, 'invite');
  const askB = askOf(b, a, askA.nonce);
  b.c.send({ t: 'accept', ask: askB });
  const [ma, mb] = await Promise.all([nextOf(a.c, 'mating'), nextOf(b.c, 'mating')]);
  return { askA, askB, ma, mb };
}

/** A courts B, B accepts, the round comes out: both hold their pending child. */
export async function breed(a: Player, b: Player): Promise<[Born, Born]> {
  const { ma } = await court(a, b);
  await publish(ma.commit.commitment.round);
  return Promise.all([nextOf(a.c, 'born'), nextOf(b.c, 'born')]);
}

/** The owner-signed `promote` of `born` naming `parent` as its chain parent. */
export function promoteRequest(p: Player, born: Born, parent = p.creature): RecordRequest {
  return {
    v: 1,
    rules: RULES_VERSION,
    kind: 'promote',
    creature: born.record.hash,
    seq: born.record.record.seq + 1,
    prev: born.record.hash,
    owner: p.id.playerId,
    body: { role: 'child', parent },
  };
}

export async function promote(p: Grower, born: Born): Promise<Grower> {
  const request = promoteRequest(p, born);
  p.c.send({ t: 'promote', request, sig: signed(p.id, request) });
  const { life } = await nextOf(p.c, 'promoted');
  const child = await grower({ ...p, creature: life.creature, ticks: 0 });
  return { ...child, ref: genomeRefOf(genomeHash(child.genome)) };
}

export async function restore(p: Player, a: Ancestor, from: string): Promise<void> {
  const request: RecordRequest = {
    v: 1,
    rules: RULES_VERSION,
    kind: 'restore',
    creature: a.creature,
    seq: a.seq + 1,
    prev: a.hash,
    owner: p.id.playerId,
    body: {
      from,
      activeMs: a.activeMs,
      biomass: a.biomass,
      energy: a.energy,
      health: a.health,
      cooldownUntilMs: a.cooldownUntilMs,
    },
  };
  p.c.send({ t: 'restore', request, sig: signed(p.id, request) });
  await nextOf(p.c, 'restored');
}

/** The snapshot claim of a player's creature as the object holds it: its real size. */
export const sizeOf = async (p: Player) => must(await lifeOn(p)).biomass / 100;

export const chainOf = (creature: string) => authority((o) => o.ledger.chain(creature));

export const keysOf = (bundle: Pick<ProofBundle, 'keys'>): PubKey[] =>
  bundle.keys.map((k) => ({ id: k.id, publicKey: k.publicKey }));
