import * as THREE from 'three';
import { setUniform, vec2Uniform, waterMaterial } from './materials';
import type { SceneView } from './scene';

/** A full-screen quad in clip space: the shader rebuilds world coordinates from the camera. */
export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material = waterMaterial();
  private readonly geometry = new THREE.PlaneGeometry(2, 2);

  constructor(worldSize: number) {
    setUniform(this.material, 'uWorld', worldSize);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
  }

  update(view: SceneView, halfWidth: number): void {
    vec2Uniform(this.material, 'uCam').set(view.camX, view.camY);
    vec2Uniform(this.material, 'uHalf').set(halfWidth, view.halfHeight);
    setUniform(this.material, 'uTime', view.time);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
