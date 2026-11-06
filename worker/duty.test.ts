import { describe, expect, it } from 'vitest';
import type { HubMsg } from '../src/net/protocol';
import { OFFER_MS, witnessView } from './duty';
import {
  advance,
  authority,
  fighters,
  outOfReach,
  type Player,
  useFightHub,
} from './fight-test-kit';
import type { Session } from './socket';
import { flush, nextOf, publish } from './test-hub';
import { commitWitnesses } from './witness-pool';
import {
  byPlayer,
  orderOf,
  poolNow,
  useWitnessHub,
  type Witness,
  witnessCommit,
  witnesses,
} from './witness-test-kit';

// M10 T4: duty offers (ADR 0058), on the hand clock. A fight started on the object directly, out
// of reach so it runs its 90 s, commits its witnesses as lock-in does; its round then resolves.

useFightHub();
useWitnessHub();

interface Witnessed {
  a: Player;
  b: Player;
  enc: string;
  event: string;
  ws: Witness[];
  /** The witness at each position of the order. */
  at: (position: number) => Witness;
}

/** A running fight with `n` eligible witnesses, its commitment written and its round published. */
async function witnessed(n: number): Promise<Witnessed> {
  const [a, b] = await fighters();
  const ws = await witnesses(n);
  const start = await outOfReach(a, b);
  const event = `enc:${start.enc}`;
  await authority((o) => commitWitnesses(o, 'enc', start.enc, [a.id.playerId, b.id.playerId]));
  const commit = await witnessCommit(event);
  if (!commit) throw new Error('no witness commitment');
  const order = orderOf(commit, commit.id);
  await publish(commit.commitment.round);
  return { a, b, enc: start.enc, event, ws, at: (p) => byPlayer(ws, order[p]) };
}

const offersOf = (event: string) =>
  authority((o) => witnessView(o, event)?.offers.map((x) => [x.position, x.outcome]));
const types = (msgs: HubMsg[]) => msgs.map((m) => m.t);
const peerOf = async (p: Player) => {
  const m = await nextOf(p.c, 'duty-peer');
  return [m.peer, m.on];
};

describe('witness duties', () => {
  it('offers the referee duty to position 0 when the round resolves, and tells both fighters', async () => {
    const f = await witnessed(3);
    const duty = await nextOf(f.at(0).c, 'duty');
    expect(duty).toMatchObject({ event: f.event, role: 'referee', position: 0 });
    if (duty.role !== 'referee') throw new Error('not a referee duty');
    expect(duty.fighters.sort()).toEqual([f.a.id.playerId, f.b.id.playerId].sort());
    expect(duty.start.enc).toBe(f.enc);
    expect(duty.history.every((h) => h.t === 'enc-frame')).toBe(true);
    for (const p of [f.a, f.b]) expect(await peerOf(p)).toEqual([f.at(0).id.playerId, true]);
    // Nobody else hears of it.
    for (const p of [1, 2]) expect(types(await flush(f.at(p).c))).not.toContain('duty');
    expect(await offersOf(f.event)).toEqual([[0, 'pending']]);
  });

  it('moves a declined offer to position 2 (1 is the auditor’s), and so does 5 s of silence', async () => {
    const f = await witnessed(5);
    await nextOf(f.at(0).c, 'duty');
    f.at(0).c.send({ t: 'duty-no', event: f.event });
    expect((await nextOf(f.at(2).c, 'duty')).position).toBe(2);
    for (const p of [f.a, f.b]) {
      expect(await peerOf(p)).toEqual([f.at(0).id.playerId, true]);
      expect(await peerOf(p)).toEqual([f.at(0).id.playerId, false]);
      expect(await peerOf(p)).toEqual([f.at(2).id.playerId, true]);
    }
    await advance(OFFER_MS);
    expect((await nextOf(f.at(2).c, 'duty-end')).why).toBe('replaced');
    expect((await nextOf(f.at(3).c, 'duty')).position).toBe(3);
    // The third offer is the last: a decline ends the duty.
    f.at(3).c.send({ t: 'duty-no', event: f.event });
    await flush(f.at(3).c);
    expect(types(await flush(f.at(4).c))).not.toContain('duty');
    expect(types(await flush(f.at(1).c))).not.toContain('duty');
    expect(await offersOf(f.event)).toEqual([
      [0, 'no'],
      [2, 'silent'],
      [3, 'no'],
    ]);
  });

  it('holds one duty per player, and drops a duty-ok from someone not offered', async () => {
    const f = await witnessed(4);
    await nextOf(f.at(0).c, 'duty');
    expect(await poolNow([f.a, f.b])).not.toContain(f.at(0).id.playerId);
    const strays = await authority((o) => o.duties.strays);
    f.at(3).c.send({ t: 'duty-ok', event: f.event });
    expect(types(await flush(f.at(3).c))).not.toContain('duty-end');
    expect(await authority((o) => o.duties.strays)).toBe(strays + 1);
    expect(await offersOf(f.event)).toEqual([[0, 'pending']]);
    // Taken: until T5 hands the fight over, the duty just ends, counted in the witness's hour.
    f.at(0).c.send({ t: 'duty-ok', event: f.event });
    expect((await nextOf(f.at(0).c, 'duty-end')).why).toBe('done');
    expect(await offersOf(f.event)).toEqual([[0, 'ok']]);
    const hour = await authority((o) => {
      for (const ws of o.ctx.getWebSockets()) {
        const s = ws.deserializeAttachment() as Session | null;
        if (s?.phase === 'active' && s.playerId === f.at(0).id.playerId) return s.duties;
      }
      return undefined;
    });
    expect(hour).toHaveLength(1);
    expect(await poolNow([f.a, f.b])).toContain(f.at(0).id.playerId);
  });

  it('moves an offer on when its player leaves', async () => {
    const f = await witnessed(3);
    await nextOf(f.at(0).c, 'duty');
    f.at(0).c.ws.close(1000, 'bye');
    await f.at(0).c.closed;
    expect((await nextOf(f.at(2).c, 'duty')).position).toBe(2);
    expect(await offersOf(f.event)).toEqual([
      [0, 'silent'],
      [2, 'pending'],
    ]);
  });

  it('ends a struck player’s duty, and never pools it again for a day', async () => {
    const f = await witnessed(3);
    await nextOf(f.at(0).c, 'duty');
    const struck = f.at(0).id.playerId;
    await authority((o) => o.duties.strike(struck, 'authority-only', f.event));
    expect((await nextOf(f.at(0).c, 'duty-end')).why).toBe('struck');
    expect(await offersOf(f.event)).toEqual([[0, 'failed']]);
    expect(await authority((o) => witnessView(o, f.event)?.struck)).toEqual([struck]);
    // A new fight's pool leaves it out.
    const [c, d] = await fighters();
    const start = await outOfReach(c, d);
    await authority((o) => commitWitnesses(o, 'enc', start.enc, [c.id.playerId, d.id.playerId]));
    const next = await witnessCommit(`enc:${start.enc}`);
    const pool = (next?.commitment.data as { pool: string[] } | undefined)?.pool;
    expect(pool?.length).toBe(2);
    expect(pool).not.toContain(struck);
  });

  it('offers nothing for a genesis until its audit is handed over', async () => {
    const ws = await witnesses(2);
    const p = await fighters().then(([x]) => x);
    const commit = await authority((o) =>
      commitWitnesses(o, 'genesis', 'ab'.repeat(32), [p.id.playerId]),
    );
    if (!commit) throw new Error('no commitment');
    await publish(commit.commitment.round);
    for (const w of ws) expect(types(await flush(w.c))).not.toContain('duty');
  });
});

