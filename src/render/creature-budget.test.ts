import { afterEach, describe, expect, it, vi } from 'vitest';
import { worstBody } from '../../tests/worst-body';
import { develop, estimateVertices } from '../genome/develop';
import { express } from '../genome/express';
import { buildCreature } from '../genome/stats';
import { RULES } from '../sim/rules';
import * as mesh from './creature-mesh';

// The instances created by user code (not by three.js itself) since the last reset; see the
// allocation test.
const made = vi.hoisted(() => ({ count: 0 }));
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  // biome-ignore lint/suspicious/noExplicitAny: a mixin constructor takes any[]
  const counted = <T extends new (...args: any[]) => object>(Base: T): T =>
    class extends Base {
      // biome-ignore lint/suspicious/noExplicitAny: a mixin constructor takes any[]
      constructor(...args: any[]) {
        super(...args);
        made.count++;
      }
    } as T;
  return {
    ...three,
    Vector2: counted(three.Vector2),
    Vector3: counted(three.Vector3),
    Vector4: counted(three.Vector4),
    Color: counted(three.Color),
    Matrix3: counted(three.Matrix3),
    Matrix4: counted(three.Matrix4),
    Quaternion: counted(three.Quaternion),
    Euler: counted(three.Euler),
  };
});

const { CreatureCache } = await import('./creature-cache');
const { CreatureView } = await import('./creature-view');
const THREE = await import('three');

const worst = worstBody();
const plan = develop(express(worst.genome));

afterEach(() => vi.restoreAllMocks());

describe('the render budget of one body', () => {
  it('builds the worst-case body in under 100 ms', () => {
    mesh.buildCreatureGeometry(plan, 'full'); // warm up the JIT
    const start = performance.now();
    const geometry = mesh.buildCreatureGeometry(plan, 'full');
    const ms = performance.now() - start;
    expect(geometry.getAttribute('position').count).toBeLessThanOrEqual(
      RULES.develop.vertices.full.cap,
    );
    expect(ms).toBeLessThan(100);
  });

  it('keeps the low level of detail of every body within its vertex cap', () => {
    expect(estimateVertices(plan, 'low')).toBeLessThanOrEqual(RULES.develop.vertices.low.cap);
    expect(RULES.develop.vertices.low.cap).toBeLessThanOrEqual(1_500);
  });
});

describe('building bodies only once', () => {
  it('builds nothing on a cache hit', () => {
    const cache = new CreatureCache();
    const creature = buildCreature(worst.genome);
    const builds = vi.spyOn(mesh, 'buildCreatureGeometry');
    const first = cache.acquire(creature, 'full');
    const second = cache.acquire(creature, 'full');
    expect(builds).toHaveBeenCalledTimes(1);
    expect(second.geometry).toBe(first.geometry);
  });
});

describe('the frame path', () => {
  it('allocates no vectors, colours or matrices in 10,000 updates', () => {
    const cache = new CreatureCache();
    const view = new CreatureView(cache);
    const creature = buildCreature(worst.genome);
    const state = {
      creature,
      x: 0,
      y: 0,
      heading: 0,
      radius: 10,
      beat: 1,
      hurt: 0,
      dissolve: 0,
      alpha: 1,
      pxPerWu: 4,
    };
    view.update(state, 0);
    // The counter must see allocations, or the test proves nothing.
    made.count = 0;
    new THREE.Vector3();
    expect(made.count).toBe(1);
    made.count = 0;
    for (let i = 1; i <= 10_000; i++) {
      state.x = i;
      state.heading = i * 0.01;
      state.beat = (i % 100) / 100;
      view.update(state, i / 60);
    }
    expect(made.count).toBe(0);
  });
});
