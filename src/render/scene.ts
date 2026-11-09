import * as THREE from 'three';
import { depthAt } from '../sim/bathymetry';
import type { Seed } from '../sim/prng';
import type { CarrionPiece, FoodItem, Plume } from '../sim/types';
import { BodyLayer } from './body-layer';
import { topDownCamera } from './camera';
import { Cell, type CellView } from './cell';
import type { CreatureSource } from './creature-cache';
import type { Lod } from './creature-mesh';
import type { CreatureViewState } from './creature-view';
import type { Ring } from './effects';
import { EggLayer, type EggView } from './egg';
import { FoodLayer } from './food';
import { GlowLayer } from './glows';
import { type GpuExtent, watchGpu } from './gpu-watch';
import { PlumeLayer } from './hazards';
import { LookAnchor } from './look';
import { materialParams } from './material-params';
import { followOrigin, ORIGIN } from './origin';
import { type DrawnOutline, OutlineLayer } from './outlines';
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
import { type RideFrame, RideFx, type RideLook } from './ride-fx';
import { RingLayer } from './rings';
import { SwarmLayer, type SwarmPoint } from './swarms';
import { TelegraphLayer, type TelegraphMark } from './telegraph';
import { Water } from './water';
import {
  causticShift,
  glowAt,
  LIGHT_WATER,
  type Light,
  lightOf,
  MAX_LIGHTS,
  SunClock,
  sightAt,
  sunlight,
  ZONE_UNIFORMS,
  ZoneMap,
  zoneBlend,
} from './zones';

export interface SceneView {
  /** Seconds, for animation only. */
  time: number;
  /**
   * The water's clock, in seconds: the water, the snow, the caustics, the god rays, the food and the
   * plumes animate on it. It holds still during an egg's still scene (M6c T11); the sim does not.
   */
  waterTime: number;
  /** 0..1: how far the still scene has dimmed everything drawn behind the egg (M6c T11). */
  dim: number;
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
  /** Eggs to draw (M6 T20): the reveal, carried eggs and their tethers. */
  eggs: readonly EggView[];
  /** Fight telegraphs (M7 T12): windup glows, block sparks and the rings of creatures fighting elsewhere. */
  telegraphs: readonly TelegraphMark[];
  /** How far the player sees clearly in dark water, in wu (`sightRadius`, M6 T16). */
  sight: number;
  /** How far the sim's currents have carried the water since the pond began, in wu: it carries the snow (M6 T17). */
  flow: { readonly x: number; readonly y: number };
  /** The newest `near`'s swarm (M11 T17): players two or more tiers smaller, drawn as faint clouds. */
  swarm: readonly SwarmPoint[];
  /** A ride of the current playing (M12 T7): its streaks and wash; absent or null otherwise. */
  ride?: RideLook | null;
}

/** A creature's glow at a radius of 1 wu, by genome hash; null for one that does not glow. */
type Glow = Light | null;
/** Glows remembered at once; a pond holds 24 bodies. */
const GLOW_CACHE = 64;

/** The renderer name Chromium gives WebGL in place of the GPU's. */
const MASKED_RENDERER = 'WebKit WebGL';

/** `calls` and `triangles` count the whole frame: the scene and every post pass. */
export interface RenderInfo extends PostInfo {
  calls: number;
  triangles: number;
  foodInstances: number;
  /** Carrion pieces drawn (M7). */
  carrionInstances: number;
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
  memory: { geometries: number; textures: number; programs: number };
  /** The caustics' strength at the camera (M6 T17, `sunlight`); `rays` is the god rays' drawn. */
  caustic: number;
  /** Eggs drawn this frame, the player's and its peers' (M6 T20). */
  eggs: number;
  /** How much the still scene's veil darkens the picture this frame, 0 to `STILL_DIM` (M6c T11). */
  veil: number;
  /** Size outlines drawn this frame, by kind (M6 T21). */
  outlines: { bigger: number; smaller: number };
  /** Fight telegraphs drawn this frame, by kind (M7 T12). */
  telegraphs: { glows: number; sparks: number; rings: number };
  /** The player's centre as the GPU draws it, CSS pixels (M11 T11); null with no player. */
  centre: { x: number; y: number } | null;
  /** The floating origin the scene draws from, wu (M11 T11, `origin.ts`). */
  origin: { x: number; y: number };
  /** Swarm clouds drawn this frame, fading ones included (M11 T17, `swarms.ts`). */
  swarms: number;
  /** The look's scale this frame (M11 T17, `look.ts`): 1 up to a starter adult's view. */
  look: number;
}

