import * as THREE from 'three';
import { setUniform, vec2Uniform, waterMaterial } from './materials';
import type { SceneView } from './scene';

/**
 * A full-screen grid in clip space: the shader rebuilds world coordinates from the camera. Each
 * vertex looks up the depth zone under it (M6 T16), so the grid is fine enough to show a zone's
 * edge band at any zoom while costing a fraction of a lookup per pixel.
 */
const GRID = { x: 12, y: 7 } as const;

export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material = waterMaterial();
  private readonly geometry = new THREE.PlaneGeometry(2, 2, GRID.x, GRID.y);

  constructor(worldSize: number) {
    setUniform(this.material, 'uWorld', worldSize);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
  }

  update(view: SceneView, halfWidth: number, light: boolean): void {
    vec2Uniform(this.material, 'uCam').set(view.camX, view.camY);
    vec2Uniform(this.material, 'uHalf').set(halfWidth, view.halfHeight);
    setUniform(this.material, 'uTime', view.time);
    setUniform(this.material, 'uLight', light ? 1 : 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
