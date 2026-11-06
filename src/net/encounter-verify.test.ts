import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES } from '../../tests/archetypes';
import { IDLE_CODE } from '../../tests/encounter-fixture';
import { speedTest } from '../../tests/heavy';
import { genomeToBase64url } from '../genome/codec';
import { starterGenome } from '../genome/starter';
import { encounterId } from '../ledger/encounter';
import { fromBase64Url, playerIdOf, publicKeyFromSecret, toBase64Url } from '../ledger/identity';
import { parseFightProof } from '../ledger/proof';
import {
  authorityKeyId,
  authorityPublicKey,
  authoritySign,
  type LedgerRecord,
  type PubKey,
  recordHash,
  type StoredRecord,
} from '../ledger/record';
import {
  checkSettledRecords,
  type FightLog,
  type Settlement,
  type SettlementV1,
  type SettlementV2,
  type SignedSettlement,
  settlementHash,
  signSettlement,
} from '../ledger/settlement';
import { createEncounter, stepFrame } from '../sim/encounter/encounter';
import { applyJoins } from '../sim/encounter/join';
import type { EncounterLog } from '../sim/encounter/replay';
import type { Encounter, FighterStart } from '../sim/encounter/types';
import { RULES, RULES_VERSION } from '../sim/rules';
import { maxHealth, starterEnergy } from '../sim/vitals';
import type { EncJoin, EncStart } from './encounter-start';
import { encounterStartOf, fighterStartOf } from './encounter-start';
import { AUTHORITY_ONLY, settlementOf, verifyEncounter } from './encounter-verify';
import type { FighterInfo } from './protocol-defs';
import { signedSettlement } from './protocol-encounter';

// ADR 0054: the settlement document of a fight, rechecked from its log. The golden settles the
// `encounter-duel` and `encounter-join` scenarios (their layouts and inputs) with real genomes, as
// the authority's messages carry them, under a fixed test key.

const AUTH_SECRET = new Uint8Array(32).fill(0x5e);
const KEYS: PubKey[] = [
  {
    id: authorityKeyId(authorityPublicKey(AUTH_SECRET)),
    publicKey: authorityPublicKey(AUTH_SECRET),
  },
];
const AT = 1_700_000_000_000;
const GOLDEN = new URL('../ledger/__golden__/settlement.json', import.meta.url);
const simGolden = (name: string): EncounterLog =>
  (
    JSON.parse(
      readFileSync(new URL(`../sim/__golden__/${name}.json`, import.meta.url), 'utf8'),
    ) as { log: EncounterLog }
  ).log;

const STARTER_TEXT = genomeToBase64url(starterGenome());
const HUNTER_TEXT = genomeToBase64url(ARCHETYPES.hunter as NonNullable<typeof ARCHETYPES.hunter>);
/** Ids that keep the scenario's creature order (slots go by creature id). */
const CREATURES: Record<string, string> = { a: '1', b: '2', c: '4', m: '3' };
const playerOf = (n: number): string => playerIdOf(publicKeyFromSecret(new Uint8Array(32).fill(n)));

/** The scenario's fighter as the authority sends it: an armed one gets the hunter's genome. */
function infoOf(f: FighterStart, n: number): FighterInfo {
  return {
    player: playerOf(n),
    creature: (CREATURES[f.creature] as string).repeat(64),
    genome: f.combat.reach > 1 ? HUNTER_TEXT : STARTER_TEXT,
    x: f.x,
    y: f.y,
    vx: f.vx,
    vy: f.vy,
    heading: f.heading,
    biomass: f.biomass,
    energy: f.energy,
    health: f.health,
    elder: f.elder,
    egg: f.egg,
    worth: f.worth,
  };
}

/** Plays `frames` from the log's start, then the autopilot until the fight is over. */
function played(log: Omit<FightLog, 'frames'>, scripted: (number | null)[][]): FightLog {
  const start = encounterStartOf(log.start, log.pondSeed);
  if (!start) throw new Error('the golden start does not build');
  const joins = log.joins.map((j) => ({
    f: j.f,
    fighter: fighterStartOf(j.fighter) as FighterStart,
  }));
  const enc = createEncounter(start);
  const frames: (number | null)[][] = [];
  while (!enc.over) {
    applyJoins(enc, joins);
    const row = scripted[enc.frame] ?? enc.fighters.map(() => null);
    frames.push(row);
    stepFrame(enc, row);
  }
  return { ...log, frames };
}

