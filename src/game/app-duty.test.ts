import { describe, expect, it } from 'vitest';
import type { PeerEvent } from '../net/protocol';
import {
  AVAIL_EVERY_MS,
  AVAIL_LATE_MS,
  AVAIL_WINDOW_MS,
  Availability,
  type AvailInputs,
  DutyProbes,
  PROBE_EVERY_MS,
} from './app-duty';

// M10 T6: the page's `avail` (ADR 0058) on a fake clock: on only while the tab is visible, the
// setting on, the player not locked or fighting and its frame times' p90 over 5 s at most 50 ms.

const FRAME_MS = 16;
const ALL_RIGHT: AvailInputs = { visible: true, setting: true, busy: false };

function harness() {
  const sent: [number, boolean][] = [];
  let now = 0;
  const avail = new Availability((on) => sent.push([now, on]));
  const inputs: AvailInputs = { ...ALL_RIGHT };
  /** Runs frames of `ms` each for `forMs`, updating after each. */
  const run = (forMs: number, ms = FRAME_MS) => {
    const end = now + forMs;
    while (now < end) {
      now += ms;
      avail.frame(now, ms);
      avail.update(now, inputs);
    }
  };
  /** Changes an input and updates at once, as the page does on its events. */
  const set = (part: Partial<AvailInputs>) => {
    Object.assign(inputs, part);
    avail.update(now, inputs);
  };
  return { avail, sent, run, set, at: () => now };
}

describe('Availability', () => {
  it('turns on once everything has been right for 5 s, and says so once', () => {
    const h = harness();
    h.run(AVAIL_WINDOW_MS - 100);
    expect(h.sent).toEqual([]);
    expect(h.avail.on).toBe(false);
    h.run(200);
    expect(h.sent.map(([, on]) => on)).toEqual([true]);
    expect(h.avail.on).toBe(true);
    h.run(60_000);
    expect(h.sent).toHaveLength(1);
  });

  for (const [what, part] of [
    ['hidden', { visible: false }],
    ['the setting off', { setting: false }],
    ['fighting', { busy: true }],
  ] as const) {
    it(`turns off at once when ${what}`, () => {
      const h = harness();
      h.run(10_000);
      h.set(part);
      expect(h.sent.map(([, on]) => on)).toEqual([true, false]);
      expect(h.sent[1]?.[0]).toBe(h.at());
      expect(h.avail.on).toBe(false);
      h.run(30_000);
      expect(h.sent).toHaveLength(2);
      // Right again: on after another 5 s.
      h.set(ALL_RIGHT);
      h.run(AVAIL_WINDOW_MS + 100);
      expect(h.sent.map(([, on]) => on)).toEqual([true, false, true]);
    });
  }

  it('turns off when the frame times’ p90 reaches 60 ms', () => {
    const h = harness();
    h.run(10_000);
    // A few slow frames keep the p90 at 16 ms; two seconds of them pass 50 ms.
    for (let i = 0; i < 40; i++) h.run(i % 10 === 0 ? 60 : FRAME_MS, i % 10 === 0 ? 60 : FRAME_MS);
    expect(h.avail.on).toBe(true);
    expect(h.avail.p90(h.at())).toBeLessThanOrEqual(50);
    const before = h.sent.length;
    h.run(2000, 60);
    expect(h.avail.p90(h.at())).toBe(60);
    expect(h.sent.slice(before).map(([, on]) => on)).toEqual([false]);
    // Fast again: the slow frames leave the window, and 5 s later it is on.
    h.run(2 * AVAIL_WINDOW_MS + 500);
    expect(h.avail.on).toBe(true);
  });

  it('says nothing before it was ever on, and nothing while off', () => {
    const h = harness();
    h.set({ setting: false });
    h.run(20_000);
    expect(h.sent).toEqual([]);
  });

  it('sends at most one message per 5 s while visibility flaps', () => {
    const h = harness();
    h.run(20_000);
    const from = h.sent.length;
    for (let i = 0; i < 120; i++) {
      h.set({ visible: i % 2 === 1 });
      h.run(250);
    }
    const flapped = h.sent.slice(from - 1);
    for (let i = 1; i < flapped.length; i++) {
      const [t, prev] = [flapped[i]?.[0] ?? 0, flapped[i - 1]?.[0] ?? 0];
      expect(t - prev).toBeGreaterThanOrEqual(AVAIL_EVERY_MS);
    }
    expect(h.sent.length - from).toBeLessThanOrEqual(30_000 / AVAIL_EVERY_MS);
  });

  it('leaves the hub room for a late message: an `on` after a flap is never dropped', () => {
    // The hub counts an `on` at most once per 5 s from when it heard the last message
    // (`worker/witness-pool.ts`). It hears the `off` up to `AVAIL_LATE_MS` late, the `on` at once.
    const h = harness();
    h.run(10_000);
    const from = h.sent.length;
    h.set({ visible: false });
    h.set({ visible: true });
    h.run(3 * AVAIL_WINDOW_MS);
    const [off, on] = h.sent.slice(from) as [number, boolean][];
    expect([off?.[1], on?.[1]]).toEqual([false, true]);
    const heardOff = (off?.[0] ?? 0) + AVAIL_LATE_MS;
    const heardOn = on?.[0] ?? 0;
    expect(heardOn - heardOff).toBeGreaterThanOrEqual(AVAIL_EVERY_MS);
  });

  it('tells a new hub session again', () => {
    const h = harness();
    h.run(10_000);
    h.avail.reset();
    expect(h.avail.on).toBe(false);
    h.run(FRAME_MS);
    expect(h.sent.map(([, on]) => on)).toEqual([true, true]);
  });
});

describe('duty link probes (M10 T7)', () => {
  it('probes each open duty link once a second, answers probes, and halves the round trip', () => {
    const sent: [string, PeerEvent][] = [];
    const probes = new DutyProbes((peer, ev) => sent.push([peer, ev]));
    probes.tick(0, () => ['w', 'x']);
    probes.tick(PROBE_EVERY_MS - 1, () => ['w', 'x']);
    expect(sent.map(([p]) => p)).toEqual(['w', 'x']);
    expect(probes.oneWayMs('w')).toBeNull();
    const [, first] = sent[0] as [string, PeerEvent];
    if (first.t !== 'probe') throw new Error('not a probe');
    // An answer from another peer, or to no probe, counts for nothing.
    probes.receive('x', { t: 'probe', n: first.n, back: true }, 40);
    probes.receive('w', { t: 'probe', n: 999, back: true }, 40);
    expect(probes.oneWayMs('w')).toBeNull();
    probes.receive('w', { t: 'probe', n: first.n, back: true }, 40);
    expect(probes.oneWayMs('w')).toBe(20);
    // A peer's probe is answered at once with its own number.
    probes.receive('w', { t: 'probe', n: 7, back: false }, 50);
    expect(sent.at(-1)).toEqual(['w', { t: 'probe', n: 7, back: true }]);
    probes.tick(PROBE_EVERY_MS, () => ['w']);
    expect(sent.filter(([, ev]) => ev.t === 'probe' && !ev.back)).toHaveLength(3);
  });
});
