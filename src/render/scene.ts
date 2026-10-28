import * as THREE from 'three';
import { depthAt } from '../sim/bathymetry';
import type { Seed } from '../sim/prng';
import type { FoodItem, Plume } from '../sim/types';
import { BodyLayer } from './body-layer';
import { topDownCamera } from './camera';
import { Cell, type CellView } from './cell';
import type { CreatureSource } from './creature-cache';
import type { Lod } from './creature-mesh';
import type { CreatureViewState } from './creature-view';
import type { Ring } from './effects';
import { FoodLayer } from './food';
import { GlowLayer } from './glows';
import { PlumeLayer } from './hazards';
import { materialParams } from './material-params';
import { ParticleLayer, type Speck } from './particles';
import {
  BACKDROP_LAYER,
  PostChain,
  type PostInfo,
  type RayView,
  type SpriteDof,
} from './post/chain';
import {
  PARTICLE_COUNTS,
  type ParticleLayerName,
  PRESETS,
  type PresetName,
  pixelRatio,
} from './presets';
import { type RemoteCellView, RemoteLayer } from './remotes';
import { RingLayer } from './rings';
import { Water } from './water';
import {
  glowAt,
  LIGHT_WATER,
  type Light,
  lightOf,
  MAX_LIGHTS,
  sightAt,
  sunlight,
  ZONE_UNIFORMS,
  ZoneMap,
  zoneBlend,
} from './zones';

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
  /** How far the player sees clearly in dark water, in wu (`sightRadius`, M6 T16). */
  sight: number;
  /** The water's velocity at the camera in wu/s (the sim's currents): it carries the snow (M6 T17). */
  current: { readonly x: number; readonly y: number };
}

/** A creature's glow at a radius of 1 wu, by genome hash; null for one that does not glow. */
type Glow = Light | null;
/** Glows remembered at once; a pond holds 24 bodies. */
const GLOW_CACHE = 64;

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
  /** The player's body: its level of detail (null with no body) and mesh vertices (M6 T10). */
  lod: Lod | null;
  vertices: number;
  /** The renderer's pixel ratio. */
  pixelRatio: number;
  /** Particles drawn across the three layers. */
  particles: number;
  /** GPU resources alive in the renderer. */
  memory: { geometries: number; textures: number };
  /** The caustics' strength at the camera (M6 T17, `sunlight`); `rays` is the god rays' drawn. */
  caustic: number;
}

/** The player's creature swims at the gameplay plane, and the camera focuses there (T3). */
const PLANE_DEPTH = 0;

/** Marine snow lies up to this far (camera heights) above and below the plane. */
const MID_SPREAD = 0.2;
/** The share of marine snow that catches the light on high (M6 T17). */
const SNOW_SPARKLE = 0.03;
/** The longest frame step the snow's drift integrates: a stalled tab must not fling it. */
const MAX_FLOW_STEP = 0.25;

