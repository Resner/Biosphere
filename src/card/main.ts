import '../style.css';
import './card.css';
import { capitalise } from '../game/badge';
import { formatBuildLabel } from '../game/build-label';
import { capabilities, showUnsupported, unsupportedReason } from '../game/capability';
import { cspViolations, watchCsp } from '../game/csp-watch';
import { listItem, pick, setText } from '../game/dom';
import { setStars, shapeName, starsText } from '../game/reveal-card';
import { loadSettings, qualityFromSearch, reducedMotion } from '../game/settings';
import { parseGenomeText } from '../genome/codec';
import { silhouetteOf } from '../genome/silhouette';
import { buildCreature } from '../genome/stats';
import type { ProofBundle } from '../ledger/proof';
import type { LineageReport } from '../ledger/verify';
import { type PresetName, resolvePreset } from '../render/presets';
import { cardFacts, familyLines, problemLines, storyLines, verdictLine } from './card';
import {
  ART_HEIGHT,
  ART_WIDTH,
  drawCardImage,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  imageBlob,
  imageFileName,
  shareUrl,
} from './card-image';
import { CreatureStage } from './card-view';
import { GraphView } from './graph-view';
import type { CardHook, CardState } from './hook';
import { cardGraph, graphState, joinBundle, type Pedigree } from './lineage-graph';
import {
  authorityBase,
  type CardError,
  creatureParam,
  ERROR_TEXT,
  loadFight,
  loadProof,
} from './load';
import { checkInWorker, VerifierLink } from './verifier';

// The creature card page (M9 T12): `card.html?c=<creature id>` fetches the creature's proof from the
// authority, draws the creature at once, and checks the proof in a module worker: the whole bundle
// first, then each settled fight replayed from its log. It works with every player offline, and it
// names no player.

// What the page's Content-Security-Policy blocks, for `state().csp` (M14 T16).
watchCsp(document);

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

const el = {
  card: pick('[data-testid="card"]'),
  canvas: pick<HTMLCanvasElement>('[data-testid="card-canvas"]'),
  preview: pick<HTMLCanvasElement>('[data-testid="card-preview"]'),
  stage: pick('[data-testid="card-stage"]'),
  species: pick('[data-testid="card-species"]'),
  stars: pick('[data-testid="card-stars"]'),
  rarity: pick('[data-testid="card-rarity"]'),
  shape: pick('[data-testid="card-shape"]'),
  generation: pick('[data-testid="card-generation"]'),
  verdict: pick('[data-testid="card-verdict"]'),
  progress: pick('[data-testid="card-progress"]'),
  story: pick('[data-testid="card-story"]'),
  families: pick('[data-testid="card-families"]'),
  problems: pick('[data-testid="card-problems"]'),
  owner: pick('[data-testid="card-owner"]'),
  copy: pick<HTMLButtonElement>('[data-testid="card-copy"]'),
  copied: pick('[data-testid="card-copied"]'),
  save: pick<HTMLButtonElement>('[data-testid="card-save"]'),
  error: pick('[data-testid="card-error"]'),
  lineage: pick('[data-testid="card-lineage"]'),
  graph: pick('[data-testid="card-graph"]'),
};

const state: CardState = {
  phase: 'loading',
  error: null,
  subject: null,
  species: null,
  tier: null,
  generation: null,
  status: null,
  verdict: null,
  verdictText: null,
  scaled: false,
  toGenesis: false,
  problems: [],
  missing: 0,
  fights: { settled: 0, replayed: 0, pruned: 0, unreplayed: 0 },
  witnessed: null,
  story: [],
  drawn: false,
  renderer: null,
  timings: { bundle: null, drawn: null, verdict: null },
  image: { ready: false, saved: 0 },
  graph: [],
  csp: [],
};

const hook: CardHook = { state: () => ({ ...structuredClone(state), csp: cspViolations() }) };
window.__card = hook;

const search = window.location.search;
const settings = loadSettings(safeStorage());
const quality = qualityFromSearch(search) ?? settings.quality;
const preset: PresetName = resolvePreset(quality, 'high');
const still = reducedMotion(settings, matchMedia('(prefers-reduced-motion: reduce)').matches);
el.card.toggleAttribute('data-still', still);

