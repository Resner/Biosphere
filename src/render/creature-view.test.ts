import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { CreatureCache } from './creature-cache';
import { CreatureView, type CreatureViewState } from './creature-view';

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
});
