import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { BodyLayer } from './body-layer';
import type { CreatureViewState } from './creature-view';

const creature = buildCreature(starterGenome());
const state = (over: Partial<CreatureViewState> = {}): CreatureViewState => ({
  creature,
  x: 0,
  y: 0,
  heading: 0,
  radius: 5,
  beat: 0,
  hurt: 0,
  dissolve: 0,
  ...over,
});

describe('BodyLayer', () => {
  it('draws a body, and hides it again without one', () => {
    const layer = new BodyLayer(new THREE.Scene(), 1);
    expect(layer.set(state(), 0)).toBe(true);
    expect(layer.shown()).toBe(true);
    expect(layer.set(null, 0.1)).toBe(false);
    expect(layer.shown()).toBe(false);
    layer.dispose();
  });

  it('falls back to the cell when the mesh cannot be built, logging once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const layer = new BodyLayer(new THREE.Scene(), 1);
    const broken = state({ creature: { ...creature, hash: 'broken', plan: null as never } });
    for (let i = 0; i < 3; i++) expect(layer.set(broken, i)).toBe(false);
    expect(layer.shown()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    // The next creature gets its own chance.
    expect(layer.set(state(), 4)).toBe(true);
    error.mockRestore();
  });
});
