import { describe, expect } from 'vitest';
import { commitmentId } from '../src/ledger/genesis';
import { type RecordRequest, recordHash } from '../src/ledger/record';
import type { Ancestor, Born, HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { RULES, RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import { IDLE_CODE } from '../tests/encounter-fixture';
import { heavyTest } from '../tests/heavy';
import { Admission } from './admission';
import { resolvedOnFetch } from './beacons';
import {
  advance,
  answer,
  authority,
  calmPond,
  engage,
  join,
  killB,
  lockIn,
  type Player,
  play,
  rehatch,
  setEnv,
  useFightHub,
} from './fight-test-kit';
import { CATALOGUE, consistent, type TransactionName } from './interrupt-kit';
import { askOf, promoteRequest, signed } from './lineage-test-kit';
import { recoverFights } from './recover';
import { type Session, socketsOf } from './socket';
import {
  type Client,
  flush,
  genesisRequest,
  nextOf,
  placed,
  publish,
  publishOnly,
  report,
  sql,
} from './test-hub';
import { armCrowds, rebuildCrowds, rebuildDirectory } from './where';

// M14 T3, the hub's kill matrix (ADR 0076): every multi-step transaction of the catalogue
// (`interrupt-kit.ts`), cut after each of its steps by a closed socket that signs in again 1 s later,
// 10 minutes later (every round published, every deadline passed), or after the object is rebuilt
// over its storage as `POST /v1/e2e/restart` does. After each case `consistent(hub)` is empty, and
// the sign-in after the cut was told everything its player has in flight. Fights run on the fight
// kit's hand clock and rounds come from the recorded fixture.

useFightHub();

const E = RULES.encounter;
type Cut = '1s' | '10min' | 'restart';
const CUTS: readonly Cut[] = ['1s', '10min', 'restart'];

/** A mate ask's nonce no other mating in this file used (a nonce makes one mating, ADR 0021). */
let mates = 0;
const mateNonce = () => `I${++mates}`.padStart(22, 'A');

/** A player of a case: `c` is null while its socket is closed. */
interface Actor extends Omit<Player, 'c'> {
  c: Client | null;
}

const live = (p: Actor): Player => {
  if (!p.c) throw new Error(`${p.id.playerId} is not signed in`);
  return p as Player;
};

/** A signed-in player with no creature. */
async function newcomer(): Promise<Actor> {
  const { c, id, pond } = await join();
  return { c, id, pond, creature: '', ref: 0, ticks: 0 };
}

/** A signed-in player with a freshly hatched creature. */
async function hatchling(): Promise<Actor> {
  return rehatch((await newcomer()) as Player);
}

/** Plays `ms` of active time with an honest calm report and waits for its ack. */
async function playFor(p: Actor, ms: number): Promise<void> {
  await advance(ms);
  p.ticks += Math.ceil((ms * TICK_HZ) / 1000);
  report(live(p).c, p.ticks);
  await nextOf(live(p).c, 'ack');
}

/** Two hatched players side by side in the directory, old enough to mate (`MATING_SCALE` 0.01). */
async function adults(): Promise<[Actor, Actor]> {
  await setEnv(true);
  const a = await hatchling();
  const b = await hatchling();
  await placed(live(a), live(b));
  await playFor(a, 12_000);
  await playFor(b, 12_000);
  return [a, b];
}

/** A courts B, B accepts and the round comes out: both hold a pending child. */
async function bred(): Promise<[Actor, Actor, Born]> {
  const [a, b] = await adults();
  const nonce = mateNonce();
  live(a).c.send({ t: 'court', ask: askOf(live(a), live(b), nonce) });
  await nextOf(live(b).c, 'invite');
  live(b).c.send({ t: 'accept', ask: askOf(live(b), live(a), nonce) });
  const { commit } = await nextOf(live(a).c, 'mating');
  await nextOf(live(b).c, 'mating');
  await publish(commit.commitment.round);
  const born = await nextOf(live(a).c, 'born');
  await nextOf(live(b).c, 'born');
  return [a, b, born];
}

/** Closes the player's socket and waits for the close. */
async function closeOf(p: Actor): Promise<void> {
  const c = p.c;
  if (!c) return;
  p.c = null;
  c.ws.close(1000, 'gone');
  await c.closed;
}

/** Publishes every round a commitment still waits for; the alarm resolves what waited. */
async function publishAll(): Promise<void> {
  const [row] = await sql<{ r: number | null }>(
    'SELECT MAX(round) AS r FROM commitments WHERE resolved IS NULL',
  );
  if (row?.r) await publish(row.r);
}

/**
 * The object rebuilt over its storage, as `POST /v1/e2e/restart` does (`e2e-entry.ts`): every
 * socket closed with no handler of the object running for it, and the memory a new object starts
 * without (the indexes, the locks, the duties, the directory, the crowds, admission's memory and
 * the beacon service's list of commitments waiting) built again from storage. Open fights are rebuilt
 * from their saved logs.
 */
const restart = () =>
  authority((o) => {
    for (const [ws, s] of socketsOf(o)) {
      if (s) ws.serializeAttachment({ ...s, phase: 'retired' } satisfies Session);
      try {
        ws.close(1012, 'restart');
      } catch {
        // already closed
      }
    }
    (o as unknown as { rebuildSeats(): void }).rebuildSeats();
    o.fights.clear();
    o.duties.clear();
    o.directory = rebuildDirectory(o);
    o.crowds = rebuildCrowds(o);
    o.crowdsKept.clear();
    armCrowds(o);
    o.admission = new Admission();
    (o.beacons as unknown as { waiting: unknown }).waiting = null;
    recoverFights(o, o.clock.now());
  });

/** What the ledger and the locks hold in flight for a player. */
const inFlight = (player: string) =>
  authority((o) => ({
    active: o.ledger.active(player)?.id ?? null,
    genesis: o.ledger.pendingCommit(player) || null,
    mating: o.ledger.openMating(player)?.commit ?? null,
    pending: o.ledger.pending(player)?.id ?? null,
    fight: o.fights.ofPlayer(player)?.fight?.enc.id ?? null,
  }));

type Life = Extract<HubMsg, { t: 'life' }>;

/** Signs the player in on a new socket: its `life` and everything that followed up to a flush. */
async function signInAgain(p: Actor): Promise<{ life: Life; after: HubMsg[] }> {
  const { c, life } = await join(p.id);
  p.c = c;
  return { life, after: await flush(c) };
}

/** The sign-in was told what its player has in flight (ADR 0076). */
async function expectTold(p: Actor, { life, after }: { life: Life; after: HubMsg[] }) {
  const held = await inFlight(p.id.playerId);
  const who = p.id.playerId.slice(0, 8);
  expect(life.life?.creature ?? null, `${who}: the active creature`).toBe(held.active);
  const commits = after
    .filter((m) => m.t === 'commit')
    .map((m) => commitmentId(m.commit.commitment));
  if (held.genesis) expect(commits, `${who}: the waiting genesis`).toContain(held.genesis);
  expect(life.mating?.commit ?? null, `${who}: the waiting mating`).toBe(held.mating);
  if (held.mating) expect(life.mating?.partner).toBe('Tester');
  const child = life.pending ? recordHash(life.pending.record.record) : null;
  expect(child, `${who}: the pending child`).toBe(held.pending);
  expect(life.fight ?? null, `${who}: the running fight`).toBe(held.fight);
  if (held.fight) {
    const starts = after.filter((m) => m.t === 'enc-start' && m.enc === held.fight);
    expect(starts.length, `${who}: the fight resent`).toBeGreaterThan(0);
  }
  if (!held.active) expect(life.fallback?.pending ?? false).toBe(held.pending !== null);
}

/**
 * Cuts `closed` off as `cut` says, then signs every player whose socket closed in again and checks
 * what each was told.
 */
async function interrupt(cut: Cut, closed: Actor[], all: Actor[]): Promise<void> {
  if (cut === 'restart') {
    // The step reached the object before it goes: what a socket sent is handled in order.
    for (const p of closed) if (p.c) await flush(p.c);
    await restart();
    for (const p of all) {
      const c = p.c;
      p.c = null;
      if (c) await c.closed;
    }
    await advance(1000);
  } else {
    for (const p of closed) await closeOf(p);
    if (cut === '1s') await advance(1000);
    else {
      await publishAll();
      await advance(10 * 60_000);
      await publishAll();
    }
  }
  for (const p of all) if (!p.c) await expectTold(p, await signInAgain(p));
}

/** Lets the world finish what is in flight: every round published, every fight over. */
async function finishAll(): Promise<void> {
  await publishAll();
  await advance(E.lockAnswerMs + E.timeoutFrames * FRAME_MS + 5000);
  await publishAll();
}

/** `consistent` over the case's players is empty. */
async function expectConsistent(players: Actor[]): Promise<void> {
  const ids = players.map((p) => p.id.playerId);
  expect(await authority((o) => consistent(o, ids))).toEqual([]);
}

/** Each genesis commitment of the player took one hatch: three in a full bucket, less one each. */
async function expectHatches(p: Actor): Promise<void> {
  const [row] = await sql<{ hatches: number; n: number }>(
    `SELECT hatches, (SELECT COUNT(*) FROM commitments WHERE kind = 'genesis' AND owner = ?1) AS n
     FROM players WHERE id = ?1`,
    p.id.playerId,
  );
  if (row) expect(row.hatches).toBe(3 - row.n);
}

// The drivers: each plays its transaction up to `step`, cuts the player it names, and finishes.

async function genesisCase(step: string, cut: Cut): Promise<Actor[]> {
  const a = await newcomer();
  live(a).c.send(genesisRequest(a.id));
  if (step !== 'ask') {
    const { commit } = await nextOf(live(a).c, 'commit');
    if (step === 'round' || step === 'genesis') await publish(commit.commitment.round);
    if (step === 'genesis') await nextOf(live(a).c, 'genesis');
  }
  await interrupt(cut, [a], [a]);
  await finishAll();
  await expectHatches(a);
  const [made] = await sql<{ n: number }>(
    "SELECT COUNT(*) AS n FROM commitments WHERE kind = 'genesis' AND owner = ?",
    a.id.playerId,
  );
  // A commitment made is a creature; the ask may have arrived too late to make one.
  expect((await inFlight(a.id.playerId)).active !== null).toBe((made?.n ?? 0) > 0);
  return [a];
}

async function matingCase(step: string, cut: Cut, partner: boolean): Promise<Actor[]> {
  const [a, b] = await adults();
  const nonce = mateNonce();
  let round = 0;
  if (step === 'mate-check') {
    live(a).c.send({ t: 'mate-check', partner: b.id.playerId });
    expect((await nextOf(live(a).c, 'mate-info')).reason).toBeNull();
  } else {
    live(a).c.send({ t: 'court', ask: askOf(live(a), live(b), nonce) });
    await nextOf(live(b).c, 'invite');
  }
  if (step === 'accept' || step === 'round' || step === 'born') {
    live(b).c.send({ t: 'accept', ask: askOf(live(b), live(a), nonce) });
    round = (await nextOf(live(b).c, 'mating')).commit.commitment.round;
  }
  if (step === 'round' || step === 'born') await publish(round);
  if (step === 'born') await Promise.all([a, b].map((p) => nextOf(live(p).c, 'born')));
  await interrupt(cut, [partner ? b : a], [a, b]);
  await finishAll();
  const [row] = await sql<{ n: number }>(
    'SELECT COUNT(*) AS n FROM matings WHERE owner_a = ? AND owner_b = ?',
    a.id.playerId,
    b.id.playerId,
  );
  const mated = round > 0;
  expect(row?.n).toBe(mated ? 1 : 0);
  // Once mated, each holds its child once the round is out, whoever was away.
  for (const p of [a, b]) expect((await inFlight(p.id.playerId)).pending !== null).toBe(mated);
  return [a, b];
}

async function promoteCase(step: string, cut: Cut): Promise<Actor[]> {
  const [a, b, born] = await bred();
  const request = promoteRequest(live(a), born);
  live(a).c.send({ t: 'promote', request, sig: signed(a.id, request) });
  if (step === 'promoted') await nextOf(live(a).c, 'promoted');
  await interrupt(cut, [a], [a, b]);
  expect((await inFlight(a.id.playerId)).active).toBe(born.record.hash);
  const [frozen] = await sql<{ n: number }>(
    "SELECT COUNT(*) AS n FROM records WHERE creature = ? AND kind = 'promote'",
    a.creature,
  );
  expect(frozen?.n).toBe(1);
  await finishAll();
  return [a, b];
}

/** A's promoted child dies; the death's fallback names A's first creature, frozen. */
async function orphaned(): Promise<{ a: Actor; b: Actor; ancestor: Ancestor; child: string }> {
  const [a, b, born] = await bred();
  const request = promoteRequest(live(a), born);
  live(a).c.send({ t: 'promote', request, sig: signed(a.id, request) });
  await nextOf(live(a).c, 'promoted');
  live(a).c.send({ t: 'death', cause: 'toxin', ticks: 0 });
  const died = await nextOf(live(a).c, 'died');
  const ancestor = died.fallback?.ancestor;
  if (!ancestor) throw new Error('no ancestor to fall back on');
  return { a, b, ancestor, child: born.record.hash };
}

const restoreOf = (p: Actor, anc: Ancestor, from: string): RecordRequest => ({
  v: 1,
  rules: RULES_VERSION,
  kind: 'restore',
  creature: anc.creature,
  seq: anc.seq + 1,
  prev: anc.hash,
  owner: p.id.playerId,
  body: {
    from,
    activeMs: anc.activeMs,
    biomass: anc.biomass,
    energy: anc.energy,
    health: anc.health,
    cooldownUntilMs: anc.cooldownUntilMs,
  },
});

async function restoreCase(step: string, cut: Cut): Promise<Actor[]> {
  const { a, b, ancestor, child } = await orphaned();
  const request = restoreOf(a, ancestor, child);
  live(a).c.send({ t: 'restore', request, sig: signed(a.id, request) });
  if (step === 'restored') await nextOf(live(a).c, 'restored');
  await interrupt(cut, [a], [a, b]);
  expect((await inFlight(a.id.playerId)).active).toBe(ancestor.creature);
  await finishAll();
  return [a, b];
}

async function deathCase(step: string, cut: Cut): Promise<Actor[]> {
  const [a, b, born] = await bred();
  const request = promoteRequest(live(a), born);
  live(a).c.send({ t: 'promote', request, sig: signed(a.id, request) });
  await nextOf(live(a).c, 'promoted');
  live(a).c.send({ t: 'death', cause: 'starved', ticks: 0 });
  if (step === 'died') await nextOf(live(a).c, 'died');
  await interrupt(cut, [a], [a, b]);
  const { active } = await inFlight(a.id.playerId);
  expect(active).toBeNull();
  await finishAll();
  return [a, b];
}

async function fightCase(step: string, cut: Cut): Promise<Actor[]> {
  const a = await hatchling();
  const b = await hatchling();
  await advance(16_000);
  await calmPond(live(a), live(b));
  let closed = a;
  if (step === 'engage') engage(live(a), live(b));
  if (step === 'lock-ask') {
    engage(live(a), live(b));
    await nextOf(live(b).c, 'lock-ask');
    closed = b;
  }
  if (step === 'answer') {
    engage(live(a), live(b));
    await answer(live(a), live(b));
    await Promise.all([a, b].map((p) => nextOf(live(p).c, 'enc-start')));
  }
  if (step === 'batch') {
    const [start] = await lockIn(live(a), live(b));
    await play(live(a), live(b), start, () => [IDLE_CODE, IDLE_CODE], 12);
  }
  if (step === 'settle' || step === 'enc-end') {
    await killB(live(a), live(b));
    if (step === 'enc-end') closed = b;
  }
  await interrupt(cut, [closed], [a, b]);
  await finishAll();
  for (const p of [a, b])
    expect(await authority((o) => o.fights.playerLocked(p.id.playerId))).toBe(false);
  return [a, b];
}

async function closeCase(_step: string, cut: Cut): Promise<Actor[]> {
  const a = await hatchling();
  await playFor(a, 10_000);
  const [before] = await sql<{ seq: number }>('SELECT seq FROM creatures WHERE id = ?', a.creature);
  await interrupt(cut, [a], [a]);
  const [after] = await sql<{ seq: number }>('SELECT seq FROM creatures WHERE id = ?', a.creature);
  // A close leaves its report as a checkpoint; a restart (no handler runs) leaves the last record.
  expect(after?.seq).toBe((before?.seq ?? 0) + (cut === 'restart' ? 0 : 1));
  await finishAll();
  return [a];
}

const DRIVERS: Record<
  TransactionName,
  (step: string, cut: Cut, partner: boolean) => Promise<Actor[]>
> = {
  genesis: genesisCase,
  mating: matingCase,
  promote: promoteCase,
  restore: restoreCase,
  death: deathCase,
  fight: fightCase,
  close: closeCase,
};

describe('the kill matrix: every step survives a closed socket and a restart (M14 T3)', () => {
  for (const [name, steps] of Object.entries(CATALOGUE) as [
    TransactionName,
    typeof CATALOGUE.genesis,
  ][]) {
    for (const { step, atomic } of steps) {
      if (atomic) continue;
      for (const cut of CUTS) {
        const partners = name === 'mating' ? [false, true] : [false];
        for (const partner of partners) {
          heavyTest(`${name} ${step}, ${cut}${partner ? ', the partner' : ''}`, async () => {
            const players = await DRIVERS[name](step, cut, partner);
            await expectConsistent(players);
          });
        }
      }
    }
  }
});

describe('named cases (M14 T3)', () => {
  heavyTest(
    'a genesis closed after `commit` and signed in after its round: one creature, one hatch',
    async () => {
      const a = await newcomer();
      const { commit } = await (async () => {
        live(a).c.send(genesisRequest(a.id));
        return nextOf(live(a).c, 'commit');
      })();
      await closeOf(a);
      await publish(commit.commitment.round);
      const { life } = await signInAgain(a);
      expect(life.life?.creature).toBeDefined();
      const [n] = await sql<{ n: number }>(
        'SELECT COUNT(*) AS n FROM creatures WHERE owner = ?',
        a.id.playerId,
      );
      expect(n?.n).toBe(1);
      await expectHatches(a);
      await expectConsistent([a]);
    },
  );

  heavyTest(
    'a genesis closed after `commit` and signed in before its round: `commit` follows `life`, then `genesis`',
    async () => {
      const a = await newcomer();
      live(a).c.send(genesisRequest(a.id));
      const { commit } = await nextOf(live(a).c, 'commit');
      await closeOf(a);
      await advance(1000);
      const { life, after } = await signInAgain(a);
      expect(life.life).toBeNull();
      const again = after.find((m) => m.t === 'commit');
      expect(again && commitmentId(again.commit.commitment)).toBe(commitmentId(commit.commitment));
      await publish(commit.commitment.round);
      const g = await nextOf(live(a).c, 'genesis');
      expect(g.commit.commitment).toEqual(commit.commitment);
      await expectHatches(a);
      await expectConsistent([a]);
    },
  );

  heavyTest(
    'a mating whose courting player closed right after `accept`: both records once, `life.mating`, then `life.pending`',
    async () => {
      const [a, b] = await adults();
      const nonce = 'N'.repeat(22);
      live(a).c.send({ t: 'court', ask: askOf(live(a), live(b), nonce) });
      await nextOf(live(b).c, 'invite');
      live(b).c.send({ t: 'accept', ask: askOf(live(b), live(a), nonce) });
      const { commit } = await nextOf(live(b).c, 'mating');
      await closeOf(a);
      const id = commitmentId(commit.commitment);
      const before = await signInAgain(a);
      expect(before.life.mating).toEqual({
        commit: id,
        round: commit.commitment.round,
        partner: 'Tester',
      });
      expect(before.life.pending).toBeUndefined();
      const mates = await sql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM records WHERE kind = 'mate-commit' AND json_extract(json, '$.body.commit') = ?",
        id,
      );
      expect(mates[0]?.n).toBe(2);
      await closeOf(a);
      await publish(commit.commitment.round);
      const after = await signInAgain(a);
      expect(after.life.mating).toBeUndefined();
      expect(after.life.pending?.commit.commitment).toEqual(commit.commitment);
      await expectConsistent([a, b]);
    },
  );

  heavyTest(
    'the object rebuilt between a mating’s commitment and its round: both births, `born` or `pending`',
    async () => {
      const [a, b] = await adults();
      const nonce = 'R'.repeat(22);
      live(a).c.send({ t: 'court', ask: askOf(live(a), live(b), nonce) });
      await nextOf(live(b).c, 'invite');
      live(b).c.send({ t: 'accept', ask: askOf(live(b), live(a), nonce) });
      const { commit } = await nextOf(live(b).c, 'mating');
      await restart();
      for (const p of [a, b]) {
        const c = p.c;
        p.c = null;
        if (c) await c.closed;
      }
      // B is back before the round, A only after it.
      const back = await signInAgain(b);
      expect(back.life.mating?.commit).toBe(commitmentId(commit.commitment));
      await publish(commit.commitment.round);
      await nextOf(live(b).c, 'born');
      const late = await signInAgain(a);
      expect(late.life.pending?.commit.commitment).toEqual(commit.commitment);
      await expectConsistent([a, b]);
    },
  );

  heavyTest(
    'a promote whose answer was lost: the child active, the parent frozen once, the same request answered alike with nothing written',
    async () => {
      const [a, b, born] = await bred();
      const parent = a.creature;
      const request = promoteRequest(live(a), born);
      const sig = signed(a.id, request);
      live(a).c.send({ t: 'promote', request, sig });
      await closeOf(a);
      const { life } = await signInAgain(a);
      expect(life.life?.creature).toBe(born.record.hash);
      const frozen = await sql<{ hash: string }>(
        "SELECT hash FROM records WHERE creature = ? AND kind = 'promote'",
        parent,
      );
      expect(frozen).toHaveLength(1);
      const rows = await authority((o) => o.ledger.rowsWritten);
      live(a).c.send({ t: 'promote', request, sig });
      const again = await nextOf(live(a).c, 'promoted');
      expect(again.life.creature).toBe(born.record.hash);
      expect(again.parent?.hash).toBe(frozen[0]?.hash);
      expect(await authority((o) => o.ledger.rowsWritten)).toBe(rows);
      await expectConsistent([a, b]);
    },
  );

  heavyTest(
    'a death whose `died` was lost: the sign-in’s `life` carries the fallback',
    async () => {
      const [a, b, born] = await bred();
      const parent = a.creature;
      const request = promoteRequest(live(a), born);
      live(a).c.send({ t: 'promote', request, sig: signed(a.id, request) });
      await nextOf(live(a).c, 'promoted');
      live(a).c.send({ t: 'death', cause: 'starved', ticks: 0 });
      await closeOf(a);
      const { life } = await signInAgain(a);
      expect(life.life).toBeNull();
      expect(life.fallback?.ancestor?.creature).toBe(parent);
      await expectConsistent([a, b]);
    },
  );

  heavyTest(
    'a court whose courting socket closed: the partner’s `accept` is refused and nothing is written',
    async () => {
      const [a, b] = await adults();
      const nonce = 'C'.repeat(22);
      live(a).c.send({ t: 'court', ask: askOf(live(a), live(b), nonce) });
      await nextOf(live(b).c, 'invite');
      await closeOf(a);
      const rows = await authority((o) => o.ledger.rowsWritten);
      live(b).c.send({ t: 'accept', ask: askOf(live(b), a as Player, nonce) });
      expect((await nextOf(live(b).c, 'refused')).reason).toBe('no-court');
      // A back on a new socket holds no invitation either.
      await signInAgain(a);
      live(b).c.send({ t: 'accept', ask: askOf(live(b), live(a), nonce) });
      expect((await nextOf(live(b).c, 'refused')).reason).toBe('no-court');
      expect(await authority((o) => o.ledger.rowsWritten)).toBe(rows);
      const [n] = await sql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM commitments WHERE kind = 'mate' AND owner = ?",
        a.id.playerId,
      );
      expect(n?.n).toBe(0);
      await expectConsistent([a, b]);
    },
  );
});

