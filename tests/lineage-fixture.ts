// The honest history every verifier test tampers with (M9 T3): an authority in Node with a fixed
// key, two players and the recorded drand rounds of `tests/fixtures/drand/`. It writes every record
// kind as the hub would, every value from the rulebook's functions (`src/ledger/gates.ts`) under
// the scales it is given:
// - two genesis creatures, A0 (player A) and B0 (player B), with checkpoints;
// - their mating, two births A1 and B1, and A promoting to A1 (A0 frozen);
// - a fight in which A1 kills B0 (the pond seed is picked so it does), eating the egg B0 carries,
//   so B1 dies `eaten` in the same settlement;
// - A1 dying of a toxin, and A restoring A0.
// `bundleOf` serves a subject's proof as `GET /v1/proof` does: its whole chain, and each ancestor's
// up to the record that ties it to its descendant.

import { readFileSync } from 'node:fs';
import { type Genome, genomeHash, genomeToBase64url } from '../src/genome/codec';
import { offspringPair } from '../src/genome/offspring';
import { buildCreature } from '../src/genome/stats';
import { genesisAskMessage } from '../src/ledger/ask';
import { type Canonical, canonicalize, hashWithDomain } from '../src/ledger/canonical';
import { type Beacon, randomnessOf, roundAt, roundTime } from '../src/ledger/drand';
import { encounterId, encounterSeed } from '../src/ledger/encounter';
import {
  type Condition,
  cooldownOf,
  growthReach,
  LIVE_SCALES,
  lifespanOf,
  matureAtOf,
  paidFor,
  type Scales,
  startOf,
  vitalsCap,
} from '../src/ledger/gates';
import { type Commitment, commitmentId, genesisFor, genesisRequest } from '../src/ledger/genesis';
import {
  type Identity,
  playerIdOf,
  publicKeyFromSecret,
  signWithSecret,
  toBase64Url,
} from '../src/ledger/identity';
import { birthRequest, type MateAsk, signMateAsk } from '../src/ledger/mating';
import type { AuthorityKey, ProofBundle } from '../src/ledger/proof';
import {
  authorityKeyId,
  authorityPublicKey,
  authoritySign,
  type LedgerRecord,
  REQUEST_DOMAIN,
  type RecordRequest,
  recordHash,
  requestMessage,
  type StoredRecord,
} from '../src/ledger/record';
import { REGISTRY } from '../src/ledger/registry';
import { type FightLog, type SignedSettlement, signSettlement } from '../src/ledger/settlement';
import type { EncStart } from '../src/net/encounter-start';
import { encounterStartOf } from '../src/net/encounter-start';
import { settlementOf } from '../src/net/encounter-verify';
import type { FighterInfo, SignedCommit } from '../src/net/protocol-defs';
import { FRAME_MS } from '../src/net/referee';
import { createEncounter, results, stepFrame } from '../src/sim/encounter/encounter';
import type { Encounter } from '../src/sim/encounter/types';
import { RULES, RULES_VERSION } from '../src/sim/rules';

const ROUNDS = JSON.parse(
  readFileSync(new URL('./fixtures/drand/rounds.json', import.meta.url), 'utf8'),
) as { first: number; last: number; beacons: Beacon[] };
const BEACONS = new Map(ROUNDS.beacons.map((b) => [b.round, b]));

export const AUTH_SECRET = new Uint8Array(32).fill(0x7a);
const AUTH_PUBLIC = authorityPublicKey(AUTH_SECRET);
/** The fixture's authority key, in force from an hour before the first recorded round. */
export const FIXTURE_KEY: AuthorityKey = {
  id: authorityKeyId(AUTH_PUBLIC),
  publicKey: AUTH_PUBLIC,
  from: roundTime(ROUNDS.first) - 3_600_000,
};
export const OWNER_SECRETS = { A: new Uint8Array(32).fill(0xa1), B: new Uint8Array(32).fill(0xb2) };
export const PLAYERS = {
  A: playerIdOf(publicKeyFromSecret(OWNER_SECRETS.A)),
  B: playerIdOf(publicKeyFromSecret(OWNER_SECRETS.B)),
};
/**
 * The free choices of the history, picked by trying values so that A1 kills B0: the genesis asks'
 * nonces (and so both genomes), the pond, and A1's size at its checkpoint as a share of its adult
 * size.
 */
