// The buffers a creature mesh is built into (`Mesh`), and what each vertex carries besides its
// shape: the part it belongs to (`aPart`), how it moves (`aFrame`, `aMotion`) and its wall coordinate.

/** What a vertex belongs to, the low four bits of `aPart`; the rest is the appendage number (0 for none). */
export const PART_KINDS = 16;
export const PART_BODY = 0;
export const PART_APPENDAGE = 1;
export const PART_PLATE = 2;
export const PART_MOUTH = 3;
export const PART_SHELL = 4;
export const PART_SETA = 5;
export const PART_MEMBRANE = 6;
export const PART_EYE = 7;
export const PART_STALK = 8;
/** The inner anatomy (M6 T12): the gut line, fluid chambers, oil droplets, the heart or ganglion, and eye pigment. */
export const PART_GUT = 9;
export const PART_CHAMBER = 10;
export const PART_DROPLET = 11;
export const PART_HEART = 12;
export const PART_PIGMENT = 13;
/** A rare glint (M6 T13): a star quad over a joint or an organ, drawn last. */
export const PART_GLINT = 14;
/** A setule (look pass 5): a fine side hair of a plumose bristle, drawn fainter than the bristle. */
export const PART_SETULE = 15;
export const ORGAN_KINDS: readonly number[] = [
  PART_GUT,
  PART_CHAMBER,
  PART_DROPLET,
  PART_HEART,
  PART_PIGMENT,
];
export const partKind = (aPart: number): number => aPart % PART_KINDS;
export const partId = (aPart: number): number => Math.floor(aPart / PART_KINDS);

/**
 * How a vertex moves (`aMotion.x`, M6 T11; `gait.ts` has the motion): with the body (rigid on a
 * bilateral body, pulsing on a radial bell), or turning about its part's root as a beating part,
 * an antenna, a wing or a bell's tentacle.
 */
export const MOTION_RIGID = 0;
export const MOTION_BEAT = 1;
export const MOTION_ANTENNA = 2;
export const MOTION_WING = 3;
export const MOTION_TENTACLE = 4;
export const MOTION_BELL = 5;
/** The beat phase between the legs of neighbouring segments (radians): a metachronal wave from the rear forward. */
export const METACHRONAL = 0.9;
/** A part turns as if it reached at most this far from its root: longer parts turn less, so none sweeps further. */
export const PART_REACH = 0.7;

/** One part's (or the body's) `aFrame` and `aMotion`: the spine normal, the root, the motion class, phase offset, side × gain and rowing share. */
export interface Motion {
  spineX: number;
  spineY: number;
  rootX: number;
  rootY: number;
  motion: number;
  offset: number;
  gain: number;
  row: number;
}

export const NO_MOTION: Motion = {
  spineX: 0,
  spineY: 1,
  rootX: 0,
  rootY: 0,
  motion: MOTION_RIGID,
  offset: 0,
  gain: 0,
  row: 0,
};

/** The wall coordinate off the body: half-way between two walls, so nothing draws one. */
export const NO_WALL = 0.5;

/** Vertex and index buffers, or only a vertex count when `counting`. */
export class Mesh {
  readonly position: number[] = [];
  readonly uv: number[] = [];
  readonly spine: number[] = [];
  readonly attach: number[] = [];
  readonly weight: number[] = [];
  readonly part: number[] = [];
  readonly frame: number[] = [];
  readonly motion: number[] = [];
  readonly flutter: number[] = [];
  readonly wall: number[] = [];
  /** How the next vertices move, and a bristle vertex's distance along its bristle. */
  gait: Motion = NO_MOTION;
  flutterAt = 0;
  /** The next vertices' segment-wall coordinate: the body's loft sets it, everything else has none. */
  wallCoord = NO_WALL;
  /** Triangles of closed surfaces, then those of flat sheets drawn from both sides. */
  readonly index: number[] = [];
  readonly sheets: number[] = [];
  /** Glint quads, drawn after everything else. */
  readonly glints: number[] = [];
  /** Vertices whose normal is set, not computed: [vertex, x, y, z]. */
  readonly fixed: number[] = [];
  count = 0;

  constructor(readonly counting: boolean) {}

  vertex(
    x: number,
    y: number,
    z: number,
    u: number,
    v: number,
    spine: number,
    attach: number,
    weight: number,
    part: number,
  ): number {
    if (!this.counting) {
      this.position.push(x, y, z);
      this.uv.push(u, v);
      this.spine.push(spine);
      this.attach.push(attach);
      this.weight.push(weight);
      this.part.push(part);
      const g = this.gait;
      this.frame.push(g.spineX, g.spineY, g.rootX, g.rootY);
      this.motion.push(g.motion, g.offset, g.gain, g.row);
      this.flutter.push(this.flutterAt);
      this.wall.push(this.wallCoord);
    }
    return this.count++;
  }

  tri(a: number, b: number, c: number): void {
    if (!this.counting) this.index.push(a, b, c);
  }

  sheet(a: number, b: number, c: number): void {
    if (!this.counting) this.sheets.push(a, b, c);
  }

  glint(a: number, b: number, c: number): void {
    if (!this.counting) this.glints.push(a, b, c);
  }

  normal(v: number, x: number, y: number, z: number): void {
    if (!this.counting) this.fixed.push(v, x, y, z);
  }

  /** Quads between `rings` rings of `ring` vertices from `first`, each ring one step forward. */
  stitch(first: number, rings: number, ring: number): void {
    for (let r = 0; r + 1 < rings; r++) {
      for (let j = 0; j < ring; j++) {
        const a = first + r * ring + j;
        const b = first + r * ring + ((j + 1) % ring);
        this.tri(a, b, a + ring);
        this.tri(b, b + ring, a + ring);
      }
    }
  }
}
