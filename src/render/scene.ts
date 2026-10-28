import * as THREE from 'three';
import type { FoodItem, Plume } from '../sim/types';
import { BodyLayer } from './body-layer';
import { topDownCamera } from './camera';
import { Cell, type CellView } from './cell';
import type { CreatureSource } from './creature-cache';
import type { CreatureViewState } from './creature-view';
import type { Ring } from './effects';
import { FoodLayer } from './food';
import { PlumeLayer } from './hazards';
import { ParticleLayer, type Speck } from './particles';
import { PostChain, type PostInfo, type SpriteDof } from './post/chain';
import { PRESETS, type PresetName, pixelRatio } from './presets';
import { type RemoteCellView, RemoteLayer } from './remotes';
import { RingLayer } from './rings';
import { Water } from './water';

export interface SceneView {
  /** Seconds, for animation only. */
  time: number;
  camX: number;
  camY: number;
  /** Visible half-height in world units. */
  halfHeight: number;
  creature: CellView | null;
  /** The player's body to draw in place of the plain cell; the cell stays the fallback. */
  body: CreatureSource | null;
  /** The other players in the pond. */
  remotes: readonly RemoteCellView[];
  /** Eat pops and dash ripples alive right now. */
  rings: readonly Ring[];
}

/** `calls` and `triangles` count the whole frame: the scene and every post pass. */
export interface RenderInfo extends PostInfo {
  calls: number;
  triangles: number;
  foodInstances: number;
  /** Other players' cells drawn this frame. */
  remoteCells: number;
  /** Other players drawn with their genome's body. */
  remoteBodies: number;
  /** Whether the player is drawn with its genome's body rather than the plain cell. */
  playerBody: boolean;
  /** CSS pixels per world unit. */
  pxPerWu: number;
  /** Creature geometries built and held by the player's and the remotes' caches. */
  creatureAssets: number;
  /** The quality preset in force. */
  preset: PresetName;
  /** The renderer's pixel ratio. */
  pixelRatio: number;
  /** Particles drawn across the three layers. */
  particles: number;
  /** GPU resources alive in the renderer. */
  memory: { geometries: number; textures: number };
}

/** The player's creature swims at the gameplay plane, and the camera focuses there (T3). */
const PLANE_DEPTH = 0;

export type ParticleLayerName = 'far' | 'mid' | 'near';

/** Marine snow lies up to this far (camera heights) above and below the plane. */
const MID_SPREAD = 0.2;

const ORDER = {
  water: 0,
  far: 1,
  plumes: 2,
  food: 3,
  cell: 4,
  rings: 4.8,
  mid: 5,
  near: 6,
} as const;