/** A sim golden as the authority would have logged it. */
function fightOf(name: string): FightLog {
  const sim = simGolden(name);
  let n = 1;
  const fighters = sim.start.fighters.map((f) => infoOf(f, n++));
  const enc = encounterId(
    fighters.map((f) => f.creature),
    AT,
  );
  const seed = `${sim.start.seed.map((w) => w.toString(16).padStart(8, '0')).join('')}${'0'.repeat(32)}`;
  const start: EncStart = {
    t: 'enc-start',
    enc,
    seed,
    round: 0,
    t0: sim.start.t0,
    at: AT,
    fighters,
  };
  const joins: EncJoin[] = (sim.joins ?? []).map((j) => ({
    t: 'enc-join',
    enc,
    f: j.f,
    fighter: infoOf(j.fighter, n++),
  }));
  return played({ pondSeed: sim.start.pondSeed, start, joins }, sim.frames);
}

/** The encounter the log plays to its end. */
function endOf(log: FightLog): Encounter {
  const enc = createEncounter(encounterStartOf(log.start, log.pondSeed) as never);
  const joins = log.joins.map((j) => ({
    f: j.f,
    fighter: fighterStartOf(j.fighter) as FighterStart,
  }));
  for (const frame of log.frames) {
    applyJoins(enc, joins);
    stepFrame(enc, frame);
  }
  return enc;
}

const stored = (record: LedgerRecord): StoredRecord => {
  const hash = recordHash(record);
  return {
    record,
    hash,
    ownerSig: null,
    authSig: authoritySign(AUTH_SECRET, hash),
    keyId: KEYS[0]?.id ?? '',
  };
};

/** The records the authority writes for a settlement (`worker/ledger-encounter.ts`), at a made-up head per fighter. */
function recordsOf(s: Settlement): StoredRecord[] {
  const out: StoredRecord[] = [];
  const creatureAt = (slot: number | undefined) =>
    slot === undefined ? {} : { by: s.results[slot]?.creature as string };
  const record = (
    r: Settlement['results'][number],
    kind: 'encounter' | 'death',
    creature: string,
    body: LedgerRecord['body'],
  ) =>
    stored({
      v: 1,
      rules: s.rules,
      kind,
      creature,
      seq: 4,
      prev: 'e'.repeat(64),
      owner: r.player,
      t: s.t,
      body,
    });
  for (const r of s.results) {
    const activeMs = 600_000 + r.frame * 100;
    if (r.outcome === 'stood' || r.outcome === 'escaped') {
      out.push(
        record(r, 'encounter', r.creature, {
          enc: s.enc,
          outcome: r.outcome,
          frames: r.frame,
          biomass: r.biomass,
          energy: r.energy,
          health: r.health,
          reward: r.reward,
          activeMs,
        }),
      );
    } else {
      out.push(
        record(r, 'death', r.creature, {
          cause: r.cause ?? 'killed',
          activeMs,
          biomass: r.biomass,
          enc: s.enc,
          ...creatureAt(r.by),
        }),
      );
    }
    if (r.egg === 'eaten') {
      out.push(
        record(r, 'death', 'f'.repeat(64), { cause: 'eaten', enc: s.enc, ...creatureAt(r.eggBy) }),
      );
    }
  }
  return out;
}

/**
 * The golden's document: version 1, as the authority wrote it before witnesses (M8). It stays
 * pinned so that version 1 keeps verifying (ADR 0058); `settlementOf` now writes version 2.
 */
function v1Of(s: SettlementV2): SettlementV1 {
  const { v: _v, referees: _r, duty: _d, ...rest } = s;
  return { v: 1, ...rest, referee: 'authority' };
}

interface GoldenFight {
  log: FightLog;
  settlement: SignedSettlement;
  records: StoredRecord[];
}

function build(): Record<'duel' | 'join', GoldenFight> {
  const fight = (name: string): GoldenFight => {
    const log = fightOf(name);
    const settlement = signSettlement(
      AUTH_SECRET,
      v1Of(settlementOf(log, endOf(log), AT + 60_000)),
    );
    return { log, settlement, records: recordsOf(settlement.settlement) };
  };
  return { duel: fight('encounter-duel'), join: fight('encounter-join') };
}

