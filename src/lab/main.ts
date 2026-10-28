import '../style.css';
import './lab.css';
import { formatBuildLabel } from '../game/build-label';
import { randomSeed, startLab } from './lab';

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

const params = new URLSearchParams(window.location.search);
if (params.has('gallery')) {
  // The look-pass sheet (M6 T5) loads its specimens only when asked for.
  import('./gallery-page')
    .then((page) => page.startGallery())
    .catch((error: unknown) => console.error(error));
} else {
  startLab({
    seed: params.get('seed') || randomSeed(),
    mode: params.get('mode') === 'wild' ? 'wild' : 'genesis',
    debug: params.has('debug'),
    genome: params.get('genome') ?? undefined,
  });
}
