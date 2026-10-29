import { describe, expect, it } from 'vitest';
import { RARITY_TIERS, type RarityTier } from '../genome/rarity';
import {
  carriedPose,
  EGG,
  EGG_CAPACITY,
  EggLayer,
  type EggPose,
  EggReveal,
  EggTether,
  type EggView,
  emptyPose,
  TETHER,
} from './egg';

/** Samples the waiting egg's angle every 5 ms over [fromMs, toMs). */
function angles(reveal: EggReveal, fromMs: number, toMs: number, reduced = false): number[] {
  const out: number[] = [];
  const pose = emptyPose();
  for (let t = fromMs; t < toMs; t += 5) out.push(reveal.pose(t, reduced, pose).angle);
  return out;
}

const crossings = (values: number[]): number => {
  let n = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.sign(values[i] as number) !== Math.sign(values[i - 1] as number)) n++;
  }
  return n;
};

const peak = (values: number[]): number => Math.max(...values.map(Math.abs));

const TIERS = RARITY_TIERS.map(([tier]) => tier);

describe('EggReveal', () => {
  it('wiggles with rising frequency, swing and glow while the beacon is awaited', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    expect(reveal.phase).toBe('waiting');
    const early = angles(reveal, 0, 2000);
    const late = angles(reveal, 7000, 9000);
    expect(crossings(late)).toBeGreaterThan(crossings(early) * 2);
    expect(peak(late)).toBeGreaterThan(peak(early) * 1.5);
    const pose = emptyPose();
    const glowEarly = reveal.pose(1000, false, pose).glow;
    const glowLate = reveal.pose(8000, false, pose).glow;
    expect(glowLate).toBeGreaterThan(glowEarly + 0.3);
    expect(pose.shown).toBe(true);
  });

  it('settles into a calm idle when the beacon is later than 10 s', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    const building = angles(reveal, 9000, 10_000);
    const calm = angles(reveal, 20_000, 25_000);
    expect(peak(calm)).toBeLessThanOrEqual(EGG.idleAmp + 1e-9);
    expect(peak(calm)).toBeLessThan(peak(building) / 3);
    // At most the idle's frequency: two crossings per period.
    expect(crossings(calm)).toBeLessThanOrEqual(Math.ceil(5 * EGG.idleHz * 2) + 1);
    const pose = emptyPose();
    for (let t = 15_000; t < 60_000; t += 250) {
      expect(reveal.pose(t, false, pose).glow).toBeLessThan(EGG.glow.to);
    }
    // The settle never jumps: 5 ms apart, samples differ by no more than the fastest swing moves
    // (0.3 rad at 3.2 Hz: about 0.03 rad).
    const through = angles(reveal, 9500, 12_500);
    for (let i = 1; i < through.length; i++) {
      expect(Math.abs((through[i] as number) - (through[i - 1] as number))).toBeLessThan(0.035);
    }
  });

  it('goes waiting, cracking, revealed, and bursts once', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    reveal.wait(500);
    reveal.crack(4000, { tier: 'rare', opens: false });
    expect(reveal.phase).toBe('cracking');
    expect(reveal.update(4000 + EGG.crackMs.rare - 1)).toBe(false);
    const pose = emptyPose();
    expect(reveal.pose(4000 + EGG.crackMs.rare / 2, false, pose).crack).toBeGreaterThan(0.2);
    expect(reveal.update(4000 + EGG.crackMs.rare)).toBe(true);
    expect(reveal.update(4000 + EGG.crackMs.rare + 16)).toBe(false);
    expect(reveal.phase).toBe('revealed');
    expect(reveal.visited).toEqual(['waiting', 'cracking', 'revealed']);
  });

  it('scales the flourish with the rarity tier: exotic bursts brightest, slowest and in slow motion', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const [lower, higher] = [TIERS[i - 1], TIERS[i]] as [RarityTier, RarityTier];
      expect(EGG.crackMs[higher]).toBeGreaterThan(EGG.crackMs[lower]);
      expect(EGG.burstMs[higher]).toBeGreaterThan(EGG.burstMs[lower]);
      expect(EGG.burstLight[higher]).toBeGreaterThan(EGG.burstLight[lower]);
      expect(EGG.burstRings[higher]).toBeGreaterThan(EGG.burstRings[lower]);
    }
    expect(EGG.burstRings.common).toBe(1);
    const burst = (tier: (typeof TIERS)[number]) => {
      const reveal = new EggReveal();
      reveal.crack(0, { tier, opens: false });
      reveal.update(EGG.crackMs[tier]);
      return reveal;
    };
    const exotic = burst('exotic');
    const at = EGG.crackMs.exotic + 100;
    expect(exotic.slowFactor(at)).toBe(EGG.slowExotic);
    expect(exotic.slowFactor(at, true)).toBe(1);
    expect(exotic.slowFactor(EGG.crackMs.exotic + EGG.slowMs + 1)).toBe(1);
    expect(exotic.pose(at, false, emptyPose()).light).toBe(EGG.burstLight.exotic);
    const common = burst('common');
    expect(common.slowFactor(EGG.crackMs.common + 100)).toBe(1);
    expect(common.done(EGG.crackMs.common + EGG.burstMs.common)).toBe(true);
    // Slow motion stretches the exotic burst beyond its nominal length.
    expect(exotic.done(EGG.crackMs.exotic + EGG.burstMs.exotic)).toBe(false);
  });

  it('heals a reveal into the carried egg, glowing by the rarity', () => {
    const reveal = new EggReveal();
    reveal.crack(0, { tier: 'uncommon', opens: false });
    reveal.update(EGG.crackMs.uncommon);
    const later = EGG.crackMs.uncommon + EGG.burstMs.uncommon + EGG.healMs + 10;
    const pose = reveal.pose(later, false, emptyPose());
    expect(pose).toMatchObject({ shown: true, crack: 0, tier: 'uncommon' });
    expect(pose.glow).toBeCloseTo(EGG.carriedGlow.uncommon, 6);
    expect(reveal.emerge(later)).toBe(1);
  });

  it('opens for a hatch: holds until released, then the creature pops out', () => {
    const reveal = new EggReveal();
    reveal.crack(0, { tier: null, opens: true, hold: true });
    expect(reveal.emerge(10)).toBe(0);
    // Held: no burst however long the hub takes, and the shell never quite breaks.
    expect(reveal.update(10_000)).toBe(false);
    expect(reveal.pose(10_000, false, emptyPose()).crack).toBeLessThanOrEqual(EGG.heldCrack);
    reveal.setTier('rare');
    reveal.release(10_050);
    expect(reveal.update(10_050)).toBe(true);
    expect(reveal.emerge(10_050)).toBe(0);
    const sizes = [];
    for (let t = 0; t <= EGG.emergeMs; t += 15) sizes.push(reveal.emerge(10_050 + t));
    expect(Math.max(...sizes)).toBeGreaterThan(1.02);
    expect(reveal.emerge(10_050 + EGG.emergeMs)).toBe(1);
    const flying = reveal.pose(10_050 + EGG.burstMs.rare / 2, false, emptyPose());
    expect(flying.spread).toBeGreaterThan(0.2);
    expect(flying.alpha).toBeLessThan(1);
    expect(reveal.pose(10_050 + EGG.burstMs.rare, false, emptyPose()).shown).toBe(false);
    expect(reveal.done(10_050 + EGG.burstMs.rare)).toBe(true);
  });

  it('a hatch that starts mid-crack takes over the burst and holds it', () => {
    const reveal = new EggReveal();
    reveal.crack(0, { tier: 'rare', opens: false });
    reveal.crack(100, { tier: 'rare', opens: true, hold: true });
    expect(reveal.opens).toBe(true);
    expect(reveal.update(10_000)).toBe(false);
    reveal.release(10_000);
    expect(reveal.update(10_000)).toBe(true);
  });

  it('a release before the crack time still waits for it', () => {
    const reveal = new EggReveal();
    reveal.crack(0, { tier: 'common', opens: true, hold: true });
    reveal.release(100);
    expect(reveal.update(100)).toBe(false);
    expect(reveal.update(EGG.crackMs.common)).toBe(true);
  });

  it('replaces the shake with a fade under reduced motion', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    expect(peak(angles(reveal, 0, 12_000, true))).toBe(0);
    const alphas: number[] = [];
    const pose = emptyPose();
    for (let t = 0; t < 4000; t += 50) alphas.push(reveal.pose(t, true, pose).alpha);
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.3);
    reveal.crack(12_000, { tier: 'exotic', opens: true });
    expect(peak(angles(reveal, 12_000, 12_000 + EGG.crackMs.exotic, true))).toBe(0);
    reveal.update(12_000 + EGG.crackMs.exotic);
    const open = reveal.pose(12_000 + EGG.crackMs.exotic + 200, true, emptyPose());
    expect(open.spread).toBe(0);
    expect(open.alpha).toBeLessThan(1);
  });

  it('resets to no egg', () => {
    const reveal = new EggReveal();
    reveal.crack(0, { tier: 'common', opens: true, hold: true });
    reveal.reset();
    expect(reveal.phase).toBe('none');
    expect(reveal.pose(10, false, emptyPose()).shown).toBe(false);
    expect(reveal.emerge(10)).toBe(1);
  });
});

