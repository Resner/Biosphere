import * as THREE from 'three';
import { type ParticleStyle, particleMaterial, setUniform, vec2Uniform } from './materials';
import { PRESETS } from './presets';
import type { SceneView } from './scene';

/** Room for the largest preset's share of particles. */
const MAX_SHARE = Math.max(...Object.values(PRESETS).map((p) => p.particles));

/**
 * One layer of drifting sprites tiled in world space, seeded so screenshots stay comparable.
 * `count` is the full (100%) count; a preset draws a share of it from the front of the buffer.
 */
export class ParticleLayer {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();
  private drawn = 0;

  constructor(
    private readonly count: number,
    seed: number,
    style: ParticleStyle,
  ) {
    const capacity = Math.ceil(count * MAX_SHARE);
    const positions = new Float32Array(capacity * 3);
    const seeds = new Float32Array(capacity);
    let state = (0x9e3779b9 ^ Math.imul(seed, 0x85ebca6b)) >>> 0;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (let i = 0; i < capacity; i++) {
      positions[i * 3] = next();
      positions[i * 3 + 1] = next();
      seeds[i] = next();
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.material = particleMaterial(style);
    this.points = new THREE.Points(this.geometry, this.material);
    this.setShare(1);
  }

  /** Draws this share of the full count; no buffer is rebuilt. */
  setShare(share: number): void {
    this.drawn = Math.min(
      Math.round(this.count * share),
      this.geometry.getAttribute('aSeed').count,
    );
    this.geometry.setDrawRange(0, this.drawn);
  }

  /** How many particles are drawn. */
  get drawnCount(): number {
    return this.drawn;
  }

  update(view: SceneView, pxPerWu: number): void {
    vec2Uniform(this.material, 'uCam').set(view.camX, view.camY);
    setUniform(this.material, 'uTime', view.time);
    setUniform(this.material, 'uPxPerWu', pxPerWu);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
