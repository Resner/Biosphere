import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GenesisAsk, verifyGenesisAsk } from '../ledger/ask';
import { createIdentity, fromBase64Url, type Identity, memoryKeyStore } from '../ledger/identity';
import { recordHash, type StoredRecord } from '../ledger/record';
import type { LifeMsg } from '../net/hub-client';
import type { ClientMsg, HubMsg, LifeInfo } from '../net/protocol';
import { LifeFlow } from './life';

type Genesis = Extract<HubMsg, { t: 'genesis' }>;

const NONCE = 'A'.repeat(22);
const WAIT = 1000;

let identity: Identity;
let sent: ClientMsg[];
let flow: LifeFlow;
let verified: Genesis[];
let problems: string[];

beforeEach(async () => {
  vi.useFakeTimers();
  identity = await createIdentity(memoryKeyStore());
  sent = [];
  verified = [];
  problems = [];
  flow = new LifeFlow({
    identity: () => identity,
    nonce: () => NONCE,
    verify: async (g) => {
      verified.push(g);
      return problems;
    },
  });
  flow.attach({ send: (m) => sent.push(m) });
});

afterEach(() => {
  vi.useRealTimers();
});

const info = (over: Partial<LifeInfo> = {}): LifeInfo => ({
  creature: 'c'.repeat(64),
  seq: 2,
  genome: 'GENOME',
  biomass: 31_250,
  energy: 4_000,
  health: 1_500,
  activeMs: 600_000,
  lifespanMs: 4_500_000,
  ...over,
});

function genesisMsg(owner = identity.playerId, hashOk = true): Genesis {
  const record = {
    v: 1 as const,
    rules: 4,
    kind: 'genesis' as const,
    creature: '',
    seq: 0,
    prev: '',
    owner,
    t: 1,
    body: { round: 9 },
  };
  const stored: StoredRecord = {
    record,
    hash: hashOk ? recordHash(record) : '0'.repeat(64),
    ownerSig: null,
    authSig: 'x',
    keyId: 'k',
  };
  const ask: GenesisAsk = { nonce: NONCE, sig: 's' };
  return {
    t: 'genesis',
    record: stored,
    ownerRequest: ask,
    commit: {
      commitment: { v: 1, kind: 'genesis', owner, round: 9, req: 'r', t: 1, data: ask },
      authSig: 'x',
      keyId: 'k',
    },
    beacon: { round: 9, signature: 'ab' },
    genome: 'FRESH',
  };
}

const feed = (msg: LifeMsg): void => flow.receive(msg);
const ofType = (t: ClientMsg['t']): ClientMsg[] => sent.filter((m) => m.t === t);

