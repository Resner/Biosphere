import { beforeAll, describe, expect, it } from 'vitest';
import { startMsg, TEST_POND } from '../../tests/scripted-referee';
import { createIdentity, type Identity, memoryKeyStore } from '../ledger/identity';
import { keyVerifier } from '../ledger/key-verify';
import { inputSigned, signInput, signWitnessFrame, witnessFrameSigned } from '../ledger/witness';
import { EncounterSync } from './encounter-sync';
import { AUTHORITY } from './handover';
import type { PeerEvent } from './protocol';
import { FRAME_MS } from './referee';
import { type DisputeMsg, type InputMsg, KEEP_WITNESS_FRAMES, RefereeRoute } from './referee-route';

const ENC = 'e1'.repeat(32);

let me: Identity;
let w: Identity;
let other: Identity;
beforeAll(async () => {
  [me, w, other] = await Promise.all(
    Array.from({ length: 3 }, () => createIdentity(memoryKeyStore())),
  );
});

type FInput = Extract<PeerEvent, { t: 'finput' }>;

function setup() {
  const hub: (InputMsg | DisputeMsg)[] = [];
  const witness: [string, FInput][] = [];
  const route = new RefereeRoute({
    enc: ENC,
    sendHub: (m) => hub.push(m),
    sendWitness: (to, ev) => witness.push([to, ev]),
    signInput: (f, code) => signInput(me, ENC, f, code),
    frameSigned: (by, f, i, sig) => witnessFrameSigned(by, ENC, f, i, sig),
    oneWayMs: (by) => (by === AUTHORITY ? 40 : 90),
  });
  const input = (f: number, i = 100 + f): InputMsg => ({ t: 'input', enc: ENC, f, i });
  const wframe = (f: number, i: (number | null)[], by = w) => ({
    t: 'wframe' as const,
    enc: ENC,
    f,
    i,
    sig: signWitnessFrame(by, ENC, f, i),
  });
  return { route, hub, witness, input, wframe };
}