/** The whole play-field picture: backdrop, particle layers, plumes, food and the cell. */
export class GameScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = topDownCamera();
  private readonly water: Water;
  private readonly far: ParticleLayer;
  private readonly mid: ParticleLayer;
  private readonly near: ParticleLayer;
  private readonly plumes = new PlumeLayer();
  private readonly food = new FoodLayer();
  private readonly cell = new Cell();
  private readonly body: BodyLayer;
  private readonly bodyState: CreatureViewState = {
    creature: null as unknown as CreatureSource,
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: 0,
    hurt: 0,
    dissolve: 0,
    pxPerWu: 1,
  };
  private readonly rings = new RingLayer();
  private readonly remotes: RemoteLayer;
  private readonly post: PostChain;
  private readonly sprites: SpriteDof = {
    pixels: 1,
    shrink: 1,
    focus: 0,
    slope: 0,
    max: 0,
    fringe: 0,
  };
  private cssWidth = 1;
  private cssHeight = 1;
  private half = 1;
  private preset: PresetName = 'medium';
  private readonly onResize = () => this.resize();

  /** `dof: false` is the `?dof=0` test switch: every preset draws without its depth of field. */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    worldSize: number,
    options: { dof?: boolean } = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setClearColor(0x04090b);
    this.post = new PostChain(this.renderer, { dof: options.dof ?? true });
    this.post.setPreset(this.preset);

    this.remotes = new RemoteLayer(this.scene, ORDER.cell - 0.1);
    this.body = new BodyLayer(this.scene, ORDER.cell + 0.5);
    this.water = new Water(worldSize);
    // Big bokeh far below and near above the plane, and marine snow on and around it: low draws them
    // as they are, the depth of field (T3) blurs each speck by its depth.
    this.far = new ParticleLayer(290, 11, {
      size: 16,
      period: 640,
      color: 0x7fb8ad,
      opacity: 0.1,
      bokeh: 1,
      parallax: 0.55,
    });
    this.mid = new ParticleLayer(2500, 23, {
      size: 1.1,
      period: 640,
      color: 0xd8efe8,
      opacity: 0.7,
      bokeh: 0,
      parallax: 1,
      spread: MID_SPREAD,
    });
    this.near = new ParticleLayer(60, 37, {
      size: 42,
      period: 640,
      color: 0x9ad7c4,
      opacity: 0.045,
      bokeh: 1,
      parallax: 1.6,
    });

    const items: [THREE.Object3D, number][] = [
      [this.water.mesh, ORDER.water],
      [this.far.points, ORDER.far],
      [this.plumes.mesh, ORDER.plumes],
      ...this.food.meshes.map((mesh): [THREE.Object3D, number] => [mesh, ORDER.food]),
      [this.cell.flagellum, ORDER.cell],
      [this.cell.body, ORDER.cell + 0.5],
      [this.rings.mesh, ORDER.rings],
      [this.mid.points, ORDER.mid],
      [this.near.points, ORDER.near],
    ];
    for (const [object, order] of items) {
      object.renderOrder = order;
      object.frustumCulled = false;
      this.scene.add(object);
    }

    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  /** The quality preset in force. */
  get quality(): PresetName {
    return this.preset;
  }

  /**
   * Adaptive resolution (T4): the share of the canvas resolution the scene draws at, 0.6 to 1. The
   * post chain shrinks its scene target; low, which has none, shrinks the canvas's backing store.
   * The canvas keeps its CSS size either way, so the HUD and the DOM are never scaled.
   */
  setRenderScale(scale: number): void {
    this.post.setRenderScale(scale);
    this.resize();
  }

  /** The GPU's name (unmasked where the browser allows), which the benchmark result is stored by. */
  gpu(): string {
    const gl = this.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return typeof name === 'string' && name ? name : 'unknown';
  }

  /** Applies a quality preset: pixel ratio, particle share and post passes, with no reload. */
  setPreset(preset: PresetName): void {
    if (preset === this.preset) return;
    this.preset = preset;
    this.post.setPreset(preset);
    const share = PRESETS[preset].particles;
    for (const layer of [this.far, this.mid, this.near]) layer.setShare(share);
    this.resize();
  }

  resize(): void {
    this.cssWidth = this.canvas.clientWidth || window.innerWidth;
    this.cssHeight = this.canvas.clientHeight || window.innerHeight;
    const preset = pixelRatio(this.preset, window.devicePixelRatio);
    const ratio = this.post.direct ? preset * this.post.scale : preset;
    if (ratio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.post.resize(this.cssWidth, this.cssHeight, ratio);
  }

  /** Sets the zoom before the first draw, so input mapping starts right. */
  setHalfHeight(half: number): void {
    this.half = half;
  }

  get aspect(): number {
    return this.cssWidth / this.cssHeight;
  }

  /** CSS pixels per world unit at the current zoom. */
  get pxPerWu(): number {
    return this.cssHeight / (2 * this.half);
  }

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  /** Replaces the food and plumes to draw; call when the sim ticks, not every frame. */
  setField(food: readonly FoodItem[], plumes: readonly Plume[]): void {
    this.food.set(food);
    this.plumes.set(plumes);
  }

  draw(view: SceneView): void {
    this.half = view.halfHeight;
    const halfWidth = view.halfHeight * this.aspect;
    const camera = this.camera;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = view.halfHeight;
    camera.bottom = -view.halfHeight;
    camera.position.x = view.camX;
    camera.position.y = view.camY;
    camera.updateProjectionMatrix();

    this.water.update(view, halfWidth);
    this.post.setFocus(PLANE_DEPTH);
    const sprites = this.post.spriteDof(this.sprites);
    this.far.update(view, this.pxPerWu, sprites);
    this.mid.update(view, this.pxPerWu, sprites);
    this.near.update(view, this.pxPerWu, sprites);
    this.plumes.update(view.time);
    this.food.update(view.time);
    this.cell.update(this.drawBody(view) ? null : view.creature, view.time);
    this.remotes.set(view.remotes, view.time, this.pxPerWu);
    this.rings.set(view.rings);

    this.post.render(this.scene, camera);
  }

  /** Draws the player's genome body; false means the plain cell must stand in. */
  private drawBody(view: SceneView): boolean {
    const { creature, body } = view;
    if (!creature || !body) return this.body.set(null, view.time);
    const state = this.bodyState;
    state.creature = body;
    state.x = creature.x;
    state.y = creature.y;
    state.heading = creature.heading;
    state.radius = creature.radius;
    state.beat = creature.beat;
    state.hurt = creature.hurt;
    state.dissolve = creature.dissolve;
    state.pxPerWu = this.pxPerWu;
    return this.body.set(state, view.time);
  }

  info(): RenderInfo {
    const { render, memory } = this.renderer.info;
    return {
      calls: render.calls,
      triangles: render.triangles,
      foodInstances: this.food.instances(),
      remoteCells: this.remotes.count(),
      remoteBodies: this.remotes.bodyCount(),
      playerBody: this.body.shown(),
      pxPerWu: this.pxPerWu,
      creatureAssets: this.body.assets() + this.remotes.assets(),
      preset: this.preset,
      pixelRatio: this.renderer.getPixelRatio(),
      particles: this.far.drawnCount + this.mid.drawnCount + this.near.drawnCount,
      memory: { geometries: memory.geometries, textures: memory.textures },
      ...this.post.info(),
    };
  }

  /** The specks of a particle layer as last drawn, for tests. */
  specks(layer: ParticleLayerName): Speck[] {
    return this[layer].specks(this.pxPerWu, this.cssWidth, this.cssHeight);
  }

  /** Runs `frame` once per display frame until `stop()`. */
  start(frame: (ms: number) => void): void {
    this.renderer.setAnimationLoop(frame);
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    for (const part of [
      this.water,
      this.far,
      this.mid,
      this.near,
      this.plumes,
      this.food,
      this.cell,
      this.body,
      this.rings,
      this.remotes,
    ]) {
      part.dispose();
    }
    this.post.dispose();
    this.renderer.dispose();
  }
}
