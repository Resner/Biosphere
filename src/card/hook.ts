import type { RarityTier } from '../genome/rarity';
import type { LineageReport } from '../ledger/verify';
import type { CardStatus } from './card';
import type { GraphNodeState } from './lineage-graph';
import type { CardError } from './load';

// `window.__card` (M9 T12): what the creature card shows, for tests. Read-only: the card changes no
// state anywhere, so it has no debug helpers.

export type CardPhase = 'loading' | 'verifying' | 'done' | 'error';

export interface CardState {
  /** `loading` the proof, `verifying` it (and replaying its fights), `done`, or an `error`. */
  phase: CardPhase;
  error: CardError | null;
  subject: string | null;
  species: string | null;
  /** The subject's rarity. */
  tier: RarityTier | null;
  generation: number | null;
  status: CardStatus | null;
  /** Null until the first verification ends; it may still turn `failed` while fights replay. */
  verdict: 'verified' | 'failed' | null;
  /** The verdict line as the card shows it. */
  verdictText: string | null;
  scaled: boolean;
  toGenesis: boolean;
  /** Every problem as its plain sentence. */
  problems: string[];
  /** Ancestors the proof left out (`more`). */
  missing: number;
  fights: LineageReport['fights'];
  /** The story lines as shown. */
  story: string[];
  /** True once a frame shows the creature (the WebGL body, or the flat preview without WebGL2). */
  drawn: boolean;
  /** How the creature is drawn: `webgl`, the flat `preview`, or null before it is. */
  renderer: 'webgl' | 'preview' | null;
  /** `performance.now()` when the bundle arrived, the creature was first drawn, and the verdict came. */
  timings: { bundle: number | null; drawn: number | null; verdict: number | null };
  /**
   * "Save image" (M9 T14): `ready` once the check is done with a verdict (the button waits until
   * then), and the images saved so far, each a 1200 × 630 PNG.
   */
  image: { ready: boolean; saved: number };
   * The lineage graph's nodes (M9 T13), the subject first, then nearest first: `branch` (the subject
   * and its chain parents), `root` (genesis), `verified` (null before its check or when not loaded)
   * and `loaded` (false for an ancestor the proof left out, until its Load joins it).
   */
  graph: GraphNodeState[];
}

export interface CardHook {
  state(): CardState;
}

declare global {
  interface Window {
    __card?: CardHook;
  }
}
