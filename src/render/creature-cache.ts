// Reference-counted creature geometry (M3 T10, M6 T10): one asset per genome hash and level of
// detail (the preset's, or low for a body small on screen), built on the first acquire and disposed
// when the last holder lets go. Sessions last hours, so every geometry and material has an owner
// that releases it.

import type * as THREE from 'three';
import type { BodyPlan } from '../genome/develop';
import type { Traits } from '../genome/express';
import { anatomyOf } from './anatomy';
import { buildCreatureGeometry, type Lod } from './creature-mesh';
import { materialParams } from './material-params';
import { creatureMaterial } from './materials';
import { glintPlanOf, glintsOf } from './surface';

/** A body smaller than this many pixels (radius) drops to low detail; larger than `FULL_ABOVE` returns to the preset's. */
export const LOW_BELOW = 12;
export const FULL_ABOVE = 16;

/**
 * The level of detail for a creature of the given on-screen radius under `preset`: the preset's own
 * level, or low when small. Between the two limits a body that is already low stays low.
 */
export function lodFor(screenRadiusPx: number, preset: Lod, current: Lod = preset): Lod {
  if (screenRadiusPx < LOW_BELOW) return 'low';
  if (screenRadiusPx > FULL_ABOVE) return preset;
  return current === 'low' ? 'low' : preset;
}

export interface CreatureAsset {
  readonly key: string;
  readonly lod: Lod;
  readonly geometry: THREE.BufferGeometry;
  /** The geometry's vertex count. */
  readonly vertices: number;
  readonly material: THREE.Material;
}

export interface CreatureSource {
  hash: string;
  plan: BodyPlan;
  traits: Traits;
}

interface Entry {
  asset: CreatureAsset;
  refs: number;
}

export class CreatureCache {
  private readonly entries = new Map<string, Entry>();

  /** `makeMaterial` must return a fresh material each call: the cache disposes it with the geometry. */
  constructor(
    private readonly makeMaterial: (creature: CreatureSource) => THREE.Material = (c) =>
      creatureMaterial(materialParams(c.traits), glintsOf(c.traits).brightness),
  ) {}

  acquire(creature: CreatureSource, lod: Lod): CreatureAsset {
    const key = `${creature.hash}/${lod}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const { plan, traits, hash } = creature;
      const geometry = buildCreatureGeometry(
        plan,
        lod,
        anatomyOf(plan, traits, hash),
        glintPlanOf(creature),
      );
      entry = {
        asset: {
          key,
          lod,
          geometry,
          vertices: geometry.getAttribute('position').count,
          material: this.makeMaterial(creature),
        },
        refs: 0,
      };
      this.entries.set(key, entry);
    }
    entry.refs++;
    return entry.asset;
  }

  release(asset: CreatureAsset): void {
    const entry = this.entries.get(asset.key);
    if (!entry || entry.asset !== asset) return;
    if (--entry.refs > 0) return;
    this.entries.delete(asset.key);
    asset.geometry.dispose();
    asset.material.dispose();
  }

  /** Assets currently built. */
  live(): number {
    return this.entries.size;
  }
}
