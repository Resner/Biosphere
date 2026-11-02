// The look-pass gallery page (M6 T5, ADR 0024): `lab.html?gallery=1` draws the specimens of
// `tests/fixtures/gallery/` on one fixed sheet: 1600×1000 CSS pixels at a pixel ratio of 1, the high
// preset through the Lab's post chain, a fixed camera, the dark-water backdrop and a fixed animation
// time. The page draws once and holds still, so `npm run gallery` captures the same bytes every time.

import * as THREE from 'three';
import { topDownCamera } from '../render/camera';
import { CreatureCache } from '../render/creature-cache';
import {
  ORGAN_TAG,
  PART_BODY,
  PART_CHAMBER,
  PART_DROPLET,
  PART_EYE,
  PART_GUT,
  PART_HEART,
  PART_MOUTH,
  PART_PIGMENT,
  PART_PLATE,
  partId,
  partKind,
} from '../render/creature-mesh';
import { CreatureView, type CreatureViewState } from '../render/creature-view';
import { type GaitUniforms, type GaitVertex, gaitPosition } from '../render/gait';
import { setUniform } from '../render/materials';
import { PostChain } from '../render/post/chain';
import {
  GALLERY_SIZE,
  type GalleryGrid,
  galleryCell,
  galleryGrid,
  gallerySpecimens,
  LABEL_HEIGHT,
} from './gallery';
import { type CellMasks, cellMasks, renderClasses } from './gallery-masks';
import { ADVANCE_STEP, SWIM, WATER } from './lab';
import { specimenOf } from './specimens';

/** The gait time the sheet shows; the clock steps there like the Lab's `debug.advance`. */
const GALLERY_TIME = 0.6;