export interface FixtureTune {
  nonces: [string, string];
  pondSeed: string;
  a1Size: number;
}
export const TUNE: FixtureTune = {
  nonces: [`A0${'A'.repeat(20)}`, `B1${'B'.repeat(20)}`],
  pondSeed: 'lineage-0',
  a1Size: 0.5,
};

function beaconAt(round: number): Beacon {
  const b = BEACONS.get(round);
  if (!b) throw new Error(`round ${round} is not recorded`);
  return b;
}

const identity = (secret: Uint8Array): Identity => ({
  playerId: playerIdOf(publicKeyFromSecret(secret)),
  sign: (domain, message) => signWithSecret(secret, domain, message),
  exportRecoveryCode: () => {
    throw new Error('not in a fixture');
  },
});

/** A record as the authority stores it: hashed and countersigned, and signed by `owner` when the owner started it. */
export function store(record: LedgerRecord, owner: Uint8Array | null = null): StoredRecord {
  const hash = recordHash(record);
  return {
    record,
    hash,
    ownerSig: owner
      ? toBase64Url(signWithSecret(owner, REQUEST_DOMAIN, requestMessage(record)))
      : null,
    authSig: authoritySign(AUTH_SECRET, hash),
    keyId: FIXTURE_KEY.id,
  };
}

/** A changed record stored again: its hash, countersignature and (when it had one) owner signature redone. */
export function resign(s: StoredRecord, record: LedgerRecord): StoredRecord {
  const owner = record.owner === PLAYERS.A ? OWNER_SECRETS.A : OWNER_SECRETS.B;
  return store(record, s.ownerSig === null ? null : owner);
}

/** A commitment as the beacon service makes it (`worker/beacons.ts`): countersigned over its id. */
export function commit(
  kind: string,
  owner: string,
  data: Canonical,
  round: number,
  t: number,
): SignedCommit {
  const req = hashWithDomain(REQUEST_DOMAIN, canonicalize({ kind, owner, data }));
  const commitment: Commitment = { v: 1, kind, owner, round, req, t, data };
  return {
    commitment,
    authSig: authoritySign(AUTH_SECRET, commitmentId(commitment)),
    keyId: FIXTURE_KEY.id,
  };
}

/** The whole history: every creature's chain and every document they name. */
export interface LineageHistory {
  scales: Scales;
  ids: { A0: string; B0: string; A1: string; B1: string };
  genomes: Map<string, string>;
  chains: Map<string, StoredRecord[]>;
  commits: Map<string, SignedCommit>;
  beacons: Map<number, Beacon>;
  settlements: Map<string, SignedSettlement>;
  logs: Map<string, FightLog>;
  /** When the history ends. */
  t: number;
}

/** One creature as the hub holds it: its chain and the condition and clock of its head. */
class Life {
  readonly chain: StoredRecord[] = [];
  condition: Condition;
  activeMs = 0;
  cooldownUntilMs = 0;
  constructor(
    readonly genome: Genome,
    readonly owner: string,
    first: StoredRecord,
  ) {
    this.chain.push(first);
    this.condition = startOf(first.record.kind === 'genesis' ? 'genesis' : 'birth', genome);
  }
  get id(): string {
    return this.chain[0]?.hash as string;
  }
  get head(): StoredRecord {
    return this.chain[this.chain.length - 1] as StoredRecord;
  }
  get generation(): number {
    return this.chain[0]?.record.body.generation as number;
  }
  /** The record that follows the head, as `Ledger` writes it. */
  next(kind: LedgerRecord['kind'], t: number, body: LedgerRecord['body']): LedgerRecord {
    const head = this.head;
    return {
      v: 1,
      rules: RULES_VERSION,
      kind,
      creature: this.id,
      seq: head.record.seq + 1,
      prev: head.hash,
      owner: this.owner,
      t,
      body,
    };
  }
  append(kind: LedgerRecord['kind'], t: number, body: LedgerRecord['body'], owner?: Uint8Array) {
    const s = store(this.next(kind, t, body), owner ?? null);
    this.chain.push(s);
    return s;
  }
  /** A checkpoint at `t` with `activeMs`, grown toward `target` hundredths as far as the reach allows, full of energy and health. */
  checkpoint(t: number, activeMs: number, target: number): StoredRecord {
    const reach = growthReach(this.condition.biomass, this.genome, activeMs - this.activeMs);
    const biomass = Math.max(this.condition.biomass, Math.min(target, reach - 1));
    this.condition = { biomass, ...vitalsCap(biomass) };
    this.activeMs = activeMs;
    return this.append('checkpoint', t, { activeMs, ...this.condition });
  }
  /** The condition, clock and cooldown a freeze and a restore keep. */
  frozen(): LedgerRecord['body'] {
    return { activeMs: this.activeMs, ...this.condition, cooldownUntilMs: this.cooldownUntilMs };
  }
}

