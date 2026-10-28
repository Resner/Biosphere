// Genesis DNA under rules version 6 (ADR 0025, DESIGN §6). Until the wider larval spread (M6 T9),
// a v6 genesis cell is the v5 cell written as a karyotype v2 genome: the same body, with every new
// locus 0. The v5 code stays frozen in `genesis-v5.ts` for verifying old genesis records.

import type { Seed } from '../sim/prng';
import { type Genome, upgrade } from './codec';
import { genesisGenomeV5 } from './genesis-v5';

export { GENESIS_FREQ } from './genesis-v5';

/** A fresh genesis genome of karyotype v2: a pure function of the seed. */
export function genesisGenome(seed: Seed): Genome {
  return upgrade(genesisGenomeV5(seed));
}