describe('carriedPose', () => {
  it('glows faintly by the rarity for the owner and plainly for peers', () => {
    const own = carriedPose('exotic', emptyPose());
    const plain = carriedPose(null, emptyPose());
    expect(own).toMatchObject({ shown: true, angle: 0, crack: 0, tier: 'exotic' });
    expect(own.glow).toBe(EGG.carriedGlow.exotic);
    expect(plain.glow).toBe(EGG.plainGlow);
    expect(plain.tier).toBeNull();
    for (const tier of TIERS) expect(EGG.carriedGlow[tier]).toBeLessThan(0.6);
  });
});

describe('EggTether', () => {
  const parent = { x: 100, y: 50, heading: 0, radius: 10 };
  const eggR = 4;
  const rest = EggTether.rest(parent, eggR);

  const settle = (tether: EggTether, p = parent, seconds = 3) => {
    for (let i = 0; i < seconds * 60; i++) tether.follow(1 / 60, p, eggR);
  };

  it('hangs a short way behind its parent', () => {
    const tether = new EggTether();
    settle(tether);
    expect(tether.x).toBeCloseTo(parent.x - rest, 3);
    expect(tether.y).toBeCloseTo(parent.y, 3);
    expect(rest).toBeLessThan(parent.radius * 2 + eggR);
  });

  it('follows a turn with a spring: it lags, then settles behind the new heading', () => {
    const tether = new EggTether();
    settle(tether);
    const turned = { ...parent, heading: Math.PI / 2 };
    tether.follow(1 / 60, turned, eggR);
    // One frame later it is still mostly where it was.
    expect(tether.x).toBeLessThan(parent.x - rest * 0.8);
    settle(tether, turned);
    expect(tether.x).toBeCloseTo(parent.x, 3);
    expect(tether.y).toBeCloseTo(parent.y - rest, 3);
  });

  it('never trails beyond the tether or sinks into the body', () => {
    const tether = new EggTether();
    settle(tether);
    const moving = { ...parent };
    for (let i = 0; i < 120; i++) {
      moving.x += 3;
      tether.follow(1 / 60, moving, eggR);
      const d = Math.hypot(tether.x - moving.x, tether.y - moving.y);
      expect(d).toBeLessThanOrEqual(rest * TETHER.stretch + 1e-6);
      expect(d).toBeGreaterThanOrEqual(parent.radius + eggR * 0.6 - 1e-6);
    }
  });

  it('snaps after a jump instead of flying across the pond', () => {
    const tether = new EggTether();
    settle(tether);
    const far = { ...parent, x: 4000, y: 4000 };
    tether.follow(1 / 60, far, eggR);
    expect(tether.x).toBeCloseTo(far.x - rest, 6);
    expect(tether.y).toBeCloseTo(far.y, 6);
  });
});

describe('EggLayer', () => {
  const view = (tier: EggPose['tier'], parent: EggView['parent']): EggView => ({
    x: 0,
    y: 0,
    radius: 3,
    heading: Math.PI / 2,
    pose: carriedPose(tier, emptyPose()),
    seed: 0.5,
    parent,
  });

  it('draws each shown egg with its tether in one instanced mesh', () => {
    const layer = new EggLayer();
    layer.set([], 0);
    expect(layer.mesh.visible).toBe(false);
    const hidden = { ...view(null, null), pose: emptyPose() };
    layer.set([view('rare', { x: 12, y: 0, heading: 0, radius: 6 }), view(null, null), hidden], 1);
    expect(layer.count()).toBe(2);
    expect(layer.mesh.count).toBe(3);
    expect(layer.mesh.visible).toBe(true);
    layer.dispose();
  });

  it('never writes past its capacity', () => {
    const layer = new EggLayer();
    const many = Array.from({ length: EGG_CAPACITY }, () =>
      view(null, { x: 12, y: 0, heading: 0, radius: 6 }),
    );
    layer.set(many, 0);
    expect(layer.mesh.count).toBeLessThanOrEqual(EGG_CAPACITY);
    layer.dispose();
  });
});
