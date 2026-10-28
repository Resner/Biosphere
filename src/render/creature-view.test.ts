import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { genesisGenome } from '../genome/genesis';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { createRng, seedFromString } from '../sim/prng';
import { CreatureCache } from './creature-cache';
import { CreatureView, type CreatureViewState } from './creature-view';
import { GAIT_WRAP } from './gait';
import { materialParams } from './material-params';

const creature = buildCreature(starterGenome());
const state = (over: Partial<CreatureViewState> = {}): CreatureViewState => ({
  creature,
  x: 3,
  y: -2,
  heading: 0.5,
  radius: 4,
  beat: 1,
  hurt: 0,
  dissolve: 0,
  ...over,
});
const colour = (m: THREE.ShaderMaterial, name: string): THREE.Color =>
  (m.uniforms[name] as THREE.IUniform<THREE.Color>).value;
const uniform = (view: CreatureView, name: string): number =>
  (view.mesh.material as THREE.ShaderMaterial).uniforms[name]?.value;

describe('CreatureView', () => {
  it('shows one scaled, placed mesh and hides it with no state', () => {
    const view = new CreatureView(new CreatureCache());
    expect(view.mesh.visible).toBe(false);
    view.update(state(), 0);
    expect(view.mesh.visible).toBe(true);
    expect(view.mesh.position.x).toBe(3);
    expect(view.mesh.scale.x).toBe(4);
    view.update(null, 1);
    expect(view.mesh.visible).toBe(false);
  });

  it('integrates the gait phase from the beat and gives each view its own uniforms', () => {
    const cache = new CreatureCache();
    const a = new CreatureView(cache);
    const b = new CreatureView(cache);
    for (const v of [a, b]) v.update(state(), 0);
    a.update(state(), 0.05);
    b.update(state({ beat: 0 }), 0.05);
    expect(uniform(a, 'uPhase')).toBeGreaterThan(uniform(b, 'uPhase'));
    expect(cache.live()).toBe(1);
  });

  it('trails the antennae behind a turn and wraps the phase at four beats (M6 T11)', () => {
    const view = new CreatureView(new CreatureCache());
    view.update(state({ heading: 0 }), 0);
    expect(uniform(view, 'uTurn')).toBe(0);
    view.update(state({ heading: 0.4 }), 0.3);
    expect(uniform(view, 'uTurn')).toBeCloseTo(-0.4 * Math.exp(-1), 6);
    for (let i = 1; i <= 120; i++) view.update(state({ heading: 0.4 }), 0.3 + i / 30);
    expect(Math.abs(uniform(view, 'uTurn'))).toBeLessThan(1e-4);
    expect(uniform(view, 'uPhase')).toBeLessThan(GAIT_WRAP);
    expect(uniform(view, 'uPhase')).toBeGreaterThanOrEqual(0);
  });

  it('switches detail with the screen size and releases everything on dispose', () => {
    const cache = new CreatureCache();
    const view = new CreatureView(cache);
    view.update(state({ pxPerWu: 10 }), 0);
    const full = view.mesh.geometry.getAttribute('position').count;
    view.update(state({ pxPerWu: 1 }), 0.1);
    expect(view.mesh.geometry.getAttribute('position').count).toBeLessThan(full);
    expect(cache.live()).toBe(1);
    view.dispose();
    expect(cache.live()).toBe(0);
  });

  it('puts the genes into the material once and rewrites only the per-frame uniforms', () => {
    const cache = new CreatureCache();
    const view = new CreatureView(cache);
    const c = buildCreature(genesisGenome(seedFromString('view-uniforms')));
    view.update(state({ creature: c }), 0);
    const material = view.mesh.material as THREE.ShaderMaterial;
    const params = materialParams(c.traits);
    expect(material.uniforms.uPattern?.value).toBe(params.pattern);
    expect(material.uniforms.uIrid?.value).toBe(params.iridescence);
    expect(material.uniforms.uLum?.value).toBe(params.luminescence);
    expect(colour(material, 'uCore').r).toBeCloseTo(params.core[0], 5);
    expect(colour(material, 'uLumColor').g).toBeCloseTo(params.lumColor[1], 5);

    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        Object.entries(material.uniforms).map(([k, u]) => [k, JSON.stringify(u.value)]),
      );
    const before = snapshot();
    view.update(state({ creature: c, beat: 0.4, hurt: 0.5, dissolve: 0.2, alpha: 0.5 }), 0.5);
    const after = snapshot();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    const perFrame = ['uTime', 'uPhase', 'uBeat', 'uTurn', 'uHurt', 'uDissolve', 'uAlpha'];
    expect(changed.every((k) => perFrame.includes(k))).toBe(true);
    expect(changed).toContain('uTime');
  });

  it('serves 24 distinct creatures from one shader program', () => {
    const cache = new CreatureCache();
    const rng = createRng(seedFromString('programs'), 'bytes');
    const sources = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const view = new CreatureView(cache);
      view.update(
        state({
          creature: buildCreature(genesisGenome(seedFromString(`prog-${i}-${rng.nextU32()}`))),
        }),
        0,
      );
      const m = view.mesh.material as THREE.ShaderMaterial;
      sources.add(m.vertexShader + m.fragmentShader + m.customProgramCacheKey());
    }
    expect(sources.size).toBe(1);
  });
});
