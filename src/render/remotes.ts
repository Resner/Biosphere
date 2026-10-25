import type * as THREE from 'three';
import { Cell, type CellView } from './cell';

/** One other player's cell, as the renderer needs it. */
export interface RemoteCellView {
  x: number;
  y: number;
  heading: number;
  radius: number;
  beat: number;
  alpha: number;
  /** 0..1, a stable tint. */
  hue: number;
}

/** Below this opacity a remote is not worth a draw call. */
const MIN_ALPHA = 0.01;

/** Other players' cells: the player's own `Cell`, one per remote, tinted by hue. */
export class RemoteLayer {
  private readonly cells: Cell[] = [];
  private readonly view: CellView = {
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

  constructor(
    private readonly scene: THREE.Scene,
    private readonly order: number,
  ) {}

  /** Draws these remotes (and hides the rest of the pool). Allocates only when the pond grows. */
  set(remotes: readonly RemoteCellView[], time: number): void {
    let used = 0;
    for (const remote of remotes) {
      if (remote.alpha < MIN_ALPHA) continue;
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
  }

  /** Cells currently drawn. */
  count(): number {
    return this.shown;
  }

  dispose(): void {
    for (const cell of this.cells) {
      this.scene.remove(cell.flagellum, cell.body);
      cell.dispose();
    }
    this.cells.length = 0;
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
