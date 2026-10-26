import '../style.css';
import './lab.css';
import { formatBuildLabel } from '../game/build-label';
import { randomSeed, startLab } from './lab';
import type { LabMode } from './specimens';

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

const params = new URLSearchParams(window.location.search);
startLab({
  seed: params.get('seed') ?? randomSeed(),
  mode: params.get('mode') === 'wild' ? ('wild' satisfies LabMode) : 'genesis',
});
