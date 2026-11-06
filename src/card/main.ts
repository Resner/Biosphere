import '../style.css';
import './card.css';
import { capitalise } from '../game/badge';
import { formatBuildLabel } from '../game/build-label';
import { listItem, pick, setText } from '../game/dom';
import { setStars, shapeName } from '../game/reveal-card';
import { loadSettings, qualityFromSearch, reducedMotion } from '../game/settings';
import { parseGenomeText } from '../genome/codec';
import { silhouetteOf } from '../genome/silhouette';
import { buildCreature } from '../genome/stats';
import type { ProofBundle } from '../ledger/proof';
import type { LineageReport } from '../ledger/verify';
import { type PresetName, resolvePreset } from '../render/presets';
import { cardFacts, familyLines, problemLines, verdictLine } from './card';
import { CreatureStage } from './card-view';
import type { CardHook, CardState } from './hook';
import {
  authorityBase,
  type CardError,
  creatureParam,
  ERROR_TEXT,
  loadFight,
  loadProof,
} from './load';
import type { FromWorker, ToWorker } from './verify-worker';

// The creature card page (M9 T12): `card.html?c=<creature id>` fetches the creature's proof from the
// authority, draws the creature at once, and checks the proof in a module worker: the whole bundle
// first, then each settled fight replayed from its log. It works with every player offline, and it
// names no player.

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
  error: pick('[data-testid="card-error"]'),
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
  story: [],
  drawn: false,
  renderer: null,
  timings: { bundle: null, drawn: null, verdict: null },
};

const hook: CardHook = { state: () => structuredClone(state) };
window.__card = hook;

const search = window.location.search;
const settings = loadSettings(safeStorage());
const quality = qualityFromSearch(search) ?? settings.quality;
const preset: PresetName = resolvePreset(quality, 'high');
const still = reducedMotion(settings, matchMedia('(prefers-reduced-motion: reduce)').matches);
el.card.toggleAttribute('data-still', still);

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
  state.timings.verdict ??= performance.now();
  el.verdict.dataset.verdict = state.verdict;
  setText(el.verdict, state.verdictText);
  el.families.replaceChildren(...familyLines(report).map(listItem));
  el.problems.replaceChildren(...state.problems.map(listItem));
  el.problems.hidden = state.problems.length === 0;
}

/** Fetches each fight's log one by one and hands it to the worker; the card shows the count. */
async function replayFights(
  base: string,
  worker: Worker,
  encs: readonly string[],
  replied: () => Promise<void>,
): Promise<void> {
  for (const [i, enc] of encs.entries()) {
    setText(el.progress, `Replaying fight ${i + 1} of ${encs.length}…`);
    el.progress.hidden = false;
    const got = await loadFight(fetch, base, enc);
    // A fight whose proof can't be had stays unreplayed, which the details say.
    if (!got.ok) continue;
    worker.postMessage({ t: 'fight', enc, log: got.value.log } satisfies ToWorker);
    await replied();
  }
  el.progress.hidden = true;
}

async function start(): Promise<void> {
  const id = creatureParam(search);
  if (!id) return fail('not-found');
  const base = authorityBase(search, __AUTHORITY_URL__);
  if (!base) return fail('offline');
  // The worker loads while the proof is fetched.
  const worker = new Worker(new URL('./verify-worker.ts', import.meta.url), { type: 'module' });
  let reply: ((msg: FromWorker) => void) | null = null;
  worker.addEventListener('message', (e: MessageEvent<FromWorker>) => reply?.(e.data));
  worker.addEventListener('error', (e) => {
    console.error('the verifier did not run', e.message);
    worker.terminate();
    fail('unchecked');
  });
  const next = (): Promise<FromWorker> =>
    new Promise((resolve) => {
      reply = resolve;
    });

  setText(el.verdict, 'Fetching its proof…');
  const got = await loadProof(fetch, base, id);
  if (!got.ok) {
    worker.terminate();
    return fail(got.error);
  }
  const bundle = got.value;
  state.timings.bundle = performance.now();
  if (!showCreature(bundle)) {
    worker.terminate();
    return fail('malformed');
  }
  setPhase('verifying');
  setText(el.verdict, 'Checking its history…');
  const first = next();
  worker.postMessage({ t: 'verify', bundle } satisfies ToWorker);
  const { report, fights } = await first;
  showReport(bundle, report);
  await replayFights(base, worker, fights, async () => {
    const msg = await next();
    showReport(bundle, msg.report);
  });
  worker.terminate();
  setPhase('done');
}

start().catch((error: unknown) => {
  console.error(error);
  fail('malformed');
});
