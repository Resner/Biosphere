import * as THREE from 'three';
import { cellMaterial, flagellumMaterial, setUniform } from './materials';

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
}

/** A translucent cell with a waving flagellum; the quad and the whip are drawn in two meshes. */
export class Cell {
  readonly body: THREE.Mesh;
  readonly flagellum: THREE.Mesh;
  private readonly bodyMaterial = cellMaterial(EXTENT);
  private readonly flagellumMat = flagellumMaterial();
  private readonly bodyGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly flagellumGeometry = new THREE.PlaneGeometry(1, 2, 40, 1);

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
    if (!view) return;

    this.body.position.set(view.x, view.y, 0);
    this.body.rotation.z = view.heading;
    this.body.scale.setScalar(view.radius * EXTENT);
    setUniform(this.bodyMaterial, 'uTime', time);

    // The whip's vertices are built in the cell's frame, so it follows the heading as a whole.
    this.flagellum.position.set(view.x, view.y, 0);
    this.flagellum.rotation.z = view.heading;
    setUniform(this.flagellumMat, 'uTime', time);
    setUniform(this.flagellumMat, 'uRadius', view.radius);
    setUniform(this.flagellumMat, 'uBeat', view.beat);
  }

  dispose(): void {
    this.bodyGeometry.dispose();
    this.flagellumGeometry.dispose();
    this.bodyMaterial.dispose();
    this.flagellumMat.dispose();
  }
}
