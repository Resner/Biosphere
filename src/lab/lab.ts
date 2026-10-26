// The Creature Lab page (M3 T13, T14): a grid of 24 creatures drawn with the game's own creature
// view, an inspector that explains the selected one in plain words, tools to mutate, breed, export
// and import genomes, and `window.__lab` for tests. It makes no network calls and has no
// post-processing: one small renderer on a dark backdrop.

import * as THREE from 'three';
import { pick } from '../game/dom';
import { genomeToBase64url, parseGenomeText } from '../genome/codec';
import { explainChild, type TraitExplanation } from '../genome/explain';
import { topDownCamera } from '../render/camera';
import { CreatureCache } from '../render/creature-cache';
import { CreatureView, type CreatureViewState } from '../render/creature-view';
import { breedBatch, labRandomness, mutateStep } from './breed';
import { CELL_COUNT, cellAt, cellRect, GRID_COUNT, HOVER_SCALE, stageCoreRadius } from './grid';
import type { LabCreature, LabHook, LabView } from './hook';
import { type LabMode, labGenomes, type Specimen, specimenOf } from './specimens';

const WATER = 0x04090b;
/** How hard the creatures swim on the grid (0..1). */
const SWIM = 0.6;
/** The longest gait step the clock takes at once (the view caps a step at 0.1 s anyway). */
const ADVANCE_STEP = 0.05;

export interface LabOptions {
  seed: string;
  mode: LabMode;
  /** Adds `window.__lab.debug` (test helpers). */
  debug: boolean;
}

/** A fresh set for every visit; tests pass `?seed=` to pin it. */
export const randomSeed = (): string => {
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  return `lab-${bytes[0]?.toString(36)}${bytes[1]?.toString(36)}`;
};

/** A change that Undo can take back: this grid cell used to hold this creature. */
interface Edit {
  index: number;
  was: Specimen;
}

/** How many Mutate and Load steps Undo remembers. */
const MAX_EDITS = 64;

const capitalise = (text: string): string => `${text[0]?.toUpperCase()}${text.slice(1)}`;