const ORDER = {
  water: 0,
  glows: 0.5,
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
  /** The pond's depth map (M6 T16) and its seed, which the zone shaders read. */
  private readonly zones = new ZoneMap();
  private seed: Seed | null = null;
  private readonly glows = new Map<string, Glow>();
  private lights = 0;
  private readonly pools = new GlowLayer();
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
  /** How far the currents have carried the water (wu, M6 T17), and the time it was last advanced. */
  private readonly flow = { x: 0, y: 0 };
  private flowTime: number | null = null;
  private readonly rays: RayView = {
    strength: 0,
    camX: 0,
    camY: 0,
    halfWidth: 1,
    halfHeight: 1,
    time: 0,
  };
  private caustic = 0;
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
    this.far = new ParticleLayer(PARTICLE_COUNTS.far, 11, {
      size: 16,
      period: 640,
      color: 0x7fb8ad,
      opacity: 0.1,
      bokeh: 1,
      parallax: 0.55,
    });
    this.mid = new ParticleLayer(PARTICLE_COUNTS.mid, 23, {
      size: 1.1,
      period: 640,
      color: 0xd8efe8,
      opacity: 0.7,
      bokeh: 0,
      parallax: 1,
      spread: MID_SPREAD,
      sparkle: SNOW_SPARKLE,
    });
    this.near = new ParticleLayer(PARTICLE_COUNTS.near, 37, {
      size: 42,
      period: 640,
      color: 0x9ad7c4,
      opacity: 0.045,
      bokeh: 1,
      parallax: 1.6,
    });

    const items: [THREE.Object3D, number][] = [
      [this.water.mesh, ORDER.water],
      [this.pools.mesh, ORDER.glows],
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
      // What lies behind the creatures also draws into the backdrop copy their glass refracts (T13).
      if (order < ORDER.cell - 0.1) object.layers.enable(BACKDROP_LAYER);
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
    for (const layer of [this.far, this.mid, this.near]) {
      layer.setShare(share);
      layer.setSparkle(PRESETS[preset].sparkle);
    }
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

  /** Loads the depth map of the pond being drawn; a no-op for the one already loaded. */
  setZones(seed: Seed, size: number): void {
    this.seed = seed;
    this.zones.set(seed, size);
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
    this.updateZones(view);
    this.post.setFocus(PLANE_DEPTH);
    const sprites = this.post.spriteDof(this.sprites);
    const depth = this.seed ? depthAt(this.seed, view.camX, view.camY) : null;
    const snow = depth === null ? 1 : zoneBlend(depth, 'snow');
    this.updateLight(view, halfWidth, depth);
    const { flow } = this;
    this.far.update(view, this.pxPerWu, sprites, snow, flow);
    this.mid.update(view, this.pxPerWu, sprites, snow, flow);
    this.near.update(view, this.pxPerWu, sprites, snow, flow);
    this.plumes.update(view.time);
    this.food.update(view.time);
    this.cell.update(this.drawBody(view) ? null : view.creature, view.time);
    this.remotes.set(
      view.remotes,
      view.time,
      this.pxPerWu,
      this.preset,
      this.sightOf,
      this.causticOf,
    );
    this.rings.set(view.rings);

    this.post.render(this.scene, camera);
  }

  /**
   * Sunlight and currents (M6 T17): the god rays take the sunlight at the camera (the composite draws
   * them, so low has none), and the snow is carried by the water's flow at the camera.
   */
  private updateLight(view: SceneView, halfWidth: number, depth: number | null): void {
    const step = this.flowTime === null ? 0 : view.time - this.flowTime;
    this.flowTime = view.time;
    const dt = Math.min(Math.max(step, 0), MAX_FLOW_STEP);
    this.flow.x += view.current.x * dt;
    this.flow.y += view.current.y * dt;
    this.caustic = depth === null ? 0 : sunlight(depth, 'caustic');
    const rays = this.rays;
    rays.strength = depth === null ? 0 : sunlight(depth, 'rays');
    rays.camX = view.camX;
    rays.camY = view.camY;
    rays.halfWidth = halfWidth;
    rays.halfHeight = view.halfHeight;
    rays.time = view.time;
    this.post.setRays(rays);
  }

  /** The caustics' strength over a body at (x, y): the sunlight at its depth (M6 T17). */
  private readonly causticOf = (x: number, y: number): number =>
    this.seed ? sunlight(depthAt(this.seed, x, y), 'caustic') : 0;

  /** Where the player sees from, and the glows of the player and the remotes in view (M6 T16). */
  private updateZones(view: SceneView): void {
    const { creature, body } = view;
    if (creature) ZONE_UNIFORMS.uViewer.value.set(creature.x, creature.y, view.sight);
    this.lights = 0;
    this.pools.clear();
    if (creature && body) this.addLight(body, creature.x, creature.y, creature.radius, 1);
    for (const r of view.remotes) {
      if (r.body && r.alpha >= 0.01) this.addLight(r.body, r.x, r.y, r.radius, r.alpha);
    }
    ZONE_UNIFORMS.uLightCount.value = this.lights;
    this.pools.flush();
  }

  private addLight(
    body: CreatureSource,
    x: number,
    y: number,
    radius: number,
    alpha: number,
  ): void {
    if (this.lights >= MAX_LIGHTS) return;
    let glow = this.glows.get(body.hash);
    if (glow === undefined) {
      if (this.glows.size >= GLOW_CACHE) this.glows.clear();
      glow = lightOf(materialParams(body.traits), 1);
      this.glows.set(body.hash, glow);
    }
    if (!glow) return;
    const i = this.lights++;
    const [r, g, b] = glow.color;
    const reach = glow.radius * radius;
    const strength = glow.strength * alpha;
    (ZONE_UNIFORMS.uLights.value[i] as THREE.Vector4).set(x, y, reach, strength);
    // The pool on the water, as bright as the zone under the creature lets glow show.
    const k = this.seed ? strength * zoneBlend(depthAt(this.seed, x, y), 'glow') * LIGHT_WATER : 0;
    if (k > 0) this.pools.add(x, y, reach, r * k, g * k, b * k);
  }

  /**
   * How clearly the player sees a body at (x, y): the creature shader's fog, worked out once per
   * body from the zone under it, the distance to the viewer and the glows (`sightAt`).
   */
  private readonly sightOf = (x: number, y: number): number => {
    if (!this.seed) return 1;
    const viewer = ZONE_UNIFORMS.uViewer.value;
    let lit = 0;
    for (let i = 0; i < this.lights; i++) {
      const l = ZONE_UNIFORMS.uLights.value[i] as THREE.Vector4;
      lit = Math.max(lit, glowAt(Math.sqrt((x - l.x) ** 2 + (y - l.y) ** 2), l.z, l.w));
    }
    const distance = Math.hypot(x - viewer.x, y - viewer.y);
    return sightAt(depthAt(this.seed, x, y), distance, viewer.z, lit);
  };

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
    state.preset = this.preset;
    state.caustic = this.causticOf(creature.x, creature.y);
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
      lod: this.body.lod(),
      vertices: this.body.vertices(),
      pixelRatio: this.renderer.getPixelRatio(),
      particles: this.far.drawnCount + this.mid.drawnCount + this.near.drawnCount,
      memory: { geometries: memory.geometries, textures: memory.textures },
      caustic: this.caustic,
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
      this.zones,
      this.water,
      this.pools,
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
