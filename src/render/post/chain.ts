// The post chain (M6 T2, ADR 0004): the scene renders into a half-float target, then dual-filter
// bloom, the grade, the vignette, film grain and chromatic aberration composite it onto the canvas.
// Low renders straight to the canvas with no target. The DOM HUD sits above the canvas and is never
// post-processed. The depth of field (T3, `dof.ts`) adds no pass of its own: the sprites off the focus
// plane draw their circle of confusion themselves, with the uniforms `spriteDof` gives them.
// Refraction (T13): a pass cannot sample the target it draws into, so the objects on
// `BACKDROP_LAYER` (the water, far particles, plumes and food) first draw into a half-resolution
// backdrop copy, which the creatures' glass samples through `BACKDROP` while the scene draws.

import * as THREE from 'three';
import { BACKDROP } from '../materials';
import { type DofMode, PRESETS, type PresetName } from '../presets';
import bloomFragment from '../shaders/bloom.frag.glsl?raw';
import postFragment from '../shaders/post.frag.glsl?raw';
import postVertex from '../shaders/post.vert.glsl?raw';
import { DOF_LOOK } from './dof';
import {
  bytesPerPixel,
  mipSizes,
  type PostPass,
  type PostPlan,
  postPlan,
  targetType,
} from './plan';

export interface PostInfo {
  passes: PostPass[];
  /** Render targets alive now. */
  targets: number;
  /** Their colour storage in bytes, multisample buffers included. */
  targetBytes: number;
  /** The scene target's share of the canvas resolution in each axis. */
  renderScale: number;
  /** The depth of field in force: half (medium) or full strength (high), or none (low, `?dof=0`). */
  dof: DofMode;
}

/** What a particle layer needs to draw its circle of confusion, in pixels of its own target. */
export interface SpriteDof {
  /** Target pixels per CSS pixel. */
  pixels: number;
  /** Target pixels per canvas pixel: below 1 when adaptive resolution (T4) shrinks the scene target. */
  shrink: number;
  /** The depth of the focus plane, in camera heights. */
  focus: number;
  /** CoC radius in target pixels per camera height off focus, and its cap; 0 without a DOF. */
  slope: number;
  max: number;
  /** The chromatic fringe as a share of the CoC; 0 below high. */
  fringe: number;
}

/** The look of the chain: tuned by eye against `docs/art/reference-01.jpg`. */
export const POST_LOOK = {
  /** Bloom starts below the threshold by the knee and is linear above it. */
  threshold: 0.55,
  knee: 0.3,
  /** Strength of the bloom added back. */
  bloom: 3.0,
  /** Each wider level counts this much of the one inside it: lower keeps the glow tight. */
  scatter: 0.7,
  /** Added to the darkest tones, fading out by a luminance of 0.3. */
  lift: [0.004, 0.014, 0.017] as const,
  /** Tones above this roll off towards white instead of clipping. */
  shoulder: 0.78,
  /** How much the corners darken. */
  vignette: 0.4,
  /** Red-blue separation as a share of the frame towards the corners. */
  chromatic: 0.006,
  /** Peak-to-peak grain amplitude. */
  grain: 0.03,
  /** How far the creatures' glass bends the water behind it, in core radii at a grazing angle. */
  refraction: 0.2,
} as const;

/** The layer (besides the default 0) of everything drawn behind the creatures, which the glass refracts. */
export const BACKDROP_LAYER = 1;

/** Render scale bounds for adaptive resolution (T4). */
const MIN_SCALE = 0.6;

function passMaterial(defines: Record<string, string>, blending: THREE.Blending) {
  return new THREE.ShaderMaterial({
    vertexShader: postVertex,
    fragmentShader: bloomFragment,
    defines,
    uniforms: {
      tSource: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: POST_LOOK.threshold },
      uKnee: { value: POST_LOOK.knee },
      uScatter: { value: POST_LOOK.scatter },
    },
    blending,
    depthTest: false,
    depthWrite: false,
  });
}

export class PostChain {
  private plan: PostPlan = postPlan('low');
  private preset: PresetName | null = null;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private renderScale = 1;
  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private backdrop: THREE.WebGLRenderTarget | null = null;
  private focus = 0;
  private mips: THREE.WebGLRenderTarget[] = [];
  private readonly type: THREE.TextureDataType;
  private readonly samples: number;
  private readonly lens: boolean;
  private readonly dof: boolean;
  /** Keeps the film grain's pattern from frame to frame (the gallery; a paused Lab). */
  still: boolean;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly quad: THREE.Mesh;
  private readonly prefilter = passMaterial({ PREFILTER: '' }, THREE.NoBlending);
  private readonly down = passMaterial({}, THREE.NoBlending);
  private readonly up = passMaterial({ UP: '' }, THREE.AdditiveBlending);
  private composite: THREE.ShaderMaterial | null = null;
  private frame = 0;
  private readonly clearColor = new THREE.Color();
  private readonly targetClear = new THREE.Color();
  private readonly rgb = { r: 0, g: 0, b: 0 };

