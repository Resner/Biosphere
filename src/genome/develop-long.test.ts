import { readdirSync, readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { decodeGenome, type Genome, upgrade } from './codec';
import { type BodyPlan, bodyViolations, develop, type PlanSegment } from './develop';
import { express } from './express';
import { GENOME_BYTES } from './karyotype';
import { type Silhouette, silhouetteOf } from './silhouette';

// One body, widest at the trunk (M6b T5, ADR 0037): a long bilateral v2 chain has a head narrower
// than its trunk, its widest point in the front half, and an outline that narrows to the tail; a
// copepod is a wide carapace with a slim tail, a shrimp a narrow head on a legged trunk, and a worm
// a long, even chain. Measured on the plan laid straight (a curl is a pose of the same body), parts
// excluded.

const DIR = new URL('../../tests/fixtures/gallery/', import.meta.url);

/** Gallery specimen `NN`, as the gallery draws it (a v1 file as its v2 upgrade, ADR 0032). */
function specimen(nn: number): { file: string; genome: Genome } {
  const file = readdirSync(DIR).find((f) => f.startsWith(`${String(nn).padStart(2, '0')}-`));
  if (!file) throw new Error(`no gallery specimen ${nn}`);
  const hex = readFileSync(new URL(file, DIR), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .join('');
  return { file, genome: upgrade(decodeGenome(hexToBytes(hex))) };
}

const planOf = (g: Genome): BodyPlan => develop(express(g));

/** The same body laid straight: the curve gene off. */
function straightOf(g: Genome): BodyPlan {
  const traits = express(g);
  return develop({ ...traits, shape: { ...traits.shape, curve: 0 } });
}

const rng = createRng(seedFromString('develop-long'), 'bytes');
const randomV2 = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

/** A bilateral chain of three or more segments: the bodies T5 shapes. */
const isLongChain = (plan: BodyPlan): boolean =>
  plan.form.radial === 0 && plan.segments.length >= 3;

/** A straight chain's length, the head's front to the tail's end. */
function lengthOf(s: readonly PlanSegment[]): number {
  const head = s[0] as PlanSegment;
  const tail = s[s.length - 1] as PlanSegment;
  return head.x + head.rx - (tail.x - tail.rx);
}

/** Where a straight chain's point at `x` lies, as a share of its length from the front. */
const shareAt = (s: readonly PlanSegment[], x: number): number =>
  ((s[0] as PlanSegment).rx - x) / lengthOf(s);

/** The index of the widest segment (the frontmost on a tie). */
function widestOf(s: readonly PlanSegment[]): number {
  let w = 0;
  for (let i = 1; i < s.length; i++) if ((s[i] as PlanSegment).ry > (s[w] as PlanSegment).ry) w = i;
  return w;
}

const trunkWidth = (s: readonly PlanSegment[]): number => Math.max(...s.slice(1).map((x) => x.ry));

/** What breaks the long-body profile on a straight plan, or an empty list. */
function profileFaults(plan: BodyPlan): string[] {
  const s = plan.segments;
  const out: string[] = [];
  const head = s[0] as PlanSegment;
  if (head.ry > 0.9 * trunkWidth(s) + 1e-9)
    out.push(`head ${head.ry.toFixed(3)} > 0.9 × trunk ${trunkWidth(s).toFixed(3)}`);
  const w = widestOf(s);
  if (plan.carapace.count < 2) {
    const at = shareAt(s, (s[w] as PlanSegment).x);
    if (at < 0.25 || at > 0.55) out.push(`widest at ${at.toFixed(3)} of the length`);
  }
  for (let i = w + 1; i < s.length; i++) {
    const [a, b] = [s[i - 1], s[i]] as [PlanSegment, PlanSegment];
    if (b.ry > 1.05 * a.ry + 1e-9) out.push(`segment ${i} widens behind the widest`);
  }
  const aspect = lengthOf(s) / (2 * (s[w] as PlanSegment).ry);
  if (aspect < 2.5 - 1e-9) out.push(`${aspect.toFixed(3)} long per wide`);
  return out;
}

/**
 * Where each segment's centre lies along a plan's spine, as a share of its length from the front
 * (the head's front, through every link, to the tail's end), and that length.
 */
function alongSpine(s: readonly PlanSegment[]): { at: number[]; length: number } {
  const head = s[0] as PlanSegment;
  const d = [head.rx];
  for (let i = 1; i < s.length; i++) {
    const [a, b] = [s[i - 1], s[i]] as [PlanSegment, PlanSegment];
    d.push((d[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const length = (d[s.length - 1] as number) + (s[s.length - 1] as PlanSegment).rx;
  return { at: d.map((x) => x / length), length };
}

/**
 * What breaks a class's proportions, or an empty list: a copepod and a shrimp measured laid
 * straight, a worm as it curls (a worm's curl narrows it, ADR 0037), along its spine.
 */
function classFaults(cls: Silhouette, curled: BodyPlan, plan: BodyPlan): string[] {
  const s = plan.segments;
  const out: string[] = [];
  if (cls === 'copepod') {
    const c = plan.carapace;
    const free = s.slice(c.count);
    const tail = Math.max(...free.map((x) => x.ry));
    if (c.ry < Math.max(...s.map((x) => x.ry)) - 1e-9) out.push('the carapace is not the widest');
    const at = shareAt(s, c.x);
    if (at > 0.45) out.push(`the carapace sits at ${at.toFixed(3)} of the length`);
    if (tail > 0.5 * c.ry + 1e-9)
      out.push(`the tail is ${(tail / c.ry).toFixed(3)} of the carapace`);
  } else if (cls === 'shrimp') {
    if ((s[0] as PlanSegment).ry >= trunkWidth(s)) out.push('the head is as wide as the trunk');
    const legs = plan.appendages.filter((a) => a.side === 1 && a.segment >= 1).length;
    if (legs < 3) out.push(`${legs} leg pairs on the trunk`);
  } else if (cls === 'worm') {
    const c = curled.segments;
    if (c.length < 5) out.push(`${c.length} segments`);
    const { at, length } = alongSpine(c);
    const aspect = length / (2 * (c[widestOf(c)] as PlanSegment).ry);
    if (aspect < 4 - 1e-9) out.push(`${aspect.toFixed(3)} long per wide`);
    const widths = c
      .filter((_, i) => (at[i] as number) >= 0.1 && (at[i] as number) <= 0.9)
      .map((x) => x.ry);
    const spread = 1 - Math.min(...widths) / Math.max(...widths);
    if (spread > 0.3 + 1e-9) out.push(`width varies by ${spread.toFixed(3)} in the middle`);
  }
  return out;
}

describe('long bodies: one body, widest at the trunk (M6b T5)', () => {
  it('profiles 95% of random bilateral v2 chains of 3+ segments', () => {
    let long = 0;
    let good = 0;
    const faults = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) {
      const g = randomV2();
      const plan = planOf(g);
      if (!isLongChain(plan)) continue;
      long++;
      expect(bodyViolations(plan)).toEqual([]);
      const f = profileFaults(straightOf(g));
      if (f.length === 0) good++;
      for (const x of f) {
        const key = x.replace(/[\d.]+/g, '#');
        faults.set(key, (faults.get(key) ?? 0) + 1);
      }
    }
    expect(long).toBeGreaterThan(2_000);
    expect(good / long, JSON.stringify([...faults])).toBeGreaterThanOrEqual(0.95);
  });

  it('profiles gallery specimens 07, 09–12, 18, 19, 26, 27 and 30', () => {
    for (const nn of [7, 9, 10, 11, 12, 18, 19, 26, 27, 30]) {
      const { file, genome } = specimen(nn);
      const plan = straightOf(genome);
      expect(isLongChain(plan), file).toBe(true);
      expect(profileFaults(plan), file).toEqual([]);
    }
  });

  it('keeps the core collider the unit circle', () => {
    for (const nn of [7, 26, 27, 28, 30]) {
      expect(planOf(specimen(nn).genome).colliders[0]).toEqual({ x: 0, y: 0, r: 1 });
    }
  });
});

describe('long bodies by class (M6b T5)', () => {
  it('gives the class specimens their proportions', () => {
    const cases: [number, Silhouette][] = [
      [26, 'copepod'],
      [27, 'shrimp'],
      [28, 'worm'],
    ];
    for (const [nn, cls] of cases) {
      const { file, genome } = specimen(nn);
      const plan = planOf(genome);
      expect(silhouetteOf(plan), file).toBe(cls);
      expect(classFaults(cls, plan, straightOf(genome)), file).toEqual([]);
    }
  });

  it('gives at least 80% of random copepods, shrimps and worms their proportions', () => {
    const seen = { copepod: 0, shrimp: 0, worm: 0 } as Record<Silhouette, number>;
    const good = { copepod: 0, shrimp: 0, worm: 0 } as Record<Silhouette, number>;
    for (let i = 0; i < 10_000; i++) {
      const g = randomV2();
      const plan = planOf(g);
      const cls = silhouetteOf(plan);
      if (!(cls in seen)) continue;
      seen[cls]++;
      if (classFaults(cls, plan, straightOf(g)).length === 0) good[cls]++;
    }
    for (const cls of ['copepod', 'shrimp', 'worm'] as const) {
      expect(seen[cls], cls).toBeGreaterThanOrEqual(50);
      expect(good[cls] / seen[cls], cls).toBeGreaterThanOrEqual(0.8);
    }
  });
});