/** The player's creature swims at the gameplay plane, and the camera focuses there (T3). */
const PLANE_DEPTH = 0;

/** Marine snow lies up to this far (camera heights) above and below the plane. */
const MID_SPREAD = 0.2;
/** The share of marine snow that catches the light on high (M6 T17). */
const SNOW_SPARKLE = 0.03;

const ORDER = {
  water: 0,
  glows: 0.5,
  far: 1,
  plumes: 2,
  food: 3,
  swarms: 3.5,
  cell: 4,
  eggs: 4.7,
  rings: 4.8,
  telegraphs: 4.85,
  outlines: 4.9,
  mid: 5,
  near: 6,
  /** A ride's wash over the world, under the creatures (M12 T7). */
  rideWash: 3.8,
  /** A ride's streaks of snow, over everything but the veil (M12 T7). */
  rideStreaks: 6.4,
  /** The still scene's veil over everything, and the egg and its rings above it (M6c T11). */
  veil: 6.5,
  eggsOverVeil: 6.6,
  ringsOverVeil: 6.7,
} as const;

/** The still scene dims the rest of the picture by this much at most (M6c T11). */
export const STILL_DIM = 0.35;

/** The whole play-field picture: backdrop, particle layers, plumes, food and the cell. */
export class GameScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = topDownCamera();
  private readonly water: Water;
  /** The pond's depth window (M6 T16, M11 T11) and its seed and size, which the zone shaders read. */
  private readonly zones = new ZoneMap();
  private seed: Seed | null = null;
  private size: number;
  /** The field last handed over (`setField`): it is written again when the floating origin moves. */
  private field: {
    food: readonly FoodItem[];
    plumes: readonly Plume[];
    carrion: readonly CarrionPiece[];
  } = { food: [], plumes: [], carrion: [] };
  /** The player's centre as the GPU draws it, CSS pixels (`info().centre`); null with no player. */
  private centre: { x: number; y: number } | null = null;
  private readonly glows = new Map<string, Glow>();
  private lights = 0;
  private readonly pools = new GlowLayer();
  private readonly far: ParticleLayer;
  private readonly mid: ParticleLayer;
  private readonly near: ParticleLayer;
  private readonly plumes = new PlumeLayer();
  private readonly food = new FoodLayer();
  private readonly swarms = new SwarmLayer();
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
  private readonly telegraphs = new TelegraphLayer();
  private readonly eggs = new EggLayer();
  /** The still scene's veil: black over the whole view, under the egg (M6c T11). */
  private readonly veil = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private readonly outlines = new OutlineLayer();
  private readonly rideFx = new RideFx();
  private readonly rideFrame: RideFrame = {
    camX: 0,
    camY: 0,
    halfWidth: 1,
    halfHeight: 1,
    time: 0,
  };
  private readonly outlineView = { camX: 0, camY: 0, pxPerWu: 1, width: 1, height: 1 };
  /** The plain cell drawn at a scaled size (a pop or a shrink), so the view itself is never written. */
  private readonly scaledCell: CellView = {
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: 0,
    hurt: 0,
    dissolve: 0,
  };
  private readonly remotes: RemoteLayer;
  private readonly post: PostChain;
  /** `debug.skipDraw` (a test aid): the scene updates as usual but its last draw call is skipped. */
  skipDraw = false;
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
  private readonly rays: RayView = {
    strength: 0,
    camX: 0,
    camY: 0,
    originX: 0,
    originY: 0,
    halfWidth: 1,
    halfHeight: 1,
    time: 0,
  };
  private caustic = 0;
  private readonly sun = new SunClock();
  /** The look's scale and the virtual camera its patterns are drawn around (M11 T17, `look.ts`). */
  private readonly look = new LookAnchor();
  private readonly light: boolean;
  private readonly onResize = () => this.resize();

  /** What the GPU has been sent (`?gpu=watch`, M11 T11); null unless watched. */
  private readonly watched: (() => GpuExtent) | null;

  /**
   * `dof: false` is the `?dof=0` test switch: every preset draws without its depth of field.
   * `light: false` is `?light=0`: no caustics and no god rays. `watch: true` is `?gpu=watch`: the
   * largest float sent to the GPU is kept (`gpuExtent`).
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    worldSize: number,
    options: { dof?: boolean; light?: boolean; watch?: boolean } = {},
  ) {
    this.light = options.light ?? true;
    this.size = worldSize;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.watched = options.watch
      ? watchGpu(this.renderer.getContext() as WebGL2RenderingContext)
      : null;
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
      ...this.food.all.map((mesh): [THREE.Object3D, number] => [mesh, ORDER.food]),
      [this.swarms.points, ORDER.swarms],
      [this.cell.flagellum, ORDER.cell],
      [this.cell.body, ORDER.cell + 0.5],
      [this.eggs.mesh, ORDER.eggs],
      [this.rings.mesh, ORDER.rings],
      [this.telegraphs.mesh, ORDER.telegraphs],
      [this.outlines.mesh, ORDER.outlines],
      [this.mid.points, ORDER.mid],
      [this.near.points, ORDER.near],
      [this.rideFx.wash, ORDER.rideWash],
      [this.rideFx.streaks, ORDER.rideStreaks],
      [this.veil, ORDER.veil],
    ];
    for (const [object, order] of items) {
      object.renderOrder = order;
      object.frustumCulled = false;
      // What lies behind the creatures also draws into the backdrop copy their glass refracts (T13).
      if (order < ORDER.cell - 0.1) object.layers.enable(BACKDROP_LAYER);
      this.scene.add(object);
    }

    this.veil.visible = false;
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
    // Firefox names the GPU here and warns that the debug extension is deprecated (M6c T8);
    // Chromium answers its generic name and unmasks only through the extension.
    const plain: unknown = gl.getParameter(gl.RENDERER);
    if (typeof plain === 'string' && plain && plain !== MASKED_RENDERER) return plain;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : plain;
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

  /** Draws the zones of the world being drawn, its depth window filled at once on the next frame. */
  setZones(seed: Seed, size: number): void {
    this.seed = seed;
    this.size = size;
    this.water.setWorld(size);
    this.zones.set(seed, size);
  }

  /** Fills the zones' depth window at once on the next frame (a debug teleport), with no budget. */
  settleZones(): void {
    this.zones.settle();
  }

  /** Replaces the food and plumes to draw; call when the sim ticks, not every frame. */
  setField(
    food: readonly FoodItem[],
    plumes: readonly Plume[],
    carrion: readonly CarrionPiece[],
  ): void {
    const { field } = this;
    field.food = food;
    field.plumes = plumes;
    field.carrion = carrion;
    this.food.set(food);
    this.food.setCarrion(carrion);
    this.plumes.set(plumes);
  }

  draw(view: SceneView): void {
    // The floating origin (M11 T11): the scene draws from a point near the camera, so every
    // position and world-space uniform sent to the GPU stays small anywhere in the world. When it
    // moves, the field's instances (written on ticks, not frames) are written again from it.
    if (followOrigin(ORIGIN, view.camX, view.camY)) {
      const { food, plumes, carrion } = this.field;
      this.setField(food, plumes, carrion);
    }
    this.half = view.halfHeight;
    const halfWidth = view.halfHeight * this.aspect;
    const camera = this.camera;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = view.halfHeight;
    camera.bottom = -view.halfHeight;
    camera.position.x = view.camX - ORIGIN.x;
    camera.position.y = view.camY - ORIGIN.y;
    camera.updateProjectionMatrix();

    const { look } = this;
    look.update(view.camX, view.camY, view.halfHeight, view.flow);
    this.water.update(view, halfWidth, this.light);
    this.zones.update(view.camX, view.camY, view.halfHeight, ORIGIN);
    ZONE_UNIFORMS.uLookScale.value = look.scale;
    ZONE_UNIFORMS.uCausticShift.value.set(
      causticShift(look.originX(ORIGIN.x)),
      causticShift(look.originY(ORIGIN.y)),
    );
    this.updateZones(view);
    this.post.setFocus(PLANE_DEPTH);
    const sprites = this.post.spriteDof(this.sprites);
    const depth = this.seed ? depthAt(this.seed, view.camX, view.camY, this.size) : null;
    const snow = depth === null ? 1 : zoneBlend(depth, 'snow');
    this.updateLight(view, halfWidth, depth);
    this.far.update(view, this.pxPerWu, sprites, snow, look);
    this.mid.update(view, this.pxPerWu, sprites, snow, look);
    this.near.update(view, this.pxPerWu, sprites, snow, look);
    this.plumes.update(view.waterTime, look.scale);
    this.food.update(view.waterTime, look.scale);
    this.swarms.update(
      view.swarm,
      view.waterTime,
      view.flow,
      look.scale,
      this.pxPerWu * sprites.pixels,
    );
    this.cell.update(this.drawBody(view) ? null : this.cellOf(view.creature), view.time);
    this.remotes.set(
      view.remotes,
      view.time,
      this.pxPerWu,
      this.preset,
      this.sightOf,
      this.causticOf,
    );
    this.eggs.set(view.eggs, view.time);
    this.rings.set(view.rings);
    this.telegraphs.set(view.telegraphs);
    this.updateOutlines(view);
    this.updateVeil(view, halfWidth);
    this.updateRide(view, halfWidth);
    this.updateCentre(view);

    if (!this.skipDraw) this.post.render(this.scene, camera);
  }

  /**
   * The still scene (M6c T11): a veil dims everything (the water, the snow and the other creatures)
   * by up to `STILL_DIM`, and the egg and its burst rings draw above it.
   */
  private updateVeil(view: SceneView, halfWidth: number): void {
    const on = view.dim > 0;
    const { veil } = this;
    veil.visible = on;
    this.eggs.mesh.renderOrder = on ? ORDER.eggsOverVeil : ORDER.eggs;
    this.rings.mesh.renderOrder = on ? ORDER.ringsOverVeil : ORDER.rings;
    if (!on) return;
    veil.position.set(view.camX - ORIGIN.x, view.camY - ORIGIN.y, 0);
    veil.scale.set(halfWidth, view.halfHeight, 1);
    (veil.material as THREE.MeshBasicMaterial).opacity = STILL_DIM * Math.min(1, view.dim);
  }

  /** A ride of the current (M12 T7): the wash and the streaks over the view, or nothing. */
  private updateRide(view: SceneView, halfWidth: number): void {
    const f = this.rideFrame;
    f.camX = view.camX;
    f.camY = view.camY;
    f.halfWidth = halfWidth;
    f.halfHeight = view.halfHeight;
    f.time = view.time;
    this.rideFx.update(f, view.ride ?? null);
  }

  /** Size outlines (M6 T21): remotes a tier bigger or smaller than the player. */
  private updateOutlines(view: SceneView): void {
    const o = this.outlineView;
    o.camX = view.camX;
    o.camY = view.camY;
    o.pxPerWu = this.pxPerWu;
    o.width = this.cssWidth;
    o.height = this.cssHeight;
    this.outlines.set(view.remotes, view.creature?.radius ?? null, view.time, o);
  }

  /**
   * Sunlight (M6 T17): the caustics and the god rays take the sunlight at the camera (the composite
   * draws the rays, so low has none), and move by the sun's clock at the camera's pace (M6b T8).
   * The rays are handed over in the patterns' units (M11 T17), so their shafts scale with the view.
   */
  private updateLight(view: SceneView, halfWidth: number, depth: number | null): void {
    this.caustic = this.causticAt(depth);
    const sunTime = this.sun.advance(view.waterTime, depth);
    ZONE_UNIFORMS.uSunTime.value = sunTime;
    const rays = this.rays;
    rays.strength = depth === null || !this.light ? 0 : sunlight(depth, 'rays');
    const { look } = this;
    const k = 1 / look.scale;
    rays.camX = (view.camX - ORIGIN.x) * k;
    rays.camY = (view.camY - ORIGIN.y) * k;
    rays.originX = look.originX(ORIGIN.x);
    rays.originY = look.originY(ORIGIN.y);
    rays.halfWidth = halfWidth * k;
    rays.halfHeight = view.halfHeight * k;
    rays.time = sunTime;
    this.post.setRays(rays);
  }

  /** The caustics' strength over a body at (x, y): the sunlight at its depth (M6 T17). */
  private readonly causticOf = (x: number, y: number): number =>
    this.causticAt(this.seed ? depthAt(this.seed, x, y, this.size) : null);

  private causticAt(depth: number | null): number {
    return depth === null || !this.light ? 0 : sunlight(depth, 'caustic');
  }

  /** Where the player sees from, and the glows of the player and the remotes in view (M6 T16). */
  private updateZones(view: SceneView): void {
    const { creature, body } = view;
    if (creature) {
      ZONE_UNIFORMS.uViewer.value.set(creature.x - ORIGIN.x, creature.y - ORIGIN.y, view.sight);
    }
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
    (ZONE_UNIFORMS.uLights.value[i] as THREE.Vector4).set(
      x - ORIGIN.x,
      y - ORIGIN.y,
      reach,
      strength,
    );
    // The pool on the water, as bright as the zone under the creature lets glow show.
    const k = this.seed
      ? strength * zoneBlend(depthAt(this.seed, x, y, this.size), 'glow') * LIGHT_WATER
      : 0;
    if (k > 0) this.pools.add(x, y, reach, r * k, g * k, b * k);
  }

  /**
   * How clearly the player sees a body at (x, y): the creature shader's fog, worked out once per
   * body from the zone under it, the distance to the viewer and the glows (`sightAt`).
   */
  private readonly sightOf = (x: number, y: number): number => {
    if (!this.seed) return 1;
    // The viewer and the lights are kept from the floating origin, as the shaders read them.
    const rx = x - ORIGIN.x;
    const ry = y - ORIGIN.y;
    const viewer = ZONE_UNIFORMS.uViewer.value;
    let lit = 0;
    for (let i = 0; i < this.lights; i++) {
      const l = ZONE_UNIFORMS.uLights.value[i] as THREE.Vector4;
      lit = Math.max(lit, glowAt(Math.sqrt((rx - l.x) ** 2 + (ry - l.y) ** 2), l.z, l.w));
    }
    const distance = Math.hypot(rx - viewer.x, ry - viewer.y);
    return sightAt(depthAt(this.seed, x, y, this.size), distance, viewer.z, lit);
  };

  /**
   * Where the GPU draws the player's centre, in CSS pixels: its position and the camera's as the
   * 32-bit floats the scene sends (both from the floating origin), projected as the shaders do.
   */
  private updateCentre(view: SceneView): void {
    const { creature } = view;
    if (!creature) {
      this.centre = null;
      return;
    }
    const k = this.pxPerWu;
    const dx = Math.fround(creature.x - ORIGIN.x) - Math.fround(this.camera.position.x);
    const dy = Math.fround(creature.y - ORIGIN.y) - Math.fround(this.camera.position.y);
    const centre = this.centre ?? { x: 0, y: 0 };
    centre.x = this.cssWidth / 2 + Math.fround(dx) * k;
    centre.y = this.cssHeight / 2 - Math.fround(dy) * k;
    this.centre = centre;
  }

  /** The plain cell's view at its drawn size. */
  private cellOf(creature: CellView | null): CellView | null {
    if (!creature || (creature.scale ?? 1) === 1) return creature;
    const cell = Object.assign(this.scaledCell, creature);
    cell.radius = creature.radius * (creature.scale ?? 1);
    return cell;
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
    // A pop or a shrink scales the drawn body; the level of detail still follows its real size.
    const scale = creature.scale ?? 1;
    state.radius = creature.radius * scale;
    state.beat = creature.beat;
    state.hurt = creature.hurt;
    state.dissolve = creature.dissolve;
    state.pxPerWu = scale > 0 ? this.pxPerWu / scale : this.pxPerWu;
    state.preset = this.preset;
    state.caustic = this.causticOf(creature.x, creature.y);
    return this.body.set(state, view.time);
  }

  info(): RenderInfo {
    const { render, memory, programs } = this.renderer.info;
    return {
      calls: render.calls,
      triangles: render.triangles,
      foodInstances: this.food.instances(),
      carrionInstances: this.food.carrionInstances(),
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
      memory: {
        geometries: memory.geometries,
        textures: memory.textures,
        programs: programs?.length ?? 0,
      },
      caustic: this.caustic,
      eggs: this.eggs.count(),
      veil: this.veil.visible ? (this.veil.material as THREE.MeshBasicMaterial).opacity : 0,
      outlines: this.outlines.counts(),
      telegraphs: this.telegraphs.counts(),
      centre: this.centre ? { ...this.centre } : null,
      origin: { x: ORIGIN.x, y: ORIGIN.y },
      swarms: this.swarms.count(),
      look: this.look.scale,
      ...this.post.info(),
    };
  }

  /** The largest float sent to the GPU so far and the uniform that sent it (`?gpu=watch`); null unless watched. */
  gpuExtent(): GpuExtent | null {
    return this.watched?.() ?? null;
  }

  /** The size outlines as last drawn, in CSS pixels, for tests. */
  outlinesDrawn(): DrawnOutline[] {
    return this.outlines.drawn();
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
      this.swarms,
      this.cell,
      this.body,
      this.eggs,
      this.rings,
      this.telegraphs,
      this.outlines,
      this.remotes,
      this.rideFx,
    ]) {
      part.dispose();
    }
    this.veil.geometry.dispose();
    (this.veil.material as THREE.MeshBasicMaterial).dispose();
    this.post.dispose();
    this.renderer.dispose();
    ORIGIN.x = 0;
    ORIGIN.y = 0;
    ZONE_UNIFORMS.uLookScale.value = 1;
  }
}
