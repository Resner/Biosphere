import * as THREE from 'three';
import { FX, type Ring } from './effects';
import { writeInstance } from './instances';
import { ringMaterial } from './materials';

/** Eat pops and dash ripples as instanced quads; the shader draws the rings. */
export class RingLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material = ringMaterial();

  constructor() {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, FX.ringCapacity);
    this.mesh.count = 0;
  }

  /** Rewrites the instances from the live rings; the phase packs the kind and the progress. */
  set(rings: readonly Ring[]): void {
    const n = Math.min(rings.length, FX.ringCapacity);
    for (let i = 0; i < n; i++) {
      const ring = rings[i] as Ring;
      const progress = Math.min(ring.age / ring.life, 0.999);
      const phase = (ring.kind === 'pop' ? 0 : 1) + progress;
      writeInstance(this.mesh.instanceMatrix.array, i, ring.x, ring.y, ring.size, 0, phase);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
