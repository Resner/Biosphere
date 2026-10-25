import './style.css';
import { startGame } from './game/app';
import { formatBuildLabel } from './game/build-label';
import { startPreview } from './render/preview';

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (canvas) {
  const params = new URLSearchParams(window.location.search);
  // Until the title screen lands (M1 T9), `autohatch` starts play directly; otherwise the title scene runs.
  if (params.has('autohatch')) {
    startGame(canvas, { seed: params.get('seed') ?? 'biosphere', debug: params.has('debug') });
  } else {
    startPreview(canvas);
  }
}
