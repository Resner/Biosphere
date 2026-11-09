// A death the page never saw (ADR 0076): a tab reopened after its creature died, with something to
// fall back on, opens on the death screen of that life rather than the title, so the player sees
// where they stand and chooses as the death screen offers. From the hub's word alone: the `life`
// (no creature, a fallback) and the history after it. DOM-free.

import type { FallbackInfo, PastLife } from '../net/protocol';
import type { LifeStatus } from './life';
import type { DeathSummary, Screen } from './screens';

/** What the page shows and holds when the history comes in. */
export interface Opening {
  screen: Screen;
  /** The title's cell is on screen: no life has begun on this page. */
  demo: boolean;
  /** Nothing is starting: no hatch, switch or genesis in flight. */
  idle: boolean;
  status: LifeStatus;
  fallback: FallbackInfo | null;
}

/** The death screen the page owes its player, or null when the title is right. */
export function missedDeath(open: Opening, lives: readonly PastLife[]): DeathSummary | null {
  const last = lives[0];
  const { fallback } = open;
  if (!last || open.screen !== 'title' || !open.demo || !open.idle || open.status !== 'idle') {
    return null;
  }
  if (!fallback || (!fallback.pending && !fallback.ancestor)) return null;
  return {
    cause: last.cause,
    survivedSeconds: last.activeMs / 1000,
    // The history keeps no peak: the screen leaves it out.
    peakBiomass: null,
    body: last.species,
    by: null,
    creature: last.creature,
  };
}
