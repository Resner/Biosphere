import { describe, expect, it } from 'vitest';
import { CLOSE_RATE_LIMITED } from '../src/net/protocol';
import { authority, fighters, join, lockIn, useFightHub } from './fight-test-kit';
import { nextOf } from './test-hub';

// Protocol 10's metering on the authority (M10 T2): a referee's batches and a fighter's disputes
// have their own window; the other witness messages count in the 20-message budget.

useFightHub();

const SIG = `${'c'.repeat(85)}A`;
const batch = (enc: string, f: number) => ({
  t: 'batch',
  enc,
  f,
  i: [[1, null]],
  s: [[SIG, null]],
  end: false,
});
const dispute = (enc: string, f: number) => ({ t: 'dispute', enc, f, i: [1, null], sig: SIG });
const droppedOf = (t: string) => authority((o) => (o.dropped as Map<string, number>).get(t) ?? 0);

describe('witness rate windows', () => {
  it('drops and counts a fighter’s batches past 30 in 10 s, and keeps its socket', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b);
    const before = await droppedOf('batch');
    for (let f = 0; f < 31; f++) a.c.send(batch(start.enc, f));
    a.c.send({ t: 'ping', id: 31 });
    expect((await nextOf(a.c, 'pong')).id).toBe(31);
    expect(await droppedOf('batch')).toBe(before + 1);
  });

  it('counts disputes in the same window as batches', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b);
    const batches = await droppedOf('batch');
    const disputes = await droppedOf('dispute');
    for (let f = 0; f < 29; f++) a.c.send(batch(start.enc, f));
    for (let f = 0; f < 3; f++) b.c.send(dispute(start.enc, f));
    a.c.send(dispute(start.enc, 0));
    a.c.send(dispute(start.enc, 1));
    a.c.send({ t: 'ping', id: 1 });
    b.c.send({ t: 'ping', id: 2 });
    await Promise.all([nextOf(a.c, 'pong'), nextOf(b.c, 'pong')]);
    // A's 30th message in the window passes, its 31st is dropped; B's 3 are within its own.
    expect(await droppedOf('batch')).toBe(batches);
    expect(await droppedOf('dispute')).toBe(disputes + 1);
  });

  it('counts batches and disputes from anyone not fighting in the 20-message budget', async () => {
    const { c } = await join();
    const enc = 'ab'.repeat(32);
    for (let f = 0; f < 15; f++) c.send(batch(enc, f));
    for (let f = 0; f < 10; f++) c.send(dispute(enc, f));
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });

  it.each([
    ['avail', { t: 'avail', on: true }],
    ['duty-ok', { t: 'duty-ok', event: `enc:${'ab'.repeat(32)}` }],
    ['duty-no', { t: 'duty-no', event: `mating:${'ab'.repeat(32)}` }],
  ])('counts %s in the 20-message budget', async (_, msg) => {
    const { c } = await join();
    for (let k = 0; k < 25; k++) c.send(msg);
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });

  it('counts attest in the 20-message budget', async () => {
    const { c, id } = await join();
    const attestation = {
      v: 1,
      kind: 'attest',
      event: `genesis:${'ab'.repeat(32)}`,
      duty: 'cd'.repeat(32),
      position: 0,
      witness: id.playerId,
      subject: 'ef'.repeat(32),
      agree: true,
    };
    for (let k = 0; k < 25; k++) c.send({ t: 'attest', signed: { attestation, sig: SIG } });
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });
});
