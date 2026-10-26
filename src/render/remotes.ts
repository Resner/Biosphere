import type * as THREE from 'three';
import { Cell, type CellView } from './cell';
import { CreatureCache, type CreatureSource } from './creature-cache';
import { CreatureView, type CreatureViewState } from './creature-view';

/** One other player's creature, as the renderer needs it. */
export interface RemoteCellView {
  /** Keeps a body on the same mesh from frame to frame. */
  id: string;
  x: number;
  y: number;
  heading: number;
  radius: number;
  beat: number;
  alpha: number;
  /** 0..1, a stable tint for the fallback cell. */
  hue: number;
  /** The creature's body; null or missing draws the tinted cell. */
  body?: CreatureSource | null;
}

/** Below this opacity a remote is not worth a draw call. */
const MIN_ALPHA = 0.01;

interface BodySlot {
  view: CreatureView;
  /** The frame in which the slot was last drawn. */
  frame: number;
}

/**
 * Other players: the body of their genome when they have one, else the player's own `Cell` tinted
 * by hue. A body whose mesh cannot be built is logged once and drawn as the cell.
 */
export class RemoteLayer {
  private readonly cells: Cell[] = [];
  private readonly cache = new CreatureCache();
  private readonly slots = new Map<string, BodySlot>();
  private readonly failed = new Set<string>();
  private readonly view: CellView = {
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: 0,
    hurt: 0,
    dissolve: 0,
  };
  private readonly bodyState: CreatureViewState = {
    creature: null as unknown as CreatureSource,
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: 0,
    hurt: 0,
    dissolve: 0,
  };
  /** Cells shown by the last `set`; the rest of the pool is already hidden. */
  private shown = 0;
  private bodies = 0;
  private frame = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly order: number,
  ) {}

  /**
   * Draws these remotes (and hides the rest). `pxPerWu` picks the level of detail of bodies.
   * Allocates only when the pond grows.
   */
  set(remotes: readonly RemoteCellView[], time: number, pxPerWu: number): void {
    this.frame++;
    let used = 0;
    let bodies = 0;
    for (const remote of remotes) {
      if (remote.alpha < MIN_ALPHA) continue;
      if (this.drawBody(remote, time, pxPerWu)) {
        bodies++;
        continue;
      }
      const cell = this.cellAt(used);
      used++;
      const { view } = this;
      view.x = remote.x;
      view.y = remote.y;
      view.heading = remote.heading;
      view.radius = remote.radius;
      view.beat = remote.beat;
      view.alpha = remote.alpha;
      view.hue = remote.hue;
      cell.update(view, time);
    }
    for (let i = used; i < this.shown; i++) (this.cells[i] as Cell).update(null, time);
    this.shown = used;
    this.bodies = bodies;
    // Let go of the mesh and geometry of a remote that left or lost its body.
    if (this.slots.size !== bodies) {
      for (const [id, slot] of this.slots) {
        if (slot.frame === this.frame) continue;
        this.dropSlot(slot);
        this.slots.delete(id);
      }
    }
  }

  /** Fallback cells currently drawn. */
  count(): number {
    return this.shown;
  }

  /** Genome bodies currently drawn. */
  bodyCount(): number {
    return this.bodies;
  }

  /** Geometries the cache holds. */
  assets(): number {
    return this.cache.live();
  }

  dispose(): void {
    for (const cell of this.cells) {
      this.scene.remove(cell.flagellum, cell.body);
      cell.dispose();
    }
    this.cells.length = 0;
    for (const slot of this.slots.values()) this.dropSlot(slot);
    this.slots.clear();
  }

  private drawBody(remote: RemoteCellView, time: number, pxPerWu: number): boolean {
    const { id, body } = remote;
    if (!body || (this.failed.size > 0 && this.failed.has(`${id}/${body.hash}`))) return false;
    let slot = this.slots.get(id);
    if (!slot) {
      const view = new CreatureView(this.cache);
      view.mesh.renderOrder = this.order + 0.5;
      this.scene.add(view.mesh);
      slot = { view, frame: 0 };
      this.slots.set(id, slot);
    }
    slot.frame = this.frame;
    const state = this.bodyState;
    state.creature = body;
    state.x = remote.x;
    state.y = remote.y;
    state.heading = remote.heading;
    state.radius = remote.radius;
    state.beat = remote.beat;
    state.alpha = remote.alpha;
    state.pxPerWu = pxPerWu;
    try {
      slot.view.update(state, time);
      return true;
    } catch (error) {
      this.failed.add(`${id}/${body.hash}`);
      console.error('remote creature mesh failed; drawing the plain cell', error);
      slot.view.dispose();
      return false;
    }
  }

  private dropSlot(slot: BodySlot): void {
    slot.view.dispose();
    slot.view.mesh.removeFromParent();
  }

  private cellAt(index: number): Cell {
    let cell = this.cells[index];
    if (!cell) {
      cell = new Cell();
      for (const [mesh, order] of [
        [cell.flagellum, this.order],
        [cell.body, this.order + 0.25],
      ] as const) {
        mesh.renderOrder = order;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
      }
      this.cells[index] = cell;
    }
    return cell;
  }
}
