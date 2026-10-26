// The Creature Lab page (M3 T13): a grid of 24 creatures drawn with the game's own creature view,
// an inspector that explains the selected one in plain words, and `window.__lab` for tests.
// It makes no network calls and has no post-processing: one small renderer on a dark backdrop.

import * as THREE from 'three';
import { pick } from '../game/dom';
import { genomeFromBase64url } from '../genome/codec';
import { CreatureCache } from '../render/creature-cache';
import { CreatureView, type CreatureViewState } from '../render/creature-view';
import { cellAt, cellRect, coreRadius, HOVER_SCALE } from './grid';
import type { LabCreature, LabHook, LabRenderInfo, LabView } from './hook';
import { LAB_COUNT, type LabMode, labGenomes, type Specimen, specimenOf } from './specimens';

const WATER = 0x04090b;
/** How hard the creatures swim on the grid (0..1). */
const SWIM = 0.6;
/** The longest gait step the clock takes at once (the view caps a step at 0.1 s anyway). */
const ADVANCE_STEP = 0.05;

export interface LabOptions {
  seed: string;
  mode: LabMode;
}

/** A fresh set for every visit; tests pass `?seed=` to pin it. */
export const randomSeed = (): string => {
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  return `lab-${bytes[0]?.toString(36)}${bytes[1]?.toString(36)}`;
};

