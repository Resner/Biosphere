// What a fight's end means for the player beyond the fight itself (M7 T13, ADR 0052): an egg
// eaten in it goes, with the pending child it was. A death comes as the hub's own `died`.

import type { FightMsg } from '../net/hub-client';

export const EGG_EATEN = 'Your egg was eaten';

export interface FightEndDeps {
  playerId: string | null;
  toast(text: string): void;
  /** Drops the pending child: its egg, its card and the life flow's word that one waits. */
  loseEgg(): void;
}

/** Reads `enc-end` for the player's own fighter: an eaten egg is told and let go. */
export function fightEnded(msg: Extract<FightMsg, { t: 'enc-end' }>, deps: FightEndDeps): void {
  const mine = msg.fighters.find((f) => f.player === deps.playerId);
  if (mine?.egg !== 'eaten') return;
  deps.loseEgg();
  deps.toast(EGG_EATEN);
}
