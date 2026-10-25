import * as THREE from 'three';
import type { Plume } from '../sim/hazards';
import { idFraction, writeInstance } from './instances';
import { plumeMaterial, setUniform } from './materials';

/** Plumes drawn at once: a plume is anchored about once per nine 256-wu cells. */
const PLUME_CAPACITY = 32;

/** Toxic plumes as instanced soft discs; the shader does the swirl and the dashed rim. */
export class PlumeLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material = plumeMaterial();

  constructor() {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, PLUME_CAPACITY);
    this.mesh.count = 0;
  }

  set(plumes: readonly Plume[]): void {
    const n = Math.min(plumes.length, PLUME_CAPACITY);
    for (let i = 0; i < n; i++) {
      const plume = plumes[i] as Plume;
      // A stable phase per plume keeps neighbours from swirling in step.
      writeInstance(
        this.mesh.instanceMatrix.array,
        i,
        plume.x,
        plume.y,
        plume.radius,
        0,
        idFraction(plume.id),
      );
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(time: number): void {
    setUniform(this.material, 'uTime', time);
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