/** Genesis at round `round` for `secret`'s player: the commitment just before the round, the record just after. */
function genesis(secret: Uint8Array, nonce: string, round: number, out: LineageHistory): Life {
  const owner = playerIdOf(publicKeyFromSecret(secret));
  const ask = {
    nonce,
    sig: toBase64Url(signWithSecret(secret, REQUEST_DOMAIN, genesisAskMessage(owner, nonce))),
  };
  // The commitment names `latest + 2`: the round two after the newest one published.
  const c = commit('genesis', owner, ask, round, roundTime(round - 2) + 1000);
  const id = commitmentId(c.commitment);
  out.commits.set(id, c);
  out.beacons.set(round, beaconAt(round));
  const genome = genesisFor(randomnessOf(beaconAt(round)), id);
  const request = genesisRequest(RULES_VERSION, c.commitment, genome);
  const life = new Life(genome, owner, store({ ...request, t: roundTime(round) + 1000 }));
  out.genomes.set(life.id, genomeToBase64url(genome));
  out.chains.set(life.id, life.chain);
  return life;
}

/**
 * The time a genesis cell needs to grow to three quarters of its adult size within the reach: the
 * mating waits for it under scales whose maturity comes sooner, so every scale fights the same fight.
 */
const GROWN_MS = 100_000;

/** A creature's adult size in hundredths: what it grows toward. */
const adultOf = (genome: Genome): number => Math.floor(buildCreature(genome).phys.maxBiomass * 100);

/** The `FighterInfo` of a creature at lock-in, as `engage.ts` sends it. */
function fighterOf(
  life: Life,
  clock: number,
  scales: Scales,
  x: number,
  heading: number,
  egg: boolean,
): FighterInfo {
  return {
    player: life.owner,
    creature: life.id,
    genome: genomeToBase64url(life.genome),
    x,
    y: 2048,
    vx: 0,
    vy: 0,
    heading,
    biomass: life.condition.biomass / 100,
    energy: life.condition.energy / 100,
    health: life.condition.health / 100,
    elder: clock >= RULES.life.elderAt * lifespanOf(life.genome, scales),
    egg,
    worth: 1,
  };
}

/** A fight played to its end on the autopilot (no inputs), as the fixture fights it. */
export function play(log: Omit<FightLog, 'frames'>): { log: FightLog; enc: Encounter } {
  const start = encounterStartOf(log.start, log.pondSeed);
  if (!start) throw new Error('the fixture fight does not build');
  const enc = createEncounter(start);
  const frames: (number | null)[][] = [];
  while (!enc.over) {
    const row = enc.fighters.map(() => null);
    frames.push(row);
    stepFrame(enc, row);
  }
  return { log: { ...log, frames }, enc };
}

