import * as THREE from 'three';
import { clamp } from '../sim/math';
import { setUniform, vec2Uniform, waterMaterial } from './materials';
import { ORIGIN } from './origin';
import type { SceneView } from './scene';

/**
 * A full-screen grid in clip space: the shader rebuilds world coordinates from the camera. Each
 * vertex looks up the depth zone under it (M6 T16), so the grid is fine enough to show a zone's
 * edge band at any zoom while costing a fraction of a lookup per pixel.
 */
const GRID = { x: 12, y: 7 } as const;
/** The body noise's cell, wu (`water.frag.glsl`). */
const BODY_CELL = 700;
/**
 * A wall further than this from the floating origin, or than 4 view half-diagonals, is drawn there
 * instead: still off screen (the camera is within `ORIGIN_SLACK` of the origin on each axis), and
 * the uniform stays small (M11 T11).
 */
const WALL_FAR = 8192;

const within = (v: number, far: number): number => clamp(v, -far, far);

export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material = waterMaterial();
  private readonly geometry = new THREE.PlaneGeometry(2, 2, GRID.x, GRID.y);
  private worldSize: number;

  constructor(worldSize: number) {
    this.worldSize = worldSize;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
  }

  /** The world whose walls glow at its edges, wu square. */
  setWorld(size: number): void {
    this.worldSize = size;
  }

  update(view: SceneView, halfWidth: number, light: boolean): void {
    const m = this.material;
    const { x: ox, y: oy } = ORIGIN;
    vec2Uniform(m, 'uCam').set(view.camX - ox, view.camY - oy);
    vec2Uniform(m, 'uHalf').set(halfWidth, view.halfHeight);
    vec2Uniform(m, 'uBodyShift').set(ox / BODY_CELL, oy / BODY_CELL);
    const far = Math.max(WALL_FAR, 4 * Math.hypot(halfWidth, view.halfHeight));
    const size = this.worldSize;
    const walls = (m.uniforms.uWalls as THREE.IUniform<THREE.Vector4>).value;
    walls.set(within(-ox, far), within(-oy, far), within(size - ox, far), within(size - oy, far));
    setUniform(m, 'uTime', view.waterTime);
    setUniform(m, 'uLight', light ? 1 : 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
