// Shared fixtures of the ledger tests that need a real Durable Object (`ledger-mating*.test.ts`).
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createIdentity, type Identity, memoryKeyStore, toBase64Url } from '../src/ledger/identity';
import {
  type RecordKind,
  type RecordRequest,
  requestMessage,
  type StoredRecord,
} from '../src/ledger/record';
import { RULES_VERSION } from '../src/sim/rules';
import type { BirthChild, Exhaustion, Head, Ledger, MateResult, PromoteResult } from './ledger';

export const stub = (name = 'global') => env.AUTHORITY.get(env.AUTHORITY.idFromName(name));
export const inLedger = <T>(fn: (ledger: Ledger) => T | Promise<T>): Promise<T> =>
  runInDurableObject(stub(), (authority) => fn(authority.ledger));

export const hex = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 0;
export const nextHex = (): string => hex(++counter * 7919 + Date.now());

export const LIFESPAN = 4_500_000;
export const RULE: Exhaustion = { lifespanOf: () => LIFESPAN, restoreMinMs: 120_000 };
export const ROUND = 5000;

export const newPlayer = (): Promise<Identity> => createIdentity(memoryKeyStore());
export const sign = (who: Identity, request: RecordRequest): string =>
  toBase64Url(who.sign('bs/req/v1', requestMessage(request)));

export function genesisRequest(owner: string): RecordRequest {
  return {
    v: 1,
    rules: RULES_VERSION,
    kind: 'genesis',
    creature: '',
    seq: 0,
    prev: '',
    owner,
    body: { commit: nextHex(), round: 100, genome: nextHex(), generation: 0, karyotype: 1 },
  };
}

export function hatch(ledger: Ledger, owner: string): Head {
  const result = ledger.accept({ request: genesisRequest(owner), genome: 'genome-text' });
  if (!result.ok) throw new Error(`genesis refused: ${result.reason}`);
  return must(ledger.head(result.stored.hash));
}

export function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('missing');
  return x;
}

export const chainRequest = (
  head: Head,
  kind: RecordKind,
  body: RecordRequest['body'],
  seq = head.seq + 1,
): RecordRequest => ({
  v: 1,
  rules: RULES_VERSION,
  kind,
  creature: head.id,
  seq,
  prev: head.hash,
  owner: head.owner,
  body,
});

export const checkpoint = (head: Head, activeMs = head.activeMs + 1000): RecordRequest =>
  chainRequest(head, 'checkpoint', { activeMs, biomass: 900, energy: 700, health: 9000 });

export function step(ledger: Ledger, request: RecordRequest): Head {
  const result = ledger.accept({ request });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return must(ledger.head(request.creature));
}

export function die(ledger: Ledger, head: Head, cause = 'killed'): Head {
  return step(
    ledger,
    chainRequest(head, 'death', {
      cause,
      activeMs: head.activeMs,
      biomass: head.biomass,
      energy: head.energy,
      health: 0,
    }),
  );
}

export function mateRequests(
  a: Head,
  b: Head,
  commit: string,
  round = ROUND,
): [RecordRequest, RecordRequest] {
  const body = (self: Head, other: Head, role: 'a' | 'b') => ({
    commit,
    round,
    role,
    partner: other.owner,
    partnerCreature: other.id,
    genome: nextHex(),
    partnerGenome: nextHex(),
    generation: self.generation,
    activeMs: self.activeMs,
    biomass: 850,
    energy: 560,
    health: 9000,
    cooldownUntilMs: self.activeMs + 360_000,
  });
  return [
    chainRequest(a, 'mate-commit', body(a, b, 'a')),
    chainRequest(b, 'mate-commit', body(b, a, 'b')),
  ];
}

export function mate(
  ledger: Ledger,
  a: Head,
  b: Head,
  commit = nextHex(),
): MateResult & { commit: string } {
  const requests = mateRequests(a, b, commit);
  return { ...ledger.mate({ commit, round: ROUND, requests }), commit };
}

export function birthChildren(
  commit: string,
  a: Head,
  b: Head,
  mates: [StoredRecord, StoredRecord],
): [BirthChild, BirthChild] {
  const make = (owner: string, slot: number): BirthChild => ({
    request: {
      v: 1,
      rules: RULES_VERSION,
      kind: 'birth',
      creature: '',
      seq: 0,
      prev: '',
      owner,
      body: {
        commit,
        round: ROUND,
        slot,
        parents: [a.id, b.id],
        mates: [mates[0].hash, mates[1].hash],
        genome: nextHex(),
        generation: Math.max(a.generation, b.generation) + 1,
        karyotype: 1,
      },
    },
    genome: `child-${slot}-${nextHex()}`,
    condition: { biomass: 80, energy: 9600, health: 9000 },
  });
  return [make(a.owner, 0), make(b.owner, 1)];
}

export interface Mated {
  a: Head;
  b: Head;
  commit: string;
  mates: [StoredRecord, StoredRecord];
}

export function mated(ledger: Ledger, a: Head, b: Head): Mated {
  const result = mate(ledger, a, b);
  if (!result.ok) throw new Error(`mate refused: ${result.reason}`);
  return { a, b, commit: result.commit, mates: result.stored };
}

/** Both players' pending children, born through the legitimate path. */
export function bear(ledger: Ledger, m: Mated): [Head, Head] {
  const children = birthChildren(m.commit, m.a, m.b, m.mates);
  const result = ledger.birth({ commit: m.commit, children });
  if (!result.ok) throw new Error(`birth refused: ${result.reason}`);
  return [must(ledger.head(result.stored[0].hash)), must(ledger.head(result.stored[1].hash))];
}

export function promoteRequest(child: Head, parent: string): RecordRequest {
  return chainRequest(child, 'promote', { role: 'child', parent });
}

export function promote(ledger: Ledger, who: Identity, child: Head, parent: string): PromoteResult {
  const request = promoteRequest(child, parent);
  return ledger.promote(request, sign(who, request));
}

export function mustPromote(ledger: Ledger, who: Identity, child: Head, parent: string) {
  const result = promote(ledger, who, child, parent);
  if (!result.ok) throw new Error(`promote refused: ${result.reason}`);
  return result;
}

export function restoreRequest(ancestor: Head, from: string): RecordRequest {
  return chainRequest(ancestor, 'restore', {
    from,
    activeMs: ancestor.activeMs,
    biomass: ancestor.biomass,
    energy: ancestor.energy,
    health: ancestor.health,
    cooldownUntilMs: ancestor.cooldownUntilMs,
  });
}

/** Two players with a genesis creature each. */
export async function pair(
  ledger: Ledger,
): Promise<{ A: Identity; B: Identity; a: Head; b: Head }> {
  const [A, B] = [await newPlayer(), await newPlayer()];
  return { A, B, a: hatch(ledger, A.playerId), b: hatch(ledger, B.playerId) };
}

/** G frozen under a promoted child C1 that is then dead: G is the nearest surviving ancestor. */
export async function lineageOfTwo(ledger: Ledger) {
  const { A, B, a, b } = await pair(ledger);
  const m = mated(ledger, a, b);
  const [c1] = bear(ledger, m);
  mustPromote(ledger, A, c1, a.id);
  const active = must(ledger.head(c1.id));
  const dead = die(ledger, step(ledger, checkpoint(active, 5000)));
  return { A, B, g: must(ledger.head(a.id)), c1: dead, b };
}
