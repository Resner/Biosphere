// One creature on screen (M3 T11): an asset from the cache drawn as a single mesh whose shader
// swims it. The mesh is in core radii, so the view scales it by the creature's radius in world units.

import * as THREE from 'three';
import type { BodyPlan, Detail } from '../genome/develop';
import type { Traits } from '../genome/express';
import { advanceBeatPhase } from './beat';
import { type CreatureAsset, type CreatureCache, lodFor } from './creature-cache';
import { gaitOf } from './gait';
import { setUniform } from './materials';

export interface CreatureViewState {
  creature: { hash: string; plan: BodyPlan; traits: Traits };
  x: number;
  y: number;
  /** Radians, 0 pointing east and growing counter-clockwise. */
  heading: number;
  /** The core radius in world units. */
  radius: number;
  /** 0..1, how hard the creature swims. */
  beat: number;
  /** 0..1, how red the body is from a recent hit. */
  hurt: number;
  /** 0..1, how far the dying body has dissolved. */
  dissolve: number;
  /** 0..1, opacity; a missing value means opaque. */
  alpha?: number;
  /** Screen pixels per world unit, for the level of detail; a missing value keeps full detail. */
  pxPerWu?: number;
}

export class CreatureView {
  readonly mesh = new THREE.Mesh();
  private asset: CreatureAsset | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private detail: Detail = 'full';
  private hash: string | null = null;
  private freq = 1;
  private phase = 0;
  private lastTime: number | null = null;

  constructor(private readonly cache: CreatureCache) {
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  update(view: CreatureViewState | null, time: number): void {
    this.mesh.visible = view !== null;
    if (!view) {
      this.lastTime = null;
      return;
    }
    const detail =
      view.pxPerWu === undefined ? 'full' : lodFor(view.radius * view.pxPerWu, this.detail);
    if (view.creature.hash !== this.hash || detail !== this.detail || !this.asset) {
      this.attach(view, detail);
    }
    const material = this.material as THREE.ShaderMaterial;

    this.mesh.position.set(view.x, view.y, 0);
    this.mesh.rotation.z = view.heading;
    this.mesh.scale.setScalar(view.radius);
    this.phase = advanceBeatPhase(this.phase, view.beat, time - (this.lastTime ?? time), this.freq);
    this.lastTime = time;
    setUniform(material, 'uPhase', this.phase);
    setUniform(material, 'uBeat', view.beat);
    setUniform(material, 'uHurt', view.hurt);
    setUniform(material, 'uDissolve', view.dissolve);
    setUniform(material, 'uAlpha', view.alpha ?? 1);
  }

  private attach(view: CreatureViewState, detail: Detail): void {
    this.release();
    const asset = this.cache.acquire(view.creature, detail);
    // The cached material is a template: the gait uniforms belong to this creature alone.
    const material = (asset.material as THREE.ShaderMaterial).clone();
    const gait = gaitOf(view.creature.traits, view.creature.plan);
    setUniform(material, 'uAmp', gait.amp);
    setUniform(material, 'uBend', gait.bend);
    this.freq = gait.freq;
    this.asset = asset;
    this.material = material;
    this.hash = view.creature.hash;
    this.detail = detail;
    this.mesh.geometry = asset.geometry;
    this.mesh.material = material;
  }

  private release(): void {
    if (this.asset) this.cache.release(this.asset);
    this.material?.dispose();
    this.asset = null;
    this.material = null;
  }

  dispose(): void {
    this.release();
    this.hash = null;
    this.mesh.visible = false;
  }
}