/** The honest history under `scales` (production's by default). */
export function lineageHistory(
  scales: Scales = LIVE_SCALES,
  tune: FixtureTune = TUNE,
): LineageHistory {
  const { pondSeed } = tune;
  const out: LineageHistory = {
    scales,
    ids: { A0: '', B0: '', A1: '', B1: '' },
    genomes: new Map(),
    chains: new Map(),
    commits: new Map(),
    beacons: new Map(),
    settlements: new Map(),
    logs: new Map(),
    t: 0,
  };
  const first = ROUNDS.first;
  const a0 = genesis(OWNER_SECRETS.A, tune.nonces[0], first + 2, out);
  const b0 = genesis(OWNER_SECRETS.B, tune.nonces[1], first + 4, out);
  const bornA = a0.head.record.t;
  const bornB = b0.head.record.t;

  // Both grow until both are mature and have had the time to reach their size, then mate.
  const mature = Math.max(
    bornA + matureAtOf(a0.genome, scales),
    bornB + matureAtOf(b0.genome, scales),
    bornB + GROWN_MS,
  );
  const mateAt = mature + 30_000;
  for (const [life, born] of [
    [a0, bornA],
    [b0, bornB],
  ] as const) {
    const half = born + Math.floor((mateAt - born) / 2);
    life.checkpoint(half, half - born, Math.floor(adultOf(life.genome) * 0.375));
    life.checkpoint(
      mateAt - 10_000,
      mateAt - 10_000 - born,
      Math.floor(adultOf(life.genome) * 0.75),
    );
  }

  // The mating: two signed asks, a commitment to the round after next, both `mate-commit`s.
  const nonce = 'M'.repeat(22);
  const askOf = (self: Life, other: Life, secret: Uint8Array): MateAsk =>
    signMateAsk(identity(secret), {
      creature: self.id,
      partner: other.owner,
      partnerCreature: other.id,
      nonce,
    });
  const mateRound = roundAt(mateAt) + 2;
  const mc = commit(
    'mate',
    a0.owner,
    {
      a: askOf(a0, b0, OWNER_SECRETS.A) as unknown as Canonical,
      b: askOf(b0, a0, OWNER_SECRETS.B) as unknown as Canonical,
    },
    mateRound,
    mateAt,
  );
  const mateId = commitmentId(mc.commitment);
  out.commits.set(mateId, mc);
  out.beacons.set(mateRound, beaconAt(mateRound));
  const cooldown = cooldownOf(0, scales);
  const mated = (self: Life, other: Life, role: 'a' | 'b', born: number): StoredRecord => {
    const t = mateAt + 500;
    self.activeMs = t - born;
    const before = self.condition;
    self.condition = paidFor(before);
    self.cooldownUntilMs = self.activeMs + cooldown;
    return self.append('mate-commit', t, {
      commit: mateId,
      round: mateRound,
      role,
      partner: other.owner,
      partnerCreature: other.id,
      genome: genomeHash(self.genome),
      partnerGenome: genomeHash(other.genome),
      generation: self.generation,
      activeMs: self.activeMs,
      ...self.condition,
      cooldownUntilMs: self.cooldownUntilMs,
      biomassBefore: before.biomass,
      energyBefore: before.energy,
      healthBefore: before.health,
    });
  };
  const mates: [string, string] = [mated(a0, b0, 'a', bornA).hash, mated(b0, a0, 'b', bornB).hash];

  // The births, once the committed round is out.
  const bornAt = roundTime(mateRound) + 1000;
  const { children, slots } = offspringPair(
    randomnessOf(beaconAt(mateRound)),
    mateId,
    a0.genome,
    b0.genome,
  );
  const birth = (slot: 0 | 1, owner: string): Life => {
    const request: RecordRequest = birthRequest(
      RULES_VERSION,
      mc.commitment,
      mates,
      slots[slot],
      [a0.id, b0.id],
      children[slot],
      Math.max(a0.generation, b0.generation) + 1,
      owner,
    );
    const life = new Life(children[slot], owner, store({ ...request, t: bornAt }));
    out.genomes.set(life.id, genomeToBase64url(children[slot]));
    out.chains.set(life.id, life.chain);
    return life;
  };
  const a1 = birth(0, a0.owner);
  const b1 = birth(1, b0.owner);

  // A promotes A1: A0 is frozen with the condition and clock its head holds.
  const promotedAt = bornAt + 20_000;
  a0.append('promote', promotedAt, { role: 'parent', child: a1.id, ...a0.frozen() });
  a1.append('promote', promotedAt, { role: 'child', parent: a0.id }, OWNER_SECRETS.A);
  a1.checkpoint(promotedAt + 60_000, 60_000, Math.floor(tune.a1Size * adultOf(a1.genome)));

  // A1 attacks B0, which carries B1 as an egg; nobody steers, so both fight on the autopilot.
  const lockAt = promotedAt + 90_000;
  const clocks = new Map([
    [a1.id, 90_000],
    [b0.id, b0.activeMs + (lockAt - (mateAt + 500))],
  ]);
  const clockOf = (life: Life) => clocks.get(life.id) as number;
  const fighters = [
    fighterOf(a1, clockOf(a1), scales, 2046, 0, false),
    fighterOf(b0, clockOf(b0), scales, 2050, Math.PI, true),
  ].sort((x, y) => (x.creature < y.creature ? -1 : 1));
  const enc = encounterId([a1.head.hash, b0.head.hash], lockAt);
  // The newest round the hub held at lock-in seeds the fight; it is no commitment's.
  const seedRound = roundAt(lockAt);
  const at = lockAt + RULES.encounter.startDelayMs;
  const start: EncStart = {
    t: 'enc-start',
    enc,
    seed: encounterSeed(randomnessOf(beaconAt(seedRound)), enc),
    round: seedRound,
    t0: 30_000,
    at,
    fighters,
  };
  const fought = play({ pondSeed, start, joins: [] });
  const settledAt = at + fought.log.frames.length * FRAME_MS + 50;
  const signed = signSettlement(AUTH_SECRET, settlementOf(fought.log, fought.enc, settledAt));
  out.settlements.set(enc, signed);
  out.logs.set(enc, fought.log);
  const s = signed.settlement;
  const done = results(fought.enc);
  const slotOf = (life: Life) => s.results.findIndex((r) => r.creature === life.id);
  const [ra, rb] = [s.results[slotOf(a1)], s.results[slotOf(b0)]];
  if (ra?.outcome !== 'stood' || rb?.outcome !== 'killed' || rb.by !== slotOf(a1)) {
    throw new Error(`in pond ${pondSeed} A1 does not kill B0: ${JSON.stringify(done)}`);
  }
  const lockedMs = (life: Life) =>
    Math.min(clockOf(life) + s.frames * FRAME_MS, lifespanOf(life.genome, scales));
  // As `settleRecords` writes them, in slot order: the survivor's encounter, the dead fighter's
  // death, and the death of the child whose egg went with it.
  for (const r of s.results) {
    const life = r.creature === a1.id ? a1 : b0;
    life.activeMs = lockedMs(life);
    life.condition = { biomass: r.biomass, energy: r.energy, health: r.health };
    if (life === a1) {
      a1.append('encounter', settledAt, {
        enc,
        outcome: r.outcome,
        frames: r.frame,
        ...life.condition,
        reward: r.reward,
        activeMs: life.activeMs,
      });
    } else {
      b0.append('death', settledAt, {
        cause: 'killed',
        activeMs: life.activeMs,
        biomass: r.biomass,
        enc,
        by: a1.id,
      });
    }
    if (r.egg === 'eaten') {
      b1.append('death', settledAt, {
        cause: 'eaten',
        activeMs: 0,
        biomass: b1.condition.biomass,
        enc,
        by: a1.id,
      });
    }
  }

  // A1 swims into a toxin: its last report saved, then its death.
  const diedAt = settledAt + 20_000;
  a1.activeMs += 20_000;
  a1.append('checkpoint', diedAt, { activeMs: a1.activeMs, ...a1.condition });
  a1.append('death', diedAt, {
    cause: 'toxin',
    activeMs: a1.activeMs,
    biomass: a1.condition.biomass,
  });

  // A brings A0 back, as frozen.
  out.t = diedAt + 5_000;
  a0.append('restore', out.t, { from: a1.id, ...a0.frozen() }, OWNER_SECRETS.A);

  out.ids = { A0: a0.id, B0: b0.id, A1: a1.id, B1: b1.id };
  return out;
}

