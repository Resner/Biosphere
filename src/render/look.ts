// The look scales with the view (M11 T17, ADR 0062): the world-space look features (the caustics,
// the god rays, the marine snow and bokeh, the food's halo and the plumes' rim) grow with the
// camera's half-height past a starter adult's, so a giant's screen reads like a starter's.
//
// A pattern whose scale changes, drawn around a fixed point, sweeps across the screen the further
// the camera is from that point (at the far corner, a 1% zoom would slide the caustics by dozens of
// tiles). So the patterns are drawn around a virtual camera in the patterns' own units (wu at scale
// 1): it moves by the camera's motion divided by the scale, the patterns stay put in the world while
// the camera swims, and a change of scale zooms them about the camera.

import { viewHalfHeight } from '../sim/size';

/** The radius of a starter adult (a genesis cell's maximum biomass, 400). */
export const LOOK_ADULT_RADIUS = 20;
/** A starter adult's view half-height (about 133.4 wu): the look's scale is 1 there and below. */
export const LOOK_HALF_HEIGHT = viewHalfHeight(LOOK_ADULT_RADIUS, LOOK_ADULT_RADIUS);
/** The caustics' filaments repeat every 2π times this many wu at scale 1 (`causticAt`). */
export const CAUSTIC_WU = 18;
/**
 * A glowing food item's halo reaches at least this many wu times the scale (`food.vert.glsl`): a
 * layer-0 crystal's quad, so a starter's food is drawn as it was and a giant's smaller layer glows.
 */
export const FOOD_HALO_WU = 5.5;
/** A plume's dashed rim is at least this many wu times the scale wide: the smallest plume's at a starter's. */
export const PLUME_RIM_WU = 2.7;

/** The look's scale for a view of `halfHeight` wu: the view over a starter adult's, never below 1. */
export function lookScale(halfHeight: number): number {
  return Math.max(1, halfHeight / LOOK_HALF_HEIGHT);
}

/** The scale and the virtual camera the patterns are drawn around, updated once a frame. */
export class LookAnchor {
  /** The look's scale this frame (`lookScale`). */
  scale = 1;
  /** The camera in the patterns' units: wu at scale 1. */
  readonly cam = { x: 0, y: 0 };
  /** How far the currents have carried the water, in the patterns' units. */
  readonly flow = { x: 0, y: 0 };
  private camX = 0;
  private camY = 0;
  private flowX = 0;
  private flowY = 0;
  private started = false;

  /** Follows the camera at (`camX`, `camY`) seeing `halfHeight` wu, and the currents' carry in wu. */
  update(
    camX: number,
    camY: number,
    halfHeight: number,
    flow: { readonly x: number; readonly y: number },
  ): void {
    const scale = lookScale(halfHeight);
    if (this.started) {
      this.cam.x += (camX - this.camX) / scale;
      this.cam.y += (camY - this.camY) / scale;
      this.flow.x += (flow.x - this.flowX) / scale;
      this.flow.y += (flow.y - this.flowY) / scale;
    } else {
      // At scale 1 the virtual camera is the camera itself, and the patterns are as they were.
      this.cam.x = camX;
      this.cam.y = camY;
      this.flow.x = flow.x;
      this.flow.y = flow.y;
      this.started = true;
    }
    this.scale = scale;
    this.camX = camX;
    this.camY = camY;
    this.flowX = flow.x;
    this.flowY = flow.y;
  }

  /**
   * The floating origin's x in the patterns' units: a pattern draws a point `w` wu from the origin
   * at `originX + w / scale`, which is the virtual camera at the camera.
   */
  originX(origin: number): number {
    return this.cam.x - (this.camX - origin) / this.scale;
  }

  originY(origin: number): number {
    return this.cam.y - (this.camY - origin) / this.scale;
  }

  /** Starts again at the next update (a new scene or world). */
  reset(): void {
    this.started = false;
  }
}
