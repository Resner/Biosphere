import { describe, expect, it } from 'vitest';
import { checkStored } from '../src/ledger/record';
import {
  checkSettlementSig,
  type Settlement,
  type SignedSettlement,
} from '../src/ledger/settlement';
import { RULES_VERSION } from '../src/sim/rules';
import type { Head, Ledger } from './ledger';
import type { FighterRecord, SettlementLog } from './ledger-encounter';
import { bear, inLedger, mated, must, mustPromote, nextHex, pair, RULE } from './ledger-test-kit';

// M7 T13: an encounter's results as records, on the ledger alone (ADR 0052). The hub tests in
// `settle.test.ts` play real fights; these build the results by hand.

const END = { biomass: 41_000, energy: 52_000, health: 0 };

/** A fighter's part of a settlement: a survivor that stood, unless told otherwise. */
function part(head: Head, over: Partial<FighterRecord> = {}): FighterRecord {
  return {
    owner: head.owner,
    creature: head.id,
    outcome: 'stood',
    cause: null,
    by: null,
    frames: 140,
    condition: { biomass: 46_000, energy: 61_000, health: 8800 },
    reward: 0,
    activeMs: head.activeMs + 30_000,
    unsaved: null,
    eggBy: null,
    ...over,
  };
}

/** `killer` kills `victim` (eating its egg when it carries one). */
function kill(killer: Head, victim: Head, eggBy: string | null = null): FighterRecord[] {
  return [
    part(killer, { reward: 16_000 }),
    part(victim, { outcome: 'killed', cause: 'killed', by: killer.id, condition: END, eggBy }),
  ];
}

/** A stand-in for the fight's saved log: it keeps the sealed document. */
function memoryLog(): SettlementLog & { doc: SignedSettlement | null } {
  const log = {
    doc: null as SignedSettlement | null,
    stored: () => log.doc,
    seal: (signed: SignedSettlement) => {
      log.doc = signed;
    },
  };
  return log;
}

/** A settlement document for `enc` (its contents are `settlementOf`'s, tested in `src/net`). */
const docOf = (enc: string): Settlement => ({
  v: 1,
  kind: 'settlement',
  rules: RULES_VERSION,
  enc,
  pondSeed: 'test',
  start: '0'.repeat(64),
  joins: [],
  frames: 1,
  root: '1'.repeat(64),
  hash: '2'.repeat(64),
  referee: 'authority',
  results: [],
  t: 1,
});

/** Settles `fighters` of encounter `enc` into `log`. */
const settle = (
  ledger: Ledger,
  input: { enc: string; fighters: FighterRecord[] },
  log: SettlementLog = memoryLog(),
) => ledger.settle({ ...input, settlement: docOf(input.enc), log });

const kinds = (ledger: Ledger, id: string) => ledger.chain(id).map((s) => s.record.kind);

