import '../style.css';
import './lab.css';
import { formatBuildLabel } from '../game/build-label';
import { capabilities, showUnsupported, unsupportedReason } from '../game/capability';
import { watchCsp } from '../game/csp-watch';
import { randomSeed, startLab } from './lab';

// What the page's Content-Security-Policy blocks, for `state().csp` (M14 T16).
watchCsp(document);

const label = document.querySelector<HTMLElement>('[data-testid="build-label"]');
if (label) label.textContent = formatBuildLabel(__BUILD_LABEL__);

const params = new URLSearchParams(window.location.search);
// A browser without WebGL2 or module workers gets the plain page (M14 T6).
const unsupported = unsupportedReason(capabilities(window), 'lab');
if (unsupported) {
  showUnsupported(document, unsupported);
} else if (params.has('gallery')) {
  // The look-pass sheet (M6 T5) loads its specimens only when asked for.
  import('./gallery-page')
    .then((page) => page.startGallery())
    .catch((error: unknown) => console.error(error));
} else {
  startLab({
    seed: params.get('seed') || randomSeed(),
    mode: params.get('mode') === 'evolved' ? 'evolved' : 'genesis',
    debug: params.has('debug'),
    genome: params.get('genome') ?? undefined,
  });
}