/** The verifier's module worker, which the build bundles once. */
const spawnVerifier = (): Worker =>
  new Worker(new URL('./verify-worker.ts', import.meta.url), { type: 'module' });

/** Not `game/app-session`'s copy: that module pulls the sim into the card page. */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function setPhase(phase: CardState['phase']): void {
  state.phase = phase;
  el.card.dataset.phase = phase;
}

function fail(error: CardError): void {
  state.error = error;
  setPhase('error');
  // With no creature to show, the card is the error line alone.
  el.card.toggleAttribute('data-empty', state.subject === null);
  el.error.hidden = false;
  setText(el.error, ERROR_TEXT[error]);
  setText(el.verdict, '');
  el.verdict.hidden = true;
  el.progress.hidden = true;
  document.title = `${ERROR_TEXT[error]} · Biosphere`;
}

el.copy.addEventListener('click', () => {
  const done = (): void => {
    el.copied.hidden = false;
    setTimeout(() => {
      el.copied.hidden = true;
    }, 2000);
  };
  navigator.clipboard?.writeText(window.location.href).then(done, done);
});

let stage: CreatureStage | null = null;

/** The card as a 1200 × 630 PNG, saved: the creature's frame, its facts, the verdict and the link. */
async function saveImage(): Promise<void> {
  const { species, tier, generation, verdict, verdictText } = state;
  if (!state.image.ready || !stage || !species || !tier || generation === null) return;
  if (!verdict || !verdictText) return;
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_WIDTH;
  canvas.height = IMAGE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const tierColour = getComputedStyle(el.card).getPropertyValue('--tier').trim();
  drawCardImage(
    ctx,
    stage.snapshot(ART_WIDTH, ART_HEIGHT),
    {
      species,
      stars: starsText(tier).text,
      rarity: capitalise(tier),
      generation: `Generation ${generation}`,
      verdict,
      verdictText,
      url: shareUrl(window.location.href),
    },
    tierColour || 'rgb(200 240 255)',
  );
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await imageBlob(canvas));
  link.download = imageFileName(species);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  state.image.saved++;
}

el.save.addEventListener('click', () => {
  saveImage().catch((error: unknown) => console.error('the card image was not made', error));
});