describe('the fighter’s route (M10 T3)', () => {
  it('sends inputs before the handover to the hub, and from it to the witness, signed', () => {
    const { route, hub, witness, input } = setup();
    route.send(input(30));
    expect(route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId })).toBe(true);
    for (const f of [31, 32, 33, 34]) route.send(input(f));
    expect(hub.map((m) => m.f)).toEqual([30, 31, 32]);
    expect(hub.every((m) => m.t === 'input')).toBe(true);
    expect(witness.map(([to, ev]) => [to, ev.f])).toEqual([
      [w.playerId, 33],
      [w.playerId, 34],
    ]);
    const key = keyVerifier(me.playerId);
    if (!key) throw new Error('no key');
    for (const [, ev] of witness) expect(inputSigned(key, ENC, ev.f, ev.i, ev.sig)).toBe(true);
  });

  it('leads by the one-way latency to each frame’s referee', () => {
    const { route } = setup();
    route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId });
    expect([route.oneWayMs(32), route.oneWayMs(33)]).toEqual([40, 90]);
  });

  it('sends each input already sent for a frame from the handover once more, to the new referee', () => {
    const { route, hub, witness, input } = setup();
    for (let f = 28; f <= 35; f++) route.send(input(f));
    expect(hub).toHaveLength(8);
    route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId });
    expect(witness.map(([, ev]) => [ev.f, ev.i])).toEqual([
      [33, 133],
      [34, 134],
      [35, 135],
    ]);
    expect(route.resent).toBe(3);
    // And back: a take-back from 40 sends 40 and 41 to the hub again.
    for (let f = 36; f <= 41; f++) route.send(input(f));
    hub.length = 0;
    route.referee({ t: 'enc-referee', enc: ENC, from: 40, by: AUTHORITY });
    expect(hub.map((m) => m.f)).toEqual([40, 41]);
    expect(route.resent).toBe(5);
    route.send(input(42));
    expect(hub.map((m) => m.f)).toEqual([40, 41, 42]);
  });

  it('ignores a handover for another fight or not past the last', () => {
    const { route } = setup();
    expect(route.referee({ t: 'enc-referee', enc: 'ab'.repeat(32), from: 3, by: w.playerId })).toBe(
      false,
    );
    expect(route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId })).toBe(true);
    expect(route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: AUTHORITY })).toBe(false);
    expect(route.refereeOf(40)).toBe(w.playerId);
  });

  it('takes a witness frame only from the frame’s referee, signed by it', () => {
    const { route, wframe } = setup();
    route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId });
    expect(route.witnessFrame(w.playerId, wframe(32, [1, 2]))).toBeNull();
    expect(route.witnessFrame(other.playerId, wframe(33, [1, 2], other))).toBeNull();
    expect(route.witnessFrame(w.playerId, { ...wframe(33, [1, 2]), i: [1, 3] })).toBeNull();
    expect(route.dropped).toBe(3);
    expect(route.witnessFrame(w.playerId, wframe(33, [1, 2]))).toEqual({
      t: 'enc-frame',
      enc: ENC,
      f: 33,
      i: [1, 2],
    });
    expect(route.witnessFrame(w.playerId, wframe(33, [1, 2]))).toBeNull();
  });

  it('gives one resync and one dispute for a differing authority frame, and nothing for an equal one', () => {
    const { route, hub, wframe } = setup();
    route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId });
    route.witnessFrame(w.playerId, wframe(33, [1, 2]));
    route.witnessFrame(w.playerId, wframe(34, [5, 6]));
    route.witnessFrame(w.playerId, wframe(35, [7, 8]));
    expect(route.hubFrame({ t: 'enc-frame', enc: ENC, f: 33, i: [1, 2] })).toBe(false);
    expect(hub).toHaveLength(0);
    expect(route.hubFrame({ t: 'enc-frame', enc: ENC, f: 34, i: [5, null] })).toBe(true);
    expect(route.resyncs).toBe(1);
    expect(route.disputes).toBe(1);
    const dispute = hub[0] as DisputeMsg;
    expect(dispute).toMatchObject({ t: 'dispute', enc: ENC, f: 34, i: [5, 6] });
    expect(witnessFrameSigned(w.playerId, ENC, dispute.f, dispute.i, dispute.sig)).toBe(true);
    // The next differing frame is overruled too, but the witness is disputed once.
    expect(route.hubFrame({ t: 'enc-frame', enc: ENC, f: 35, i: [7, 9] })).toBe(true);
    expect(route.resyncs).toBe(2);
    expect(hub).toHaveLength(1);
  });

  it('disputes a witness frame that comes after a differing authority frame', () => {
    const { route, hub, wframe } = setup();
    route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId });
    expect(route.hubFrame({ t: 'enc-frame', enc: ENC, f: 33, i: [1, 2] })).toBe(false);
    expect(route.witnessFrame(w.playerId, wframe(33, [1, 4]))).toBeNull();
    expect(hub).toMatchObject([{ t: 'dispute', f: 33, i: [1, 4] }]);
  });

  it('never disputes a frame a take-back gave the authority', () => {
    const { route, hub, wframe } = setup();
    route.referee({ t: 'enc-referee', enc: ENC, from: 33, by: w.playerId });
    route.witnessFrame(w.playerId, wframe(40, [1, 2]));
    route.referee({ t: 'enc-referee', enc: ENC, from: 40, by: AUTHORITY });
    expect(route.hubFrame({ t: 'enc-frame', enc: ENC, f: 40, i: [1, null] })).toBe(true);
    expect(hub).toHaveLength(0);
  });

  it('keeps the witness’s last 50 frames', () => {
    const { route, hub, wframe } = setup();
    route.referee({ t: 'enc-referee', enc: ENC, from: 1, by: w.playerId });
    for (let f = 1; f <= 60; f++) route.witnessFrame(w.playerId, wframe(f, [f, f]));
    expect(route.hubFrame({ t: 'enc-frame', enc: ENC, f: 60 - KEEP_WITNESS_FRAMES, i: [0, 0] })).toBe(
      false,
    );
    expect(route.hubFrame({ t: 'enc-frame', enc: ENC, f: 61 - KEEP_WITNESS_FRAMES, i: [0, 0] })).toBe(
      true,
    );
    expect(hub).toHaveLength(1);
  });
});

describe('the authority overrules a witness’s frame in the fight (M10 T3)', () => {
  it('rolls the fight back to the authority’s frame', () => {
    const msg = startMsg(10_000);
    const sync = new EncounterSync({
      me: 'pa',
      sample: () => null,
      send: () => {},
      oneWayMs: () => 0,
    });
    sync.start(msg, TEST_POND);
    const frame = (f: number, i: (number | null)[]) => ({ t: 'enc-frame' as const, enc: msg.enc, f, i });
    for (let f = 0; f < 5; f++) sync.receive(frame(f, [null, null]));
    sync.step(msg.at + 5 * FRAME_MS + 1);
    const before = sync.rollbacks;
    expect(sync.overrule(frame(3, [null, null]))).toBe(false);
    expect(sync.overrule(frame(3, [null]))).toBe(false);
    expect(sync.overrule(frame(3, [7, null]))).toBe(true);
    expect(sync.held[3]).toEqual([7, null]);
    sync.step(msg.at + 5 * FRAME_MS + 2);
    expect(sync.rollbacks).toBe(before + 1);
    // A frame not held yet is simply taken.
    expect(sync.overrule(frame(5, [1, 1]))).toBe(true);
    expect(sync.held[5]).toEqual([1, 1]);
  });
});