const FILES = import.meta.glob<string>('../../tests/fixtures/gallery/*.hex', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export interface GalleryEntry {
  file: string;
  comment: string;
  hash: string;
  species: string;
  rarity: string;
  vertices: number;
  /** False when the body breaks a development rule (never expected). */
  valid: boolean;
  /**
   * The organs as drawn (M6b T3): CSS-pixel discs of each organ ball and of each ring of the gut
   * line, so screenshot measures can mask by them.
   */
  organs: Disc[];
  /** The eyes as drawn (M6c T7): CSS-pixel discs; their irises carry the main organ colour. */
  eyes: Disc[];
  /** The body's hull as drawn, parts excluded: a CSS-pixel polygon down the left edge and back up the right. */
  outline: { x: number; y: number }[];
  /**
   * The cell's region masks as drawn (M6c T6, T7, `gallery-masks.ts`): the body's glass face, its
   * rim, its limbs, its mouth, its organs (all, the main tone's, the glowing ones) and its irises, as
   * bitsets over the cell's room.
   */
  masks: CellMasks;
}

export interface Disc {
  x: number;
  y: number;
  r: number;
}

/** The body's loft and its organ balls, by part kind (`creature-mesh.ts`). */
const HULL_KINDS = new Set([PART_BODY, PART_PLATE, PART_MOUTH]);
const ORGAN_BALLS = new Set([PART_CHAMBER, PART_DROPLET, PART_HEART, PART_PIGMENT]);

/**
 * Where a creature mesh draws its body outline and organs, in CSS pixels: every vertex posed by the
 * gait as the shader poses it (`gaitPosition`), for a body at CSS centre `(cx, cy)`, heading 0 and
 * `radius` pixels per core radius on a y-up camera. The outline joins each loft ring's left edge
 * (`uv.x` 0) front to rear, then its right edge (`uv.x` nearest 0.5) rear to front.
 */
export function drawnGeometry(
  geometry: THREE.BufferGeometry,
  gait: GaitUniforms,
  cx: number,
  cy: number,
  radius: number,
): Pick<GalleryEntry, 'organs' | 'eyes' | 'outline'> {
  const attr = (name: string) => geometry.getAttribute(name) as THREE.BufferAttribute;
  const [position, normal, uv, part] = [
    attr('position'),
    attr('normal'),
    attr('uv'),
    attr('aPart'),
  ];
  const [attach, weight, frame, motion, flutter] = [
    attr('aAttach'),
    attr('aWeight'),
    attr('aFrame'),
    attr('aMotion'),
    attr('aFlutter'),
  ];
  const out = { x: 0, y: 0 };
  const at = (i: number): { x: number; y: number } => {
    const v: GaitVertex = {
      x: position.getX(i),
      y: position.getY(i),
      z: position.getZ(i),
      normalX: normal.getX(i),
      normalY: normal.getY(i),
      attach: attach.getX(i),
      weight: weight.getX(i),
      spineX: frame.getX(i),
      spineY: frame.getY(i),
      rootX: frame.getZ(i),
      rootY: frame.getW(i),
      motion: motion.getX(i),
      offset: motion.getY(i),
      gain: motion.getZ(i),
      row: motion.getW(i),
      flutter: flutter.getX(i),
    };
    gaitPosition(out, v, gait);
    return { x: cx + out.x * radius, y: cy - out.y * radius };
  };
  type Box = { x0: number; x1: number; y0: number; y1: number };
  const boxes = new Map<number, Box>();
  const eyeBoxes = new Map<number, Box>();
  const grow = (map: Map<number, Box>, tag: number, q: { x: number; y: number }): void => {
    const b = map.get(tag) ?? { x0: q.x, x1: q.x, y0: q.y, y1: q.y };
    map.set(tag, {
      x0: Math.min(b.x0, q.x),
      x1: Math.max(b.x1, q.x),
      y0: Math.min(b.y0, q.y),
      y1: Math.max(b.y1, q.y),
    });
  };
  const rings: { s: number; left: number; right: number; off: number }[] = [];
  for (let i = 0; i < position.count; i++) {
    const p = part.getX(i);
    const kind = partKind(p);
    if (partId(p) === 0 && HULL_KINDS.has(kind)) {
      const u = uv.getX(i);
      if (u === 0) rings.push({ s: uv.getY(i), left: i, right: i, off: 0.5 });
      const ring = rings[rings.length - 1];
      if (ring && Math.abs(u - 0.5) < ring.off) [ring.right, ring.off] = [i, Math.abs(u - 0.5)];
    } else if (ORGAN_BALLS.has(kind) || kind === PART_GUT) {
      // Organ balls are numbered from 1; gut rings take negative keys by their place on the line.
      const tag =
        kind === PART_GUT ? -1 - Math.round(uv.getY(i) * 1e4) : Math.floor(uv.getX(i) / ORGAN_TAG);
      grow(boxes, tag, at(i));
    } else if (kind === PART_EYE) {
      // The pair lies on either side of the body's midline.
      grow(eyeBoxes, Math.sign(position.getY(i)), at(i));
    }
  }
  rings.sort((a, b) => a.s - b.s);
  const outline = [...rings.map((r) => at(r.left)), ...rings.map((r) => at(r.right)).reverse()];
  const disc = (b: Box): Disc => ({
    x: (b.x0 + b.x1) / 2,
    y: (b.y0 + b.y1) / 2,
    r: Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2,
  });
  return { organs: [...boxes.values()].map(disc), eyes: [...eyeBoxes.values()].map(disc), outline };
}

const gaitOfView = (view: CreatureView): GaitUniforms => {
  const u = (view.mesh.material as THREE.ShaderMaterial).uniforms;
  const value = (name: string): number => (u[name]?.value as number | undefined) ?? 0;
  return {
    amp: value('uAmp'),
    phase: value('uPhase'),
    beat: value('uBeat'),
    bend: value('uBend'),
    turn: value('uTurn'),
  };
};

export interface GalleryState {
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** The core radius every specimen is drawn at, in CSS pixels. */
  radius: number;
  specimens: GalleryEntry[];
}

/** `window.__gallery`: read-only; `ready` turns true once the sheet is drawn and will not change. */
export interface GalleryHook {
  ready: boolean;
  state(): GalleryState;
  renderInfo(): { calls: number; triangles: number };
}

declare global {
  interface Window {
    __gallery?: GalleryHook;
  }
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

function fail(sheet: HTMLElement, message: string, error: unknown): void {
  const line = document.createElement('p');
  line.className = 'gallery-error';
  line.setAttribute('role', 'alert');
  line.textContent = message;
  sheet.append(line);
  console.error(error);
}

export async function startGallery(): Promise<void> {
  // The sheet replaces the Lab's page: no bar, inspector or build label.
  document.querySelector('.lab')?.remove();
  document.querySelector('[data-testid="build-label"]')?.remove();
  document.title = 'Gallery · Creature Lab · Biosphere';
  const { width, height } = GALLERY_SIZE;
  const sheet = document.createElement('main');
  sheet.className = 'gallery';
  sheet.dataset.testid = 'gallery';
  sheet.style.width = `${width}px`;
  sheet.style.height = `${height}px`;
  const canvas = document.createElement('canvas');
  canvas.dataset.testid = 'gallery-canvas';
  canvas.setAttribute('aria-label', 'Creature gallery');
  sheet.append(canvas);
  document.body.append(sheet);

  let specimens: ReturnType<typeof gallerySpecimens>;
  let renderer: THREE.WebGLRenderer;
  try {
    specimens = gallerySpecimens(FILES);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  } catch (error) {
    // `window.__gallery` stays unset, so a capture times out instead of saving a broken sheet.
    fail(sheet, 'The gallery cannot be drawn here.', error);
    return;
  }
  renderer.setClearColor(WATER);
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const post = new PostChain(renderer, { samples: 4, lens: false, still: true });
  post.setPreset('high');
  post.resize(width, height, 1);

  const camera = topDownCamera();
  camera.left = -width / 2;
  camera.right = width / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.updateProjectionMatrix();

  const grid: GalleryGrid = galleryGrid(specimens.length, width, height);
  const scene = new THREE.Scene();
  const cache = new CreatureCache();
  const shown = specimens.map((s, i) => {
    const specimen = specimenOf(s.genome);
    const cell = galleryCell(i, grid);
    const view = new CreatureView(cache);
    scene.add(view.mesh);
    const state: CreatureViewState = {
      creature: specimen.creature,
      x: cell.x + cell.w / 2 - width / 2,
      // The body sits in the room above the caption band.
      y: height / 2 - (cell.y + (cell.h - LABEL_HEIGHT) / 2),
      heading: 0,
      radius: grid.radius,
      beat: SWIM,
      hurt: 0,
      dissolve: 0,
    };
    const label = document.createElement('p');
    label.className = 'gallery-label';
    label.style.left = `${cell.x}px`;
    label.style.top = `${cell.y + cell.h - LABEL_HEIGHT}px`;
    label.style.width = `${cell.w}px`;
    label.textContent = `${s.file.slice(0, 2)} ${specimen.species} · ${specimen.rarity}`;
    label.title = s.comment;
    sheet.append(label);
    const entry: GalleryEntry = {
      file: s.file,
      comment: s.comment,
      hash: specimen.creature.hash,
      species: specimen.species,
      rarity: specimen.rarity,
      vertices: specimen.vertices,
      valid: specimen.violations.length === 0,
      organs: [],
      eyes: [],
      outline: [],
      masks: {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        face: '',
        rim: '',
        limbs: '',
        mouth: '',
        organs: '',
        main: '',
        glow: '',
        iris: '',
      },
    };
    return { view, state, entry };
  });

  // A fixed gait time, reached in fixed steps from rest: the same pose on every capture.
  const steps = Math.round(GALLERY_TIME / ADVANCE_STEP);
  for (let k = 0; k <= steps; k++) {
    for (const { view, state } of shown) view.update(state, k * ADVANCE_STEP);
  }
  // `&glow=0` draws the sheet without the organs' faint glow (M6c T7), so a look check can find
  // every pixel the glow lights by comparing the two sheets.
  if (new URLSearchParams(location.search).get('glow') === '0') {
    for (const { view } of shown)
      setUniform(view.mesh.material as THREE.ShaderMaterial, 'uOrganGlow', 0);
  }
  for (const { view, state, entry } of shown) {
    const drawn = drawnGeometry(
      view.mesh.geometry,
      gaitOfView(view),
      state.x + width / 2,
      height / 2 - state.y,
      state.radius,
    );
    Object.assign(entry, drawn);
  }
  post.render(scene, camera);
  const info = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  const classes = renderClasses(
    renderer,
    scene,
    camera,
    shown.map((s) => s.view.mesh),
    width,
    height,
  );
  shown.forEach(({ entry }, i) => {
    const cell = galleryCell(i, grid);
    entry.masks = cellMasks(classes, width, { ...cell, h: cell.h - LABEL_HEIGHT });
  });

  const hook: GalleryHook = {
    ready: false,
    state: () => ({
      width,
      height,
      cols: grid.cols,
      rows: grid.rows,
      radius: grid.radius,
      specimens: shown.map((s) => ({
        ...s.entry,
        organs: s.entry.organs.map((o) => ({ ...o })),
        eyes: s.entry.eyes.map((o) => ({ ...o })),
        outline: s.entry.outline.map((p) => ({ ...p })),
        masks: { ...s.entry.masks },
      })),
    }),
    renderInfo: () => ({ ...info }),
  };
  window.__gallery = hook;
  // The captions need their font, and the drawn frame must reach the screen before a capture.
  await document.fonts.ready;
  await nextFrame();
  await nextFrame();
  hook.ready = true;
}
