// The title screen's list of past lives (M4 T10): what each creature was, how it died and when.

import type { PastLife } from '../net/protocol';
import { pick } from './dom';
import { DEATH_TEXT, livedText, whenText } from './life-text';

/** Lives the list shows; the hub sends up to 20. */
export const HISTORY_SHOWN = 10;

export interface HistoryRow {
  species: string;
  cause: string;
  lived: string;
  when: string;
}

/** The rows to show, newest first as the hub sends them. */
export function historyRows(lives: readonly PastLife[], nowMs: number): HistoryRow[] {
  return lives.slice(0, HISTORY_SHOWN).map((l) => ({
    species: l.species,
    cause: DEATH_TEXT[l.cause].name,
    lived: livedText(l.activeMs),
    when: whenText(nowMs - l.diedT),
  }));
}

/** The History panel on the title screen. It stays hidden where there is no hub to ask. */
export class HistoryPanel {
  private readonly panel = pick('[data-testid="history"]');
  private readonly list = pick('[data-testid="history-list"]');
  private readonly empty = pick('[data-testid="history-empty"]');

  /** Fills the list; an empty answer shows "No creatures yet". */
  show(lives: readonly PastLife[], nowMs: number): void {
    const rows = historyRows(lives, nowMs);
    this.panel.hidden = false;
    this.empty.hidden = rows.length > 0;
    this.list.replaceChildren(
      ...rows.map((row) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'history-name';
        name.textContent = row.species;
        const detail = document.createElement('span');
        detail.className = 'history-detail';
        detail.textContent = `${row.cause} · ${row.lived} · ${row.when}`;
        item.append(name, detail);
        return item;
      }),
    );
  }
}
