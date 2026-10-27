import { beforeEach, describe, expect, it } from 'vitest';
import { createIdentity, type Identity, memoryKeyStore } from '../ledger/identity';
import { checkMatePair, type MateAsk, signMateAsk } from '../ledger/mating';
import type { LifeMsg } from '../net/hub-client';
import type { ClientMsg } from '../net/protocol';
import type { MateView } from '../sim/mating';
import { RULES } from '../sim/rules';
import { maxEnergy } from '../sim/vitals';
import { MateFlow } from './mate';

const NONCE = 'B'.repeat(22);
const MINE = 'a'.repeat(64);
const THEIRS = 'b'.repeat(64);

let me: Identity;
let them: Identity;
let clock: number;
let sent: ClientMsg[];
let flow: MateFlow;
let own: MateView | null;

const view = (change: Partial<MateView> = {}): MateView => ({
  creature: MINE,
  owner: me.playerId,
  active: true,
  activeMs: 400_000,
  matureAtMs: 100_000,
  cooldownUntilMs: 0,
  biomass: 100,
  energy: 0.8 * maxEnergy(100),
  hasPending: false,
  inFlight: false,
  locked: false,
  ...change,
});

const info = (change: Partial<Extract<LifeMsg, { t: 'mate-info' }>> = {}): LifeMsg => ({
  t: 'mate-info',
  partner: them.playerId,
  creature: THEIRS,
  reason: null,
  kinship: 0,
  generation: 0,
  tier: 1,
  cooldownLeftMs: 0,
  ...change,
});

const courts = () => sent.filter((m) => m.t === 'court');
const mating = { t: 'mating', commit: {}, record: {} } as unknown as LifeMsg;
const ask = (): MateAsk =>
  signMateAsk(them, {
    creature: THEIRS,
    partner: me.playerId,
    partnerCreature: MINE,
    nonce: NONCE,
  });

beforeEach(async () => {
  me = await createIdentity(memoryKeyStore());
  them = await createIdentity(memoryKeyStore());
  clock = 1000;
  sent = [];
  own = view();
  flow = new MateFlow({
    identity: () => me,
    nonce: () => NONCE,
    now: () => clock,
    own: () => own,
    nameOf: (id) => (id === them.playerId ? 'Mira' : undefined),
  });
  flow.attach({ send: (m) => sent.push(m) });
});

describe('courting', () => {
  it('sends one court per press once the partner has been checked', () => {
    flow.check(them.playerId);
    expect(sent).toEqual([{ t: 'mate-check', partner: them.playerId }]);
    flow.receive(info());
    flow.court(them.playerId);
    flow.court(them.playerId);
    flow.court(them.playerId);
    expect(courts()).toHaveLength(1);
    expect(flow.view().state).toBe('courting');
    const court = courts()[0] as Extract<ClientMsg, { t: 'court' }>;
    expect(court.ask).toMatchObject({
      creature: MINE,
      partner: them.playerId,
      partnerCreature: THEIRS,
      nonce: NONCE,
    });
  });

  it('checks first when a press comes before the answer, then courts', () => {
    flow.court(them.playerId);
    expect(flow.view().state).toBe('checking');
    expect(sent).toEqual([{ t: 'mate-check', partner: them.playerId }]);
    flow.receive(info());
    expect(courts()).toHaveLength(1);
    expect(flow.view().state).toBe('courting');
  });

  it('shows the reason and does not court when the check says no', () => {
    flow.court(them.playerId);
    flow.receive(info({ reason: 'partner-not-mature' }));
    expect(courts()).toHaveLength(0);
    expect(flow.view().state).toBe('declined');
    expect(flow.view().note).toBe('Mira: Not mature yet');
  });

  it('does nothing when its own creature may not mate', () => {
    own = view({ activeMs: 1000 });
    flow.court(them.playerId);
    expect(sent).toHaveLength(0);
    expect(flow.view().state).toBe('idle');
  });

  it('expires after 20 s without an answer', () => {
    flow.receive(info());
    flow.court(them.playerId);
    clock += RULES.mating.signWindowMs - 1;
    flow.tick();
    expect(flow.view().state).toBe('courting');
    clock += 1;
    flow.tick();
    expect(flow.view().state).toBe('expired');
    expect(flow.view().note).toBe('No answer');
  });

  it('ends on a decline and may court again', () => {
    flow.receive(info());
    flow.court(them.playerId);
    flow.receive({ t: 'declined', by: them.playerId });
    expect(flow.view().state).toBe('declined');
    expect(flow.view().note).toBe('Mira said no');
    flow.court(them.playerId);
    expect(courts()).toHaveLength(2);
  });

  it('moves to awaiting on mating, owes the cost once, and is done on born', () => {
    flow.receive(info());
    flow.court(them.playerId);
    flow.receive(mating);
    expect(flow.view().state).toBe('awaiting');
    expect(flow.view().note).toBe('Awaiting beacon');
    expect(flow.takeCost()).toBe(true);
    expect(flow.takeCost()).toBe(false);
    flow.court(them.playerId);
    expect(courts()).toHaveLength(1);
    flow.receive({ t: 'born' } as unknown as LifeMsg);
    expect(flow.view().state).toBe('done');
  });

  it('shows a refusal from the hub in plain words', () => {
    flow.receive(info());
    flow.court(them.playerId);
    flow.receive({ t: 'refused', reason: 'not-here' } as LifeMsg);
    expect(flow.view().state).toBe('declined');
    expect(flow.view().note).toBe('Out of reach');
  });

  it('ignores the refusals that belong to the life flow', () => {
    flow.receive(info());
    flow.court(them.playerId);
    flow.receive({ t: 'refused', reason: 'dead' } as LifeMsg);
    expect(flow.view().state).toBe('courting');
  });
});