function startStage(): CreatureStage {
  const s = new CreatureStage({
    canvas: el.canvas,
    preview: el.preview,
    preset,
    still,
    onDrawn: (how) => {
      state.drawn = true;
      state.renderer = how;
      state.timings.drawn = performance.now();
      el.stage.dataset.drawn = how;
    },
  });
  const resize = (): void => s.resize(el.stage.clientWidth, el.stage.clientHeight);
  new ResizeObserver(resize).observe(el.stage);
  resize();
  const loop = (now: number): void => {
    s.tick(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return s;
}

// The lineage graph: every creature the card knows of, from its own bundle and any ancestor's
// loaded since, each with its mark from its own bundle's check.
const pedigree: Pedigree = new Map();
let authority: string | null = null;
const graph = new GraphView({
  section: el.lineage,
  box: el.graph,
  search,
  onLoad: (id) => void loadAncestor(id),
});

function drawGraph(): void {
  if (!state.subject) return;
  const g = cardGraph(pedigree, state.subject);
  state.graph = graphState(g);
  graph.draw(g);
}

/** One bundle checked in a worker of its own, without its fights: an ancestor's, for the graph. */
async function verifyOnce(bundle: ProofBundle): Promise<LineageReport> {
  const link = new VerifierLink(spawnVerifier());
  try {
    return (await link.ask({ t: 'verify', bundle })).report;
  } finally {
    link.close();
  }
}

/** Fetches an ancestor the proof left out, checks its own bundle, and joins it to the graph. */
async function loadAncestor(id: string): Promise<void> {
  if (!authority) return;
  graph.setLoad(id, 'loading');
  const got = await loadProof(fetch, authority, id);
  if (!got.ok) return graph.setLoad(id, 'failed');
  try {
    joinBundle(pedigree, got.value, await verifyOnce(got.value));
  } catch (error) {
    console.error('the ancestor was not checked', error);
    return graph.setLoad(id, 'failed');
  }
  graph.setLoad(id, null, false);
  drawGraph();
}

/** Writes the creature's facts and story, and starts drawing it. */
function showCreature(bundle: ProofBundle): boolean {
  const facts = cardFacts(bundle);
  const genome = facts ? parseGenomeText(facts.genome) : null;
  if (!facts || !genome) return false;
  Object.assign(state, {
    subject: facts.subject,
    species: facts.species,
    tier: facts.tier,
    generation: facts.generation,
    status: facts.status,
    story: facts.story,
  });
  setText(el.species, facts.species);
  setStars(el.card, el.stars, facts.tier);
  setText(el.rarity, capitalise(facts.tier));
  setText(el.shape, shapeName(silhouetteOf(buildCreature(genome).plan)));
  setText(el.generation, `Generation ${facts.generation}`);
  el.story.replaceChildren(...facts.story.map(listItem));
  setText(el.owner, `Owner's key begins ${facts.owner}… (no name is kept on a card).`);
  el.canvas.setAttribute('aria-label', `${facts.species}, drawn as in the game`);
  document.title = `${facts.species} · Biosphere`;
  stage ??= startStage();
  stage.show(genome);
  joinBundle(pedigree, bundle, null);
  drawGraph();
  return true;
}

function showReport(bundle: ProofBundle, report: LineageReport): void {
  const verified = report.problems.length === 0;
  state.verdict = verified ? 'verified' : 'failed';
  state.verdictText = verdictLine(report);
  state.scaled = report.scaled;
  state.toGenesis = report.toGenesis;
  state.problems = problemLines(bundle, report.problems);
  state.missing = report.missing.length;
  state.fights = report.fights;
  state.witnessed = report.witnessed;
  // The story again, each fight, birth and hatch now saying what a witness did.
  state.story = storyLines(bundle, report);
  el.story.replaceChildren(...state.story.map(listItem));
  state.timings.verdict ??= performance.now();
  el.verdict.dataset.verdict = state.verdict;
  setText(el.verdict, state.verdictText);
  el.families.replaceChildren(...familyLines(report).map(listItem));
  el.problems.replaceChildren(...state.problems.map(listItem));
  el.problems.hidden = state.problems.length === 0;
  joinBundle(pedigree, bundle, report);
  drawGraph();
}

async function start(): Promise<void> {
  const id = creatureParam(search);
  if (!id) return fail('not-found');
  const base = authorityBase(search, __AUTHORITY_URL__);
  if (!base) return fail('offline');
  authority = base;
  // The worker loads while the proof is fetched; if it fails to load, the check below ends unchecked.
  const link = new VerifierLink(spawnVerifier());

  setText(el.verdict, 'Fetching its proof…');
  const got = await loadProof(fetch, base, id);
  if (!got.ok) {
    link.close();
    return fail(got.error);
  }
  const bundle = got.value;
  state.timings.bundle = performance.now();
  if (!showCreature(bundle)) {
    link.close();
    return fail('malformed');
  }
  setPhase('verifying');
  setText(el.verdict, 'Checking its history…');
  // Each fight's log is fetched one by one and handed to the worker; the card shows the count.
  const outcome = await checkInWorker(link, bundle, {
    report: (report) => showReport(bundle, report),
    replaying: (i, n) => {
      setText(el.progress, `Replaying fight ${i + 1} of ${n}…`);
      el.progress.hidden = false;
    },
    // A fight whose proof can't be had stays unreplayed, which the details say.
    log: async (enc) => {
      const got = await loadFight(fetch, base, enc);
      return got.ok ? got.value.log : undefined;
    },
  });
  el.progress.hidden = true;
  if (outcome === 'unchecked') return fail('unchecked');
  setPhase('done');
  // No image without a verdict: "Save image" waits for the last one.
  state.image.ready = state.verdict !== null;
  el.save.disabled = !state.image.ready;
  if (state.image.ready) el.save.removeAttribute('title');
}

// Without module workers the card can't check a history, so it says what to do instead (M14 T6).
// Without WebGL2 it still runs: the flat preview draws the creature.
const unsupported = unsupportedReason(capabilities(window), 'card');
if (unsupported) {
  showUnsupported(document, unsupported);
} else {
  start().catch((error: unknown) => {
    console.error(error);
    fail('malformed');
  });
}
