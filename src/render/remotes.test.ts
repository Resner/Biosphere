import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { type RemoteCellView, RemoteLayer } from './remotes';

const creature = buildCreature(starterGenome());
const remote = (id: string, over: Partial<RemoteCellView> = {}): RemoteCellView => ({
  id,
  x: 0,
  y: 0,
  heading: 0,
  radius: 5,
  beat: 0,
  alpha: 1,
  hue: 0.3,
  ...over,
});

describe('RemoteLayer', () => {
  it('draws a body for a remote that has one and a tinted cell for the rest', () => {
    const layer = new RemoteLayer(new THREE.Scene(), 1);
    layer.set([remote('a', { body: creature }), remote('b'), remote('c', { body: null })], 0, 1);
    expect(layer.bodyCount()).toBe(1);
    expect(layer.count()).toBe(2);
    layer.dispose();
  });

  it('keeps a body on one mesh and removes the mesh when the body goes', () => {
    const scene = new THREE.Scene();
    const layer = new RemoteLayer(scene, 1);
    layer.set([remote('a', { body: creature })], 0, 1);
    const meshes = scene.children.filter((o) => o instanceof THREE.Mesh).length;
    layer.set([remote('a', { body: creature, x: 4 })], 0.1, 1);
    expect(scene.children.filter((o) => o instanceof THREE.Mesh)).toHaveLength(meshes);
    layer.set([remote('a')], 0.2, 1);
    expect(layer.bodyCount()).toBe(0);
    expect(layer.count()).toBe(1);
    expect(scene.children.filter((o) => o instanceof THREE.Mesh).length).toBeLessThan(meshes + 2);
    layer.set([], 0.3, 1);
    layer.dispose();
  });

  it('ignores a remote that has faded out', () => {
    const layer = new RemoteLayer(new THREE.Scene(), 1);
    layer.set([remote('a', { body: creature, alpha: 0 })], 0, 1);
    expect(layer.bodyCount()).toBe(0);
    expect(layer.count()).toBe(0);
    layer.dispose();
  });

  it('falls back to the cell when a mesh cannot be built, logging once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const layer = new RemoteLayer(new THREE.Scene(), 1);
    const broken = { ...creature, hash: 'broken', plan: null as never };
    for (let i = 0; i < 3; i++) {
      layer.set([remote('a', { body: broken })], i, 1);
      expect(layer.bodyCount()).toBe(0);
      expect(layer.count()).toBe(1);
    }
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    layer.dispose();
  });
});