const loadGolden = () =>
  JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
    rulesVersion: number;
    keys: PubKey[];
    fights: Record<'duel' | 'join', GoldenFight>;
  };

describe('the golden settlement', () => {
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(
      GOLDEN,
      `${JSON.stringify({ rulesVersion: RULES_VERSION, keys: KEYS, fights: build() }, null, 1)}\n`,
    );
  }

  it('is pinned, and rebuilds the same', () => {
    const golden = loadGolden();
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(golden.keys).toEqual(KEYS);
    expect(golden.fights).toEqual(build());
  });

  it('settles what its scenarios promise', () => {
    const { duel, join } = loadGolden().fights;
    const out = (g: GoldenFight) => g.settlement.settlement.results.map((r) => r.outcome);
    expect(out(duel)).toContain('killed');
    expect(join.log.joins).toHaveLength(1);
    expect(join.settlement.settlement.joins).toHaveLength(1);
    expect(join.settlement.settlement.results).toHaveLength(3);
    expect(out(join)).toContain('killed');
  });

  it('verifies with no problems', () => {
    const golden = loadGolden();
    for (const g of Object.values(golden.fights)) {
      expect(verifyEncounter(g.settlement, g.log, golden.keys)).toEqual([]);
      expect(checkSettledRecords(g.settlement.settlement, g.records)).toEqual([]);
    }
  });
});

describe('settlement version 2 (ADR 0058)', () => {
  const golden = loadGolden();
  const W = playerOf(9);

  it('is what settlementOf writes, authority-only unless told who refereed', () => {
    const { log } = golden.fights.duel;
    const doc = settlementOf(log, endOf(log), AT);
    expect(doc).toMatchObject({ v: 2, referees: [{ by: 'authority', from: 0 }], duty: '' });
    expect(AUTHORITY_ONLY).toEqual({ referees: [{ by: 'authority', from: 0 }], duty: '' });
    const { v: _v, referees: _r, duty: _d, ...rest } = doc;
    const {
      v: _v1,
      referee: _one,
      ...before
    } = golden.fights.duel.settlement.settlement as SettlementV1;
    expect(rest).toEqual({ ...before, t: AT });
  });

  it('round-trips through the wire and the fight proof, and verifies from its log', () => {
    for (const g of Object.values(golden.fights)) {
      const referees = [
        { by: 'authority', from: 0 },
        { by: W, from: 10, position: 0 },
        { by: 'authority', from: 20 },
      ];
      const signed = signSettlement(
        AUTH_SECRET,
        settlementOf(g.log, endOf(g.log), AT, { referees, duty: 'cd'.repeat(32) }),
      );
      expect(signed.settlement).toMatchObject({ v: 2, referees, duty: 'cd'.repeat(32) });
      expect(verifyEncounter(signed, g.log, golden.keys)).toEqual([]);
      expect(signedSettlement(JSON.parse(JSON.stringify(signed)))).toEqual(signed);
      expect(parseFightProof({ settlement: signed, log: g.log })).toEqual({
        settlement: signed,
        log: g.log,
      });
      // Who refereed is part of what the authority countersigned.
      const moved = structuredClone(signed);
      (moved.settlement as SettlementV2).referees[1] = { by: W, from: 11, position: 0 };
      expect(verifyEncounter(moved, g.log, golden.keys)).toEqual(['signature']);
      expect(settlementHash(moved.settlement)).not.toBe(signed.hash);
    }
  });

  it('still reads and verifies version 1 (the M8 golden)', () => {
    for (const g of Object.values(golden.fights)) {
      expect(g.settlement.settlement.v).toBe(1);
      expect(signedSettlement(structuredClone(g.settlement))).toEqual(g.settlement);
      expect(parseFightProof({ settlement: g.settlement, log: g.log })?.settlement).toEqual(
        g.settlement,
      );
      expect(verifyEncounter(g.settlement, g.log, golden.keys)).toEqual([]);
    }
  });

  it('refuses a version 2 document without its spans or duty, or with version 1 fields', () => {
    const { log } = golden.fights.duel;
    const doc = settlementOf(log, endOf(log), AT) as unknown as Record<string, unknown>;
    const signed = (settlement: unknown) => ({
      settlement,
      hash: 'ab'.repeat(32),
      authSig: golden.fights.duel.settlement.authSig,
      keyId: golden.fights.duel.settlement.keyId,
    });
    expect(signedSettlement(signed(doc))).not.toBeNull();
    const { referees: _r, ...noSpans } = doc;
    const { duty: _d, ...noDuty } = doc;
    for (const bad of [
      noSpans,
      noDuty,
      { ...doc, duty: 'xyz' },
      { ...doc, referees: [{ by: 'nobody', from: 0 }] },
      { ...doc, v: 1 },
      { ...doc, v: 3 },
    ]) {
      expect(signedSettlement(signed(bad))).toBeNull();
      expect(parseFightProof({ settlement: signed(bad), log: null })).toBeNull();
    }
  });
});

