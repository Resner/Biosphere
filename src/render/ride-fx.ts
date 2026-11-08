import * as THREE from 'three';
import { ORIGIN } from './origin';

// Riding the current (M12 T7): streaks of marine snow rushing past along the ride's way, and the
// picture easing toward the water's colour, so a ride reads as a journey through the water rather
// than a cut. Two draw calls while a ride plays, none otherwise.

/** Streaks drawn across the view at full strength. */
export const RIDE_STREAKS = 72;
/** The water the picture eases toward: the open water's teal, a little lighter than the deep. */
const WASH_COLOR = 0x123a3a;
/** The wash covers the picture this much at most: the creature still shows through it. */
export const WASH_MAX = 0.72;
/** The streaks' head colour: the marine snow's (`scene.ts`, the mid layer). */
const SNOW = new THREE.Color(0xd8efe8);

/** A ride's look this frame: how strong the sweep and the wash are (0 to 1), and the way it goes. */
export interface RideLook {
  sweep: number;
  wash: number;
  dirX: number;
  dirY: number;
}

/** The view the effect is drawn over: the camera and the visible half-extents, in wu. */
export interface RideFrame {
  camX: number;
  camY: number;
  halfWidth: number;
  halfHeight: number;
  /** Seconds, for the streaks' motion only. */
  time: number;
}

const fract = (v: number): number => v - Math.floor(v);

export class RideFx {
  readonly streaks: THREE.LineSegments;
  readonly wash: THREE.Mesh;
  private readonly positions = new Float32Array(RIDE_STREAKS * 2 * 3);
  private readonly colors = new Float32Array(RIDE_STREAKS * 2 * 3);
  /** Each streak's seeded place across the view (0 to 1, twice) and speed factor. */
  private readonly seeds = new Float32Array(RIDE_STREAKS * 3);
  private readonly lineGeometry = new THREE.BufferGeometry();
  private readonly lineMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  private readonly washGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly washMaterial = new THREE.MeshBasicMaterial({
    color: WASH_COLOR,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });

  constructor() {
    let state = 0x2545f491;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = next();
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.lineGeometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.streaks = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.wash = new THREE.Mesh(this.washGeometry, this.washMaterial);
    this.streaks.visible = false;
    this.wash.visible = false;
  }

  /** Draws the ride's look over `frame`, or hides it (`look` null or spent). Allocates nothing. */
  update(frame: RideFrame, look: RideLook | null): void {
    const sweep = look ? look.sweep : 0;
    const wash = look ? look.wash : 0;
    this.wash.visible = wash > 0.001;
    this.streaks.visible = sweep > 0.001;
    if (this.wash.visible) {
      this.wash.position.set(frame.camX - ORIGIN.x, frame.camY - ORIGIN.y, 0);
      this.wash.scale.set(frame.halfWidth, frame.halfHeight, 1);
      this.washMaterial.opacity = WASH_MAX * Math.min(1, wash);
    }
    if (!this.streaks.visible || !look) return;
    const { halfWidth: hw, halfHeight: hh } = frame;
    const len = Math.hypot(look.dirX, look.dirY) || 1;
    // The snow rushes past against the ride's way, as the water would past a carried creature.
    const ux = -look.dirX / len;
    const uy = -look.dirY / len;
    const streak = hh * (0.12 + 0.3 * sweep);
    const cx = frame.camX - ORIGIN.x;
    const cy = frame.camY - ORIGIN.y;
    const p = this.positions;
    const c = this.colors;
    for (let i = 0; i < RIDE_STREAKS; i++) {
      const sx = this.seeds[i * 3] as number;
      const sy = this.seeds[i * 3 + 1] as number;
      const speed = 0.6 + (this.seeds[i * 3 + 2] as number);
      // Spread across the view, each carried along the way and wrapped round it.
      const along = fract(sx + frame.time * speed * 1.4);
      const across = sy * 2 - 1;
      const ax = (along * 2 - 1) * hw * 1.2;
      const ay = across * hh * 1.1;
      // Rotate the (along, across) frame onto the way.
      const hx = cx + ax * ux - ay * uy;
      const hy = cy + ax * uy + ay * ux;
      const o = i * 6;
      p[o] = hx;
      p[o + 1] = hy;
      p[o + 2] = 0;
      p[o + 3] = hx - ux * streak * speed;
      p[o + 4] = hy - uy * streak * speed;
      p[o + 5] = 0;
      // The head bright, the tail gone: additive, so black fades it.
      const k = 0.55 * sweep * (0.5 + 0.5 * (this.seeds[i * 3 + 2] as number));
      c[o] = SNOW.r * k;
      c[o + 1] = SNOW.g * k;
      c[o + 2] = SNOW.b * k;
      c[o + 3] = 0;
      c[o + 4] = 0;
      c[o + 5] = 0;
    }
    (this.lineGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Whether anything of the ride is drawn this frame. */
  get shown(): boolean {
    return this.streaks.visible || this.wash.visible;
  }

  dispose(): void {
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.washGeometry.dispose();
    this.washMaterial.dispose();
  }
}
