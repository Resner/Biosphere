import './style.css';
import { formatBuildLabel } from './game/build-label';
import { startPreview } from './render/preview';

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (canvas) startPreview(canvas);
