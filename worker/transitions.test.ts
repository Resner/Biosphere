import { afterAll, beforeEach, describe, expect } from 'vitest';
import { genomeFromBase64url, genomeHash } from '../src/genome/codec';
import type { Identity } from '../src/ledger/identity';
import type { RecordRequest } from '../src/ledger/record';
import { aoiRadius } from '../src/net/aoi';
import { sameWater } from '../src/net/instance';
import {
  type Ancestor,
  type Born,
  genomeRefOf,
  type HubMsg,
  type WorldInfo,
} from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { RULES, RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import { heavyTest } from '../tests/heavy';
import { Crowds } from './crowds';
import { Directory, reachSince } from './directory';
import {
  advance,
  authority,
  clock,
  join,
  type Player,
  setEnv,
  snap,
  useFightHub,
} from './fight-test-kit';
import { RIDE_AFTER_FIGHT_MS } from './fights';
import type { LifeState } from './life';
import { askOf, promoteRequest, signed } from './lineage-test-kit';
import { activeSessions } from './socket';
import type { Anchor } from './spawn';
import { type Client, flush, genesisRequest, publish, report, sql } from './test-hub';
import { bindingOf, type WhereAt } from './where';

// M12 T10, the transitions property test: seeded runs of random steps over six sessions, through
// the real hub. Reports cross leaves and tiers and carry crowd lists; creatures leave and enter the
// water, ride, fight to the end on the fight kit's clock, court and mate, promote, restore, hatch
// and die; sessions close and sign in again. After every step the hub must hold one place and one
// state for each creature: one directory member and one instance each, fighters sharing water and
// keeping their instance, no spawn or ride for a locked creature (nor a ride within 120 s of its
// fight), heads moved only by life records, and every report it took within its anchor's bound.
// One run in three is a test world (`MATING_SCALE`, fixture mode, so matings come in seconds); it
// takes every jump, so only the other runs send dishonest ones.

useFightHub();

const RUNS = 30;
const STEPS = 80;
const ACTORS = 6;
/** A fixed world seed, as the spawn tests use: placement reads its depth and plumes. */
const SEED = '5'.repeat(64);
/** Commitments one run may publish: 600 recorded rounds, two or three each, shared by the 30 runs. */
const COMMITS_PER_RUN = 8;
/** What a starter's report says of its size, and the larger bodies a report may cross to. */
const RADII = [10, 10, 10, 30, 63];
const E = RULES.encounter;
/** The hub's rate window per session (`worker/authority.ts`): 20 messages each. */
const RATE_WINDOW_MS = 10_000;

beforeEach(async () => {
  await sql('UPDATE world SET seed = ?', SEED);
  await authority((o) => {
    // Small leaves, so a few members split and merge them.
    o.directory = new Directory(RULES.world.size, { leafMax: 2 });
    o.crowds = new Crowds();
    o.crowdTimer = null;
    o.crowdsKept.clear();
    o.spawns.length = 0;
  });
});

interface Actor {
  id: Identity;
  c: Client | null;
  pond: WorldInfo;
  born: Born | null;
  ancestor: Ancestor | null;
  /** Whether it plays a promoted child, whose death leaves its parent to restore. */
  promoted: boolean;
  /** The hub's rate window as this test mirrors it: its start and the messages sent in it. */
  win: number;
  sent: number;
}

/** A seated session as the hub holds it. */
interface Seat {
  life?: LifeState | undefined;
  where?: WhereAt | undefined;
  anchor?: Anchor | undefined;
  crowd?: { id: number; n: number } | undefined;
  ref: number;
}

/** What the invariants read of the hub after a step, in one call. */
interface View {
  seats: Map<string, Seat>;
  members: Map<string, { x: number; y: number }>;
  instance: Map<string, number>;
  fights: { enc: string; players: string[] }[];
  locked: Set<string>;
  heads: Map<string, string>;
  records: number;
  rows: number;
  flags: number;
}

function view(players: readonly string[]): Promise<View> {
  return authority((o) => {
    const seats = new Map<string, Seat>();
    for (const [, s] of activeSessions(o)) {
      const head = s.life ? o.ledger.head(s.life.creature) : null;
      const genome = head ? genomeFromBase64url(head.genome) : null;
      const ref = genome ? genomeRefOf(genomeHash(genome)) : 0;
      seats.set(s.playerId, {
        life: s.life,
        where: s.where,
        anchor: s.anchor,
        crowd: s.crowd,
        ref,
      });
    }
    const members = new Map<string, { x: number; y: number }>();
    let inTree = 0;
    for (const leaf of o.directory.leaves()) inTree += leaf.members;
    for (const p of players) {
      const m = o.directory.member(p);
      if (m) members.set(p, { x: m.x, y: m.y });
    }
    expect(inTree, 'the directory holds only these players').toBe(members.size);
    const sql = o.ctx.storage.sql;
    const heads = new Map(
      sql
        .exec<{ id: string; seq: number; hash: string }>('SELECT id, seq, hash FROM creatures')
        .toArray()
        .map((r) => [r.id, `${r.seq}:${r.hash}`]),
    );
    const one = (q: string) => sql.exec<{ n: number }>(q).one().n;
    return {
      seats,
      members,
      instance: new Map(players.map((p) => [p, o.crowds.instanceOf(p)])),
      fights: o.fights.running().map((l) => ({ enc: l.fight?.enc.id ?? l.id, players: l.players })),
      locked: new Set(players.filter((p) => o.fights.playerLocked(p))),
      heads,
      records: one('SELECT COUNT(*) AS n FROM records'),
      rows: o.ledger.rowsWritten - o.fightStore.rowsWritten,
      flags: one('SELECT COUNT(*) AS n FROM flags'),
    };
  });
}

/** What the run saw, summed over every run: each kind of transition must have happened. */
const seen: Record<string, number> = {};
const tally = (what: string) => {
  seen[what] = (seen[what] ?? 0) + 1;
};

/** The transitions the runs must cover between them (the hub places by a random draw, so counts vary). */
const COVERED = [
  'spawn placed',
  'spawn back',
  'report',
  'instance',
  'lock-ask',
  'fight',
  'mating',
  'promote',
  'death',
  'close',
  'sign-in',
];
let runsDone = 0;

type Kind = 'quiet' | 'close' | 'other';

class Run {
  readonly actors: Actor[] = [];
  readonly violations: string[] = [];
  /** Each fighter's instance when first seen connected in its fight: it must keep it. */
  private readonly fightWater = new Map<string, number>();
  /** The rows one checkpoint writes, once a progress step has shown it. */
  private checkpointRows: number | null = null;
  private commits = COMMITS_PER_RUN;
  v!: View;

  constructor(
    readonly rng: Rng,
    readonly testWorld: boolean,
  ) {}

  get ids(): string[] {
    return this.actors.map((a) => a.id.playerId);
  }

  fail(step: number, what: string): void {
    this.violations.push(`step ${step}: ${what}`);
  }

  pick<T>(xs: readonly T[]): T | undefined {
    return xs.length === 0 ? undefined : xs[this.rng.int(0, xs.length - 1)];
  }

  seat(a: Actor): Seat | undefined {
    return a.c ? this.v.seats.get(a.id.playerId) : undefined;
  }

  /** The actor as the fight kit's helpers take it. */
  player(a: Actor): Player {
    const s = this.seat(a);
    return {
      c: a.c as Client,
      id: a.id,
      pond: a.pond,
      creature: s?.life?.creature ?? '',
      ref: s?.ref ?? 0,
      ticks: 0,
    };
  }

  /** Where the creature is now: its anchor when the hub set one since its last report, else that report. */
  base(s: Seat): { x: number; y: number; t: number } | undefined {
    const bind = bindingOf(s.life);
    const { anchor, where } = s;
    if (anchor?.bind === bind && (where?.bind !== bind || anchor.t >= where.t)) return anchor;
    return where;
  }

  /** Counts `n` messages in the actor's rate window, as the hub does (20 per 10 s). */
  spend(a: Actor, n: number): void {
    if (clock.t - a.win >= RATE_WINDOW_MS) [a.win, a.sent] = [clock.t, 0];
    a.sent += n;
  }

  /** Waits out every rate window that a step's messages could fill, before the step's view. */
  async rest(): Promise<void> {
    const busy = this.actors.filter((a) => clock.t - a.win < RATE_WINDOW_MS && a.sent > 10);
    if (busy.length === 0) return;
    await advance(RATE_WINDOW_MS);
    for (const x of this.actors) await this.drain(x);
  }

  /** Sends one message and flushes the socket (two messages), taking in what came. */
  async say(a: Actor, msg: unknown): Promise<HubMsg[]> {
    const c = a.c as Client;
    this.spend(a, 2);
    c.send(msg);
    const got = await flush(c);
    this.absorb(a, got);
    return got;
  }

  /** Flushes the socket (one message) and takes in what came. */
  async drain(a: Actor): Promise<HubMsg[]> {
    if (!a.c) return [];
    this.spend(a, 1);
    const got = await flush(a.c);
    this.absorb(a, got);
    return got;
  }

  absorb(a: Actor, msgs: readonly HubMsg[]): void {
    for (const m of msgs) {
      if (m.t === 'born') a.born = m;
      else if (m.t === 'promoted') a.born = null;
      else if (m.t === 'life' && m.pending) a.born = m.pending;
      else if (m.t === 'died') a.ancestor = m.fallback?.ancestor ?? null;
      else if (m.t === 'restored') a.ancestor = null;
    }
  }

  async commit(round: number): Promise<boolean> {
    if (this.commits <= 0) return false;
    this.commits--;
    await publish(round);
    return true;
  }

  // The steps. Each returns what it may write: nothing, a close's checkpoint and place, or more.

  async reportStep(step: number, a: Actor, s: Seat): Promise<Kind> {
    const from = this.base(s);
    if (!from) return 'quiet';
    const p = a.id.playerId;
    const r = this.pick(RADII) ?? 10;
    const cheat = !this.testWorld && this.rng.next() < 0.1;
    const reach = cheat ? 4000 + 4000 * this.rng.next() : 1500 * this.rng.next();
    const angle = this.rng.next() * 2 * Math.PI;
    const x = from.x + reach * Math.cos(angle);
    const y = from.y + reach * Math.sin(angle);
    const others = this.ids.filter((id) => id !== p && this.rng.next() < 0.4);
    const crowd = this.rng.next() < 0.3 && others.length > 0 ? { crowd: others.slice(0, 3) } : {};
    await this.say(a, { t: 'where', x, y, r, aoi: aoiRadius(r, Math.max(r, 20)), ...crowd });
    const after = (await view(this.ids)).seats.get(p)?.where;
    if (!after || after.t === s.where?.t) return 'quiet';
    tally(cheat ? 'far report taken' : 'report');
    // Taken: within its anchor's bound when it is the first since the anchor, else the jump bound.
    const bind = bindingOf(s.life);
    const { anchor, where } = s;
    const first = where?.bind !== bind || (anchor?.bind === bind && where.t <= anchor.t);
    const dist = (b: { x: number; y: number }) => Math.hypot(after.x - b.x, after.y - b.y);
    if (first && anchor?.bind !== bind && !this.testWorld)
      this.fail(step, `${p} taken with no anchor`);
    else if (first && anchor?.bind === bind && dist(anchor) > reachSince(after.t - anchor.t))
      this.fail(step, `${p} taken ${dist(anchor).toFixed(0)} wu from its anchor`);
    else if (!first && where && !this.testWorld && dist(where) > reachSince(after.t - where.t))
      this.fail(step, `${p} taken past the jump bound`);
    return 'quiet';
  }

  async progressStep(a: Actor, s: Seat): Promise<Kind> {
    const life = s.life;
    if (!life || life.over) return 'other';
    const before = this.v;
    this.spend(a, 2);
    report(a.c as Client, Math.floor(((clock.t - life.startT) * TICK_HZ) / 1000));
    this.absorb(a, await flush(a.c as Client));
    const after = await view(this.ids);
    if (after.records === before.records + 1) this.checkpointRows = after.rows - before.rows;
    return 'other';
  }

  async spawnStep(step: number, a: Actor): Promise<Kind> {
    const p = a.id.playerId;
    const locked = this.v.locked.has(p);
    const got = await this.say(a, { t: 'spawn', r: 10, aoi: 233 });
    const answer = got.find((m) => m.t === 'spawn');
    if (answer) tally(`spawn ${answer.why}`);
    if (answer && locked) this.fail(step, `${p} granted a spawn while locked`);
    return 'quiet';
  }

  async rideStep(step: number, a: Actor): Promise<Kind> {
    const p = a.id.playerId;
    this.spend(a, 2);
    const [locked, ended] = await authority((o) => [
      o.fights.playerLocked(p),
      o.fights.fightEnded(p, RIDE_AFTER_FIGHT_MS),
    ]);
    a.c?.send({ t: 'ride' });
    const got = await flush(a.c as Client);
    this.absorb(a, got);
    const answer = got.find((m) => m.t === 'spawn' || m.t === 'ride-no');
    tally(answer?.t === 'spawn' ? 'ride' : `ride-no ${answer?.t === 'ride-no' ? answer.why : '?'}`);
    if (answer?.t === 'spawn' && locked) this.fail(step, `${p} rode while locked`);
    if (answer?.t === 'spawn' && ended !== null)
      this.fail(step, `${p} rode within 120 s of a fight`);
    return 'quiet';
  }

  async engageStep(a: Actor, b: Actor): Promise<Kind> {
    const [sa, sb] = [this.seat(a), this.seat(b)];
    const [fa, fb] = [sa && this.base(sa), sb && this.base(sb)];
    if (!sa?.life || !sb?.life || !fa || !fb) return 'other';
    if (Math.hypot(fa.x - fb.x, fa.y - fb.y) > 1500) return 'other';
    // B swims beside A, then A engages.
    const r = Math.sqrt(sb.life.biomass / 100);
    await this.say(b, { t: 'where', x: fa.x + 12, y: fa.y, r, aoi: aoiRadius(r, Math.max(r, 20)) });
    const [pa, pb] = [this.player(a), this.player(b)];
    const mine = snap(pa, fa.x, fa.y, { biomass: sa.life.biomass / 100 });
    const theirs = snap(pb, fa.x + 12, fa.y, { biomass: sb.life.biomass / 100 });
    const said = await this.say(a, { t: 'engage', target: b.id.playerId, mine, theirs });
    const ask = (await this.drain(b)).find((m) => m.t === 'lock-ask');
    const no = said.find((m) => m.t === 'refused');
    tally(ask ? 'lock-ask' : `engage ${no?.t === 'refused' ? no.reason : '?'}`);
    if (ask && this.rng.next() < 0.7)
      await this.say(b, { t: 'lock-state', lock: ask.lock, mine: theirs, seen: [mine] });
    return 'other';
  }

  async courtStep(a: Actor, b: Actor): Promise<Kind> {
    const [sa, sb] = [this.seat(a), this.seat(b)];
    if (!sa?.life || !sb?.life || sa.life.over || sb.life.over) return 'other';
    for (const [x, s] of [
      [a, sa],
      [b, sb],
    ] as const)
      await this.progressStep(x, s);
    const [pa, pb] = [this.player(a), this.player(b)];
    const nonce = `${this.rng.int(0, 1e9)}`.padStart(22, 'A');
    const asked = await this.say(a, { t: 'court', ask: askOf(pa, pb, nonce) });
    const invite = (await this.drain(b)).find((m) => m.t === 'invite');
    if (!invite) {
      const no = asked.find((m) => m.t === 'refused');
      tally(`court ${no?.t === 'refused' ? no.reason : 'unanswered'}`);
      return 'other';
    }
    await this.say(b, { t: 'accept', ask: askOf(pb, pa, nonce) });
    const mating = (await this.drain(a)).find((m) => m.t === 'mating');
    if (!mating) return 'other';
    tally('mating');
    if (await this.commit(mating.commit.commitment.round)) {
      await this.drain(a);
      await this.drain(b);
    }
    return 'other';
  }

  async promoteStep(a: Actor, s: Seat): Promise<Kind> {
    const born = a.born;
    if (!born || !s.life) return 'other';
    const request = promoteRequest(this.player(a), born, s.life.creature);
    const got = await this.say(a, { t: 'promote', request, sig: signed(a.id, request) });
    if (got.some((m) => m.t === 'promoted')) {
      tally('promote');
      a.promoted = true;
    }
    return 'other';
  }

  async restoreStep(a: Actor, s: Seat): Promise<Kind> {
    const anc = a.ancestor;
    if (!anc || !s.life) return 'other';
    const request: RecordRequest = {
      v: 1,
      rules: RULES_VERSION,
      kind: 'restore',
      creature: anc.creature,
      seq: anc.seq + 1,
      prev: anc.hash,
      owner: a.id.playerId,
      body: {
        from: s.life.creature,
        activeMs: anc.activeMs,
        biomass: anc.biomass,
        energy: anc.energy,
        health: anc.health,
        cooldownUntilMs: anc.cooldownUntilMs,
      },
    };
    const got = await this.say(a, { t: 'restore', request, sig: signed(a.id, request) });
    if (got.some((m) => m.t === 'restored')) tally('restore');
    return 'other';
  }

  async deathStep(a: Actor): Promise<Kind> {
    const got = await this.say(a, { t: 'death', cause: 'toxin', ticks: 0 });
    if (got.some((m) => m.t === 'died')) tally('death');
    a.promoted = false;
    return 'other';
  }

  async genesisStep(a: Actor): Promise<Kind> {
    const got = await this.say(a, genesisRequest(a.id));
    const commit = got.find((m) => m.t === 'commit');
    if (commit && (await this.commit(commit.commit.commitment.round))) {
      if ((await this.drain(a)).some((m) => m.t === 'genesis')) tally('genesis');
    }
    return 'other';
  }

  async signIn(a: Actor): Promise<void> {
    const { c, pond, life } = await join(a.id);
    Object.assign(a, { c, pond, win: clock.t, sent: 1 });
    this.absorb(a, [life]);
  }

  /** One random step for one actor (or two). */
  async step(step: number): Promise<Kind> {
    const a = this.pick(this.actors) as Actor;
    const s = this.seat(a);
    if (!a.c) {
      await this.signIn(a);
      tally('sign-in');
      return 'other';
    }
    const roll = this.rng.next();
    const live = s?.life && !s.life.over;
    // A pending child is promoted, and a creature with only an ancestor left restores it, soon.
    if (s && a.born && this.rng.next() < 0.5) return this.promoteStep(a, s);
    if (s && !live && a.ancestor && this.rng.next() < 0.6) return this.restoreStep(a, s);
    if (live && a.promoted && this.rng.next() < 0.3) return this.deathStep(a);
    if (roll < 0.3)
      return s && (s.where || s.anchor) ? this.reportStep(step, a, s) : this.spawnStep(step, a);
    if (roll < 0.36) {
      await this.say(a, { t: 'gone' });
      return 'quiet';
    }
    if (roll < 0.42) return this.spawnStep(step, a);
    if (roll < 0.47) return this.rideStep(step, a);
    if (roll < 0.52) return s ? this.progressStep(a, s) : 'other';
    if (roll < 0.62) {
      const b = this.pick(this.actors.filter((x) => x !== a && x.c));
      return b ? this.engageStep(a, b) : 'other';
    }
    if (roll < 0.68) {
      // A fight runs to its end (or a lock's window closes), with the world going on meanwhile.
      await advance(E.lockAnswerMs + E.timeoutFrames * FRAME_MS + 2000);
      for (const x of this.actors) await this.drain(x);
      return 'other';
    }
    if (roll < (this.testWorld ? 0.78 : 0.7)) {
      const b = this.pick(this.actors.filter((x) => x !== a && x.c));
      return b ? this.courtStep(a, b) : 'other';
    }
    if (roll < 0.8) return s && a.born ? this.promoteStep(a, s) : this.genesisStep(a);
    if (roll < 0.83 && live) return this.deathStep(a);
    if (roll < 0.86) return s && a.ancestor ? this.restoreStep(a, s) : this.genesisStep(a);
    if (roll < 0.91) {
      tally('close');
      a.c.ws.close(1000, 'reload');
      await a.c.closed;
      a.c = null;
      return 'close';
    }
    await advance(this.pick([500, 2000, 5000, 20_000, 125_000, 11 * 60_000]) ?? 500);
    for (const x of this.actors) await this.drain(x);
    return 'other';
  }

  /** The invariants after a step of `kind`, from the views before and after it. */
  check(step: number, kind: Kind, before: View, after: View): void {
    const ids = this.ids;
    // One place and one instance for every creature in the water.
    for (const p of ids) {
      const s = after.seats.get(p);
      const m = after.members.get(p);
      if (s?.where && (m?.x !== s.where.x || m.y !== s.where.y))
        this.fail(step, `${p} in the water but not in the directory where it reported`);
      if (!s?.where && m) this.fail(step, `${p} in the directory out of the water`);
      if (s?.where && (s.crowd?.n ?? 0) !== after.instance.get(p))
        this.fail(
          step,
          `${p} hears instance ${s.crowd?.n ?? 0}, the hub holds ${after.instance.get(p)}`,
        );
    }
    // Fighters share water, and a connected one keeps its instance through its fight.
    for (const f of after.fights) {
      tally('fight');
      for (const p of f.players)
        for (const q of f.players)
          if (!sameWater(after.instance.get(p) ?? 0, after.instance.get(q) ?? 0))
            this.fail(step, `fighters ${p} and ${q} don't share water`);
      for (const p of f.players) {
        if (!after.seats.has(p)) continue;
        const key = `${f.enc}|${p}`;
        const n = after.instance.get(p) ?? 0;
        const was = this.fightWater.get(key);
        if (was === undefined) this.fightWater.set(key, n);
        else if (was !== n) this.fail(step, `fighter ${p} moved from instance ${was} to ${n}`);
      }
    }
    if (after.instance.size > 0 && [...after.instance.values()].some((n) => n !== 0))
      tally('instance');
    // Heads move only through life records.
    const moved = [...after.heads].filter(([id, h]) => before.heads.get(id) !== h);
    const newRecords = after.records - before.records;
    if (kind === 'quiet') {
      if (moved.length > 0 || newRecords !== 0)
        this.fail(step, 'a report, spawn or ride wrote a record');
      if (after.rows - before.rows !== after.flags - before.flags)
        this.fail(step, `a report, spawn or ride wrote ${after.rows - before.rows} rows`);
    }
    if (kind === 'close') {
      if (newRecords > 1 || moved.length > newRecords) this.fail(step, 'a close moved a head');
      const allowed = 1 + newRecords * (this.checkpointRows ?? Number.POSITIVE_INFINITY);
      if (after.rows - before.rows > allowed)
        this.fail(step, `a close wrote ${after.rows - before.rows} rows`);
    }
    if (newRecords < moved.length) this.fail(step, 'a head moved with no record');
  }

  async play(): Promise<void> {
    for (let i = 0; i < ACTORS; i++) {
      const { c, id, pond, life } = await join();
      const a: Actor = {
        id,
        c,
        pond,
        born: null,
        ancestor: null,
        promoted: false,
        win: clock.t,
        sent: 1,
      };
      this.actors.push(a);
      this.absorb(a, [life]);
      // Four hatch at once; the others start as practice cells, until a genesis step.
      if (i < 4) await this.genesisStep(a);
    }
    this.v = await view(this.ids);
    for (let step = 0; step < STEPS; step++) {
      for (const x of this.actors) if (x.c) this.absorb(x, x.c.inbox.splice(0));
      await this.rest();
      this.v = await view(this.ids);
      const before = this.v;
      const kind = await this.step(step);
      this.v = await view(this.ids);
      this.check(step, kind, before, this.v);
      await advance(this.rng.int(200, 1500));
    }
  }
}

describe('transitions keep one place and one state (M12 T10)', () => {
  for (let seed = 0; seed < RUNS; seed++) {
    heavyTest(`run ${seed}`, async () => {
      const testWorld = seed % 3 === 0;
      if (testWorld) await setEnv(true);
      const run = new Run(createRng(seedFromString(`transitions-${seed}`), 'steps'), testWorld);
      await run.play();
      expect(run.violations).toEqual([]);
      runsDone++;
    });
  }

  afterAll(() => {
    console.info('transitions seen', seen);
    // Once every run has played: each kind of transition happened somewhere in them.
    if (runsDone < RUNS) return;
    for (const kind of COVERED) expect(seen[kind] ?? 0, kind).toBeGreaterThan(0);
  });
});