/** The record of `chain` that ties it to `child`: its `mate-commit` of the mating, or its parent `promote`. */
function tieOf(chain: readonly StoredRecord[], child: readonly StoredRecord[]): number {
  const first = child[0]?.record;
  let end = -1;
  const mates = first?.kind === 'birth' ? (first.body.mates as string[]) : [];
  const childId = child[0]?.hash;
  for (const [i, s] of chain.entries()) {
    const tied =
      mates.includes(s.hash) ||
      (s.record.kind === 'promote' &&
        s.record.body.role === 'parent' &&
        s.record.body.child === childId);
    if (tied) end = i;
  }
  return end;
}

/**
 * `subject`'s proof bundle: its whole chain, then its ancestors breadth-first (nearest first, ties
 * by id), each up to the record that ties it to its descendant (the longer when reached twice), and
 * every commitment, beacon and settlement those records name. `leave` names creatures to leave out,
 * which then go into `more`.
 */
export function bundleOf(
  h: LineageHistory,
  subject: string,
  leave: readonly string[] = [],
): ProofBundle {
  const held = new Map<string, number>([[subject, Number.POSITIVE_INFINITY]]);
  const order = [subject];
  const more: string[] = [];
  let level = [subject];
  while (level.length > 0) {
    const next = new Map<string, number>();
    for (const id of level) {
      const chain = (h.chains.get(id) ?? []).slice(0, (held.get(id) ?? 0) + 1);
      const first = chain[0]?.record;
      const parents = first?.kind === 'birth' ? (first.body.parents as string[]) : [];
      const promote = chain.find(
        (s) => s.record.kind === 'promote' && s.record.body.role === 'child',
      );
      const chainParent = promote ? [promote.record.body.parent as string] : [];
      for (const parent of [...parents, ...chainParent]) {
        if (leave.includes(parent)) {
          if (!more.includes(parent)) more.push(parent);
          continue;
        }
        const end = tieOf(h.chains.get(parent) ?? [], chain);
        const known = held.get(parent) ?? next.get(parent);
        if (known === undefined || end > known) {
          if (held.has(parent)) held.set(parent, end);
          else next.set(parent, end);
        }
      }
    }
    level = [...next.keys()].sort();
    for (const id of level) {
      held.set(id, next.get(id) as number);
      order.push(id);
    }
  }
  const records = order.flatMap((id) =>
    (h.chains.get(id) ?? []).slice(0, (held.get(id) as number) + 1),
  );
  const named = (field: string) =>
    new Set(records.map((s) => s.record.body[field]).filter((v) => typeof v === 'string'));
  const commits = [...named('commit')].map((id) => h.commits.get(id as string) as SignedCommit);
  const rounds = new Set(commits.map((c) => c.commitment.round));
  const settlements = [...named('enc')].map(
    (enc) => h.settlements.get(enc as string) as SignedSettlement,
  );
  return {
    v: 1,
    kind: 'proof',
    subject,
    world: {
      epoch: REGISTRY.find((e) => e.rules === RULES_VERSION)?.epoch ?? 0,
      rules: RULES_VERSION,
      scales: { ...h.scales },
    },
    keys: [{ ...FIXTURE_KEY }],
    creatures: order.map((id) => ({ id, genome: h.genomes.get(id) as string })),
    records,
    commits,
    beacons: [...rounds].sort((x, y) => x - y).map((r) => beaconAt(r)),
    settlements,
    flags: [],
    more,
    t: h.t + 60_000,
  };
}

