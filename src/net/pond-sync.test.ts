import { describe, expect, it } from 'vitest';
import { STARTER_PHYS } from '../sim/body';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import type { CreatureState } from '../sim/types';
import { maxEnergy, maxHealth } from '../sim/vitals';
import {
  FADE_AFTER_MS,
  INTERPOLATION_MS,
  REMOVE_AFTER_MS,
  RemoteBuffer,
  RemoteSet,
  SnapshotSender,
  snapshotOf,
} from './pond-sync';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from './protocol';

const TICK_MS = 1000 / 30;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    seq: 0,
    tick: 0,
    x: 0,
    y: 0,
    heading: 0,
    vx: 0,
    vy: 0,
    biomass: 100,
    energy: 1,
    health: 1,
    alive: true,
    dashing: false,
    ...over,
  };
}

/** A creature swimming east at 60 wu/s from x = 1000, sampled at `ms` of pond time. */
function swimming(seq: number, ms: number): Snapshot {
  return snap({ seq, tick: Math.round(ms / TICK_MS), x: 1000 + (60 * ms) / 1000, y: 500, vx: 60 });
}

describe('SnapshotSender', () => {
  it('emits 10 Hz at 60 fps on a fake clock, within one', () => {
    const sent: Uint8Array[] = [];
    const sender = new SnapshotSender((bytes) => sent.push(bytes));
    for (let ms = 0; ms <= 10_000; ms += 1000 / 60) sender.update(ms, false, () => snap());
    expect(sent.length).toBeGreaterThanOrEqual(99);
    expect(sent.length).toBeLessThanOrEqual(101);
  });

  it('numbers snapshots in order and sends valid bytes', () => {
    const sent: Uint8Array[] = [];
    const sender = new SnapshotSender((bytes) => sent.push(bytes));
    for (let ms = 0; ms < 450; ms += 10) sender.update(ms, false, () => snap({ x: 12.5 }));
    const decoded = sent.map((b) => decodeSnapshot(b));
    expect(decoded.map((d) => d?.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(decoded[0]?.x).toBe(12.5);
  });

  it('sends nothing while the tab is hidden, and does not burst afterwards', () => {
    const sent: Uint8Array[] = [];
    const sender = new SnapshotSender((bytes) => sent.push(bytes));
    sender.update(0, false, () => snap());
    for (let ms = 100; ms < 5000; ms += 100) sender.update(ms, true, () => snap());
    expect(sent.length).toBe(1);
    sender.update(5000, false, () => snap());
    sender.update(5010, false, () => snap());
    expect(sent.length).toBe(2);
  });

  it('does not build a snapshot when none is due', () => {
    let built = 0;
    const build = (): Snapshot => {
      built++;
      return snap();
    };
    const sender = new SnapshotSender(() => {});
    sender.update(0, false, build);
    sender.update(50, false, build);
    expect(built).toBe(1);
  });
});

describe('RemoteBuffer', () => {
  it('stays within 0.5 wu of a 60 wu/s swimmer through jitter, loss and reordering', () => {
    const rng = createRng(seedFromString('remote-buffer'), 'jitter');
    const buffer = new RemoteBuffer();
    interface Packet {
      arrival: number;
      snapshot: Snapshot;
    }
    const packets: Packet[] = [];
    for (let i = 0; i < 260; i++) {
      if (rng.next() < 0.05) continue;
      const sentAt = i * 100;
      packets.push({
        arrival: sentAt + 40 + (rng.next() * 2 - 1) * 30,
        snapshot: swimming(i, sentAt),
      });
    }
    packets.sort((a, b) => a.arrival - b.arrival);

    let worst = 0;
    let next = 0;
    for (let now = 3000; now < 23_000; now += 1000 / 60) {
      while (packets[next] && (packets[next] as Packet).arrival <= now) {
        buffer.push((packets[next] as Packet).snapshot);
        next++;
      }
      const at = buffer.sample(now - INTERPOLATION_MS);
      expect(at).not.toBeNull();
      const truth = 1000 + (60 * (now - INTERPOLATION_MS)) / 1000;
      worst = Math.max(worst, Math.abs((at?.x ?? 0) - truth));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('keeps the newest snapshot when an older one arrives late', () => {
    const buffer = new RemoteBuffer();
    expect(buffer.push(swimming(5, 500))).toBe(true);
    expect(buffer.push(swimming(3, 300))).toBe(false);
    expect(buffer.push(swimming(5, 500))).toBe(false);
    expect(buffer.push(swimming(6, 600))).toBe(true);
  });

  it('treats sequence numbers as wrapping', () => {
    const buffer = new RemoteBuffer();
    buffer.push(swimming(0xfffe, 100));
    expect(buffer.push(swimming(0xffff, 200))).toBe(true);
    expect(buffer.push(swimming(0, 300))).toBe(true);
    expect(buffer.push(swimming(0xfffd, 50))).toBe(false);
  });

  it('accepts a peer that reloaded and counts from zero again', () => {
    const buffer = new RemoteBuffer();
    buffer.push(swimming(500, 5000));
    expect(buffer.push(swimming(0, 6000))).toBe(true);
    expect(buffer.push(swimming(1, 6100))).toBe(true);
    expect(buffer.sample(6100)?.x).toBeCloseTo(1000 + 60 * 6.1, 0);
  });

  it('turns the short way across the heading seam', () => {
    const buffer = new RemoteBuffer();
    buffer.push(snap({ seq: 0, tick: 0, heading: 6.1 }));
    buffer.push(snap({ seq: 1, tick: 3, heading: 0.2 }));
    const mid = buffer.sample(50);
    const heading = mid?.heading ?? 0;
    // Halfway between 6.1 and 0.2 + 2π is about 6.3 rad, which is 0.02 after the seam.
    const wrapped = Math.min(heading, 2 * Math.PI - heading);
    expect(wrapped).toBeLessThan(0.15);
  });

  it('extrapolates for 250 ms across a gap, then holds', () => {
    const buffer = new RemoteBuffer();
    buffer.push(swimming(0, 0));
    buffer.push(swimming(1, 100));
    const newest = 1000 + 6;
    const atGap = buffer.sample(100 + 200);
    expect(atGap?.x).toBeCloseTo(newest + 60 * 0.2, 0);
    const held = buffer.sample(100 + 250);
    const later = buffer.sample(100 + 2000);
    expect(later?.x).toBeCloseTo(held?.x ?? 0, 6);
    expect(held?.x).toBeCloseTo(newest + 60 * 0.25, 0);
  });

  it('returns null before it has heard anything', () => {
    expect(new RemoteBuffer().sample(0)).toBeNull();
  });
});

describe('RemoteSet', () => {
  const send = (set: RemoteSet, id: string, s: Snapshot, localMs: number): void => {
    set.receive(id, s, localMs);
  };

  it('fades after 2 s of silence over 1 s, is removed after 6 s, and returns on a snapshot', () => {
    const set = new RemoteSet();
    set.setMember('a', 'Alice');
    send(set, 'a', swimming(0, 0), 0);
    const alphaAt = (ms: number): number | undefined => set.sample(ms, ms)[0]?.alpha;
    expect(alphaAt(FADE_AFTER_MS - 1)).toBe(1);
    expect(alphaAt(FADE_AFTER_MS + 500)).toBeCloseTo(0.5, 5);
    expect(alphaAt(FADE_AFTER_MS + 1000)).toBe(0);
    expect(set.sample(REMOVE_AFTER_MS - 1, 0)).toHaveLength(1);
    expect(set.sample(REMOVE_AFTER_MS + 1, 0)).toHaveLength(0);
    send(set, 'a', swimming(1, 100), REMOVE_AFTER_MS + 100);
    const back = set.sample(REMOVE_AFTER_MS + 100, REMOVE_AFTER_MS + 100)[0];
    expect(back?.name).toBe('Alice');
    expect(back?.alpha).toBe(1);
  });

  it('does not count repeated packets as signs of life', () => {
    const set = new RemoteSet();
    send(set, 'a', swimming(3, 300), 0);
    for (let ms = 500; ms < 3000; ms += 500) send(set, 'a', swimming(3, 300), ms);
    expect(set.sample(2500, 0)[0]?.alpha).toBeLessThan(1);
  });

  it('bounds the drawn size whatever a peer claims', () => {
    const set = new RemoteSet();
    send(set, 'big', snap({ seq: 0, biomass: 6500 }), 0);
    send(set, 'tiny', snap({ seq: 0, biomass: 0 }), 0);
    const radii = Object.fromEntries(set.sample(0, 1000).map((r) => [r.id, r.radius]));
    expect(radii.big).toBeLessThanOrEqual(Math.sqrt(1000));
    expect(radii.tiny).toBeGreaterThan(1);
  });

  it('forgets a member who left the roster', () => {
    const set = new RemoteSet();
    set.setMember('a', 'Alice');
    send(set, 'a', swimming(0, 0), 0);
    set.removeMember('a');
    expect(set.sample(10, 10)).toHaveLength(0);
  });

  it('gives a stable hue from the player id and hides the dead', () => {
    const set = new RemoteSet();
    send(set, 'a', swimming(0, 0), 0);
    send(set, 'b', snap({ seq: 0, alive: false }), 0);
    const first = set.sample(10, 10);
    expect(first.map((r) => r.id)).toEqual(['a']);
    const hue = first[0]?.hue;
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(1);
    expect(set.sample(20, 20)[0]?.hue).toBe(hue);
  });

  it('round-trips quantised snapshots through the buffer', () => {
    const set = new RemoteSet();
    const bytes = encodeSnapshot(snap({ seq: 1, tick: 30, x: 100, y: 200, biomass: 400 }));
    const decoded = decodeSnapshot(bytes);
    if (!decoded) throw new Error('decode failed');
    send(set, 'a', decoded, 0);
    const out = set.sample(0, 1000)[0];
    expect(out?.radius).toBeCloseTo(20, 0);
  });
});

describe('snapshotOf', () => {
  const creature: CreatureState = {
    id: 'player',
    x: 10,
    y: 20,
    vx: 1,
    vy: 2,
    heading: 1,
    biomass: 100,
    energy: maxEnergy(100) / 2,
    health: maxHealth(100),
    dashReadyTick: 0,
    alive: true,
    cause: null,
    bornTick: 0,
    phys: STARTER_PHYS,
  };

  it('turns energy and health into fractions of their maxima', () => {
    const s = snapshotOf(creature, 40);
    expect(s.energy).toBeCloseTo(0.5, 6);
    expect(s.health).toBe(1);
    expect(s.dashing).toBe(false);
  });

  it('shows a dash for a few ticks after it starts', () => {
    const dashed = { ...creature, dashReadyTick: 100 + RULES.movement.dashCooldownTicks };
    expect(snapshotOf(dashed, 100).dashing).toBe(true);
    expect(snapshotOf(dashed, 103).dashing).toBe(true);
    expect(snapshotOf(dashed, 120).dashing).toBe(false);
    expect(snapshotOf(dashed, 99).dashing).toBe(false);
  });
});
