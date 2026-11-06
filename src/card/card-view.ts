// The creature on a card (M9 T12): one body drawn with the game's creature mesh, glass and post
// chain, at rest and swimming gently (still under Reduce motion), scaled so it fills its stage.
// Without WebGL2 the flat preview of the offspring card stands in. It draws from the bundle's genome
// alone, so no frame ever waits on the verifier.

import * as THREE from 'three';
import { hatchBody } from '../game/body';
import { drawPreview } from '../game/offspring-preview';
import type { Genome } from '../genome/codec';
import { topDownCamera } from '../render/camera';
import { CreatureCache } from '../render/creature-cache';
import { CreatureView, type CreatureViewState } from '../render/creature-view';
import { PostChain } from '../render/post/chain';
import { type PresetName, pixelRatio } from '../render/presets';

const WATER = 0x04090b;
/** How hard the creature swims on its card: a gentle gait (0..1). */
const CARD_SWIM = 0.3;
/** The share of the stage the body's box may fill. */
const FILL = 0.84;
/** The body's slant on the stage, radians from east: a specimen laid at a slight angle. */
const HEADING = 0.28;

/**
 * The core radius (pixels) and the offset (pixels, y up) that fit a body's rest box, in core radii
 * and turned by `heading`, inside a stage of `w` × `h` pixels.
 */
export function fitBody(
  box: { minX: number; maxX: number; minY: number; maxY: number },
  w: number,
  h: number,
  heading = HEADING,
): { radius: number; x: number; y: number } {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ] as const) {
    xs.push(px * c - py * s);
    ys.push(px * s + py * c);
  }
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const radius = Math.max(1e-3, Math.min((w * FILL) / (x1 - x0 || 1), (h * FILL) / (y1 - y0 || 1)));
  return { radius, x: (-(x0 + x1) / 2) * radius, y: (-(y0 + y1) / 2) * radius };
}

export interface StageOptions {
  canvas: HTMLCanvasElement;
  preview: HTMLCanvasElement;
  preset: PresetName;
  /** Reduce motion: the body is drawn at rest and the clock stands still. */
  still: boolean;
  /** Called once, when a frame first shows the creature. */
  onDrawn(how: 'webgl' | 'preview'): void;
}

export class CreatureStage {
  private renderer: THREE.WebGLRenderer | null = null;
  private post: PostChain | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = topDownCamera();
  private readonly cache = new CreatureCache();
  private readonly view = new CreatureView(this.cache);
  private frame: CreatureViewState | null = null;
  private box: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private width = 1;
  private height = 1;
  private clock = 0;
  private last: number | null = null;
  private drawn = false;
  private genome: Genome | null = null;

  constructor(private readonly opts: StageOptions) {
    try {
      // The scene target is multisampled instead: the canvas only receives the composite.
      this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: false });
    } catch (error) {
      console.warn('no WebGL2: the card draws the flat preview', error);
      opts.canvas.hidden = true;
      opts.preview.hidden = false;
      return;
    }
    this.renderer.setClearColor(WATER);
    this.renderer.setPixelRatio(pixelRatio(opts.preset, window.devicePixelRatio));
    this.post = new PostChain(this.renderer, { samples: 4, lens: false, still: opts.still });
    this.post.setPreset(opts.preset);
    this.scene.add(this.view.mesh);
  }

  /** Shows this creature from the next frame on. */
  show(genome: Genome): void {
    this.genome = genome;
    const body = hatchBody(genome);
    if (!this.renderer) {
      this.drawFlat();
      return;
    }
    this.frame = {
      creature: body.creature,
      x: 0,
      y: 0,
      heading: HEADING,
      radius: 1,
      beat: this.opts.still ? 0 : CARD_SWIM,
      hurt: 0,
      dissolve: 0,
    };
    // The first update builds the mesh, whose rest box sets the fit.
    this.view.update(this.frame, this.clock);
    const geometry = this.view.mesh.geometry;
    geometry.computeBoundingBox();
    const b = geometry.boundingBox;
    this.box = b ? { minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y } : null;
    this.place();
  }

  /** The stage's size in CSS pixels. */
  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    if (!this.renderer || !this.post) {
      this.opts.preview.width = this.width;
      this.opts.preview.height = this.height;
      this.drawFlat();
      return;
    }
    this.fitTargets();
    if (this.opts.still) this.draw();
  }

  /**
   * One frame of the creature at `width` × `height` device pixels, copied to a 2D canvas (M9 T14):
   * drawn and read back in this one task, so the WebGL canvas needs no preserved buffer, then the
   * stage is drawn again at its own size before the browser shows a frame. Null before a creature.
   */
  snapshot(width: number, height: number): HTMLCanvasElement | null {
    if (!this.genome) return null;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    if (!this.renderer || !this.post) {
      drawPreview(out, hatchBody(this.genome));
      return out;
    }
    const ctx = out.getContext('2d');
    if (!ctx || !this.frame) return null;
    const [w, h, ratio] = [this.width, this.height, this.renderer.getPixelRatio()];
    this.renderer.setPixelRatio(1);
    [this.width, this.height] = [width, height];
    try {
      this.fitTargets();
      this.draw();
      ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
    } finally {
      this.renderer.setPixelRatio(ratio);
      [this.width, this.height] = [w, h];
      this.fitTargets();
      this.draw();
    }
    return out;
  }

  /** Sizes the renderer, the post chain and the camera to the stage, and fits the body to it. */
  private fitTargets(): void {
    if (!this.renderer || !this.post) return;
    this.renderer.setSize(this.width, this.height, false);
    this.post.resize(this.width, this.height, this.renderer.getPixelRatio());
    const cam = this.camera;
    cam.left = -this.width / 2;
    cam.right = this.width / 2;
    cam.top = this.height / 2;
    cam.bottom = -this.height / 2;
    cam.updateProjectionMatrix();
    this.place();
  }

  /** One animation frame: the gait moves on unless motion is reduced. */
  tick(now: number): void {
    if (!this.frame || !this.post) return;
    if (this.opts.still && this.drawn) return;
    if (!this.opts.still)
      this.clock += this.last === null ? 0 : Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.draw();
  }

  private place(): void {
    if (!this.frame || !this.box) return;
    const fit = fitBody(this.box, this.width, this.height);
    this.frame.radius = fit.radius;
    this.frame.x = fit.x;
    this.frame.y = fit.y;
  }

  private draw(): void {
    if (!this.frame || !this.post) return;
    this.view.update(this.frame, this.clock);
    this.post.render(this.scene, this.camera);
    if (!this.drawn && this.view.vertices > 0) {
      this.drawn = true;
      this.opts.onDrawn('webgl');
    }
  }

  private drawFlat(): void {
    if (!this.genome) return;
    drawPreview(this.opts.preview, hatchBody(this.genome));
    if (!this.drawn) {
      this.drawn = true;
      this.opts.onDrawn('preview');
    }
  }
}
