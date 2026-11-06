// The heaviest audit a page can be given (M10 T8): a fight's whole log, 4 starter cells idling side
// by side until the 90 s timeout (900 frames), settled under a fixed test key. The `m10-audit` scenario
// measures the page's frames while its audit worker replays it, and `src/net/audit.test.ts` checks
// that the verdict agrees.

import { genomeToBase64url } from '../src/genome/codec';
import { starterGenome } from '../src/genome/starter';
import type { Beacon } from '../src/ledger/drand';
import { encounterId } from '../src/ledger/encounter';
import { playerIdOf, publicKeyFromSecret } from '../src/ledger/identity';
import { authorityKeyId, authorityPublicKey, type PubKey } from '../src/ledger/record';
import { type FightLog, signSettlement } from '../src/ledger/settlement';
import type { EncStart } from '../src/net/encounter-start';
import { encounterStartOf } from '../src/net/encounter-start';
import { settlementOf } from '../src/net/encounter-verify';
import type { AuditCase, FighterInfo } from '../src/net/protocol-defs';
import { createEncounter, stepFrame } from '../src/sim/encounter/encounter';
import { RULES } from '../src/sim/rules';
import { maxHealth, starterEnergy } from '../src/sim/vitals';
import { IDLE_CODE } from './encounter-fixture';

const AUTH_SECRET = new Uint8Array(32).fill(0x5d);
const AT = 1_700_000_000_000;

export interface LongAudit {
  audit: AuditCase & { kind: 'enc' };
  /** The test key the settlement is signed under. */
  keys: PubKey[];
  /** Any beacon: a fight's verdict reads none. */
  beacon: Beacon;
}

/** A 4-fighter fight that runs its 900 frames, as an auditor duty would carry it. */
export function longAudit(): LongAudit {
  const biomass = RULES.starter.biomass;
  const fighters: FighterInfo[] = [0, 1, 2, 3].map((i) => ({
    player: playerIdOf(publicKeyFromSecret(new Uint8Array(32).fill(i + 1))),
    creature: String(i + 1).repeat(64),
    genome: genomeToBase64url(starterGenome()),
    x: 3000 + i * 20,
    y: 3000 + (i % 2) * 20,
    vx: 0,
    vy: 0,
    heading: 0,
    biomass,
    energy: starterEnergy(biomass),
    health: maxHealth(biomass),
    elder: false,
    egg: false,
    worth: 1,
  }));
  const start: EncStart = {
    t: 'enc-start',
    enc: encounterId(
      fighters.map((f) => f.creature),
      AT,
    ),
    seed: '5eed'.repeat(16),
    round: 0,
    t0: 1000,
    at: AT,
    fighters,
  };
  const pondSeed = 'audit-pond';
  const enc = createEncounter(encounterStartOf(start, pondSeed) as never);
  const frames: (number | null)[][] = [];
  while (!enc.over) {
    const row = enc.fighters.map(() => IDLE_CODE);
    frames.push(row);
    stepFrame(enc, row);
  }
  const log: FightLog = { pondSeed, start, joins: [], frames };
  const publicKey = authorityPublicKey(AUTH_SECRET);
  return {
    audit: {
      kind: 'enc',
      log,
      settlement: signSettlement(AUTH_SECRET, settlementOf(log, enc, AT + frames.length * 100)),
    },
    keys: [{ id: authorityKeyId(publicKey), publicKey }],
    beacon: { round: 1, signature: '00'.repeat(48) },
  };
}
