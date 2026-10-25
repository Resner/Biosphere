import * as THREE from 'three';
import { TAU } from '../sim/math';
import type { FoodItem, FoodKind } from '../sim/types';
import { idFraction, writeInstance } from './instances';
import { foodMaterial, setUniform } from './materials';

/** Most items of one kind drawn at once; a full-zoom-out view on a wide screen holds far fewer. */
const FOOD_CAPACITY = 1024;

/** Quad half-size in food radii: leaves room for the halo around the body. */
const SPRITE = 2.2;

const KINDS: readonly { kind: FoodKind; shader: number; color: number }[] = [
  { kind: 'detritus', shader: 0, color: 0xc9a46a },
  { kind: 'globule', shader: 1, color: 0x8de88a },
  { kind: 'crystal', shader: 2, color: 0x7fd0ff },
];

const SLOT: Record<FoodKind, number> = { detritus: 0, globule: 1, crystal: 2 };

/** One `InstancedMesh` per food kind, rewritten whenever the sim ticks. */
export class FoodLayer {
  readonly meshes: THREE.InstancedMesh[];
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly counts = KINDS.map(() => 0);

  constructor() {
    this.meshes = KINDS.map((spec) => {
      const mesh = new THREE.InstancedMesh(
        this.geometry,
        foodMaterial(spec.shader, spec.color),
        FOOD_CAPACITY,
      );
      mesh.count = 0;
      return mesh;
    });
  }

  set(items: readonly FoodItem[]): void {
    this.counts.fill(0);
    for (const item of items) {
      const slot = SLOT[item.kind];
      const mesh = this.meshes[slot];
      const n = this.counts[slot] ?? 0;
      if (!mesh || n >= FOOD_CAPACITY) continue;
      const f = idFraction(item.id);
      writeInstance(mesh.instanceMatrix.array, n, item.x, item.y, item.radius * SPRITE, f * TAU, f);
      this.counts[slot] = n + 1;
    }
    this.meshes.forEach((mesh, slot) => {
      mesh.count = this.counts[slot] ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  update(time: number): void {
    for (const mesh of this.meshes) {
      const material = mesh.material as THREE.ShaderMaterial;
      setUniform(material, 'uTime', time);
    }
  }

  /** How many items are drawn across all kinds. */
  instances(): number {
    return this.meshes.reduce((sum, mesh) => sum + mesh.count, 0);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.geometry.dispose();
  }
}