  /**
   * `samples` multisamples the scene target. `lens: false` drops the vignette and the chromatic
   * aberration, which depend on where in the frame a thing is: the Lab's grid compares creatures
   * cell by cell, so a corner cell must not look different from a central one. `dof: false` (the
   * `?dof=0` test switch) turns the depth of field off. `still: true` keeps the film grain's pattern
   * from frame to frame, so the gallery (T5) gives the same picture however many frames it draws.
   */
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    options: { samples?: number; lens?: boolean; dof?: boolean; still?: boolean } = {},
  ) {
    // The chain resets the counters once a frame, so they add up every pass.
    renderer.info.autoReset = false;
    this.type = targetType((name) => renderer.extensions.has(name));
    this.samples = options.samples ?? 0;
    this.lens = options.lens ?? true;
    this.dof = options.dof ?? true;
    this.still = options.still ?? false;
    // One triangle that covers the screen: no seam down the diagonal, and a third fewer vertices.
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this.quad = new THREE.Mesh(this.geometry, this.down);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Turns passes on and off and sizes their targets; low renders straight to the canvas. */
  setPreset(preset: PresetName): void {
    if (preset === this.preset) return;
    this.preset = preset;
    this.plan = postPlan(preset, { lens: this.lens, dof: this.dof });
    this.composite?.dispose();
    this.composite = this.plan.passes.length > 0 ? this.compositeMaterial() : null;
    this.rebuild();
  }

  /** The canvas size in CSS pixels and its pixel ratio. */
  resize(width: number, height: number, pixelRatio: number): void {
    if (width === this.width && height === this.height && pixelRatio === this.pixelRatio) return;
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.rebuild();
  }

  /** Adaptive resolution (T4): the scene target's share of the canvas, 0.6 to 1. */
  setRenderScale(scale: number): void {
    const next = Math.min(1, Math.max(MIN_SCALE, scale));
    if (next === this.renderScale) return;
    this.renderScale = next;
    this.rebuild();
  }

  /** The render scale in force. */
  get scale(): number {
    return this.renderScale;
  }

  /** No pass and no target (low): the scene draws straight onto the canvas. */
  get direct(): boolean {
    return this.plan.passes.length === 0;
  }

  /** The depth of the focus plane, in camera heights (0: the gameplay plane). */
  setFocus(z: number): void {
    this.focus = z;
  }

  /** Fills `out` with how sprites draw their circle of confusion into the scene target. */
  spriteDof(out: SpriteDof): SpriteDof {
    const dof = this.plan.dof;
    out.shrink = this.sceneTarget ? this.renderScale : 1;
    out.pixels = this.pixelRatio * out.shrink;
    out.focus = this.focus;
    out.slope = dof ? DOF_LOOK.slope * out.pixels : 0;
    out.max = dof ? dof.maxPx * out.pixels : 0;
    out.fringe = dof?.fringe ? DOF_LOOK.fringe : 0;
    return out;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    r.info.reset();
    const target = this.sceneTarget;
    const composite = this.composite;
    const backdrop = this.backdrop;
    BACKDROP.texture.value = backdrop ? backdrop.texture : null;
    BACKDROP.strength.value = backdrop ? POST_LOOK.refraction : 0;
    if (!target || !composite) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    // three clears a target in linear values but the canvas in sRGB, while the scene's shaders
    // write display values either way: the target gets the clear colour's display values.
    r.getClearColor(this.clearColor);
    const alpha = r.getClearAlpha();
    const { rgb } = this;
    this.clearColor.getRGB(rgb, THREE.SRGBColorSpace);
    r.setClearColor(
      this.targetClear.setRGB(rgb.r, rgb.g, rgb.b, THREE.LinearSRGBColorSpace),
      alpha,
    );
    if (backdrop) {
      const mask = camera.layers.mask;
      camera.layers.set(BACKDROP_LAYER);
      r.setRenderTarget(backdrop);
      r.render(scene, camera);
      camera.layers.mask = mask;
    }
    r.setRenderTarget(target);
    r.render(scene, camera);
    r.setClearColor(this.clearColor, alpha);

    // Full-screen passes overwrite or add onto their whole target; clearing first would waste fill.
    const autoClear = r.autoClear;
    r.autoClear = false;
    try {
      const mips = this.mips;
      const first = mips[0];
      if (first) {
        this.pass(this.prefilter, target, first);
        for (let i = 1; i < mips.length; i++)
          this.pass(this.down, mips[i - 1] ?? first, mips[i] ?? first);
        for (let i = mips.length - 1; i > 0; i--)
          this.pass(this.up, mips[i] ?? first, mips[i - 1] ?? first);
      }
      const u = composite.uniforms;
      (u.tScene as THREE.IUniform).value = target.texture;
      (u.tBloom as THREE.IUniform).value = first ? first.texture : null;
      (u.uAspect as THREE.IUniform).value = this.width / this.height;
      if (!this.still) this.frame = (this.frame + 1) % 4096;
      (u.uSeed as THREE.IUniform).value = this.frame * 17.31;
      this.quad.material = composite;
      r.setRenderTarget(null);
      r.render(this.quadScene, this.quadCamera);
    } finally {
      r.autoClear = autoClear;
    }
  }

  info(): PostInfo {
    const bpp = bytesPerPixel(this.type);
    let targetBytes = 0;
    if (this.sceneTarget) {
      const { width, height } = this.sceneTarget;
      targetBytes += width * height * bpp * (1 + this.samples);
    }
    if (this.backdrop) targetBytes += this.backdrop.width * this.backdrop.height * bpp;
    for (const mip of this.mips) targetBytes += mip.width * mip.height * bpp;
    return {
      passes: [...this.plan.passes],
      targets: (this.sceneTarget ? 1 : 0) + (this.backdrop ? 1 : 0) + this.mips.length,
      targetBytes,
      renderScale: this.renderScale,
      dof: this.plan.dof && this.preset ? PRESETS[this.preset].dof : 'none',
    };
  }

  dispose(): void {
    this.release();
    this.composite?.dispose();
    this.composite = null;
    for (const material of [this.prefilter, this.down, this.up]) material.dispose();
    this.geometry.dispose();
  }

  private pass(
    material: THREE.ShaderMaterial,
    source: THREE.WebGLRenderTarget,
    target: THREE.WebGLRenderTarget,
  ): void {
    const u = material.uniforms;
    (u.tSource as THREE.IUniform).value = source.texture;
    ((u.uTexel as THREE.IUniform).value as THREE.Vector2).set(1 / source.width, 1 / source.height);
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  private compositeMaterial(): THREE.ShaderMaterial {
    const defines: Record<string, string> = {};
    if (this.plan.bloom) defines.BLOOM = '';
    if (this.plan.passes.includes('chromatic')) defines.CHROMATIC = '';
    if (this.plan.passes.includes('grain')) defines.GRAIN = '';
    // The first mip ends up holding every level, each weighted by the scatter once more.
    let weight = 0;
    for (let i = 0; i < (this.plan.bloom?.levels ?? 1); i++) weight += POST_LOOK.scatter ** i;
    return new THREE.ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: postFragment,
      defines,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uBloom: { value: POST_LOOK.bloom / weight },
        uAspect: { value: 1 },
        uVignette: { value: this.plan.passes.includes('vignette') ? POST_LOOK.vignette : 0 },
        uLift: { value: new THREE.Vector3(...POST_LOOK.lift) },
        uKnee: { value: POST_LOOK.shoulder },
        uChromatic: { value: POST_LOOK.chromatic },
        uGrain: { value: POST_LOOK.grain },
        uSeed: { value: 0 },
      },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
  }

  private target(width: number, height: number, samples: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, height, {
      type: this.type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      samples,
    });
  }

  /** Frees the old targets and makes the ones the plan needs at today's size. */
  private rebuild(): void {
    this.release();
    if (this.plan.passes.length === 0) return;
    const width = Math.max(1, Math.floor(this.width * this.pixelRatio * this.renderScale));
    const height = Math.max(1, Math.floor(this.height * this.pixelRatio * this.renderScale));
    this.sceneTarget = this.target(width, height, this.samples);
    const backdrop = this.plan.backdrop;
    if (backdrop) {
      this.backdrop = this.target(
        Math.max(1, Math.round(width * backdrop.scale)),
        Math.max(1, Math.round(height * backdrop.scale)),
        0,
      );
    }
    const bloom = this.plan.bloom;
    if (bloom) {
      this.mips = mipSizes(width, height, bloom.scale, bloom.levels).map(([w, h]) =>
        this.target(w, h, 0),
      );
    }
  }

  private release(): void {
    this.sceneTarget?.dispose();
    this.sceneTarget = null;
    this.backdrop?.dispose();
    this.backdrop = null;
    for (const mip of this.mips) mip.dispose();
    this.mips = [];
  }
}
