// The player's own creature in the game scene (M3 T15): the cached, shader-swum mesh of its genome.
// A mesh that cannot be built is logged once and the caller falls back to the plain `Cell`.

import type * as THREE from 'three';
import { CreatureCache } from './creature-cache';
import { CreatureView, type CreatureViewState } from './creature-view';

export class BodyLayer {
  private readonly cache = new CreatureCache();
  private readonly view = new CreatureView(this.cache);
  /** The creature whose mesh threw, so that it is neither retried every frame nor logged twice. */
  private failed: string | null = null;

  constructor(scene: THREE.Scene, order: number) {
    this.view.mesh.renderOrder = order;
    scene.add(this.view.mesh);
  }

  /** Draws the body and returns true, or hides it and returns false when there is none to draw. */
  set(state: CreatureViewState | null, time: number): boolean {
    if (state && state.creature.hash !== this.failed) {
      try {
        this.view.update(state, time);
        return true;
      } catch (error) {
        this.failed = state.creature.hash;
        console.error('creature mesh failed; drawing the plain cell', error);
        this.view.dispose();
        return false;
      }
    }
    // Let go of the geometry while the death screen is up.
    if (this.view.mesh.visible) this.view.dispose();
    return false;
  }

  /** Whether the mesh is on screen. */
  shown(): boolean {
    return this.view.mesh.visible;
  }

  dispose(): void {
    this.view.dispose();
    this.view.mesh.removeFromParent();
  }
}