describe('the signal relay for duty links (M10 T6)', () => {
  const env = (vars: Record<string, string | undefined>) =>
    authority((o) => {
      Object.assign(o.env as unknown as Record<string, string | undefined>, vars);
    });
  const offer = (from: Player | Witness, to: Player | Witness) =>
    from.c.send({ t: 'signal', to: to.id.playerId, kind: 'offer', sdp: 'v=0' });
  const relayed = async (from: Player | Witness, to: Player | Witness) => {
    offer(from, to);
    const got = await nextOf(to.c, 'signal');
    return got.from === from.id.playerId;
  };
  const refused = async (from: Player | Witness, to: Player | Witness) => {
    offer(from, to);
    const back = await nextOf(from.c, 'error');
    const theirs = await flush(to.c);
    return back.code === 'no-peer' && !types(theirs).includes('signal');
  };

  it('passes signals between a referee witness and a fighter in another pond only while the duty runs', async () => {
    await env({ DRAND_SOURCE: 'fixture', POND_MAX: '2' });
    try {
      const [a, b] = await fighters();
      const [w] = await witnesses(1);
      if (!w) throw new Error('no witness');
      expect(w.pond.id).not.toBe(a.pond.id);
      const start = await outOfReach(a, b);
      const event = `enc:${start.enc}`;
      await authority((o) => commitWitnesses(o, 'enc', start.enc, [a.id.playerId, b.id.playerId]));
      const commit = await witnessCommit(event);
      if (!commit) throw new Error('no witness commitment');
      // Before the round: no duty, no relay across ponds.
      expect(await refused(w, a)).toBe(true);
      expect(await refused(a, w)).toBe(true);
      await publish(commit.commitment.round);
      expect((await nextOf(w.c, 'duty')).role).toBe('referee');
      expect(await peerOf(a)).toEqual([w.id.playerId, true]);
      // While it is offered: both ways, with each fighter.
      expect(await relayed(w, a)).toBe(true);
      expect(await relayed(a, w)).toBe(true);
      expect(await relayed(w, b)).toBe(true);
      // Declined, with nobody left to offer: the duty is over and so is the relay.
      w.c.send({ t: 'duty-no', event });
      expect(await peerOf(a)).toEqual([w.id.playerId, false]);
      expect(await refused(w, a)).toBe(true);
      expect(await refused(b, w)).toBe(true);
    } finally {
      await env({ POND_MAX: undefined });
    }
  });
});
