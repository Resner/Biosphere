// Glow pools (M6 T16): the light luminous creatures throw on the dark water around them, drawn as
// additive instanced quads over the water. The zone shaders' own glow lookup (`zoneLight`) serves
// only small things (food, bodies); a loop over the lights for every water pixel is too slow when
// WebGL renders in software.

import * as THREE from 'three';
import { writeInstance } from './instances';
import { glowMaterial } from './materials';
import { MAX_LIGHTS } from './zones';

export class GlowLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material = glowMaterial();
  private readonly colors = new Float32Array(MAX_LIGHTS * 3);
  private count = 0;

  constructor() {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_LIGHTS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    // Always in the scene: with no pools three draws nothing (no call), but the quad is uploaded
    // from the first frame, so the GPU resources do not change when a glowing body swims in.
    this.mesh.count = 0;
  }

  /** Starts a frame's pools. */
  clear(): void {
    this.count = 0;
  }

  /** Adds a pool of `radius` wu whose centre takes `r, g, b` (already scaled); beyond capacity it is dropped. */
  add(x: number, y: number, radius: number, r: number, g: number, b: number): void {
    if (this.count >= MAX_LIGHTS) return;
    const i = this.count++;
    writeInstance(this.mesh.instanceMatrix.array, i, x, y, radius, 0, 0);
    this.colors[i * 3] = r;
    this.colors[i * 3 + 1] = g;
    this.colors[i * 3 + 2] = b;
  }

  /** Ends the frame: uploads the pools (with none, three issues no draw call). */
  flush(): void {
    this.mesh.count = this.count;
    if (this.count === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
