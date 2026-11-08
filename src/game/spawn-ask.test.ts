import { describe, expect, it } from 'vitest';
import { aoiRadius } from '../net/aoi';
import type { ClientMsg } from '../net/protocol';
import { placeLife, SPAWN_WAIT_MS, SpawnAsk, spawnAskOf } from './spawn-ask';

/** Timers that run only when told, so no test waits on real time. */
function handTimers() {
  let t = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    set(run: () => void, ms: number) {
      const id = next++;
      due.set(id, { at: t + ms, run });
      return id;
    },
    clear(handle: unknown) {
      due.delete(handle as number);
    },
    advance(ms: number) {
      t += ms;
      for (const [id, d] of [...due]) {
        if (d.at <= t) {
          due.delete(id);
          d.run();
        }
      }
    },
  };
}

const ASK = spawnAskOf(100, 400);
const answer = { t: 'spawn', x: 131_500, y: 130_900, why: 'placed', protect: true } as const;

function online() {
  const sent: ClientMsg[] = [];
  const send = (msg: ClientMsg): boolean => {
    sent.push(msg);
    return true;
  };
  return { sent, send };
}

describe('spawnAskOf', () => {
  it('states the creature’s radius and the AoI of its size, within the wire’s ranges', () => {
    expect(ASK).toEqual({ t: 'spawn', r: 10, aoi: aoiRadius(10, 20) });
    expect(spawnAskOf(0, 0).r).toBe(1);
    expect(spawnAskOf(1e12, 1e12).aoi).toBe(40_000);
  });
});

describe('a life in the hub’s world (M12 T4)', () => {
  it('asks spawn once and begins at the answer, protected as the hub says', async () => {
    const timers = handTimers();
    const asker = new SpawnAsk(timers);
    const link = online();
    const placing = placeLife(asker, link.send, ASK);
    expect(link.sent).toEqual([ASK]);
    asker.receive(answer);
    // A second copy changes nothing.
    asker.receive(answer);
    expect(await placing).toEqual({
      inPond: true,
      place: { at: { x: answer.x, y: answer.y }, protect: true },
    });
    expect(link.sent).toHaveLength(1);
    expect(asker.last).toEqual({ x: answer.x, y: answer.y, why: 'placed', protect: true });
  });

  it('begins a promoted child where its parent was, asking nothing', async () => {
    const asker = new SpawnAsk(handTimers());
    const link = online();
    const parent = { at: { x: 1000, y: 2000 }, protect: true };
    expect(await placeLife(asker, link.send, ASK, parent)).toEqual({ inPond: true, place: parent });
    expect(link.sent).toEqual([]);
    expect(asker.last).toBeNull();
  });

  it('begins in a local world with no answer in 4 s, and with no link at once', async () => {
    const timers = handTimers();
    const asker = new SpawnAsk(timers);
    const link = online();
    let settled: unknown = 'waiting';
    const placing = placeLife(asker, link.send, ASK).then((p) => {
      settled = p;
    });
    timers.advance(SPAWN_WAIT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe('waiting');
    timers.advance(1);
    await placing;
    expect(settled).toEqual({ inPond: false });
    // An answer after the wait is still the last one, but begins nothing.
    asker.receive(answer);
    expect(asker.last).toMatchObject({ x: answer.x });
    expect(await placeLife(new SpawnAsk(timers), () => false, ASK)).toEqual({ inPond: false });
  });

  it('begins in a local world when the hub refuses (a locked creature)', async () => {
    const asker = new SpawnAsk(handTimers());
    const placing = placeLife(asker, online().send, ASK);
    asker.receive({ t: 'refused', reason: 'locked' });
    asker.receive({ t: 'refused', reason: 'spawn' });
    expect(await placing).toEqual({ inPond: false });
  });
});
