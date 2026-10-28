import './style.css';
import { startApp } from './game/app';
import { formatBuildLabel } from './game/build-label';
import { qualityFromSearch } from './game/settings';

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (canvas) {
  const params = new URLSearchParams(window.location.search);
  startApp(canvas, {
    seed: params.get('seed') ?? randomSeed(),
    debug: params.has('debug'),
    genome: params.get('genome'),
    quality: qualityFromSearch(window.location.search),
    dof: params.get('dof') !== '0',
  });
}

/** A fresh pond for every visit; tests pass `?seed=` to pin it. */
function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  return `pond-${bytes[0]?.toString(36)}${bytes[1]?.toString(36)}`;
}
