// The checks on a `born` message that need the beacon code (BLS): loaded when the first child
// arrives, like the genesis check.

import { genomeHash, parseGenomeText } from '../genome/codec';
import { recordHash } from '../ledger/record';
import type { Born } from '../net/protocol';

/** Why `born` is not a child of the player's mating; empty when it is. Never throws. */
export async function birthProblems(born: Born, playerId: string): Promise<string[]> {
  try {
    const { checkBirth } = await import('../ledger/mating');
    const { record, hash } = born.record;
    if (record.owner !== playerId) return ['not-yours'];
    if (hash !== recordHash(record)) return ['hash'];
    const child = parseGenomeText(born.genome);
    if (!child || genomeHash(child) !== record.body.genome) return ['child-genome'];
    const a = parseGenomeText(born.parents[0]);
    const b = parseGenomeText(born.parents[1]);
    if (!a || !b) return ['parent-genome'];
    return checkBirth(record, born.commit.commitment, born.beacon, [a, b], born.mates);
  } catch {
    return ['unreadable'];
  }
}