export function startLab(options: LabOptions): LabHook {
  const canvas = pick<HTMLCanvasElement>('#lab-canvas');
  const stage = pick('[data-testid="lab-stage"]');
  const hoverRing = pick('[data-ring="hover"]');
  const selectRing = pick('[data-ring="select"]');
  const name = pick('[data-testid="inspect-name"]');
  const lines = pick('[data-testid="inspect-lines"]');
  const facts = pick('[data-testid="inspect-facts"]');
  const errorLine = pick('[data-testid="lab-error"]');
  const seedLabel = pick('[data-testid="lab-seed"]');
  const modeButtons = {
    genesis: pick('[data-testid="mode-genesis"]'),
    wild: pick('[data-testid="mode-wild"]'),
  } as const;

  let seed = options.seed;
  let mode: LabView = options.mode;
  let specimens: Specimen[] = [];
  let hovered: number | null = null;
  let selected: number | null = null;
  let width = 1;
  let height = 1;
  let clock = 0;
  let paused = false;
  let last: number | null = null;

  const hook: LabHook = {
    ready: false,
    state: () => ({
      seed,
      mode,
      creatures: specimens.map(summary),
      hovered,
      selected,
      offspring: [],
    }),
    select,
    setMode: (next) => show(next, seed),
    renderInfo: () => ({ calls: 0, triangles: 0, programs: 0, geometries: 0 }),
    showGenomes,
    pause: () => {
      paused = true;
    },
    advance: (seconds) => {
      paused = true;
      for (let left = seconds; left > 1e-9; left -= ADVANCE_STEP) {
        clock += Math.min(ADVANCE_STEP, left);
        draw();
      }
      draw();
    },
  };
  window.__lab = hook;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (error) {
    errorLine.hidden = false;
    errorLine.textContent = 'This browser cannot draw the Lab (WebGL2 is needed).';
    console.error(error);
    hook.ready = true;
    return hook;
  }
  renderer.setClearColor(WATER);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  camera.position.z = 5;
  const cache = new CreatureCache();
  const views = Array.from({ length: LAB_COUNT }, () => {
    const view = new CreatureView(cache);
    scene.add(view.mesh);
    return view;
  });
  const frame: CreatureViewState = {
    creature: undefined as unknown as CreatureViewState['creature'],
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: SWIM,
    hurt: 0,
    dissolve: 0,
    pxPerWu: 1,
  };

  hook.renderInfo = (): LabRenderInfo => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? 0,
    geometries: renderer.info.memory.geometries,
  });

  function summary(s: Specimen, index: number): LabCreature {
    return {
      index,
      hash: s.creature.hash,
      species: s.species,
      tier: s.tier,
      rarity: s.rarity,
      vertices: s.vertices,
      valid: s.violations.length === 0,
    };
  }

  function show(next: LabMode, nextSeed: string): void {
    seed = nextSeed;
    mode = next;
    install(labGenomes(seed, next).map(specimenOf));
    seedLabel.textContent = `set ${seed}`;
    for (const [m, button] of Object.entries(modeButtons)) {
      button.setAttribute('aria-pressed', String(m === next));
    }
    const url = new URL(window.location.href);
    url.searchParams.set('seed', seed);
    if (next === 'wild') url.searchParams.set('mode', 'wild');
    else url.searchParams.delete('mode');
    window.history.replaceState(null, '', url);
  }

  function showGenomes(texts: readonly string[]): boolean {
    const genomes = texts.slice(0, LAB_COUNT).map(genomeFromBase64url);
    if (texts.length > LAB_COUNT || genomes.some((g) => g === null)) return false;
    mode = 'custom';
    for (const button of Object.values(modeButtons)) button.setAttribute('aria-pressed', 'false');
    install(genomes.map((g) => specimenOf(g as NonNullable<typeof g>)));
    return true;
  }

  function install(next: Specimen[]): void {
    specimens = next;
    for (const [i, s] of specimens.entries()) {
      if (s.violations.length > 0) {
        console.error(`creature ${i} breaks body rules: ${s.violations.join('; ')}`);
      }
    }
    hovered = null;
    select(null);
    draw();
  }

  function select(index: number | null): void {
    selected = index !== null && specimens[index] ? index : null;
    const s = selected === null ? undefined : specimens[selected];
    if (!s) {
      name.textContent = 'Click a creature to inspect it.';
      facts.hidden = true;
      lines.replaceChildren();
    } else {
      name.textContent = s.species;
      lines.replaceChildren(
        ...s.lines.map((text) => {
          const li = document.createElement('li');
          li.textContent = text;
          return li;
        }),
      );
      facts.hidden = false;
      const rows: [string, string][] = [
        ['Rarity', `${s.rarity[0]?.toUpperCase()}${s.rarity.slice(1)}`],
        ['Size tier', String(s.tier)],
        ['Mesh vertices', String(s.vertices)],
        ['Genome', s.creature.hash.slice(0, 12)],
      ];
      facts.replaceChildren(
        ...rows.flatMap(([term, value]) => {
          const dt = document.createElement('dt');
          dt.textContent = term;
          const dd = document.createElement('dd');
          dd.textContent = value;
          if (term === 'Genome') dd.title = s.creature.hash;
          return [dt, dd];
        }),
      );
    }
    placeRing(selectRing, selected);
  }

  function placeRing(ring: HTMLElement, index: number | null): void {
    ring.hidden = index === null;
    if (index === null) return;
    const r = cellRect(index, width, height);
    ring.style.left = `${r.x + 2}px`;
    ring.style.top = `${r.y + 2}px`;
    ring.style.width = `${r.w - 4}px`;
    ring.style.height = `${r.h - 4}px`;
  }

  function draw(): void {
    const radius = coreRadius(width / 6, height / 4);
    for (const [i, view] of views.entries()) {
      const s = specimens[i];
      if (!s) {
        view.update(null, clock);
        continue;
      }
      const r = cellRect(i, width, height);
      frame.creature = s.creature;
      frame.x = r.x + r.w / 2 - width / 2;
      frame.y = height / 2 - (r.y + r.h / 2);
      frame.radius = i === hovered ? radius * HOVER_SCALE : radius;
      view.update(frame, clock);
    }
    renderer.render(scene, camera);
  }

  function resize(): void {
    width = Math.max(1, stage.clientWidth);
    height = Math.max(1, stage.clientHeight);
    renderer.setSize(width, height, false);
    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;
    camera.updateProjectionMatrix();
    placeRing(selectRing, selected);
    placeRing(hoverRing, hovered);
    draw();
  }

  function cellOf(event: PointerEvent): number | null {
    const box = canvas.getBoundingClientRect();
    const i = cellAt(event.clientX - box.left, event.clientY - box.top, box.width, box.height);
    return i >= 0 && specimens[i] ? i : null;
  }

  canvas.addEventListener('pointermove', (event) => {
    hovered = cellOf(event);
    placeRing(hoverRing, hovered);
  });
  canvas.addEventListener('pointerleave', () => {
    hovered = null;
    placeRing(hoverRing, null);
  });
  canvas.addEventListener('click', (event) => {
    const i = cellOf(event);
    if (i !== null) select(i);
  });
  modeButtons.genesis.addEventListener('click', () => show('genesis', seed));
  modeButtons.wild.addEventListener('click', () => show('wild', seed));
  pick('[data-testid="lab-shuffle"]').addEventListener('click', () => {
    show(mode === 'wild' ? 'wild' : 'genesis', randomSeed());
  });
  new ResizeObserver(resize).observe(stage);

  function loop(now: number): void {
    if (!paused) {
      clock += last === null ? 0 : Math.min((now - last) / 1000, 0.1);
      draw();
    }
    last = now;
    requestAnimationFrame(loop);
  }

  resize();
  show(options.mode, options.seed);
  requestAnimationFrame(loop);
  hook.ready = true;
  return hook;
}
