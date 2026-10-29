import * as THREE from 'three';
import { advanceBeatPhase } from './beat';
import { cellMaterial, colorUniform, flagellumMaterial, setUniform } from './materials';

/** The halo reaches this many radii out from the centre. */
const EXTENT = 1.45;

export interface CellView {
  x: number;
  y: number;
  /** Radians, 0 pointing east and growing counter-clockwise. */
  heading: number;
  /** In world units. */
  radius: number;
  /** 0..1, how hard the flagellum beats. */
  beat: number;
  /** 0..1, how red the body is from a recent hit. */
  hurt: number;
  /** 0..1, how far the dying body has dissolved. */
  dissolve: number;
  /** 0..1, opacity; a missing value means opaque. */
  alpha?: number;
  /** The drawn size against `radius` (M6 T20: a hatchling's pop, the shrink of a mating's cost); a missing value is 1. Only the player's view sets it. */
  scale?: number;
  /** 0..1, tints the cell for another player; a missing value keeps the player's own teal; a cell is tinted or not for its whole life. */
  hue?: number;
}

/** A translucent cell with a waving flagellum; the quad and the whip are drawn in two meshes. */
export class Cell {
  readonly body: THREE.Mesh;
  readonly flagellum: THREE.Mesh;
  private readonly bodyMaterial = cellMaterial(EXTENT);
  private readonly flagellumMat = flagellumMaterial();
  private readonly bodyGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly flagellumGeometry = new THREE.PlaneGeometry(1, 2, 40, 1);
  private tint: number | null = null;
  private phase = 0;
  private lastTime: number | null = null;

  constructor() {
    this.flagellumGeometry.translate(-0.5, 0, 0);
    this.body = new THREE.Mesh(this.bodyGeometry, this.bodyMaterial);
    this.flagellum = new THREE.Mesh(this.flagellumGeometry, this.flagellumMat);
    this.body.visible = false;
    this.flagellum.visible = false;
  }

  update(view: CellView | null, time: number): void {
    const visible = view !== null;
    this.body.visible = visible;
    this.flagellum.visible = visible;
    if (!view) {
      this.lastTime = null;
      return;
    }

    if (view.hue !== undefined) this.setTint(view.hue);
    const alpha = view.alpha ?? 1;
    setUniform(this.bodyMaterial, 'uAlpha', alpha);
    setUniform(this.flagellumMat, 'uAlpha', alpha);

    this.body.position.set(view.x, view.y, 0);
    this.body.rotation.z = view.heading;
    this.body.scale.setScalar(view.radius * EXTENT);
    setUniform(this.bodyMaterial, 'uTime', time);
    setUniform(this.bodyMaterial, 'uHurt', view.hurt);
    setUniform(this.bodyMaterial, 'uDissolve', view.dissolve);

    // The whip's vertices are built in the cell's frame, so it follows the heading as a whole.
    this.flagellum.position.set(view.x, view.y, 0);
    this.flagellum.rotation.z = view.heading;
    this.phase = advanceBeatPhase(this.phase, view.beat, time - (this.lastTime ?? time));
    this.lastTime = time;
    setUniform(this.flagellumMat, 'uPhase', this.phase);
    setUniform(this.flagellumMat, 'uRadius', view.radius);
    setUniform(this.flagellumMat, 'uBeat', view.beat);
    setUniform(this.flagellumMat, 'uDissolve', view.dissolve);
  }

  /** Recolours another player's cell around a hue; writes only when the hue changes. */
  private setTint(hue: number): void {
    if (hue === this.tint) return;
    this.tint = hue;
    colorUniform(this.bodyMaterial, 'uCore').setHSL(hue, 0.6, 0.1);
    colorUniform(this.bodyMaterial, 'uRim').setHSL(hue, 0.85, 0.72);
    colorUniform(this.bodyMaterial, 'uNucleus').setHSL((hue + 0.15) % 1, 0.75, 0.62);
    colorUniform(this.flagellumMat, 'uColor').setHSL(hue, 0.7, 0.76);
  }

  dispose(): void {
    this.bodyGeometry.dispose();
    this.flagellumGeometry.dispose();
    this.bodyMaterial.dispose();
    this.flagellumMat.dispose();
  }
}