describe('one transaction per step (M14 T3)', () => {
  heavyTest(
    'a genesis whose hatch could not be spent leaves no commitment, and the same ask then hatches',
    async () => {
      const a = await newcomer();
      const ask = genesisRequest(a.id);
      await authority((o) => {
        const take = o.ledger.takeHatch.bind(o.ledger);
        o.ledger.takeHatch = () => {
          o.ledger.takeHatch = take;
          throw new Error('evicted');
        };
      });
      live(a).c.send(ask);
      expect((await nextOf(live(a).c, 'error')).code).toBe('genesis-failed');
      const [none] = await sql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM commitments WHERE kind = 'genesis' AND owner = ?",
        a.id.playerId,
      );
      expect(none?.n).toBe(0);
      live(a).c.send(ask);
      const { commit } = await nextOf(live(a).c, 'commit');
      await publish(commit.commitment.round);
      await nextOf(live(a).c, 'genesis');
      await expectHatches(a);
      await expectConsistent([a]);
    },
  );

  heavyTest('a mating whose records could not be written leaves no commitment', async () => {
    const [a, b] = await adults();
    const nonce = 'M'.repeat(22);
    await authority((o) => {
      const mate = o.ledger.mate.bind(o.ledger);
      o.ledger.mate = () => {
        o.ledger.mate = mate;
        throw new Error('evicted');
      };
    });
    live(a).c.send({ t: 'court', ask: askOf(live(a), live(b), nonce) });
    await nextOf(live(b).c, 'invite');
    live(b).c.send({ t: 'accept', ask: askOf(live(b), live(a), nonce) });
    expect((await nextOf(live(b).c, 'error')).code).toBe('mate-failed');
    const [none] = await sql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM commitments WHERE kind = 'mate' AND owner = ?",
      a.id.playerId,
    );
    expect(none?.n).toBe(0);
    await expectConsistent([a, b]);
  });

  heavyTest(
    'a round fetched but not yet written stays due across a wake: the next alarm writes the creature and the births',
    async () => {
      const [a, b] = await adults();
      const g = await newcomer();
      live(g).c.send(genesisRequest(g.id));
      const genesis = (await nextOf(live(g).c, 'commit')).commit;
      const nonce = 'W'.repeat(22);
      live(a).c.send({ t: 'court', ask: askOf(live(a), live(b), nonce) });
      await nextOf(live(b).c, 'invite');
      live(b).c.send({ t: 'accept', ask: askOf(live(b), live(a), nonce) });
      const mate = (await nextOf(live(b).c, 'mating')).commit;
      for (const p of [g, a, b]) await closeOf(p);
      const ids = [genesis, mate].map((c) => commitmentId(c.commitment));
      const round = Math.max(genesis.commitment.round, mate.commitment.round);
      // The alarm's first part: the beacon service fetches the rounds; the object is gone before
      // anything is written.
      publishOnly(round);
      await authority((o) => o.beacons.alarm(resolvedOnFetch));
      await restart();
      const open = await sql<{ id: string }>(
        `SELECT id FROM commitments WHERE resolved IS NULL AND id IN (?, ?)`,
        ...ids,
      );
      expect(open.map((r) => r.id).sort()).toEqual([...ids].sort());
      // The new object's alarm finds them due and writes them, with nobody signed in.
      await publish(round);
      expect((await inFlight(g.id.playerId)).active).not.toBeNull();
      for (const p of [a, b]) expect((await inFlight(p.id.playerId)).pending).not.toBeNull();
      await expectConsistent([g, a, b]);
    },
  );
});
