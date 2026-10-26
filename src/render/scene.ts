import * as THREE from 'three';
import type { FoodItem, Plume } from '../sim/types';
import { BodyLayer } from './body-layer';
import { Cell, type CellView } from './cell';
import type { CreatureSource } from './creature-cache';
import type { CreatureViewState } from './creature-view';
import type { Ring } from './effects';
import { FoodLayer } from './food';
import { PlumeLayer } from './hazards';
import { ParticleLayer } from './particles';
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

export interface RenderInfo {
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
  /** GPU resources alive in the renderer. */
  memory: { geometries: number; textures: number };
}

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
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
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
  private cssWidth = 1;
  private cssHeight = 1;
  private half = 1;
  private readonly onResize = () => this.resize();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    worldSize: number,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x04090b);
    this.camera.position.z = 5;

    this.remotes = new RemoteLayer(this.scene, ORDER.cell - 0.1);
    this.body = new BodyLayer(this.scene, ORDER.cell + 0.5);
    this.water = new Water(worldSize);
    // Fake depth of field until M6: big soft bokeh far below and near above the plane.
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

  resize(): void {
    this.cssWidth = this.canvas.clientWidth || window.innerWidth;
    this.cssHeight = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
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
    // Point sizes are in device pixels.
    const pxPerWu = this.pxPerWu * this.renderer.getPixelRatio();
    this.far.update(view, pxPerWu);
    this.mid.update(view, pxPerWu);
    this.near.update(view, pxPerWu);
    this.plumes.update(view.time);
    this.food.update(view.time);
    this.cell.update(this.drawBody(view) ? null : view.creature, view.time);
    this.remotes.set(view.remotes, view.time, this.pxPerWu);
    this.rings.set(view.rings);

    this.renderer.render(this.scene, camera);
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
      memory: { geometries: memory.geometries, textures: memory.textures },
    };
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
    this.renderer.dispose();
  }
}
