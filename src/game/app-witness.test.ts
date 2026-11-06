import { beforeAll, describe, expect, it } from 'vitest';
import rounds from '../../tests/fixtures/drand/rounds.json';
import { startMsg, TEST_POND } from '../../tests/scripted-referee';
import { randomnessOf } from '../ledger/drand';
import { commitmentId } from '../ledger/genesis';
import { createIdentity, type Identity, memoryKeyStore } from '../ledger/identity';
import { keyVerifier } from '../ledger/key-verify';
import {
  dutyEvent,
  inputSigned,
  signInput,
  witnessFrameSigned,
  witnessOrder,
} from '../ledger/witness';
import type { ClientMsg, DutyHistory, PeerEvent } from '../net/protocol';
import { FRAME_MS } from '../net/referee';
import type { RefereeDuty } from '../net/witness-referee';
import { encodeFrameInput } from '../sim/encounter/codec';
import {
  ACCEPT_WAIT_MS,
  LINK_POLL_MS,
  selected,
  WitnessDuties,
  type WitnessHost,
} from './app-witness';

const CODE = encodeFrameInput({
  steer: 10,
  throttle: 1,
  dash: false,
  stance: 'balanced',
  target: 1,
  brace: false,
});

let a: Identity;
let b: Identity;
let w: Identity;
let other: Identity;
beforeAll(async () => {
  const make = () => createIdentity(memoryKeyStore());
  [a, b, w, other] = await Promise.all([make(), make(), make(), make()]);
});

const beacon = rounds.beacons[0] as { round: number; signature: string };

/** A referee duty for a duel of `a` and `b` (fight `enc`), offered to `w` at its place in the order. */
function dutyFor(held = 5, enc?: string): RefereeDuty {
  const start = startMsg(10_000);
  if (enc) start.enc = enc;
  start.fighters = start.fighters.map((f, s) => ({ ...f, player: [a, b][s]?.playerId as string }));
  const event = dutyEvent('enc', start.enc);
  const pool = [w.playerId, other.playerId].sort();
  const commitment = {
    v: 1 as const,
    kind: 'witness',
    owner: '',
    round: beacon.round,
    req: 'ab'.repeat(32),
    t: 1,
    data: { event, pool },
  };
  const order = witnessOrder(pool, randomnessOf(beacon), commitmentId(commitment));
  const history: DutyHistory[] = Array.from({ length: held }, (_, f) => ({
    t: 'enc-frame',
    f,
    i: [CODE, CODE],
  }));
  return {
    t: 'duty',
    event,
    role: 'referee',
    position: order.indexOf(w.playerId),
    commit: { commitment, authSig: 'sig', keyId: 'k' },
    beacon,
    pondSeed: TEST_POND.seed,
    fighters: [a.playerId, b.playerId],
    start,
    history,
  };
}

/** A fake page around the runner: a hand clock, timers it fires, and what goes out. */
function page(me = () => w) {
  const clock = { hub: 10_000, perf: 0 };
  const hub: ClientMsg[] = [];
  const peers: [string, PeerEvent][] = [];
  const links = new Map<string, boolean>();
  const opened: string[] = [];
  const closed: string[] = [];
  let timer: { at: number; fn: () => void } | null = null;
  const host: WitnessHost = {
    identity: () => me(),
    hubNow: () => clock.hub,
    perfNow: () => clock.perf,
    sendHub: (m) => hub.push(m),
    sendPeer: (p, ev) => peers.push([p, ev]),
    dutyPeer: (_enc, p, on) => (on ? opened : closed).push(p),
    linkOpen: (p) => links.get(p) === true,
    busy: () => false,
    setTimer: (fn, ms) => {
      timer = { at: clock.perf + ms, fn };
      return timer;
    },
    clearTimer: (t) => {
      if (timer === t) timer = null;
    },
  };
  /** Moves both clocks on by `ms`, firing the timer whenever it is due. */
  const advance = (ms: number) => {
    const end = clock.perf + ms;
    while (timer && timer.at <= end) {
      const t = timer;
      clock.hub += t.at - clock.perf;
      clock.perf = t.at;
      timer = null;
      t.fn();
    }
    clock.hub += end - clock.perf;
    clock.perf = end;
  };
  const runner = new WitnessDuties(host);
  return { runner, clock, hub, peers, links, opened, closed, advance };
}

