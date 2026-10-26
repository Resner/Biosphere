// Reference-counted creature geometry (M3 T10): one asset per genome hash and detail level, built
// on the first acquire and disposed when the last holder lets go. Sessions last hours, so every
// geometry and material has an owner that releases it.

import type * as THREE from 'three';
import type { BodyPlan, Detail } from '../genome/develop';
import { buildCreatureGeometry } from './creature-mesh';
import { creatureMaterial } from './materials';

/** A body smaller than this many pixels across (radius) drops to low detail; larger than `FULL_ABOVE` returns to full. */
export const LOW_BELOW = 12;
export const FULL_ABOVE = 16;

/** The detail level for a creature of the given on-screen radius; between the two limits it keeps `current`. */
export function lodFor(screenRadiusPx: number, current: Detail = 'full'): Detail {
  if (screenRadiusPx < LOW_BELOW) return 'low';
  if (screenRadiusPx > FULL_ABOVE) return 'full';
  return current;
}

export interface CreatureAsset {
  readonly key: string;
  readonly detail: Detail;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

interface Entry {
  asset: CreatureAsset;
  refs: number;
}

export class CreatureCache {
  private readonly entries = new Map<string, Entry>();

  /** `makeMaterial` must return a fresh material each call: the cache disposes it with the geometry. */
  constructor(private readonly makeMaterial: () => THREE.Material = creatureMaterial) {}

  acquire(creature: { hash: string; plan: BodyPlan }, detail: Detail): CreatureAsset {
    const key = `${creature.hash}/${detail}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        asset: {
          key,
          detail,
          geometry: buildCreatureGeometry(creature.plan, detail),
          material: this.makeMaterial(),
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
