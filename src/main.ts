import './style.css';
import { startApp } from './game/app';
import { formatBuildLabel } from './game/build-label';
import { capabilities, showUnsupported, unsupportedReason } from './game/capability';
import { watchCsp } from './game/csp-watch';
import { installPlainHook } from './game/debug';
import { qualityFromSearch, worldFromSearch } from './game/settings';

// What the page's Content-Security-Policy blocks, for `state().csp` (M14 T16).
watchCsp(document);

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

// A browser without what the game needs gets a plain page that says what to do (M14 T6).
const caps = capabilities(window);
const unsupported = unsupportedReason(caps, 'game');
const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (unsupported) {
  showUnsupported(document, unsupported);
  installPlainHook(caps, unsupported);
} else if (canvas) {
  const params = new URLSearchParams(window.location.search);
  startApp(canvas, {
    seed: params.get('seed') ?? randomSeed(),
    debug: params.has('debug'),
    genome: params.get('genome'),
    quality: qualityFromSearch(window.location.search),
    dof: params.get('dof') !== '0',
    light: params.get('light') !== '0',
    world: worldFromSearch(window.location.search),
    gpuWatch: params.get('gpu') === 'watch',
    capabilities: caps,
  });
}

/** A fresh pond for every visit; tests pass `?seed=` to pin it. */
function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  return `pond-${bytes[0]?.toString(36)}${bytes[1]?.toString(36)}`;
}
