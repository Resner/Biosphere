// The look-pass gallery page (M6 T5, ADR 0024): `lab.html?gallery=1` draws the specimens of
// `tests/fixtures/gallery/` on one fixed sheet: 1600×1000 CSS pixels at a pixel ratio of 1, the high
// preset through the Lab's post chain, a fixed camera, the dark-water backdrop and a fixed animation
// time. The page draws once and holds still, so `npm run gallery` captures the same bytes every time.

import * as THREE from 'three';
import { topDownCamera } from '../render/camera';
import { CreatureCache } from '../render/creature-cache';
import { CreatureView, type CreatureViewState } from '../render/creature-view';
import { PostChain } from '../render/post/chain';
import {
  GALLERY_SIZE,
  type GalleryGrid,
  galleryCell,
  galleryGrid,
  gallerySpecimens,
  LABEL_HEIGHT,
} from './gallery';
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
}

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
    };
    return { view, state, entry };
  });

  // A fixed gait time, reached in fixed steps from rest: the same pose on every capture.
  const steps = Math.round(GALLERY_TIME / ADVANCE_STEP);
  for (let k = 0; k <= steps; k++) {
    for (const { view, state } of shown) view.update(state, k * ADVANCE_STEP);
  }
  post.render(scene, camera);
  const info = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };

  const hook: GalleryHook = {
    ready: false,
    state: () => ({
      width,
      height,
      cols: grid.cols,
      rows: grid.rows,
      radius: grid.radius,
      specimens: shown.map((s) => ({ ...s.entry })),
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
