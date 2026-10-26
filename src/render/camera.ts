import * as THREE from 'three';
import { lerp } from '../sim/math';
import { RULES } from '../sim/rules';

const { heightCoeff, heightExp, smoothSeconds } = RULES.camera;
/** `smoothSeconds` is the time to cover ~98% of a zoom change: exp(-4) ≈ 0.018. */
const SETTLE_TIME_CONSTANTS = 4;

/** Visible half-height in world units for a creature of radius `r`. */
export function viewHalfHeight(r: number): number {
  return heightCoeff * r ** heightExp;
}

export interface CameraTarget {
  x: number;
  y: number;
  radius: number;
}

/** Follows a creature exactly and eases the zoom, with no overshoot. */
export class FollowCamera {
  x = 0;
  y = 0;
  halfHeight = viewHalfHeight(1);
  private started = false;

  update(dt: number, target: CameraTarget): void {
    const wanted = viewHalfHeight(target.radius);
    this.x = target.x;
    this.y = target.y;
    if (!this.started) {
      this.started = true;
      this.halfHeight = wanted;
      return;
    }
    const k = 1 - Math.exp((-dt * SETTLE_TIME_CONSTANTS) / smoothSeconds);
    this.halfHeight = lerp(this.halfHeight, wanted, k);
  }

  /** Jumps to the target without easing, e.g. on a new hatch. */
  snap(target: CameraTarget): void {
    this.started = false;
    this.update(0, target);
  }
}

/**
 * Half the depth range of the orthographic cameras, in world units. A body is scaled by its radius
 * in every axis (up to √2^24 = 4,096), so its dorsal height can reach a few thousand units; a
 * small fixed range clips the middle of a big body into a hole. Layers draw without a depth test,
 * so the wide range costs them nothing.
 */
export const CAMERA_DEPTH = 20_000;

/** A top-down camera looking down -z whose range covers the tallest possible body. */
export function topDownCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -CAMERA_DEPTH, CAMERA_DEPTH);
  camera.position.z = 5;
  return camera;
}