/** The next double above `x`. */
function ulpUp(x: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

describe('verifyEncounter', () => {
  const golden = loadGolden();
  const { keys } = golden;
  const fresh = (name: 'duel' | 'join'): GoldenFight => structuredClone(golden.fights[name]);
  /** The document changed, then signed again with the authority's key: only the change itself shows. */
  const resigned = (g: GoldenFight, change: (s: Settlement) => void): SignedSettlement => {
    const doc = structuredClone(g.settlement.settlement);
    change(doc);
    return signSettlement(AUTH_SECRET, doc);
  };

  it('names a start one ulp off', () => {
    const g = fresh('duel');
    const f0 = g.log.start.fighters[0] as FighterInfo;
    f0.x = ulpUp(f0.x);
    expect(verifyEncounter(g.settlement, g.log, keys)).toContain('start');
  });

  it('names a changed input, a dropped frame and two swapped frames', () => {
    const changed = fresh('duel');
    const row = changed.log.frames[5] as (number | null)[];
    row[0] = (row[0] ?? 0) ^ 1;
    expect(verifyEncounter(changed.settlement, changed.log, keys)).toContain('root');

    const dropped = fresh('duel');
    dropped.log.frames.splice(10, 1);
    const problems = verifyEncounter(dropped.settlement, dropped.log, keys);
    expect(problems).toContain('frames');
    expect(problems).toContain('root');

    const swapped = fresh('duel');
    const [f3, f4] = [swapped.log.frames[3], swapped.log.frames[4]] as (number | null)[][];
    expect(f3).not.toEqual(f4);
    swapped.log.frames[3] = f4 as (number | null)[];
    swapped.log.frames[4] = f3 as (number | null)[];
    expect(verifyEncounter(swapped.settlement, swapped.log, keys)).toContain('root');
  });

  it('names a join moved to another frame, and the frames whose width it changes', () => {
    const g = fresh('join');
    const join = g.log.joins[0] as EncJoin;
    join.f += 1;
    const problems = verifyEncounter(g.settlement, g.log, keys);
    expect(problems).toContain('joins');
    expect(problems).toContain(`width:${join.f - 1}`);
  });

  it('names a result that the replay does not give', () => {
    const g = fresh('duel');
    const biomass = resigned(g, (s) => {
      (s.results[1] as Settlement['results'][number]).biomass += 1;
    });
    expect(verifyEncounter(biomass, g.log, keys)).toEqual(['result:1:biomass']);
    const outcome = resigned(g, (s) => {
      (s.results[1] as Settlement['results'][number]).outcome = 'escaped';
    });
    expect(verifyEncounter(outcome, g.log, keys)).toEqual(['result:1:outcome']);
    const cause = resigned(g, (s) => {
      delete (s.results[1] as Settlement['results'][number]).cause;
    });
    expect(verifyEncounter(cause, g.log, keys)).toEqual(['result:1:cause']);
  });

  it('names the end hash and the rules', () => {
    const g = fresh('duel');
    const hash = resigned(g, (s) => {
      s.hash = s.hash.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    });
    expect(verifyEncounter(hash, g.log, keys)).toEqual(['hash']);
    for (const [rules, problem] of [
      [10, 'rules-retired'],
      [12, 'rules-unknown'],
    ] as const) {
      const other = resigned(g, (s) => {
        s.rules = rules;
      });
      expect(verifyEncounter(other, g.log, keys)).toEqual([problem]);
    }
  });

  it('names a broken countersignature and an unknown key', () => {
    const g = fresh('duel');
    const sig = fromBase64Url(g.settlement.authSig) as Uint8Array;
    sig[0] = (sig[0] as number) ^ 1;
    const bad = { ...g.settlement, authSig: toBase64Url(sig) };
    expect(verifyEncounter(bad, g.log, keys)).toEqual(['signature']);
    // A document changed after it was signed.
    const doc = structuredClone(g.settlement);
    (doc.settlement.results[0] as Settlement['results'][number]).reward += 100;
    expect(verifyEncounter(doc, g.log, keys)).toEqual(['signature', 'result:0:reward']);
    const other = new Uint8Array(32).fill(0x42);
    const unknown = signSettlement(other, g.settlement.settlement);
    expect(verifyEncounter(unknown, g.log, keys)).toEqual(['key']);
    // A key listed under an id it does not derive is no key.
    const forged = [{ id: unknown.keyId, publicKey: (keys[0] as PubKey).publicKey }];
    expect(verifyEncounter(g.settlement, g.log, forged)).toEqual(['key']);
  });

  it('names a frame of the wrong width, and never throws on a broken log', () => {
    const g = fresh('join');
    g.log.frames[20]?.pop();
    expect(verifyEncounter(g.settlement, g.log, keys)).toEqual(
      expect.arrayContaining(['root', 'width:20', 'replay']),
    );
    const broken = fresh('duel');
    (broken.log.start.fighters[0] as FighterInfo).genome = 'not-a-genome';
    expect(verifyEncounter(broken.settlement, broken.log, keys)).toEqual(['start', 'replay']);
    const empty = fresh('duel');
    empty.log.frames = [];
    expect(verifyEncounter(empty.settlement, empty.log, keys)).toEqual([
      'frames',
      'root',
      'replay',
    ]);
    expect(verifyEncounter({} as SignedSettlement, empty.log, keys)).toEqual(['key', 'replay']);
  });

  it('does not take frames played after the end', () => {
    const g = fresh('duel');
    g.log.frames.push([null, null]);
    const doc = resigned(g, (s) => {
      s.frames += 1;
      s.root = settlementOf(g.log, endOf(g.log), s.t).root;
    });
    expect(verifyEncounter(doc, g.log, keys)).toEqual(['replay']);
  });

  it('leaves out a join whose frame never came', () => {
    const g = fresh('duel');
    const late: EncJoin = {
      ...(fresh('join').log.joins[0] as EncJoin),
      enc: g.log.start.enc,
      f: g.log.frames.length,
    };
    g.log.joins.push(late);
    expect(v1Of(settlementOf(g.log, endOf(g.log), g.settlement.settlement.t))).toEqual(
      g.settlement.settlement,
    );
    expect(verifyEncounter(g.settlement, g.log, keys)).toEqual([]);
  });

  speedTest('verifies a 900-frame 4-fighter log in under 300 ms in Node', () => {
    const biomass = RULES.starter.biomass;
    const fighters: FighterInfo[] = [0, 1, 2, 3].map((i) => ({
      player: playerOf(i + 1),
      creature: String(i + 1).repeat(64),
      genome: STARTER_TEXT,
      x: 3000 + i * 20,
      y: 3000 + (i % 2) * 20,
      vx: 0,
      vy: 0,
      heading: 0,
      biomass,
      energy: starterEnergy(biomass),
      health: maxHealth(biomass),
      elder: false,
      egg: false,
      worth: 1,
    }));
    const enc = encounterId(
      fighters.map((f) => f.creature),
      AT,
    );
    const start: EncStart = {
      t: 'enc-start',
      enc,
      seed: '5eed'.repeat(16),
      round: 0,
      t0: 1000,
      at: AT,
      fighters,
    };
    const log = played(
      { pondSeed: 'speed-pond', start, joins: [] },
      Array.from({ length: RULES.encounter.timeoutFrames }, () => [
        IDLE_CODE,
        IDLE_CODE,
        IDLE_CODE,
        IDLE_CODE,
      ]),
    );
    expect(log.frames).toHaveLength(RULES.encounter.timeoutFrames);
    const signed = signSettlement(AUTH_SECRET, settlementOf(log, endOf(log), AT));
    expect(verifyEncounter(signed, log, KEYS)).toEqual([]);
    const t0 = performance.now();
    expect(verifyEncounter(signed, log, KEYS)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