// Tampering helpers: what a test changes is stored again with the fixture's keys, so only the
// check under test can catch it.

/** Where record `seq` of `creature` sits in the bundle's records. */
export function indexOf(b: ProofBundle, creature: string, seq: number): number {
  const i = b.records.findIndex(
    (s) => (s.record.creature || s.hash) === creature && s.record.seq === seq,
  );
  if (i < 0) throw new Error(`no record ${seq} of ${creature}`);
  return i;
}

/** Replaces a record with `change` applied, stored again, and relinks the records after it. */
export function rewrite(
  b: ProofBundle,
  creature: string,
  seq: number,
  change: (r: LedgerRecord) => void,
): void {
  let i = indexOf(b, creature, seq);
  const s = b.records[i] as StoredRecord;
  const record = structuredClone(s.record);
  change(record);
  let prev = resign(s, record);
  b.records[i] = prev;
  for (let next = seq + 1; ; next++) {
    i = b.records.findIndex((x) => x.record.creature === creature && x.record.seq === next);
    if (i < 0) return;
    const later = b.records[i] as StoredRecord;
    prev = resign(later, { ...later.record, prev: prev.hash });
    b.records[i] = prev;
  }
}

/** A record to write in place of others: its kind, time and body. */
export interface Step {
  kind: LedgerRecord['kind'];
  t: number;
  body: LedgerRecord['body'];
}

/** Replaces `creature`'s records from `seq` on with `steps`, written and countersigned as the authority would. */
export function retail(
  b: ProofBundle,
  creature: string,
  seq: number,
  steps: readonly Step[],
): void {
  let prev = b.records[indexOf(b, creature, seq - 1)] as StoredRecord;
  b.records = b.records.filter(
    (s) => (s.record.creature || s.hash) !== creature || s.record.seq < seq,
  );
  for (const [n, step] of steps.entries()) {
    const record: LedgerRecord = {
      ...structuredClone(prev.record),
      creature,
      seq: seq + n,
      prev: prev.hash,
      t: step.t,
      kind: step.kind,
      body: step.body,
    };
    const ownerStarted =
      step.kind === 'restore' || (step.kind === 'promote' && step.body.role === 'child');
    const secret = record.owner === PLAYERS.A ? OWNER_SECRETS.A : OWNER_SECRETS.B;
    prev = store(record, ownerStarted ? secret : null);
    b.records.push(prev);
  }
}
