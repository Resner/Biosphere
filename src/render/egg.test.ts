import { describe, expect, it } from 'vitest';
import { RARITY_TIERS, type RarityTier } from '../genome/rarity';
import {
  carriedPose,
  EGG,
  EGG_CAPACITY,
  EGG_TINT,
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
  /** Sampled angles every `step` ms over [fromMs, toMs) (`update` first, as a frame does). */
  const sampled = (reveal: EggReveal, fromMs: number, toMs: number, step = 5, reduced = false) => {
    const out: number[] = [];
    const pose = emptyPose();
    for (let t = fromMs; t < toMs; t += step) {
      reveal.update(t);
      out.push(reveal.pose(t, reduced, pose).angle);
    }
    return out;
  };

  it('drops in over 0.4 s, then rests without a swing while its glow breathes slowly', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    expect(reveal.phase).toBe('waiting');
    const pose = emptyPose();
    expect(reveal.pose(0, false, pose).lift).toBeGreaterThan(0.5);
    expect(reveal.pose(EGG.dropMs / 2, false, pose).lift).toBeGreaterThan(0);
    expect(reveal.pose(EGG.dropMs, false, pose).lift).toBe(0);
    expect(pose.shown).toBe(true);
    // At 10 Hz over 2 s after the drop, with no input: no swing at all.
    const rest = angles(reveal, EGG.dropMs, EGG.dropMs + 2000).filter((_, i) => i % 20 === 0);
    expect(rest).toHaveLength(20);
    expect(peak(rest)).toBeLessThanOrEqual(0.01);
    // The glow breathes, slowly (under 0.5 Hz: at most two crossings of its mean a second).
    const glows: number[] = [];
    for (let t = 1000; t < 11_000; t += 50) glows.push(reveal.pose(t, false, pose).glow);
    expect(Math.max(...glows) - Math.min(...glows)).toBeGreaterThan(0.08);
    const mean = glows.reduce((a, b) => a + b, 0) / glows.length;
    expect(crossings(glows.map((g) => g - mean))).toBeLessThanOrEqual(10);
  });

  it('never wiggles while it waits, however long the beacon takes', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    expect(peak(angles(reveal, EGG.dropMs, 60_000))).toBe(0);
  });

  it('answers a poke with one damped wobble that settles within a second', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    expect(reveal.poke(1000)).toBe(true);
    const wobble = angles(reveal, 1000, 2000);
    expect(peak(wobble)).toBeGreaterThanOrEqual(0.1);
    expect(peak(wobble)).toBeLessThanOrEqual(0.2);
    expect(peak(angles(reveal, 2000, 4000))).toBeLessThanOrEqual(0.01);
    // A flurry of pokes never swings past the cap.
    for (let t = 5000; t < 5600; t += 60) reveal.poke(t);
    expect(peak(angles(reveal, 5000, 7000))).toBeLessThanOrEqual(EGG.pokeMax + 1e-9);
    // Only a waiting egg answers.
    const idle = new EggReveal();
    expect(idle.poke(0)).toBe(false);
    idle.stir(0, { tier: 'common', opens: false });
    expect(idle.poke(10)).toBe(false);
  });

  it('shows the waiting line after 10 s of waiting, and only then', () => {
    const reveal = new EggReveal();
    expect(reveal.waitLine(20_000)).toBe(false);
    reveal.wait(1000);
    expect(reveal.waitLine(1000 + EGG.waitLineMs - 1)).toBe(false);
    expect(reveal.waitLine(1000 + EGG.waitLineMs)).toBe(true);
    reveal.stir(12_000, { tier: 'common', opens: false });
    expect(reveal.waitLine(12_000)).toBe(false);
  });

  it('stirs on the beacon for 1.2 s (common) to 1.8 s (exotic), then cracks and bursts', () => {
    expect(EGG.stirMs.common).toBe(1200);
    expect(EGG.stirMs.exotic).toBe(1800);
    const reveal = new EggReveal();
    reveal.wait(0);
    reveal.stir(4000, { tier: 'rare', opens: false });
    expect(reveal.phase).toBe('stirring');
    expect(reveal.update(4000 + EGG.stirMs.rare - 1)).toBe(false);
    expect(reveal.phase).toBe('stirring');
    expect(reveal.update(4000 + EGG.stirMs.rare)).toBe(false);
    expect(reveal.phase).toBe('cracking');
    const crackAt = 4000 + EGG.stirMs.rare;
    expect(reveal.update(crackAt + EGG.crackMs.rare - 1)).toBe(false);
    expect(reveal.update(crackAt + EGG.crackMs.rare)).toBe(true);
    expect(reveal.visited).toEqual(['waiting', 'stirring', 'cracking', 'revealed']);
  });

  it('twitches in three bursts, each stronger, with shorter pauses between them', () => {
    for (const tier of TIERS) {
      const reveal = new EggReveal();
      reveal.wait(0);
      reveal.stir(1000, { tier, opens: true, hold: true });
      const step = 2;
      const values = sampled(reveal, 1000, 1000 + EGG.stirMs[tier], step);
      // Bursts are runs of motion; a pause is a run of stillness longer than 20 ms.
      const bursts: { from: number; to: number; peak: number }[] = [];
      values.forEach((v, i) => {
        if (v === 0) return;
        const last = bursts.at(-1);
        if (last && (i - last.to) * step <= 20) {
          last.to = i;
          last.peak = Math.max(last.peak, Math.abs(v));
        } else bursts.push({ from: i, to: i, peak: Math.abs(v) });
      });
      expect(bursts, tier).toHaveLength(3);
      const [a, b, c] = bursts as [(typeof bursts)[0], (typeof bursts)[0], (typeof bursts)[0]];
      expect(b.peak, tier).toBeGreaterThan(a.peak);
      expect(c.peak, tier).toBeGreaterThan(b.peak);
      expect(c.from - b.to, tier).toBeLessThan(b.from - a.to);
      expect(c.peak, tier).toBeLessThanOrEqual(0.2);
    }
  });

  it('leaks the rarity colour from the second burst on', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    reveal.stir(0, { tier: 'exotic', opens: false });
    const pose = emptyPose();
    const second = EGG.stirBursts[1]?.from ?? 0;
    const before = second * EGG.stirMs.exotic - 1;
    expect(reveal.pose(before, false, pose).tint).toBe(0);
    expect(pose.tier).toBe('exotic');
    const end = reveal.pose(EGG.stirMs.exotic - 1, false, pose);
    expect(end.tint).toBeGreaterThan(0.8);
    expect(end.glow).toBeGreaterThan(reveal.pose(10, false, emptyPose()).glow);
    // Waiting shows no tier; a crack and a carried egg show it in full.
    expect(new EggReveal().pose(0, false, emptyPose()).tint).toBe(1);
    reveal.update(EGG.stirMs.exotic);
    expect(reveal.pose(EGG.stirMs.exotic + 10, false, pose).tint).toBe(1);
  });

  it('keeps the time from the beacon to the burst within 2.2 s (common) and 4 s (exotic)', () => {
    const cap = { common: 2200, uncommon: 2800, rare: 3400, exotic: 4000 } as const;
    for (const tier of TIERS) {
      expect(EGG.stirMs[tier] + EGG.crackMs[tier], tier).toBeLessThanOrEqual(cap[tier]);
      if (tier !== 'common') {
        const lower = TIERS[TIERS.indexOf(tier) - 1] as RarityTier;
        expect(EGG.stirMs[tier]).toBeGreaterThan(EGG.stirMs[lower]);
      }
      const reveal = new EggReveal();
      reveal.stir(0, { tier, opens: false });
      let burstAt = -1;
      for (let t = 0; t <= 5000 && burstAt < 0; t += 1000 / 60) if (reveal.update(t)) burstAt = t;
      expect(burstAt, tier).toBeGreaterThan(0);
      expect(burstAt, tier).toBeLessThanOrEqual(cap[tier] + 1000 / 60);
    }
  });

  it('skips to the burst on a click or Enter while stirring or cracking', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    expect(reveal.skip(100)).toBe(false);
    reveal.stir(1000, { tier: 'exotic', opens: false });
    expect(reveal.skip(1200)).toBe(true);
    expect(reveal.update(1200)).toBe(true);
    expect(reveal.visited).toEqual(['waiting', 'stirring', 'cracking', 'revealed']);
    // While cracking too.
    const cracking = new EggReveal();
    cracking.stir(0, { tier: 'rare', opens: false });
    cracking.update(EGG.stirMs.rare + 10);
    expect(cracking.phase).toBe('cracking');
    expect(cracking.skip(EGG.stirMs.rare + 20)).toBe(true);
    expect(cracking.update(EGG.stirMs.rare + 20)).toBe(true);
  });

  it('a held stir is ripe once its stir and crack times pass, and bursts on release', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    reveal.stir(0, { tier: null, opens: true, hold: true });
    expect(reveal.emerge(10)).toBe(0);
    reveal.setTier('common');
    const due = EGG.stirMs.common + EGG.crackMs.common;
    expect(reveal.ripe(due - 1)).toBe(false);
    reveal.update(due - 1);
    expect(reveal.ripe(due)).toBe(true);
    expect(reveal.update(due + 500)).toBe(false);
    reveal.release();
    expect(reveal.update(due + 500)).toBe(true);
    // A skip makes a held egg ripe at once; it still waits for its release.
    const skipped = new EggReveal();
    skipped.stir(0, { tier: 'exotic', opens: true, hold: true });
    expect(skipped.ripe(100)).toBe(false);
    skipped.skip(100);
    expect(skipped.ripe(100)).toBe(true);
    expect(skipped.update(100)).toBe(false);
    skipped.release();
    expect(skipped.update(150)).toBe(true);
  });

  it('scales the flourish with the rarity tier: exotic bursts brightest, slowest and in slow motion', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const [lower, higher] = [TIERS[i - 1], TIERS[i]] as [RarityTier, RarityTier];
      expect(EGG.crackMs[higher]).toBeGreaterThan(EGG.crackMs[lower]);
      expect(EGG.burstMs[higher]).toBeGreaterThan(EGG.burstMs[lower]);
      expect(EGG.burstLight[higher]).toBeGreaterThan(EGG.burstLight[lower]);
      expect(EGG.burstRings[higher]).toBeGreaterThan(EGG.burstRings[lower]);
      expect(EGG.burstShards[higher]).toBeGreaterThanOrEqual(EGG.burstShards[lower]);
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

  it('bursts with shell shards, and with light rays for rare and exotic only', () => {
    for (const tier of TIERS) {
      const reveal = new EggReveal();
      reveal.crack(0, { tier, opens: true });
      reveal.update(EGG.crackMs[tier]);
      const pose = reveal.pose(EGG.crackMs[tier] + 50, false, emptyPose());
      expect(pose.shards, tier).toBe(EGG.burstShards[tier]);
      expect(pose.shards, tier).toBeGreaterThan(0);
      expect(pose.rays > 0, tier).toBe(tier === 'rare' || tier === 'exotic');
      // Reduced motion: nothing flies, the burst fades.
      const still = reveal.pose(EGG.crackMs[tier] + 50, true, emptyPose());
      expect(still.shards, tier).toBe(0);
      expect(still.spread, tier).toBe(0);
    }
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
    reveal.release();
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

  it('a hatch that starts mid-stir or mid-crack takes over the burst and holds it', () => {
    for (const at of [100, EGG.stirMs.rare + 100]) {
      const reveal = new EggReveal();
      reveal.stir(0, { tier: 'rare', opens: false });
      reveal.update(at);
      reveal.crack(at, { tier: 'rare', opens: true, hold: true });
      expect(reveal.opens).toBe(true);
      expect(reveal.update(10_000)).toBe(false);
      reveal.release();
      expect(reveal.update(10_000)).toBe(true);
    }
  });

  it('a release before the crack time still waits for it', () => {
    const reveal = new EggReveal();
    reveal.crack(0, { tier: 'common', opens: true, hold: true });
    reveal.release();
    expect(reveal.update(100)).toBe(false);
    expect(reveal.update(EGG.crackMs.common)).toBe(true);
  });

  it('under reduced motion: no drop, wobble or twitch; the glow pulses instead', () => {
    const reveal = new EggReveal();
    reveal.wait(0);
    expect(reveal.pose(0, true, emptyPose()).lift).toBe(0);
    reveal.poke(500);
    expect(peak(angles(reveal, 0, 12_000, true))).toBe(0);
    const glows: number[] = [];
    const pose = emptyPose();
    for (let t = 0; t < 4000; t += 50) glows.push(reveal.pose(t, true, pose).glow);
    expect(Math.max(...glows) - Math.min(...glows)).toBeGreaterThan(0.25);
    reveal.stir(12_000, { tier: 'exotic', opens: true });
    const stirGlows: number[] = [];
    for (let t = 12_000; t < 12_000 + EGG.stirMs.exotic; t += 20) {
      stirGlows.push(reveal.pose(t, true, pose).glow);
      expect(pose.angle).toBe(0);
    }
    expect(Math.max(...stirGlows) - Math.min(...stirGlows)).toBeGreaterThan(0.25);
    reveal.update(12_000 + EGG.stirMs.exotic);
    const crackAt = 12_000 + EGG.stirMs.exotic;
    expect(peak(angles(reveal, crackAt, crackAt + EGG.crackMs.exotic, true))).toBe(0);
    reveal.update(crackAt + EGG.crackMs.exotic);
    const open = reveal.pose(crackAt + EGG.crackMs.exotic + 200, true, emptyPose());
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

  it('lifts a dropping egg above its place and blends a stir’s leak into the rarity tint', () => {
    const layer = new EggLayer();
    const egg = view('rare', null);
    egg.pose.lift = 0.5;
    egg.pose.tint = 0.25;
    layer.set([egg], 0);
    const matrix = layer.mesh.instanceMatrix.array;
    expect(matrix[13]).toBeCloseTo(egg.y + 0.5 * egg.radius, 6);
    const tint = layer.mesh.geometry.getAttribute('aEggTint').array;
    const [plain, rare] = [EGG_TINT.plain, EGG_TINT.rare];
    for (let k = 0; k < 3; k++) {
      expect(tint[k]).toBeCloseTo((plain[k] as number) * 0.75 + (rare[k] as number) * 0.25, 6);
    }
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