describe('the invitation', () => {
  const invite = (): LifeMsg => ({
    t: 'invite',
    from: them.playerId,
    ask: ask(),
    kinship: 0.25,
    generation: 3,
  });

  it('shows who asks, the words for kinship and a 15 s countdown', () => {
    flow.receive(invite());
    const v = flow.view();
    expect(v.state).toBe('invited');
    expect(v.invite).toMatchObject({ from: them.playerId, name: 'Mira', generation: 3 });
    expect(v.invite?.band).toContain('Very close');
    expect(v.inviteLeftMs).toBe(RULES.mating.acceptShownMs);
    clock += 5000;
    expect(flow.view().inviteLeftMs).toBe(RULES.mating.acceptShownMs - 5000);
  });

  it('accepts with a signed ask that names the courting player, then signs', () => {
    const incoming = invite();
    flow.receive(incoming);
    flow.accept();
    flow.accept();
    const accepts = sent.filter((m) => m.t === 'accept');
    expect(accepts).toHaveLength(1);
    const mine = (accepts[0] as Extract<ClientMsg, { t: 'accept' }>).ask;
    expect(mine).toMatchObject({ creature: MINE, partner: them.playerId, partnerCreature: THEIRS });
    expect(
      checkMatePair((incoming as { ask: MateAsk }).ask, them.playerId, mine, me.playerId),
    ).toEqual([]);
    expect(flow.view().state).toBe('signing');
    flow.receive(mating);
    expect(flow.view().state).toBe('awaiting');
    expect(flow.takeCost()).toBe(true);
  });

  it('declines on Esc and when the 15 s run out', () => {
    flow.receive(invite());
    flow.decline();
    expect(sent).toContainEqual({ t: 'decline', partner: them.playerId });
    expect(flow.view().state).toBe('declined');

    sent = [];
    flow.receive(invite());
    clock += RULES.mating.acceptShownMs;
    flow.tick();
    expect(sent).toContainEqual({ t: 'decline', partner: them.playerId });
    expect(flow.view().invite).toBeNull();
  });

  it('declines at once when it is busy, or not able to mate', () => {
    own = view({ hasPending: true });
    flow.receive(invite());
    expect(sent).toContainEqual({ t: 'decline', partner: them.playerId });
    expect(flow.view().state).toBe('idle');
  });

  it('drops an invitation whose courting player cancelled', () => {
    flow.receive(invite());
    flow.receive({ t: 'refused', reason: 'expired' } as LifeMsg);
    expect(flow.view().invite).toBeNull();
    expect(flow.view().state).toBe('declined');
  });
});

describe('the hint beside a nearby creature', () => {
  const near = { id: 'p', name: 'Mira', biomass: 100 };
  const partner = { ...near, id: 'p' };

  it('offers the court when the client sees nothing wrong', () => {
    const hint = flow.hint({ ...partner, id: them.playerId });
    expect(hint).toEqual({ court: true, text: 'E: court Mira' });
  });

  it('gives the plain reason for itself, size, and what the hub said', () => {
    own = view({ activeMs: 50_000 });
    expect(flow.hint({ ...partner, id: them.playerId })).toEqual({
      court: false,
      text: 'Not mature yet',
    });
    own = view({ cooldownUntilMs: 600_000 });
    expect(flow.hint({ ...partner, id: them.playerId })?.text).toBe('Rest for 3:20');
    own = view({ energy: 0.1 * maxEnergy(100) });
    expect(flow.hint({ ...partner, id: them.playerId })?.text).toBe('Needs more energy');
    own = view();
    expect(flow.hint({ ...partner, id: them.playerId, biomass: 300_000 })?.text).toBe(
      'Too big or too small',
    );
    flow.receive(info({ reason: 'partner-pending' }));
    expect(flow.hint({ ...partner, id: them.playerId })?.text).toBe(
      'Mira: Already has an offspring waiting',
    );
  });

  it('has no hint without a creature, and while a court is under way', () => {
    own = null;
    expect(flow.hint({ ...partner, id: them.playerId })).toBeNull();
    own = view();
    flow.receive(info());
    flow.court(them.playerId);
    expect(flow.hint({ ...partner, id: them.playerId })).toBeNull();
  });

  it('asks the hub again only when its answer is stale, and at most once in a while', () => {
    flow.check(them.playerId);
    flow.check(them.playerId);
    expect(sent).toHaveLength(1);
    flow.receive(info());
    clock += 1000;
    flow.check(them.playerId);
    expect(sent).toHaveLength(1);
    clock += 5000;
    flow.check(them.playerId);
    expect(sent).toHaveLength(2);
  });
});

describe('a new connection', () => {
  it('forgets a court that was waiting and an answer that was cached', () => {
    flow.receive(info());
    flow.court(them.playerId);
    flow.attach({ send: (m) => sent.push(m) });
    expect(flow.view().state).toBe('idle');
    sent = [];
    flow.court(them.playerId);
    expect(sent).toEqual([{ t: 'mate-check', partner: them.playerId }]);
  });
});