export function startLab(options: LabOptions): void {
  const canvas = pick<HTMLCanvasElement>('#lab-canvas');
  const stage = pick('[data-testid="lab-stage"]');
  const hoverRing = pick('[data-ring="hover"]');
  const selectRing = pick('[data-ring="select"]');
  const name = pick('[data-testid="inspect-name"]');
  const lines = pick('[data-testid="inspect-lines"]');
  const facts = pick('[data-testid="inspect-facts"]');
  const errorLine = pick('[data-testid="lab-error"]');
  const inheritBox = pick('[data-testid="inspect-inherit"]');
  const inheritLines = pick('[data-testid="inspect-inherit-lines"]');
  const stripLabel = pick('[data-testid="strip-label"]');
  const hint = pick('[data-testid="tool-hint"]');
  const copyText = pick<HTMLTextAreaElement>('[data-testid="genome-copy"]');
  const loadText = pick<HTMLTextAreaElement>('[data-testid="genome-load"]');
  const tools = {
    mutate: pick<HTMLButtonElement>('[data-testid="tool-mutate"]'),
    undo: pick<HTMLButtonElement>('[data-testid="tool-undo"]'),
    breed: pick<HTMLButtonElement>('[data-testid="tool-breed"]'),
    copy: pick<HTMLButtonElement>('[data-testid="tool-copy"]'),
    load: pick<HTMLButtonElement>('[data-testid="tool-load"]'),
  } as const;
  const parentRingA = pick('[data-ring="parent"][data-label="A"]');
  const parentRingB = pick('[data-ring="parent"][data-label="B"]');
  const seedLabel = pick('[data-testid="lab-seed"]');
  const modeButtons = {
    genesis: pick('[data-testid="mode-genesis"]'),
    wild: pick('[data-testid="mode-wild"]'),
  } as const;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (error) {
    // `window.__lab` stays unset, so the page never reports ready.
    errorLine.hidden = false;
    errorLine.textContent = 'This browser cannot draw the Lab (WebGL2 is needed).';
    console.error(error);
    return;
  }
  renderer.setClearColor(WATER);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = topDownCamera();
  const cache = new CreatureCache();
  const views = Array.from({ length: CELL_COUNT }, () => {
    const view = new CreatureView(cache);
    scene.add(view.mesh);
    return view;
  });

  let seed = options.seed;
  // `show` below sets the first mode; 'custom' keeps its early return from skipping it.
  let mode: LabView = 'custom';
  let specimens: Specimen[] = [];
  /** The last Breed: its eight children and where each trait came from. */
  let offspring: Specimen[] = [];
  let inheritance: TraitExplanation[][] = [];
  let hovered: number | null = null;
  /** The cell in the inspector: 0-23 the grid, 24-31 the offspring. */
  let selected: number | null = null;
  /** The two grid cells Breed would mate: the last plain click, then the shift-click. */
  let parents: [number | null, number | null] = [null, null];
  let edits: Edit[] = [];
  let mutations = 0;
  let width = 1;
  let height = 1;
  let clock = 0;
  let paused = false;
  let last: number | null = null;
  // Where each cell's creature sits (pixels from the stage centre, y up) and its core radius;
  // set on resize so that drawing allocates nothing.
  const cellX = new Float64Array(CELL_COUNT);
  const cellY = new Float64Array(CELL_COUNT);
  let radius = 1;
  /** The scratch state handed to every view; its creature is set before each update. */
  const frame: Omit<CreatureViewState, 'creature'> & { creature: Specimen['creature'] | null } = {
    creature: null,
    x: 0,
    y: 0,
    heading: 0,
    radius: 1,
    beat: SWIM,
    hurt: 0,
    dissolve: 0,
  };

  const hook: LabHook = {
    ready: false,
    state: () => ({
      seed,
      mode,
      creatures: specimens.map(summary),
      hovered,
      selected,
      parents: [...parents],
      offspring: offspring.map(summary),
    }),
    select: (index, options) => select(index, options?.second === true),
    setMode: (next) => show(next, seed),
    renderInfo: () => ({
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      geometries: renderer.info.memory.geometries,
    }),
  };
  if (options.debug) {
    hook.debug = {
      showGenomes,
      pause: () => {
        paused = true;
      },
      advance: (seconds) => {
        paused = true;
        for (let left = seconds; left > 1e-9; left -= ADVANCE_STEP) {
          clock += Math.min(ADVANCE_STEP, left);
          updateViews();
        }
        renderer.render(scene, camera);
      },
    };
  }

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

  /** Shows these specimens as `view` and clears the hover and selection. */
  function setView(view: LabView, next: Specimen[]): void {
    mode = view;
    for (const [m, button] of Object.entries(modeButtons)) {
      button.setAttribute('aria-pressed', String(m === view));
    }
    specimens = next;
    for (const [i, s] of specimens.entries()) {
      if (s.violations.length > 0) {
        console.error(`creature ${i} breaks body rules: ${s.violations.join('; ')}`);
      }
    }
    offspring = [];
    inheritance = [];
    edits = [];
    mutations = 0;
    parents = [null, null];
    hovered = null;
    placeRing(hoverRing, null);
    showError(null);
    select(null);
    draw();
  }

  function specimenAt(index: number): Specimen | undefined {
    return index < GRID_COUNT ? specimens[index] : offspring[index - GRID_COUNT];
  }

  function showError(message: string | null): void {
    errorLine.hidden = message === null;
    errorLine.textContent = message ?? '';
  }

  function show(next: LabMode, nextSeed: string): void {
    if (next === mode && nextSeed === seed) return;
    seed = nextSeed;
    seedLabel.textContent = `set ${seed}`;
    setView(next, labGenomes(seed, next).map(specimenOf));
    const url = new URL(window.location.href);
    url.searchParams.set('seed', seed);
    if (next === 'wild') url.searchParams.set('mode', 'wild');
    else url.searchParams.delete('mode');
    window.history.replaceState(null, '', url);
  }

  function showGenomes(texts: readonly string[]): boolean {
    if (texts.length > GRID_COUNT) return false;
    const next: Specimen[] = [];
    for (const text of texts) {
      const genome = parseGenomeText(text);
      if (genome === null) return false;
      next.push(specimenOf(genome));
    }
    setView('custom', next);
    return true;
  }

  /** Chooses a cell to inspect; a grid cell also becomes a parent (the second with shift-click). */
  function select(index: number | null, second = false): void {
    const s = index === null ? undefined : specimenAt(index);
    selected = s ? (index as number) : null;
    if (selected === null) parents = [null, null];
    else if (selected < GRID_COUNT) {
      if (second && parents[0] === selected) {
        // Shift-clicking parent A again only inspects it.
      } else if (second && parents[0] !== null) parents[1] = selected;
      else parents = [selected, null];
    }
    inspect();
  }

  /** Shows the new state: the inspector, rings and tools, and a frame when the clock is stopped. */
  function refresh(): void {
    inspect();
    if (paused) draw();
  }

  /** Fills the inspector, the rings and the tools for the current selection. */
  function inspect(): void {
    placeRings();
    const s = selected === null ? undefined : specimenAt(selected);
    updateTools();
    if (!s || selected === null) {
      name.textContent = 'Click a creature to inspect it.';
      facts.hidden = true;
      inheritBox.hidden = true;
      lines.replaceChildren();
      return;
    }
    name.textContent = s.species;
    lines.replaceChildren(...s.lines.map(listItem));
    const where = selected < GRID_COUNT ? undefined : inheritance[selected - GRID_COUNT];
    inheritBox.hidden = where === undefined;
    inheritLines.replaceChildren(...(where ?? []).map((line) => listItem(line.text)));
    facts.hidden = false;
    const rows: [term: string, value: string, title?: string][] = [
      ['Rarity', capitalise(s.rarity)],
      ['Size tier', String(s.tier)],
      ['Mesh vertices', String(s.vertices)],
      ['Genome', s.creature.hash.slice(0, 12), s.creature.hash],
    ];
    facts.replaceChildren(
      ...rows.flatMap(([term, value, title]) => {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        if (title) dd.title = title;
        return [dt, dd];
      }),
    );
  }

  function listItem(text: string): HTMLElement {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }

  function updateTools(): void {
    const inGrid = selected !== null && selected < GRID_COUNT;
    const [a, b] = parents;
    tools.mutate.disabled = !inGrid;
    tools.undo.disabled = edits.length === 0;
    tools.breed.disabled = a === null || b === null;
    tools.copy.disabled = selected === null;
    tools.load.disabled = !inGrid;
    hint.textContent =
      a === null
        ? 'Click a creature, then shift-click a second one to breed them.'
        : b === null
          ? 'Shift-click a second creature to breed with it.'
          : 'Press Breed to see eight children of A and B.';
    stripLabel.textContent =
      offspring.length > 0 ? 'Children of the last Breed' : 'Children appear here after Breed.';
  }

  /** Puts a creature in a grid cell; Undo can take it back. */
  function replace(index: number, genome: Specimen['genome']): void {
    edits.push({ index, was: specimens[index] as Specimen });
    if (edits.length > MAX_EDITS) edits.shift();
    specimens[index] = specimenOf(genome);
    refresh();
  }

  function mutate(): void {
    const s = selected === null || selected >= GRID_COUNT ? undefined : specimens[selected];
    if (!s || selected === null) return;
    replace(selected, mutateStep(s.genome, seed, mutations++));
  }

  function undo(): void {
    const edit = edits.pop();
    if (!edit) return;
    specimens[edit.index] = edit.was;
    refresh();
  }

  function breedParents(): void {
    const a = parents[0] === null ? undefined : specimens[parents[0]];
    const b = parents[1] === null ? undefined : specimens[parents[1]];
    if (!a || !b) return;
    const kids = breedBatch(a.genome, b.genome, labRandomness(seed));
    offspring = kids.map(specimenOf);
    inheritance = kids.map((kid) => explainChild(kid, a.genome, b.genome));
    for (const [k, kid] of offspring.entries()) {
      if (kid.violations.length > 0) {
        console.error(`child ${k} breaks body rules: ${kid.violations.join('; ')}`);
      }
    }
    refresh();
  }

  function copyGenome(): void {
    const s = selected === null ? undefined : specimenAt(selected);
    if (!s) return;
    const text = genomeToBase64url(s.genome);
    copyText.value = text;
    showError(null);
    // The text field is the dependable part: a clipboard can be blocked by the browser.
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function loadGenome(): void {
    const genome = parseGenomeText(loadText.value);
    if (genome === null) {
      showError('That text is not a creature genome.');
    } else if (selected === null || selected >= GRID_COUNT) {
      showError('Click a creature in the grid first; the genome replaces it.');
    } else {
      showError(null);
      replace(selected, genome);
    }
  }

  function placeRings(): void {
    placeRing(selectRing, selected);
    placeRing(parentRingA, parents[0]);
    placeRing(parentRingB, parents[1]);
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

  function updateViews(): void {
    for (let i = 0; i < views.length; i++) {
      const view = views[i] as CreatureView;
      const s = specimenAt(i);
      if (!s) {
        view.update(null, clock);
        continue;
      }
      frame.creature = s.creature;
      frame.x = cellX[i] as number;
      frame.y = cellY[i] as number;
      frame.radius = i === hovered ? radius * HOVER_SCALE : radius;
      view.update(frame as CreatureViewState, clock);
    }
  }

  function draw(): void {
    updateViews();
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
    radius = stageCoreRadius(width, height);
    for (let i = 0; i < CELL_COUNT; i++) {
      const r = cellRect(i, width, height);
      cellX[i] = r.x + r.w / 2 - width / 2;
      cellY[i] = height / 2 - (r.y + r.h / 2);
    }
    placeRings();
    placeRing(hoverRing, hovered);
    const label = cellRect(GRID_COUNT, width, height);
    stripLabel.style.left = `${label.x}px`;
    stripLabel.style.top = `${label.y + 4}px`;
    // The loop redraws a running Lab; a paused one needs the frame now.
    if (paused) draw();
  }

  function cellOf(event: PointerEvent): number | null {
    const box = canvas.getBoundingClientRect();
    const i = cellAt(event.clientX - box.left, event.clientY - box.top, box.width, box.height);
    return i >= 0 && specimenAt(i) ? i : null;
  }

  function hover(index: number | null): void {
    if (index === hovered) return;
    hovered = index;
    placeRing(hoverRing, index);
    if (paused) draw();
  }

  canvas.addEventListener('pointermove', (event) => hover(cellOf(event)));
  canvas.addEventListener('pointerleave', () => hover(null));
  canvas.addEventListener('click', (event) => {
    const i = cellOf(event);
    if (i !== null && (i !== selected || event.shiftKey)) select(i, event.shiftKey);
  });
  tools.mutate.addEventListener('click', mutate);
  tools.undo.addEventListener('click', undo);
  tools.breed.addEventListener('click', breedParents);
  tools.copy.addEventListener('click', copyGenome);
  tools.load.addEventListener('click', loadGenome);
  for (const [m, button] of Object.entries(modeButtons)) {
    button.addEventListener('click', () => show(m as LabMode, seed));
  }
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

  window.__lab = hook;
  updateTools();
  resize();
  show(options.mode, options.seed);
  requestAnimationFrame(loop);
  hook.ready = true;
}