describe('hatching', () => {
  it('resumes the active creature without asking the hub for anything', async () => {
    feed({ t: 'life', life: info(), genesisIn: 0 });
    const outcome = await flow.hatch(WAIT);
    expect(outcome).toEqual({
      kind: 'recorded',
      start: {
        creature: 'c'.repeat(64),
        seq: 2,
        genome: 'GENOME',
        condition: { biomass: 312.5, energy: 40, health: 15 },
        activeMs: 600_000,
        lifespanMs: 4_500_000,
      },
    });
    expect(flow.view().status).toBe('playing');
    expect(sent).toEqual([]);
  });

  it('starts a fresh creature from the genome when the checkpoint has no condition yet', async () => {
    feed({ t: 'life', life: info({ biomass: 0, energy: 0, health: 0, seq: 0 }), genesisIn: 0 });
    const outcome = await flow.hatch(WAIT);
    expect(outcome.kind === 'recorded' && outcome.start.condition).toBeNull();
  });

  it('asks for a genesis with a signed ask, shows the wait, then verifies and starts', async () => {
    feed({ t: 'life', life: null, genesisIn: 0 });
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    const request = ofType('genesis-request')[0] as Extract<ClientMsg, { t: 'genesis-request' }>;
    expect(request).toBeDefined();
    expect(fromBase64Url(request.nonce)).toHaveLength(16);
    expect(verifyGenesisAsk(identity.playerId, request)).toBe(true);
    expect(flow.view().status).toBe('requesting');

    feed({
      t: 'commit',
      commit: genesisMsg().commit,
      hatchesLeft: 2,
    });
    expect(flow.view()).toMatchObject({ status: 'awaiting', awaitingBeacon: true });

    feed(genesisMsg());
    expect(flow.view().status).toBe('verifying');
    const outcome = await pending;
    expect(verified).toHaveLength(1);
    expect(outcome).toMatchObject({
      kind: 'recorded',
      start: { genome: 'FRESH', seq: 0, condition: null, activeMs: 0 },
    });
    const view = flow.view();
    expect(view).toMatchObject({ status: 'playing', awaitingBeacon: false, seq: 0 });
    expect(view.creature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses DNA that does not verify and spawns nothing', async () => {
    feed({ t: 'life', life: null, genesisIn: 0 });
    problems = ['body-mismatch'];
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    feed(genesisMsg());
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'failed', message: 'Could not verify your creature' });
    expect(flow.view().status).toBe('idle');
    expect(flow.view().creature).toBeNull();
  });

  it('refuses a genesis for another owner or with a wrong record hash before checking the beacon', async () => {
    for (const msg of [genesisMsg('o'.repeat(43)), genesisMsg(identity.playerId, false)]) {
      feed({ t: 'life', life: null, genesisIn: 0 });
      const pending = flow.hatch(WAIT);
      await vi.advanceTimersByTimeAsync(0);
      feed(msg);
      expect(await pending).toMatchObject({ kind: 'failed' });
    }
    expect(verified).toEqual([]);
  });

  it('retries after a failure with a new ask', async () => {
    feed({ t: 'life', life: null, genesisIn: 0 });
    problems = ['bad-beacon'];
    let pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    feed(genesisMsg());
    await pending;
    problems = [];
    pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('genesis-request')).toHaveLength(2);
    feed(genesisMsg());
    expect((await pending).kind).toBe('recorded');
  });

  it('swims as a practice cell when the bucket is empty, with or without asking', async () => {
    feed({ t: 'life', life: null, genesisIn: 90_000 });
    expect(await flow.hatch(WAIT)).toEqual({
      kind: 'practice',
      reason: 'limit',
      genesisIn: 90_000,
    });
    expect(sent).toEqual([]);

    feed({ t: 'life', life: null, genesisIn: 0 });
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    feed({ t: 'refused', reason: 'limit', genesisIn: 300_000 });
    expect(await pending).toEqual({ kind: 'practice', reason: 'limit', genesisIn: 300_000 });
    expect(flow.view().status).toBe('practice');
  });

  it('asks the hub again after a wait instead of trusting the stale countdown', async () => {
    feed({ t: 'life', life: null, genesisIn: 90_000 });
    expect((await flow.hatch(WAIT)).kind).toBe('practice');
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('genesis-request')).toHaveLength(1);
    feed(genesisMsg());
    expect((await pending).kind).toBe('recorded');
  });

  it('asks the hub for the next hatch after a death, not the countdown from long ago', async () => {
    feed({ t: 'life', life: null, genesisIn: 300_000 });
    expect((await flow.hatch(WAIT)).kind).toBe('practice');
    let pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    feed(genesisMsg());
    expect((await pending).kind).toBe('recorded');
    flow.died('starved', 100);
    pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('genesis-request')).toHaveLength(2);
    feed({ t: 'refused', reason: 'limit', genesisIn: 1_000 });
    expect(await pending).toEqual({ kind: 'practice', reason: 'limit', genesisIn: 1_000 });
  });

  it('resumes the creature the hub says is active instead of blaming another tab', async () => {
    feed({ t: 'life', life: null, genesisIn: 0 });
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    // A genesis that arrived after the client gave up left a creature on the hub.
    feed({ t: 'life', life: info(), genesisIn: 0 });
    feed({ t: 'refused', reason: 'active' });
    const outcome = await pending;
    expect(outcome.kind).toBe('recorded');
    expect(outcome.kind === 'recorded' && outcome.start.creature).toBe('c'.repeat(64));
  });

  it('plays unrecorded when the hub never says what the player has', async () => {
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(await pending).toEqual({ kind: 'practice', reason: 'offline' });
    expect(sent).toEqual([]);
    const lonely = new LifeFlow({
      identity: () => identity,
      nonce: () => NONCE,
      verify: async () => [],
    });
    expect(await lonely.hatch(WAIT)).toEqual({ kind: 'practice', reason: 'offline' });
  });

  it('gives up on a beacon that never comes, with a message', async () => {
    feed({ t: 'life', life: null, genesisIn: 0 });
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    feed({ t: 'commit', commit: genesisMsg().commit, hatchesLeft: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ kind: 'failed' });
    expect(flow.view()).toMatchObject({ status: 'idle', awaitingBeacon: false });
  });

  // Every reason string the hub sends in `refused`, and whether it answers a genesis ask.
  const REASONS: [string, 'answer' | 'stray'][] = [
    ['limit', 'answer'],
    ['bad-signature', 'answer'],
    ['used', 'answer'],
    ['active', 'answer'],
    ['already-active', 'answer'],
    ['bad-owner-signature', 'answer'],
    ['invalid-record:shape', 'answer'],
    ['dead', 'stray'],
    ['cause', 'stray'],
    ['queued', 'stray'],
  ];

  it.each(REASONS)('treats a refusal for "%s" as %s', async (reason, group) => {
    feed({ t: 'life', life: null, genesisIn: 0 });
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    feed({ t: 'refused', reason });
    if (group === 'answer') {
      expect((await pending).kind === 'recorded').toBe(false);
      return;
    }
    // A stray refusal about something else keeps the wait going until the genesis comes.
    feed(genesisMsg());
    expect((await pending).kind).toBe('recorded');
  });

  it('reports a creature that plays elsewhere', async () => {
    feed({ t: 'life', life: null, genesisIn: 0 });
    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    feed({ t: 'refused', reason: 'active' });
    expect(await pending).toMatchObject({ kind: 'failed' });
  });
});

