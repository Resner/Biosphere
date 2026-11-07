// The floating origin (M11 T11): a 262,144 wu world is too wide for the GPU's 32-bit floats, which
// keep only about 0.03 wu of precision out at the far corner, so the scene draws relative to an
// origin near the camera, snapped to multiples of `ORIGIN_STEP`. Every position and world-space
// uniform the renderer writes takes the origin off first; the patterns that live in world space
// (the caustics, the water's body, the god rays, the marine snow) take the origin's own phase in
// each pattern, worked out here in double precision, so they stay continuous when it moves.

/** The origin snaps to multiples of this many wu. */
export const ORIGIN_STEP = 4096;
/** It moves once the camera is more than this far from it on an axis, so it never flickers between two. */
export const ORIGIN_SLACK = 3072;

/**
 * The scene's origin, wu. `GameScene` moves it as the camera swims (`followOrigin`); every layer
 * subtracts it from what it sends to the GPU. Outside a game scene (the Lab, the card) it stays at 0.
 */
export const ORIGIN = { x: 0, y: 0 };

/** Moves `origin` to the step nearest the camera once the camera is `ORIGIN_SLACK` away; true when it moved. */
export function followOrigin(
  origin: { x: number; y: number },
  camX: number,
  camY: number,
): boolean {
  let moved = false;
  if (Math.abs(camX - origin.x) > ORIGIN_SLACK) {
    origin.x = Math.round(camX / ORIGIN_STEP) * ORIGIN_STEP;
    moved = true;
  }
  if (Math.abs(camY - origin.y) > ORIGIN_SLACK) {
    origin.y = Math.round(camY / ORIGIN_STEP) * ORIGIN_STEP;
    moved = true;
  }
  return moved;
}

/** `v` modulo `period`, in [0, period). */
export const wrapTo = (v: number, period: number): number => ((v % period) + period) % period;
