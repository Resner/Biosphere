import { describe, expect, it } from 'vitest';
import type { CreatureSource } from '../render/creature-cache';
import { EGG, type EggView, TETHER } from '../render/egg';
import { type EggFrame, EggShow, GHOST_MS } from './eggs';

const SELF = { x: 500, y: 300, heading: 0, radius: 12 };

function show() {
  const bursts: { x: number; y: number; radius: number; rings: number }[] = [];
  const eggs = new EggShow((x, y, radius, rings) => bursts.push({ x, y, radius, rings }));
  return { eggs, bursts };
}

const frame = (eggs: EggShow, now: number, over: Partial<EggFrame> = {}): readonly EggView[] =>
  eggs.frame({
    now,
    dt: 1 / 60,
    reduced: false,
    self: SELF,
    child: null,
    remotes: [],
    ...over,
  });

/** Runs frames from `from` to `to` ms at 60 Hz and returns the last frame's eggs. */
function run(eggs: EggShow, from: number, to: number, over: Partial<EggFrame> = {}) {
  let out: readonly EggView[] = [];
  for (let t = from; t <= to; t += 1000 / 60) out = frame(eggs, t, over);
  return out;
}

describe('EggShow', () => {
  it('a genesis: the egg covers the title cell, cracks on the beacon and the creature grows out', () => {
    const { eggs, bursts } = show();
    eggs.awaitGenesis(0);
    let out = frame(eggs, 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ x: SELF.x, y: SELF.y, parent: null });
    expect(out[0]?.radius).toBeGreaterThan(SELF.radius);
    expect(eggs.reveal.phase).toBe('waiting');
    eggs.genesisBeacon(4000);
    expect(eggs.reveal.phase).toBe('cracking');
    // Held until the creature is there.
    run(eggs, 4000, 8000);
    expect(bursts).toHaveLength(0);
    expect(eggs.hatched(8000, 'rare')).toBe(true);
    expect(eggs.reveal.emerge(8000)).toBe(0);
    run(eggs, 8000, 8000 + EGG.crackMs.rare + 20);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.rings).toBe(EGG.burstRings.rare);
    expect(eggs.reveal.phase).toBe('revealed');
    out = run(eggs, 8000 + EGG.crackMs.rare + 20, 8000 + EGG.crackMs.rare + EGG.burstMs.rare + 50);
    expect(out).toHaveLength(0);
    expect(eggs.ownShown).toBe(false);
    expect(eggs.mode).toBeNull();
    expect(eggs.reveal.visited).toEqual(['waiting', 'cracking', 'revealed']);
  });

  it('a mating: the egg waits beside the parent, bursts once by its rarity and stays carried', () => {
    const { eggs, bursts } = show();
    eggs.awaitMate(0);
    let out = run(eggs, 0, 1000);
    const egg = out[0] as EggView;
    expect(egg.parent).not.toBeNull();
    // Behind the parent, which faces east.
    expect(egg.x).toBeLessThan(SELF.x - SELF.radius);
    const child = { tier: 'exotic' as const, maxBiomass: 4000 };
    eggs.childRevealed(1000, 'child-1', 'exotic');
    eggs.childRevealed(1100, 'child-1', 'exotic');
    out = run(eggs, 1000, 1000 + EGG.crackMs.exotic + 20, { child });
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.rings).toBe(EGG.burstRings.exotic);
    out = run(eggs, 4000, 9000, { child });
    expect(out).toHaveLength(1);
    expect(out[0]?.pose).toMatchObject({ crack: 0, tier: 'exotic' });
    expect(out[0]?.pose.glow).toBeCloseTo(EGG.carriedGlow.exotic, 6);
    expect(bursts).toHaveLength(1);
  });

  it('carries a pending child behind the parent on a short tether', () => {
    const { eggs } = show();
    const out = run(eggs, 0, 3000, { child: { tier: 'uncommon', maxBiomass: 1000 } });
    const egg = out[0] as EggView;
    expect(egg.pose).toMatchObject({ shown: true, tier: 'uncommon', crack: 0 });
    const gap = Math.hypot(egg.x - SELF.x, egg.y - SELF.y);
    expect(gap).toBeLessThanOrEqual((SELF.radius * (1 + TETHER.gap) + egg.radius) * 1.01);
    expect(egg.radius).toBeLessThan(SELF.radius);
    expect(eggs.ownAt()).toEqual({ x: egg.x, y: egg.y });
    // No child, no egg.
    expect(frame(eggs, 3100)).toHaveLength(0);
    expect(eggs.ownAt()).toBeNull();
  });

  it("shows peers' eggs plainly from their snapshots' egg mark", () => {
    const { eggs } = show();
    const peer = { id: 'b', x: 900, y: 300, heading: Math.PI, radius: 10, alpha: 0.8, egg: true };
    const out = run(eggs, 0, 1000, { remotes: [peer, { ...peer, id: 'c', egg: false }] });
    expect(eggs.peerIds).toEqual(['b']);
    const egg = out[0] as EggView;
    expect(egg.pose.tier).toBeNull();
    expect(egg.pose.glow).toBe(EGG.plainGlow);
    expect(egg.pose.alpha).toBe(0.8);
    // Behind a peer facing west.
    expect(egg.x).toBeGreaterThan(peer.x + peer.radius);
    expect(frame(eggs, 1100, { remotes: [{ ...peer, egg: false }] })).toHaveLength(0);
    expect(eggs.peerIds).toEqual([]);
  });

  it('a hatch holds the egg where it was, then the child grows out of it there', () => {
    const { eggs, bursts } = show();
    const child = { tier: 'common' as const, maxBiomass: 1000 };
    run(eggs, 0, 2000, { child });
    const at = eggs.ownAt() as { x: number; y: number };
    eggs.hatchStart(2000, 'common', true);
    run(eggs, 2000, 2500, { child, self: { ...SELF, x: SELF.x + 40 } });
    expect(eggs.ownAt()).toEqual(at);
    expect(bursts).toHaveLength(0);
    const born = { ...SELF, x: at.x, y: at.y, radius: 8 };
    expect(eggs.hatched(2500, 'common')).toBe(true);
    run(eggs, 2500, 2500 + EGG.crackMs.common, { self: born });
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ x: at.x, y: at.y });
  });

  it('a hatch the hub refuses puts the carried egg back', () => {
    const { eggs } = show();
    const child = { tier: 'rare' as const, maxBiomass: 1000 };
    run(eggs, 0, 1000, { child });
    eggs.hatchStart(1000, 'rare', true);
    eggs.cancel();
    const out = run(eggs, 1000, 1500, { child });
    expect(out[0]?.pose).toMatchObject({ crack: 0, tier: 'rare', angle: 0 });
    expect(eggs.reveal.phase).toBe('none');
  });

  it('a life with no egg before it (a resume, a return) shows none', () => {
    const { eggs } = show();
    expect(eggs.hatched(0, 'common')).toBe(false);
    expect(frame(eggs, 10)).toHaveLength(0);
  });

  it('dissolves the parent a hatch leaves behind over a second, then nothing of it stays', () => {
    const { eggs } = show();
    const body = { hash: 'parent' } as unknown as CreatureSource;
    eggs.leave({ ...SELF, body, hue: 0.3 }, 1000);
    const start = eggs.ghostOf(1000);
    expect(start).toMatchObject({ x: SELF.x, y: SELF.y, dissolve: 0, body });
    expect(eggs.ghostOf(1000 + GHOST_MS / 2)?.dissolve).toBeCloseTo(0.5, 6);
    expect(eggs.ghostOf(1000 + GHOST_MS)).toBeNull();
    expect(eggs.ghostOf(1000 + GHOST_MS / 2)).toBeNull();
  });
});