describe('progress', () => {
  const play = async (): Promise<void> => {
    feed({ t: 'life', life: info(), genesisIn: 0 });
    await flow.hatch(WAIT);
  };

  it('reports the condition in hundredths with a rising count', async () => {
    await play();
    flow.report(900, { biomass: 312.504, energy: 40.126, health: 15 });
    flow.report(1800, { biomass: 320, energy: 30, health: 15 });
    expect(sent).toEqual([
      { t: 'progress', n: 1, ticks: 900, biomass: 31_250, energy: 4_013, health: 1_500 },
      { t: 'progress', n: 2, ticks: 1800, biomass: 32_000, energy: 3_000, health: 1_500 },
    ]);
  });

  it('sends a broken value as zero instead of throwing into the game loop', async () => {
    await play();
    expect(() =>
      flow.report(900, { biomass: Number.NaN, energy: Number.POSITIVE_INFINITY, health: -5 }),
    ).not.toThrow();
    expect(sent).toEqual([{ t: 'progress', n: 1, ticks: 900, biomass: 0, energy: 0, health: 0 }]);
  });

  it('takes the ack as the new life clock', async () => {
    await play();
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    feed({ t: 'ack', n: 1, activeMs: 630_000, lifespanMs: 4_500_000 });
    expect(flow.view()).toMatchObject({
      activeMs: 630_000,
      lifespanMs: 4_500_000,
      lastAckN: 1,
    });
  });

  it('counts ticks per connection: a reconnect starts again from the next report', async () => {
    await play();
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    flow.attach({ send: (m) => sent.push(m) });
    feed({ t: 'life', life: info({ activeMs: 700_000 }), genesisIn: 0 });
    flow.report(1800, { biomass: 1, energy: 1, health: 1 });
    flow.report(2700, { biomass: 1, energy: 1, health: 1 });
    const progress = ofType('progress') as Extract<ClientMsg, { t: 'progress' }>[];
    expect(progress.map((m) => [m.n, m.ticks])).toEqual([
      [1, 900],
      [1, 900],
      [2, 1800],
    ]);
  });

  it('sends nothing for practice, before hatching or after a death', async () => {
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    feed({ t: 'life', life: null, genesisIn: 600_000 });
    await flow.hatch(WAIT);
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    expect(sent).toEqual([]);
    await play();
    flow.died('starved', 100);
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    expect(ofType('progress')).toEqual([]);
  });
});

describe('death', () => {
  it('is sent once, and the next hatch asks for a new genesis', async () => {
    feed({ t: 'life', life: info(), genesisIn: 0 });
    await flow.hatch(WAIT);
    flow.died('toxin', 1234);
    flow.died('toxin', 1234);
    expect(sent).toEqual([{ t: 'death', cause: 'toxin', ticks: 1234 }]);
    expect(flow.view().status).toBe('dead');

    const pending = flow.hatch(WAIT);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('genesis-request')).toHaveLength(1);
    feed(genesisMsg());
    expect((await pending).kind).toBe('recorded');
  });

  it('leaves old age to the authority', async () => {
    feed({ t: 'life', life: info(), genesisIn: 0 });
    await flow.hatch(WAIT);
    flow.died('old-age', 1234);
    expect(sent).toEqual([]);
    expect(flow.view().status).toBe('dead');
  });

  it('adopts the authority’s word that the creature died', async () => {
    feed({ t: 'life', life: info(), genesisIn: 0 });
    await flow.hatch(WAIT);
    feed({ t: 'died', cause: 'old-age', record: genesisMsg().record });
    expect(flow.view().status).toBe('dead');
    feed({ t: 'life', life: null, genesisIn: 0 });
    expect(flow.view().status).toBe('dead');
  });

  it('sends nothing for a practice cell', async () => {
    feed({ t: 'life', life: null, genesisIn: 600_000 });
    await flow.hatch(WAIT);
    flow.died('starved', 10);
    expect(sent).toEqual([]);
  });
});

