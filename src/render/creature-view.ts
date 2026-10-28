// One creature on screen (M3 T11): an asset from the cache drawn as a single mesh whose shader
// swims it. The mesh is in core radii, so the view scales it by the creature's radius in world units.

import * as THREE from 'three';
import { advanceBeatPhase } from './beat';
import {
  type CreatureAsset,
  type CreatureCache,
  type CreatureSource,
  lodFor,
} from './creature-cache';
import type { Lod } from './creature-mesh';
import { GAIT_WRAP, gaitOf, trailHeading, turnLag } from './gait';
import { setUniform, shareBackdrop } from './materials';
import type { PresetName } from './presets';

export interface CreatureViewState {
  creature: CreatureSource;
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
  /** How clearly the player sees it in dark water (M6 T16, `sightAt`); a missing value is clear. */
  sight?: number;
  /** Screen pixels per world unit, for the level of detail; a missing value keeps the preset's. */
  pxPerWu?: number;
  /** The quality preset, whose level of detail the body is drawn at; a missing value is high (the Lab). */
  preset?: PresetName;
}

const NO_GEOMETRY = new THREE.BufferGeometry();

export class CreatureView {
  readonly mesh = new THREE.Mesh();
  private readonly blank = this.mesh.material;
  private asset: CreatureAsset | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private detail: Lod = 'high';
  private hash: string | null = null;
  private freq = 1;
  private phase = 0;
  /** The heading the antennae trail along (M6 T11); null until the first frame. */
  private trail: number | null = null;
  private lastTime: number | null = null;

  constructor(private readonly cache: CreatureCache) {
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  update(view: CreatureViewState | null, time: number): void {
    this.mesh.visible = view !== null;
    if (!view) {
      this.lastTime = null;
      this.trail = null;
      return;
    }
    const preset = view.preset ?? 'high';
    const detail =
      view.pxPerWu === undefined ? preset : lodFor(view.radius * view.pxPerWu, preset, this.detail);
    if (view.creature.hash !== this.hash) this.trail = null;
    if (view.creature.hash !== this.hash || detail !== this.detail || !this.asset) {
      this.attach(view, detail);
    }
    const material = this.material as THREE.ShaderMaterial;

    this.mesh.position.set(view.x, view.y, 0);
    this.mesh.rotation.z = view.heading;
    this.mesh.scale.setScalar(view.radius);
    const dt = time - (this.lastTime ?? time);
    this.phase = advanceBeatPhase(this.phase, view.beat, dt, this.freq, GAIT_WRAP);
    this.trail = trailHeading(this.trail ?? view.heading, view.heading, dt);
    this.lastTime = time;
    setUniform(material, 'uTime', time);
    setUniform(material, 'uPhase', this.phase);
    setUniform(material, 'uBeat', view.beat);
    setUniform(material, 'uTurn', turnLag(this.trail, view.heading));
    setUniform(material, 'uHurt', view.hurt);
    setUniform(material, 'uDissolve', view.dissolve);
    setUniform(material, 'uAlpha', view.alpha ?? 1);
    setUniform(material, 'uSight', view.sight ?? 1);
  }

  /** The level of detail drawn, and its vertex count (0 with no body). */
  get lod(): Lod | null {
    return this.asset?.lod ?? null;
  }

  get vertices(): number {
    return this.asset?.vertices ?? 0;
  }

  private attach(view: CreatureViewState, detail: Lod): void {
    this.release();
    const asset = this.cache.acquire(view.creature, detail);
    // The cached material is a template: the gait uniforms belong to this creature alone.
    const material = (asset.material as THREE.ShaderMaterial).clone();
    shareBackdrop(material);
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
    // The mesh must not keep pointing at what the cache is about to dispose.
    this.mesh.geometry = NO_GEOMETRY;
    this.mesh.material = this.blank;
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
