import * as THREE from 'three';
import { type ParticleStyle, particleMaterial, setUniform, vec2Uniform } from './materials';
import type { SceneView } from './scene';

/** One layer of drifting sprites tiled in world space, seeded so screenshots stay comparable. */
export class ParticleLayer {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();

  constructor(count: number, seed: number, style: ParticleStyle) {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    let state = (0x9e3779b9 ^ Math.imul(seed, 0x85ebca6b)) >>> 0;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (let i = 0; i < count; i++) {
      positions[i * 3] = next();
      positions[i * 3 + 1] = next();
      seeds[i] = next();
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.material = particleMaterial(style);
    this.points = new THREE.Points(this.geometry, this.material);
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