describe('the referee duty in the page (M10 T7)', () => {
  it('checks its own selection: only its place in the drand order is accepted', () => {
    const duty = dutyFor();
    expect(selected(duty, w.playerId)).toBe(true);
    expect(selected({ ...duty, position: 1 - duty.position }, w.playerId)).toBe(false);
    expect(selected(duty, other.playerId)).toBe(false);
    const later = rounds.beacons[1] as { round: number; signature: string };
    expect(selected({ ...duty, beacon: later }, w.playerId)).toBe(false);
  });

  it('answers duty-no when its selection does not check, and opens no link', () => {
    const p = page();
    const duty = dutyFor();
    p.runner.offer({ ...duty, position: 1 - duty.position });
    expect(p.hub).toEqual([{ t: 'duty-no', event: duty.event }]);
    expect(p.opened).toEqual([]);
    expect(p.runner.view()).toBeNull();
  });

  it('opens its duty links and sends duty-ok only once every fighter’s channels are open', () => {
    const p = page();
    const duty = dutyFor();
    p.runner.offer(duty);
    expect(p.opened.sort()).toEqual([a.playerId, b.playerId].sort());
    expect(p.runner.view()?.phase).toBe('linking');
    p.links.set(a.playerId, true);
    p.advance(LINK_POLL_MS * 5);
    expect(p.hub).toEqual([]);
    p.links.set(b.playerId, true);
    p.advance(LINK_POLL_MS);
    expect(p.hub).toEqual([{ t: 'duty-ok', event: duty.event }]);
    expect(p.runner.view()?.phase).toBe('accepted');
    expect(p.runner.onDuty).toBe(true);
    expect(p.runner.duties).toBe(1);
  });

  it('declines when its links never open, and closes them', () => {
    const p = page();
    const duty = dutyFor();
    p.runner.offer(duty);
    p.links.set(a.playerId, true);
    p.advance(ACCEPT_WAIT_MS);
    expect(p.hub).toEqual([{ t: 'duty-no', event: duty.event }]);
    expect(p.closed.sort()).toEqual([a.playerId, b.playerId].sort());
    expect(p.runner.view()).toBeNull();
  });

  it('referees from the handover: signed frames to the fighters and signed inputs in its batches', () => {
    const p = page();
    const duty = dutyFor(5);
    const enc = duty.start.enc;
    p.runner.offer(duty);
    p.links.set(a.playerId, true);
    p.links.set(b.playerId, true);
    p.advance(LINK_POLL_MS);
    p.hub.length = 0;
    // The fighters heard the handover first: A's input for frame 8 waits for the page's.
    const finput = (who: Identity, f: number) => ({
      t: 'finput' as const,
      enc,
      f,
      i: CODE,
      sig: signInput(who, enc, f, CODE),
    });
    p.clock.hub = duty.start.at + 6 * FRAME_MS;
    p.runner.input(a.playerId, finput(a, 8));
    p.runner.hubMsg({ t: 'enc-referee', enc, from: 8, by: w.playerId });
    expect(p.runner.view()?.phase).toBe('refereeing');
    for (const f of [5, 6, 7]) p.runner.hubMsg({ t: 'enc-frame', enc, f, i: [CODE, CODE] });
    p.runner.input(b.playerId, finput(b, 8));
    for (let f = 9; f < 20; f++) {
      p.runner.input(a.playerId, finput(a, f));
      p.runner.input(b.playerId, finput(b, f));
    }
    p.advance(20 * FRAME_MS);
    const frames = p.peers.map(([, ev]) => ev).filter((ev) => ev.t === 'wframe');
    expect(frames.length).toBeGreaterThanOrEqual(2 * 12);
    for (const ev of frames) {
      if (ev.t !== 'wframe') continue;
      expect(witnessFrameSigned(w.playerId, enc, ev.f, ev.i, ev.sig)).toBe(true);
    }
    // Frame 8 carries A's early input: nothing was lost to the handover's race.
    const eight = frames.find((ev) => ev.t === 'wframe' && ev.f === 8);
    expect(eight?.t === 'wframe' && eight.i).toEqual([CODE, CODE]);
    const batches = p.hub.filter((m) => m.t === 'batch');
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const keys = [keyVerifier(a.playerId), keyVerifier(b.playerId)];
    for (const batch of batches) {
      if (batch.t !== 'batch') continue;
      batch.i.forEach((inputs, k) => {
        inputs.forEach((code, slot) => {
          const sig = batch.s[k]?.[slot];
          if (code === null) return;
          const key = keys[slot];
          expect(key && sig && inputSigned(key, enc, batch.f + k, code, sig)).toBe(true);
        });
      });
    }
    expect(p.runner.dutyMs.length).toBeGreaterThan(0);
  });

  it('stops at a planned take-back’s frame, and at once on duty-end', () => {
    const p = page();
    const duty = dutyFor(5);
    const enc = duty.start.enc;
    p.runner.offer(duty);
    p.links.set(a.playerId, true);
    p.links.set(b.playerId, true);
    p.advance(LINK_POLL_MS);
    p.clock.hub = duty.start.at + 6 * FRAME_MS;
    p.runner.hubMsg({ t: 'enc-referee', enc, from: 8, by: w.playerId });
    for (const f of [5, 6, 7]) p.runner.hubMsg({ t: 'enc-frame', enc, f, i: [CODE, CODE] });
    p.runner.hubMsg({ t: 'enc-referee', enc, from: 12, by: 'authority' });
    p.advance(30 * FRAME_MS);
    const frames = p.peers.map(([, ev]) => ev).filter((ev) => ev.t === 'wframe');
    expect(Math.max(...frames.map((ev) => (ev.t === 'wframe' ? ev.f : -1)))).toBe(11);
    const last = p.hub.filter((m) => m.t === 'batch').at(-1);
    expect(last?.t === 'batch' && last.end).toBe(true);
    expect(p.runner.view()?.phase).toBe('stopped');

    p.runner.end({ t: 'duty-end', event: duty.event, why: 'taken-back' });
    expect(p.runner.view()).toBeNull();
    expect(p.runner.onDuty).toBe(false);
  });

  it('stops sending at once on duty-end, mid-span', () => {
    const p = page();
    const duty = dutyFor(5);
    const enc = duty.start.enc;
    p.runner.offer(duty);
    p.links.set(a.playerId, true);
    p.links.set(b.playerId, true);
    p.advance(LINK_POLL_MS);
    p.clock.hub = duty.start.at + 6 * FRAME_MS;
    p.runner.hubMsg({ t: 'enc-referee', enc, from: 8, by: w.playerId });
    for (const f of [5, 6, 7]) p.runner.hubMsg({ t: 'enc-frame', enc, f, i: [CODE, CODE] });
    p.advance(5 * FRAME_MS);
    p.runner.end({ t: 'duty-end', event: duty.event, why: 'struck' });
    const sent = p.peers.length + p.hub.length;
    p.advance(30 * FRAME_MS);
    expect(p.peers.length + p.hub.length).toBe(sent);
    expect(p.runner.view()).toBeNull();
  });

  it('holds one duty at a time', () => {
    const p = page();
    const duty = dutyFor();
    p.runner.offer(duty);
    const second = dutyFor(5, 'f2'.repeat(32));
    expect(selected(second, w.playerId)).toBe(true);
    p.runner.offer(second);
    expect(p.hub).toEqual([{ t: 'duty-no', event: second.event }]);
  });
});
