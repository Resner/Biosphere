// What happened while the player was away (M8 T12, ADR 0053). A fight that settled with its player
// gone leaves a report on the hub, and the next sign-in's `life` carries it once. It is told once,
// in plain words, on the title or death screen; a page still playing hears it as a toast. The
// creature's species comes from the `life` when it lives on, else from the newest past life the
// history lists. DOM-free: the app shows the lines.

import type { FightReport, PastLife } from '../net/protocol';
import type { DeathCause } from '../sim/types';

/** What the report says when the species is not known (yet). */
export const YOUR_CREATURE = 'your creature';
export const EGG_EATEN_AWAY = 'Your egg was eaten while you were away';

/** "… died of <cause>": a death in a fight that was not a strike. */
const DIED_OF: Readonly<Record<DeathCause, string>> = {
  starved: 'hunger',
  toxin: 'poison',
  'old-age': 'old age',
  uv: 'sunburn',
  pressure: 'the pressure of the deep',
  killed: 'its wounds',
  eaten: 'its wounds',
};

/** The report in plain words: what became of the creature, then its egg if one was eaten. */
export function reportLines(report: FightReport, species: string): string[] {
  const who = `While you were away, ${species}`;
  let line: string;
  if (report.outcome === 'killed') {
    line = report.by ? `${who} was killed by ${report.by}` : `${who} was killed`;
  } else if (report.outcome === 'died') {
    line = report.cause ? `${who} died of ${DIED_OF[report.cause]}` : `${who} died in a fight`;
  } else if (report.outcome === 'escaped') {
    line = `${who} escaped a fight`;
  } else {
    line = `${who} held its own in a fight`;
  }
  return report.egg === 'eaten' ? [line, EGG_EATEN_AWAY] : [line];
}

/** A report as `state().report` shows it: the hub's report and the lines told. */
export interface ToldReport extends FightReport {
  lines: string[];
}

export class AwayReport {
  /** What was told last on this page (`state().report`); null before any. */
  told: ToldReport | null = null;
  /** The species was not known when it was told: the next history names it. */
  private unnamed = false;

  /** `show(lines, fresh)`: the lines to put on screen; `fresh` once per report, false for a rename. */
  constructor(private readonly show: (lines: string[], fresh: boolean) => void) {}

  /**
   * A `life` from the hub: its report, if any, is told at once, with the creature's species when
   * the page knows it. The same report twice is told once. True when it was told now.
   */
  life(report: FightReport | undefined, species: string | null): boolean {
    if (!report || report.enc === this.told?.enc) return false;
    this.unnamed = species === null;
    this.told = { ...report, lines: reportLines(report, species ?? YOUR_CREATURE) };
    this.show(this.told.lines, true);
    return true;
  }

  /** The history after it: a report told without a species takes the newest past life's. */
  history(lives: readonly PastLife[]): void {
    const species = lives[0]?.species;
    const { told } = this;
    if (!this.unnamed || !told || !species) return;
    this.unnamed = false;
    this.told = { ...told, lines: reportLines(told, species) };
    this.show(this.told.lines, false);
  }
}
