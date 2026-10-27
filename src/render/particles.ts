import * as THREE from 'three';
import { TAU } from '../sim/math';
import { type ParticleStyle, particleMaterial, setUniform, vec2Uniform } from './materials';
import type { SpriteDof } from './post/chain';
import { depthOfParallax, parallaxOfDepth } from './post/dof';
import { PRESETS } from './presets';
import type { SceneView } from './scene';

/** Room for the largest preset's share of particles. */
const MAX_SHARE = Math.max(...Object.values(PRESETS).map((p) => p.particles));
/** The largest sprite in canvas pixels: big discs cost fill, and some GPUs cap point sizes there. */
const MAX_SPRITE_PX = 256;

/** One speck as drawn, for tests (`__bs.render.specks`). */
export interface Speck {
  /** Its place in the layer: the same speck in another frame or page. */
  index: number;
  /** Its centre on screen, in CSS pixels. */
  x: number;
  y: number;
  /** Its diameter before the blur, in CSS pixels. */
  size: number;
  /** Its depth in camera heights: 0 at the gameplay plane, positive towards the camera. */
  z: number;
  /** The radius of its circle of confusion in CSS pixels; 0 without a depth of field. */
  blur: number;
}

/** GLSL's `mod`: the result takes the sign of the divisor. */
const mod = (a: number, b: number): number => a - b * Math.floor(a / b);

/**
 * One layer of drifting sprites tiled in world space, seeded so screenshots stay comparable.
 * `count` is the full (100%) count; a preset draws a share of it from the front of the buffer.
 */
export class ParticleLayer {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions: Float32Array;
  private readonly seeds: Float32Array;
  /** Target pixels per CSS pixel at the last update. */
  private pixels = 1;

  constructor(
    private readonly count: number,
    seed: number,
    private readonly style: ParticleStyle,
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
      // Where in the layer's depth spread the speck lies.
      positions[i * 3 + 2] = next();
    }
    this.positions = positions;
    this.seeds = seeds;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.material = particleMaterial(style);
    this.points = new THREE.Points(this.geometry, this.material);
    this.setShare(1);
  }

  /** Draws this share of the full count; no buffer is rebuilt. */
  setShare(share: number): void {
    this.geometry.setDrawRange(0, Math.round(this.count * share));
  }

  /** How many particles are drawn. */
  get drawnCount(): number {
    return this.geometry.drawRange.count;
  }

  /** `pxPerWu` is in CSS pixels; `dof` says how the sprites draw their blur into their target. */
  update(view: SceneView, pxPerWu: number, dof: SpriteDof): void {
    const m = this.material;
    this.pixels = dof.pixels;
    vec2Uniform(m, 'uCam').set(view.camX, view.camY);
    setUniform(m, 'uTime', view.time);
    setUniform(m, 'uPxPerWu', pxPerWu * dof.pixels);
    setUniform(m, 'uMaxSize', MAX_SPRITE_PX * dof.shrink);
    setUniform(m, 'uFocus', dof.focus);
    setUniform(m, 'uCocSlope', dof.slope);
    setUniform(m, 'uCocMax', dof.max);
    setUniform(m, 'uFringe', dof.fringe);
  }

  /**
   * The specks drawn at the last update whose centres fall on a `width` by `height` CSS-pixel
   * screen, worked out as `particles.vert.glsl` does. For tests; it allocates.
   */
  specks(pxPerWu: number, width: number, height: number): Speck[] {
    const u = this.material.uniforms;
    const value = (name: string) => (u[name] as THREE.IUniform).value as number;
    const cam = (u.uCam as THREE.IUniform).value as THREE.Vector2;
    const t = value('uTime');
    const { period, size, spread = 0 } = this.style;
    const depth = depthOfParallax(this.style.parallax);
    const out: Speck[] = [];
    for (let i = 0; i < this.drawnCount; i++) {
      const s = this.seeds[i] ?? 0;
      const z = depth + spread * (2 * (this.positions[i * 3 + 2] ?? 0) - 1);
      const parallax = parallaxOfDepth(z);
      const dx = (0.8 + 1.2 * s) * t;
      const dy = 0.3 * Math.sin(t * 0.3 + s * TAU) * t;
      const rx = mod((this.positions[i * 3] ?? 0) * period + dx - cam.x * parallax, period);
      const ry = mod((this.positions[i * 3 + 1] ?? 0) * period + dy - cam.y * parallax, period);
      const x = width / 2 + (rx - period / 2) * pxPerWu;
      const y = height / 2 - (ry - period / 2) * pxPerWu;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const coc = Math.min(value('uCocMax'), value('uCocSlope') * Math.abs(z - value('uFocus')));
      const fringe = value('uFringe') * coc;
      const drawn = Math.min(
        size * (0.6 + s) * pxPerWu * this.pixels,
        value('uMaxSize') - 2 * (coc + fringe),
      );
      out.push({ index: i, x, y, size: drawn / this.pixels, z, blur: coc / this.pixels });
    }
    return out;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