describe('Ledger.settle', () => {
  it('writes the victim’s death by the killer and the killer’s encounter record', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const enc = nextHex();
      const fighters = kill(a, b);
      const before = ledger.rowsWritten;
      const log = memoryLog();
      const result = settle(ledger, { enc, fighters }, log);
      const rows = ledger.rowsWritten - before;
      console.log(`rows written by a kill: ${rows}`);
      // Two per participant (its record and its head), and the dead index entry of the victim's.
      expect(rows).toBeLessThanOrEqual(5);
      expect(result.fresh).toBe(true);
      const keys = ledger.pubkeys();
      // The document is countersigned, and the log keeps it.
      expect(result.settlement?.settlement).toEqual(docOf(enc));
      expect(checkSettlementSig(result.settlement as SignedSettlement, keys)).toEqual([]);
      expect(log.doc).toEqual(result.settlement);
      for (const s of result.stored) {
        expect(checkStored(s, keys)).toEqual([]);
        expect(s.ownerSig).toBeNull();
      }
      expect(kinds(ledger, a.id)).toEqual(['genesis', 'encounter']);
      expect(ledger.chain(a.id)[1]?.record.body).toEqual({
        enc,
        outcome: 'stood',
        frames: 140,
        biomass: 46_000,
        energy: 61_000,
        health: 8800,
        reward: 16_000,
        activeMs: a.activeMs + 30_000,
      });
      const killer = must(ledger.head(a.id));
      expect(killer).toMatchObject({ status: 'active', biomass: 46_000, energy: 61_000 });
      expect(killer.health).toBe(8800);
      expect(must(ledger.head(b.id)).status).toBe('dead');
      expect(ledger.deathRecord(b.id)?.record.body).toEqual({
        cause: 'killed',
        activeMs: b.activeMs + 30_000,
        biomass: END.biomass,
        enc,
        by: a.id,
      });
    });
  });

  it('writes nothing when the same encounter is settled again, and returns the stored document', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const enc = nextHex();
      const log = memoryLog();
      const first = settle(ledger, { enc, fighters: kill(a, b) }, log);
      const before = ledger.rowsWritten;
      expect(settle(ledger, { enc, fighters: kill(a, b) }, log)).toEqual({
        fresh: false,
        stored: [],
        settlement: first.settlement,
      });
      expect(ledger.rowsWritten).toBe(before);
      expect(kinds(ledger, a.id)).toEqual(['genesis', 'encounter']);
    });
  });

  it('writes no record when the document can’t be sealed', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const log: SettlementLog = {
        stored: () => null,
        seal: () => {
          throw new Error('disk full');
        },
      };
      expect(() => settle(ledger, { enc: nextHex(), fighters: kill(a, b) }, log)).toThrow(
        /disk full/,
      );
      expect(kinds(ledger, a.id)).toEqual(['genesis']);
      expect(kinds(ledger, b.id)).toEqual(['genesis']);
      expect(must(ledger.head(b.id)).status).toBe('active');
    });
  });

  it('checkpoints a dead fighter’s unsaved report first', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const unsaved = { biomass: 39_000, energy: 20_000, health: 7000 };
      const [killer, victim] = kill(a, b);
      const before = ledger.rowsWritten;
      settle(ledger, {
        enc: nextHex(),
        fighters: [must(killer), { ...must(victim), unsaved, activeMs: 25_000 }],
      });
      expect(ledger.rowsWritten - before).toBeLessThanOrEqual(7);
      expect(kinds(ledger, b.id)).toEqual(['genesis', 'checkpoint', 'death']);
      expect(ledger.chain(b.id)[1]?.record.body).toEqual({ ...unsaved, activeMs: 25_000 });
    });
  });

  it('writes an eaten egg as its pending child’s death, which leaves the fallback', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const [, childB] = bear(ledger, mated(ledger, a, b));
      expect(ledger.fallback(b.id, RULE).pending?.id).toBe(childB.id);
      const enc = nextHex();
      const before = ledger.rowsWritten;
      // B escapes, but A ate its egg on the way.
      settle(ledger, {
        enc,
        fighters: [part(a, { reward: 4000 }), part(b, { outcome: 'escaped', eggBy: a.id })],
      });
      // Two per participant, and three for the egg (its record, its head and its dead index entry).
      expect(ledger.rowsWritten - before).toBeLessThanOrEqual(7);
      const child = must(ledger.head(childB.id));
      expect(child.status).toBe('dead');
      expect(ledger.deathRecord(child.id)?.record.body).toEqual({
        cause: 'eaten',
        activeMs: 0,
        biomass: childB.biomass,
        enc,
        by: a.id,
      });
      expect(ledger.pending(b.owner)).toBeNull();
      expect(ledger.fallback(b.id, RULE).pending).toBeNull();
      expect(must(ledger.head(b.id)).status).toBe('active');
      // A child that never hatched is not a life: History and the last death skip it.
      expect(ledger.history(b.owner, 10)).toEqual([]);
      expect(ledger.lastDead(b.owner)).toBeNull();
    });
  });

  it('lets a carrier killed with its egg fall back to its ancestor', async () => {
    await inLedger(async (ledger) => {
      // A and B each promote their first child (A and B frozen), whose own mating gives eggs.
      const { A, B, a, b } = await pair(ledger);
      const [childA, childB] = bear(ledger, mated(ledger, a, b));
      mustPromote(ledger, A, childA, a.id);
      mustPromote(ledger, B, childB, b.id);
      const [ca, cb] = [must(ledger.head(childA.id)), must(ledger.head(childB.id))];
      const [eggA] = bear(ledger, mated(ledger, ca, cb));
      const [killer, carrier] = [must(ledger.head(cb.id)), must(ledger.head(ca.id))];
      settle(ledger, { enc: nextHex(), fighters: kill(killer, carrier, killer.id) });
      expect(must(ledger.head(eggA.id)).status).toBe('dead');
      const fallback = ledger.fallback(carrier.id, RULE);
      expect(fallback.pending).toBeNull();
      expect(fallback.ancestor?.id).toBe(a.id);
      // The last death is the carrier, not its egg, so a promote or restore starts from it.
      expect(ledger.lastDead(A.playerId)?.id).toBe(carrier.id);
    });
  });

  it('keeps the pending child when its carrier dies of a hazard', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const [, childB] = bear(ledger, mated(ledger, a, b));
      const enc = nextHex();
      settle(ledger, {
        enc,
        fighters: [part(a), part(b, { outcome: 'died', cause: 'toxin', condition: END })],
      });
      expect(ledger.deathRecord(b.id)?.record.body).toMatchObject({ cause: 'toxin', enc });
      expect(ledger.fallback(b.id, RULE).pending?.id).toBe(childB.id);
      expect(ledger.history(b.owner, 10).map((l) => l.cause)).toEqual(['toxin']);
    });
  });

  it('still writes an eaten egg’s death when the carrier’s creature is no longer active', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const [, childB] = bear(ledger, mated(ledger, a, b));
      // B dies first, in a fight that ate nothing; the egg is eaten in a second fight's results.
      settle(ledger, { enc: nextHex(), fighters: kill(a, b) });
      expect(must(ledger.head(b.id)).status).toBe('dead');
      expect(ledger.pending(b.owner)?.id).toBe(childB.id);
      settle(ledger, {
        enc: nextHex(),
        fighters: [part(a), part(b, { outcome: 'killed', cause: 'killed', by: a.id, eggBy: a.id })],
      });
      expect(must(ledger.head(childB.id)).status).toBe('dead');
    });
  });

  it('skips a fighter whose creature is no longer active, and refuses what the rules refuse', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const enc = nextHex();
      // A kill that names no killer breaks the death body: nothing at all is written.
      expect(() =>
        settle(ledger, { enc, fighters: [part(a), { ...must(kill(a, b)[1]), by: null }] }),
      ).toThrow(/missing:by/);
      expect(kinds(ledger, a.id)).toEqual(['genesis']);
      settle(ledger, { enc, fighters: [part(a), part({ ...b, owner: a.owner })] });
      expect(kinds(ledger, b.id)).toEqual(['genesis']);
    });
  });
});

describe('client requests', () => {
  it('can never write a kill, an eaten egg or an encounter record', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const [, childB] = bear(ledger, mated(ledger, a, b));
      const chain = (head: Head, kind: 'death' | 'encounter', body: Record<string, string>) => ({
        v: 1 as const,
        rules: 9,
        kind,
        creature: head.id,
        seq: head.seq + 1,
        prev: head.hash,
        owner: head.owner,
        body,
      });
      const enc = nextHex();
      const fresh = must(ledger.head(a.id));
      for (const request of [
        chain(fresh, 'death', { cause: 'killed', enc, by: b.id }),
        chain(childB, 'death', { cause: 'eaten', enc, by: a.id }),
      ]) {
        expect(ledger.accept({ request })).toEqual({ ok: false, reason: 'use-operation' });
      }
      expect(ledger.accept({ request: { ...chain(fresh, 'encounter', {}) } })).toEqual({
        ok: false,
        reason: 'use-operation',
      });
      // And a pending child dies of nothing else.
      expect(
        ledger.accept({ request: chain(childB, 'death', { cause: 'starved' }) }),
      ).toMatchObject({ ok: false });
      expect(must(ledger.head(childB.id)).status).toBe('pending');
    });
  });
});
