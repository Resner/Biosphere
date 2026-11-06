import { describe, expect, it } from 'vitest';
import { advance, authority, clock, setEnv, useFightHub } from './fight-test-kit';
import { pondMax } from './sessions';
import type { Session } from './socket';
import { flush, nextOf, signIn, sql } from './test-hub';
import {
  AVAIL_EVERY_MS,
  DUTIES_PER_HOUR,
  ipCheck,
  STRIKE_MS,
  WITNESS_PLAY_MS,
  witnessPlayMs,
} from './witness-pool';
import {
  credit,
  editWitness,
  nextIp,
  poolNow,
  setAvail,
  useWitnessHub,
  witness,
} from './witness-test-kit';

// M10 T4: who may witness (ADR 0058), on the hand clock. Every other session a test leaves
// open is closed after it, so the pool holds only this test's witnesses.

useFightHub();
useWitnessHub();

const fixture = (vars: Record<string, string | undefined>) =>
  authority((a) => {
    Object.assign(a.env as unknown as Record<string, string | undefined>, vars);
  });

describe('witness eligibility', () => {
  it('pools a seated session with avail on, 20 minutes of play, no strike, no duty and room in the hour', async () => {
    const w = await witness();
    expect(await poolNow()).toEqual([w.id.playerId]);
  });

  it('leaves out a session whose avail is off, and one that never said on', async () => {
    const w = await witness();
    const quiet = await witness({ avail: false });
    expect(await poolNow()).toEqual([w.id.playerId]);
    await setAvail(w.c, false);
    expect(await poolNow()).toEqual([]);
    // An `on` within 5 s of the last that counted is dropped; after it, it counts.
    await setAvail(w.c, true);
    expect(await poolNow()).toEqual([]);
    await advance(AVAIL_EVERY_MS);
    await setAvail(w.c, true);
    await setAvail(quiet.c, true);
    expect(await poolNow()).toEqual([w.id.playerId, quiet.id.playerId].sort());
  });

  it('needs 20 minutes of play: 19 min 59 s is not enough', async () => {
    const w = await witness({ playMs: WITNESS_PLAY_MS - 1000 });
    expect(await poolNow()).toEqual([]);
    await credit(w.id.playerId, 1000);
    expect(await poolNow()).toEqual([w.id.playerId]);
  });

  it('leaves out a struck player for a day', async () => {
    const w = await witness();
    await authority((a) => a.duties.strike(w.id.playerId, 'authority-only', 'test:strike'));
    expect(await poolNow()).toEqual([]);
    const [row] = await sql<{ until: number }>(
      'SELECT struck_until AS until FROM players WHERE id = ?',
      w.id.playerId,
    );
    expect(row?.until).toBe(clock.t + STRIKE_MS);
    await advance(STRIKE_MS);
    expect(await poolNow()).toEqual([w.id.playerId]);
  });

  it('leaves out a session that accepted 20 duties in the hour', async () => {
    const w = await witness();
    const times = (n: number) => Array.from({ length: n }, (_, k) => clock.t - k * 1000);
    await editWitness(w, (s) => ({ ...s, duties: times(DUTIES_PER_HOUR) }) satisfies Session);
    expect(await poolNow()).toEqual([]);
    await editWitness(w, (s) => ({ ...s, duties: times(DUTIES_PER_HOUR - 1) }) satisfies Session);
    expect(await poolNow()).toEqual([w.id.playerId]);
    await editWitness(w, (s) => ({ ...s, duties: times(DUTIES_PER_HOUR) }) satisfies Session);
    await advance(3_600_000);
    expect(await poolNow()).toEqual([w.id.playerId]);
  });

  it('leaves out the participants and anyone sharing a participant’s IP hash', async () => {
    const shared = nextIp();
    const fighter = await witness({ ip: shared });
    const twin = await witness({ ip: shared });
    const other = await witness();
    expect(await poolNow([fighter])).toEqual([other.id.playerId]);
    expect(await poolNow([])).toEqual(
      [fighter.id.playerId, twin.id.playerId, other.id.playerId].sort(),
    );
    // E2E contexts all share localhost: fixture mode may turn the IP check off.
    await fixture({ DRAND_SOURCE: 'fixture', WITNESS_IP_CHECK: 'off' });
    expect(await poolNow([fighter])).toEqual([twin.id.playerId, other.id.playerId].sort());
    await fixture({ WITNESS_IP_CHECK: undefined });
    await setEnv(false);
  });

  it('never pools a queued session', async () => {
    const seatedOne = await witness();
    await fixture({ MAX_SESSIONS: '1' });
    try {
      const { c, id } = await signIn(undefined, undefined, nextIp());
      expect((await c.next()).t).toBe('queued');
      await credit(id.playerId, WITNESS_PLAY_MS);
      c.send({ t: 'avail', on: true });
      expect((await nextOf(c, 'refused')).reason).toBe('queued');
      // Even marked available, a waiting session is in no pond and in no pool.
      await authority((a) => {
        for (const ws of a.ctx.getWebSockets()) {
          const s = ws.deserializeAttachment() as Session | null;
          if (s?.phase === 'queued' && s.playerId === id.playerId)
            ws.serializeAttachment({ ...s, avail: true });
        }
      });
      expect(await poolNow()).toEqual([seatedOne.id.playerId]);
      await flush(seatedOne.c);
    } finally {
      await fixture({ MAX_SESSIONS: '200' });
    }
  });

  it('reads WITNESS_PLAY_MS, WITNESS_IP_CHECK and POND_MAX only in fixture mode', () => {
    expect(witnessPlayMs({ WITNESS_PLAY_MS: '0' })).toBe(WITNESS_PLAY_MS);
    expect(witnessPlayMs({ DRAND_SOURCE: 'fixture', WITNESS_PLAY_MS: '0' })).toBe(0);
    expect(witnessPlayMs({ DRAND_SOURCE: 'fixture', WITNESS_PLAY_MS: '1.5' })).toBe(
      WITNESS_PLAY_MS,
    );
    expect(ipCheck({ WITNESS_IP_CHECK: 'off' })).toBe(true);
    expect(ipCheck({ DRAND_SOURCE: 'fixture', WITNESS_IP_CHECK: 'off' })).toBe(false);
    expect(pondMax({ POND_MAX: '2' })).toBe(24);
    expect(pondMax({ DRAND_SOURCE: 'fixture', POND_MAX: '2' })).toBe(2);
    for (const bad of ['1', '25', 'x'])
      expect(pondMax({ DRAND_SOURCE: 'fixture', POND_MAX: bad })).toBe(24);
  });

  it('seats a third session in a second pond under POND_MAX=2', async () => {
    await fixture({ DRAND_SOURCE: 'fixture', POND_MAX: '2' });
    try {
      const [x, y, z] = [await witness(), await witness(), await witness()];
      expect(x.pond.id).toBe(y.pond.id);
      expect(z.pond.id).not.toBe(x.pond.id);
    } finally {
      await fixture({ POND_MAX: undefined });
      await setEnv(false);
    }
  });
});