describe('life clock', () => {
  const MAX = 10_000;
  const FALLBACK = 4_500_000;
  const play = async (over: Partial<LifeInfo> = {}): Promise<void> => {
    feed({ t: 'life', life: info(over), genesisIn: 0 });
    await flow.hatch(WAIT);
  };

  it('counts on from the saved time with the ticks played since', async () => {
    await play({ activeMs: 600_000 });
    expect(flow.clock(0, 100, MAX, FALLBACK)).toMatchObject({
      activeMs: 600_000,
      lifespanMs: 4_500_000,
      remainingMs: 3_900_000,
    });
    expect(flow.clock(900, 100, MAX, FALLBACK)?.activeMs).toBe(630_000);
  });

  it('starts from the genome’s own lifespan until the hub says', async () => {
    await play({ lifespanMs: 0, activeMs: 0 });
    expect(flow.clock(30, 100, MAX, 2_700_000)?.lifespanMs).toBe(2_700_000);
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    feed({ t: 'ack', n: 1, activeMs: 30_000, lifespanMs: 45_000 });
    expect(flow.clock(900, 100, MAX, 2_700_000)).toMatchObject({
      activeMs: 30_000,
      lifespanMs: 45_000,
      remainingMs: 15_000,
    });
  });

  it('measures from the ticks the acked report carried, not from when the ack came', async () => {
    await play({ activeMs: 0 });
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    // 3 s of play go by before the ack arrives.
    feed({ t: 'ack', n: 1, activeMs: 30_000, lifespanMs: 4_500_000 });
    expect(flow.clock(990, 100, MAX, FALLBACK)?.activeMs).toBe(33_000);
  });

  it('keeps counting through a reconnect, which numbers reports again from 1', async () => {
    await play({ activeMs: 0 });
    flow.report(900, { biomass: 1, energy: 1, health: 1 });
    feed({ t: 'ack', n: 1, activeMs: 30_000, lifespanMs: 4_500_000 });
    flow.attach({ send: (m) => sent.push(m) });
    feed({ t: 'life', life: info({ activeMs: 30_000 }), genesisIn: 0 });
    flow.report(1800, { biomass: 1, energy: 1, health: 1 });
    feed({ t: 'ack', n: 1, activeMs: 60_000, lifespanMs: 4_500_000 });
    expect(flow.clock(1800, 100, MAX, FALLBACK)?.activeMs).toBe(60_000);
    expect(flow.clock(2700, 100, MAX, FALLBACK)?.activeMs).toBe(90_000);
  });

  it('reads the stage from the clock: old from 85% of the lifespan', async () => {
    await play({ activeMs: 3_800_000 });
    expect(flow.clock(0, 7000, MAX, FALLBACK)?.stage).toBe('mature');
    expect(flow.clock(0, 100, MAX, FALLBACK)?.stage).toBe('young');
    await play({ activeMs: 3_825_000 });
    expect(flow.clock(0, 100, MAX, FALLBACK)?.stage).toBe('old');
    await play({ activeMs: 10_000 });
    expect(flow.clock(0, 100, MAX, FALLBACK)?.stage).toBe('young');
  });

  it('has no clock for a practice cell or a dead creature', async () => {
    feed({ t: 'life', life: null, genesisIn: 600_000 });
    await flow.hatch(WAIT);
    expect(flow.clock(10, 100, MAX, FALLBACK)).toBeNull();
    await play();
    flow.died('toxin', 5);
    expect(flow.clock(10, 100, MAX, FALLBACK)).toBeNull();
  });

  it('never goes below zero remaining', async () => {
    await play({ activeMs: 4_499_000 });
    expect(flow.clock(300, 100, MAX, FALLBACK)?.remainingMs).toBe(0);
  });

  it('knows the authority ended it of old age, and forgets that on the next hatch', async () => {
    await play();
    expect(flow.expired).toBe(false);
    feed({ t: 'died', cause: 'toxin', record: genesisMsg().record });
    expect(flow.expired).toBe(false);
    await play();
    feed({ t: 'died', cause: 'old-age', record: genesisMsg().record });
    expect(flow.expired).toBe(true);
    await play();
    expect(flow.expired).toBe(false);
  });

  it('does not carry an old-age ending into a practice cell', async () => {
    await play();
    feed({ t: 'died', cause: 'old-age', record: genesisMsg().record });
    expect(flow.expired).toBe(true);
    flow.practice();
    expect(flow.expired).toBe(false);
  });
});
